import { createClient } from "../api/client";
import { isConfigured, loadConfig } from "../config/store";

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
}

export interface CanonicalEventOptions {
  eventType: CanonicalEventType;
  client?: string;
  workspace?: string;
  sessionId?: string;
  agentId?: string;
  privacyLevel?: PrivacyLevel;
  payload?: Record<string, unknown>;
}

export function buildCanonicalEvent(options: CanonicalEventOptions) {
  const config = loadConfig();

  return {
    type: options.eventType,
    client: options.client || "snipara-companion",
    workspace: options.workspace || process.cwd(),
    session_id: options.sessionId || config.sessionId || "default",
    agent_id: options.agentId || "local-agent",
    timestamp: new Date().toISOString(),
    privacy_level: options.privacyLevel || "standard",
    payload: options.payload || {},
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
