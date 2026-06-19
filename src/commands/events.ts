/**
 * Canonical automation events — build, emit, and fetch.
 *
 * Defines the canonical event schema (session_start/end, tool_call/result,
 * file_changed, error_observed, …) and privacy levels, builds events with
 * consistent metadata, emits them to the Snipara automation API, and fetches
 * recent events. Other commands route their telemetry through here so event
 * shape stays consistent.
 */
import { createClient } from "../api/client";
import { isConfigured, loadConfig } from "../config/store";
import { type ContextPackRecord, resolveContextPackRecord } from "./context-pack";

type PrivacyLevel = "standard" | "sensitive" | "restricted";
type CanonicalEventType =
  | "session_start"
  | "session_end"
  | "compact"
  | "message_user"
  | "message_assistant"
  | "tool_call"
  | "tool_result"
  | "file_changed"
  | "error_observed";

export interface EmitEventCommandOptions {
  eventType: CanonicalEventType;
  client?: string;
  workspace?: string;
  sessionId?: string;
  agentId?: string;
  privacyLevel?: PrivacyLevel;
  payload?: string;
  contextPackIds?: string[];
  contextPackOperation?: LocalContextPackReceiptOperation;
  cwd?: string;
}

export interface CanonicalEventOptions {
  eventType: CanonicalEventType;
  client?: string;
  workspace?: string;
  sessionId?: string;
  agentId?: string;
  privacyLevel?: PrivacyLevel;
  payload?: Record<string, unknown>;
  contextPackReceipts?: LocalContextPackReceiptPayload[];
}

export type LocalContextPackReceiptOperation = "pack" | "retrieve" | "reference";

export interface LocalContextPackReceiptPayload {
  version: "snipara.context_pack.receipt.v1";
  receipt_id: string;
  pack_id: string;
  operation: LocalContextPackReceiptOperation;
  content_uploaded: false;
  policy_decision: "local_only" | "blocked" | "metadata_only";
  privacy_level: PrivacyLevel;
  kind: ContextPackRecord["kind"];
  label?: string | null;
  source?: string | null;
  tags: string[];
  bytes: number;
  line_count: number;
  payload_digest?: string;
  sensitive: boolean;
  created_at: string;
  expires_at?: string | null;
  local_ref: {
    base_relative_path: string;
    manifest_relative_path: string;
  };
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function buildLocalContextPackReceipt(
  record: ContextPackRecord,
  options: {
    operation?: LocalContextPackReceiptOperation;
    privacyLevel?: PrivacyLevel;
    policyDecision?: LocalContextPackReceiptPayload["policy_decision"];
  } = {}
): LocalContextPackReceiptPayload {
  const operation = options.operation ?? "reference";
  return {
    version: "snipara.context_pack.receipt.v1",
    receipt_id: `${record.id}:${operation}:${record.updatedAt}`,
    pack_id: record.id,
    operation,
    content_uploaded: false,
    policy_decision: options.policyDecision ?? "local_only",
    privacy_level: options.privacyLevel ?? (record.sensitive ? "sensitive" : "standard"),
    kind: record.kind,
    label: record.label,
    source: record.source,
    tags: record.tags,
    bytes: record.bytes,
    line_count: record.lineCount,
    payload_digest: record.sha256,
    sensitive: record.sensitive,
    created_at: record.createdAt,
    expires_at: record.expiresAt,
    local_ref: {
      base_relative_path: record.storage.baseRelativePath,
      manifest_relative_path: record.storage.manifestRelativePath,
    },
  };
}

export function buildLocalContextPackReceipts(options: {
  ids: string[];
  cwd?: string;
  operation?: LocalContextPackReceiptOperation;
  privacyLevel?: PrivacyLevel;
}): LocalContextPackReceiptPayload[] {
  return uniqueStrings(options.ids)
    .slice(0, 20)
    .map((id) => {
      const { record } = resolveContextPackRecord(id, options.cwd);
      return buildLocalContextPackReceipt(record, {
        operation: options.operation,
        privacyLevel: options.privacyLevel,
      });
    });
}

export function attachLocalContextPackReceipts(
  payload: Record<string, unknown>,
  receipts: LocalContextPackReceiptPayload[]
): Record<string, unknown> {
  if (receipts.length === 0) {
    return payload;
  }
  return {
    ...payload,
    local_context_pack_receipts: receipts,
  };
}

export function buildCanonicalEvent(options: CanonicalEventOptions) {
  const config = loadConfig();
  const payload = attachLocalContextPackReceipts(
    options.payload || {},
    options.contextPackReceipts ?? []
  );

  return {
    type: options.eventType,
    client: options.client || "snipara-companion",
    workspace: options.workspace || process.cwd(),
    session_id: options.sessionId || config.sessionId || "default",
    agent_id: options.agentId || "local-agent",
    timestamp: new Date().toISOString(),
    privacy_level: options.privacyLevel || "standard",
    payload,
  };
}

export async function emitCanonicalEvent(
  options: CanonicalEventOptions,
  { silent = true, timeoutMs = 10000 }: { silent?: boolean; timeoutMs?: number } = {}
): Promise<boolean> {
  if (!isConfigured()) {
    if (!silent) {
      console.log("Not configured. Run 'npx -y snipara-companion@latest init' first.");
    }
    return false;
  }

  try {
    const client = createClient(timeoutMs);
    await client.emitEvent(buildCanonicalEvent(options));
    return true;
  } catch (error) {
    if (!silent && process.env.RLM_DEBUG) {
      console.error(
        `[Snipara] Event error: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
    return false;
  }
}

export async function emitEventCommand(options: EmitEventCommandOptions): Promise<void> {
  const payload = options.payload ? (JSON.parse(options.payload) as Record<string, unknown>) : {};

  if (!isConfigured()) {
    console.log("Not configured. Run 'npx -y snipara-companion@latest init' first.");
    process.exit(1);
  }

  const contextPackReceipts = buildLocalContextPackReceipts({
    ids: options.contextPackIds ?? [],
    cwd: options.cwd,
    operation: options.contextPackOperation,
    privacyLevel: options.privacyLevel,
  });

  const client = createClient(10000);
  const result = await client.emitEvent(
    buildCanonicalEvent({
      eventType: options.eventType,
      client: options.client,
      workspace: options.workspace,
      sessionId: options.sessionId,
      agentId: options.agentId,
      privacyLevel: options.privacyLevel,
      payload,
      contextPackReceipts,
    })
  );

  console.log(`Accepted ${result.accepted} event(s) for session ${result.sessionIds.join(", ")}`);
}

export async function recentEventsCommand(options: {
  sessionId?: string;
  limit?: number;
  json?: boolean;
}): Promise<void> {
  if (!isConfigured()) {
    console.log("Not configured. Run 'npx -y snipara-companion@latest init' first.");
    process.exit(1);
  }

  const client = createClient(10000);
  const result = await client.getAutomationEvents({
    sessionId: options.sessionId,
    limit: options.limit,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Recent events: ${result.count}`);
  if (result.events.length === 0) {
    console.log("No recent automation events found.");
    return;
  }

  console.log("");
  for (const item of result.events) {
    console.log(`${item.createdAt}  ${item.event.type}`);
    console.log(
      `session=${item.sessionId} client=${item.event.client} privacy=${item.event.privacy_level}`
    );

    const payload = item.event.payload || {};
    const command = typeof payload.command === "string" ? payload.command : null;
    const files = Array.isArray(payload.files)
      ? payload.files.filter((value): value is string => typeof value === "string")
      : [];

    if (command) {
      console.log(`command=${command}`);
    }
    if (files.length > 0) {
      console.log(`files=${files.slice(0, 5).join(", ")}`);
    }
    console.log("");
  }
}
