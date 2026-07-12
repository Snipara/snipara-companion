/**
 * `stuck-guard` — detect and break agent "stuck" loops.
 *
 * Normalizes tool calls/results into canonical events, classifies outcomes
 * (success | failure | empty_result | timeout), and evaluates whether the agent
 * is stuck (e.g. repeated failing searches) so a rescue hint can be injected.
 * Tool input and results are scrubbed of secrets (see SECRET_PATTERNS) before
 * any payload is built or sent.
 */
import * as fs from "node:fs";
import { buildCanonicalEvent } from "./events";
import {
  createClient,
  type CanonicalAutomationEvent,
  type StuckGuardDecision,
  type StuckGuardEvaluationResult,
} from "../api/client";
import { isConfigured } from "../config/store";

export type ToolResultClassification = "success" | "failure" | "empty_result" | "timeout";

export interface ToolResultPayloadOptions {
  tool?: string;
  toolInput?: string;
  result?: string;
  exitCode?: number;
  status?: string;
  files?: string[];
  hook?: string;
}

export interface ToolCallPayloadOptions {
  tool?: string;
  toolInput?: string;
  query?: string | null;
  hook?: string;
}

const SEARCH_TOOL_PATTERN = /\b(read|grep|glob|find|rg|ripgrep|search|ls)\b/i;
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}\b/g, "$1[REDACTED]"],
  [/\b(sk|snp|rlm)_[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_KEY]"],
  [/\b[A-Za-z0-9._%+-]+:[^@\s]{8,}@([A-Za-z0-9.-]+:[0-9]+)\b/g, "[REDACTED_CREDENTIALS]@$1"],
  [
    /\b([A-Za-z][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Za-z0-9_]*)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s;&|]{8,})/gi,
    "$1=[REDACTED]",
  ],
  [/\b(api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^"'\s]{8,}["']?/gi, "$1=[REDACTED]"],
];
const COMMAND_FIELDS = ["command", "cmd", "script", "query", "pattern", "path", "file_path"];
const NESTED_TOOL_INPUT_FIELDS = [
  "tool_input",
  "toolInput",
  "input",
  "arguments",
  "args",
  "params",
];

function findStringField(value: unknown, fields: string[], depth = 0): string | undefined {
  if (depth > 4 || value === null || value === undefined || typeof value !== "object") {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findStringField(item, fields, depth + 1);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const field of fields) {
    const candidate = record[field];
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim();
    }
  }

  for (const field of NESTED_TOOL_INPUT_FIELDS) {
    const nested = findStringField(record[field], fields, depth + 1);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

export function extractCommandFromToolInput(toolInput?: string): string | undefined {
  const parsed = parseToolInput(toolInput);
  if (!parsed) {
    return undefined;
  }

  return findStringField(parsed, COMMAND_FIELDS);
}

export function classifyToolResult(options: {
  tool?: string;
  command?: string;
  result?: string;
  exitCode?: number;
  status?: string;
}): ToolResultClassification {
  const status = options.status?.trim().toLowerCase();
  if (status && ["timeout", "timed_out"].includes(status)) {
    return "timeout";
  }

  if (
    typeof options.exitCode === "number" &&
    options.exitCode !== 0 &&
    !(isSearchLike(options.tool, options.command) && options.exitCode === 1)
  ) {
    return "failure";
  }

  if (status && ["error", "failed", "failure"].includes(status)) {
    return "failure";
  }

  if (isSearchLike(options.tool, options.command)) {
    const result = options.result?.trim() ?? "";
    if (result === "" || /^0\s+(matches|results|sections)$/i.test(result)) {
      return "empty_result";
    }
  }

  return "success";
}

export function buildToolCallPayload(options: ToolCallPayloadOptions): Record<string, unknown> {
  return {
    hook: options.hook ?? "pre-tool",
    tool: options.tool || "unknown",
    ...(options.query ? { query: options.query } : {}),
    ...(options.toolInput
      ? { tool_input_preview: truncate(redactSecrets(options.toolInput), 800) }
      : {}),
  };
}

export function buildToolResultPayload(options: ToolResultPayloadOptions): Record<string, unknown> {
  const command = extractCommandFromToolInput(options.toolInput);
  const commandPreview = command ? truncate(redactSecrets(command), 800) : undefined;
  const classification = classifyToolResult({
    tool: options.tool,
    command,
    result: options.result,
    exitCode: options.exitCode,
    status: options.status,
  });

  return {
    hook: options.hook ?? "post-tool",
    tool: options.tool || "unknown",
    result_classification: classification,
    ...(commandPreview ? { command: commandPreview } : {}),
    ...(typeof options.exitCode === "number" ? { exit_code: options.exitCode } : {}),
    ...(options.status ? { status: options.status } : {}),
    ...(options.files && options.files.length > 0 ? { files: options.files } : {}),
    has_result: typeof options.result === "string" && options.result.trim() !== "",
    ...(options.result ? { result_preview: truncate(redactSecrets(options.result), 1200) } : {}),
  };
}

export function getStuckGuardInjection(decision: StuckGuardDecision): string | null {
  if (
    !decision.triggered ||
    (decision.action !== "inject" && decision.action !== "enforce") ||
    !decision.rescuePack?.injectionText
  ) {
    return null;
  }

  return decision.rescuePack.injectionText;
}

export function formatStuckGuardDecision(result: StuckGuardEvaluationResult): string {
  const { decision } = result;
  const lines = [
    `Stuck Guard: ${decision.action} (score ${decision.score}, mode ${decision.configuredMode})`,
    `Project: ${result.project.name} (${result.project.slug})`,
    `Events evaluated: ${result.eventsEvaluated}`,
  ];

  if (!decision.enabled) {
    lines.push("Disabled for this project.");
    return lines.join("\n");
  }

  if (decision.sessionId) {
    lines.push(`Session: ${decision.sessionId}`);
  }

  if (decision.reasons.length > 0) {
    lines.push("");
    lines.push("Reasons:");
    for (const reason of decision.reasons) {
      lines.push(`- ${reason.code}: ${reason.message} (${reason.weight})`);
    }
  }

  const injection = getStuckGuardInjection(decision);
  if (injection) {
    lines.push("");
    lines.push(injection);
  }

  return lines.join("\n");
}

export async function evaluateAndPrintStuckGuard(args: {
  event?: CanonicalAutomationEvent;
  events?: CanonicalAutomationEvent[];
  sessionId?: string;
  includeRecent?: boolean;
  limit?: number;
  json?: boolean;
  timeoutMs?: number;
}): Promise<StuckGuardEvaluationResult | null> {
  if (!isConfigured()) {
    return null;
  }

  const client = createClient(args.timeoutMs ?? 3000);
  const result = await client.evaluateStuckGuard({
    event: args.event,
    events: args.events,
    sessionId: args.sessionId,
    includeRecent: args.includeRecent,
    limit: args.limit,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const injection = getStuckGuardInjection(result.decision);
    if (injection) {
      console.log(injection);
    }
  }

  return result;
}

export async function stuckGuardStatusCommand(options: {
  sessionId?: string;
  limit?: number;
  json?: boolean;
}): Promise<void> {
  ensureConfiguredForCommand();
  const client = createClient(10000);
  const result = await client.getStuckGuardStatus({
    sessionId: options.sessionId,
    limit: options.limit,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatStuckGuardDecision(result));
}

export async function stuckGuardCheckCommand(
  toolInput: string | undefined,
  options: {
    tool?: string;
    query?: string;
    result?: string;
    exitCode?: number;
    status?: string;
    sessionId?: string;
    includeRecent?: boolean;
    limit?: number;
    json?: boolean;
  }
): Promise<void> {
  ensureConfiguredForCommand();

  const isResultEvent =
    typeof options.result === "string" ||
    typeof options.exitCode === "number" ||
    typeof options.status === "string";
  const payload = isResultEvent
    ? buildToolResultPayload({
        tool: options.tool,
        toolInput,
        result: options.result,
        exitCode: options.exitCode,
        status: options.status,
      })
    : buildToolCallPayload({
        tool: options.tool,
        toolInput,
        query: options.query ?? extractCommandFromToolInput(toolInput),
      });
  const event = buildCanonicalEvent({
    eventType: isResultEvent ? "tool_result" : "tool_call",
    sessionId: options.sessionId,
    payload,
  });

  const client = createClient(10000);
  const result = await client.evaluateStuckGuard({
    event,
    sessionId: options.sessionId ?? event.session_id,
    includeRecent: options.includeRecent ?? true,
    limit: options.limit,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatStuckGuardDecision(result));
}

export async function stuckGuardSimulateCommand(options: {
  fixture: string;
  json?: boolean;
}): Promise<void> {
  ensureConfiguredForCommand();

  const fixture = JSON.parse(fs.readFileSync(options.fixture, "utf8")) as unknown;
  const payload = normalizeFixture(fixture);
  const client = createClient(10000);
  const result = await client.evaluateStuckGuard(payload);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatStuckGuardDecision(result));
}

function normalizeFixture(fixture: unknown): {
  sessionId?: string;
  events?: CanonicalAutomationEvent[];
  event?: CanonicalAutomationEvent;
  includeRecent: boolean;
} {
  if (Array.isArray(fixture)) {
    return {
      events: fixture as CanonicalAutomationEvent[],
      includeRecent: false,
    };
  }

  if (typeof fixture !== "object" || fixture === null) {
    throw new Error("Fixture must be a JSON object or an array of canonical events");
  }

  const record = fixture as {
    sessionId?: string;
    event?: CanonicalAutomationEvent;
    events?: CanonicalAutomationEvent[];
    includeRecent?: boolean;
  };

  return {
    sessionId: record.sessionId,
    event: record.event,
    events: record.events,
    includeRecent: record.includeRecent ?? false,
  };
}

function parseToolInput(toolInput?: string): Record<string, unknown> | null {
  if (!toolInput) {
    return null;
  }

  const trimmed = toolInput.trim();
  if (trimmed === "") {
    return null;
  }

  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return { command: trimmed };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { command: trimmed };
  } catch {
    return { command: trimmed };
  }
}

function isSearchLike(tool?: string, command?: string): boolean {
  return SEARCH_TOOL_PATTERN.test(`${tool ?? ""} ${command ?? ""}`);
}

function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    value
  );
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function ensureConfiguredForCommand(): void {
  if (!isConfigured()) {
    console.log("Not configured. Run 'npx -y snipara-companion@latest init' first.");
    process.exit(1);
  }
}
