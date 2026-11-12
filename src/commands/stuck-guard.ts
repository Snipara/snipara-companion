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
import path from "node:path";
import { resolveWorkflowContinuityFile, readWorkflowContinuityFile } from "./workflow-continuity";
import { createHash } from "node:crypto";
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

const SEARCH_TOOL_PATTERN = /^(?:grep|glob|find|rg|ripgrep|search|websearch|.*[_.](?:search|query|recall))$/i;
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
  let resultRecord: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(options.result ?? "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) resultRecord = parsed as Record<string, unknown>;
  } catch { /* Plain text requires explicit status or exit code. */ }
  const recordedExit = resultRecord.exit_code ?? resultRecord.exitCode;
  const exitCode = options.exitCode ?? (typeof recordedExit === "number" ? recordedExit : undefined);
  const status = (options.status ?? (typeof resultRecord.status === "string" ? resultRecord.status : undefined))?.trim().toLowerCase();
  if (resultRecord.is_error === true || resultRecord.isError === true) return "failure";
  if (status && ["timeout", "timed_out"].includes(status)) {
    return "timeout";
  }

  if (
    typeof exitCode === "number" &&
    exitCode !== 0 &&
    !(isSearchLike(options.tool, options.command) && exitCode === 1)
  ) {
    return "failure";
  }

  if (status && ["error", "failed", "failure"].includes(status)) {
    return "failure";
  }

  if (isSearchLike(options.tool, options.command)) {
    const result = options.result?.trim() ?? "";
    const counts = ["numFiles", "numMatches", "numLines", "total_results", "total_count"];
    const recordedCounts = counts.map(key => resultRecord[key]).filter(value => typeof value === "number");
    const emptyCount = recordedCounts.length > 0 && recordedCounts.every(value => value === 0);
    const resultLists = ["results", "matches", "files", "sections"].map(key => resultRecord[key]).filter(Array.isArray);
    const emptyList = resultLists.length > 0 && resultLists.every(value => value.length === 0);
    const emptyStructured = (emptyCount || emptyList) &&
      !recordedCounts.some(value => (value as number) > 0) && !resultLists.some(value => value.length > 0);
    if (exitCode === 1 || emptyStructured || result === "[]" || result === '""' ||
        (typeof options.result === "string" && result === "") ||
        /^(?:0\s+(matches|results|sections)|no (?:matches|results)(?: found)?)[.!]?$/i.test(result)) {
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
    ...(options.toolInput?.trim() ? { action_key: toolActionKey(options.tool, options.toolInput) } : {}),
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
  // Hooks use result evidence locally. The hosted detector also scores keywords
  // and repeated calls, which cannot establish failure and must not inject here.
  if (args.event) {
    const pack = updateLocalStuckGuard(args.event);
    if (pack) console.log(pack);
  }
  return null;
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
  return SEARCH_TOOL_PATTERN.test(tool ?? "") || /^(?:rg|grep|find|ripgrep)\b/.test(command?.trim() ?? "");
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

/** Input equality preserves shell quoting and case; only JSON key ordering is normalized. */
export function toolActionKey(tool?: string, input?: string): string {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    return value;
  }
  const parsed = parseToolInput(input);
  if (parsed) for (const volatile of ["description", "timeout"]) delete parsed[volatile]; // vary between identical retries
  const normalized = JSON.stringify(canonical(parsed));
  return createHash("sha256").update(`${tool ?? "unknown"}\n${normalized}`).digest("hex");
}

/** One repeated failing (or empty-search) action seen recently in this session. */
export interface LocalStuckEntry {
  action: string;
  kind: string;
  tool: string;
  /** Timestamps of the most recent hits inside the window (at most the threshold). */
  hits: number[];
  lastAt: number;
  deliveredAt?: number;
}
export interface LocalStuckEvidence {
  entries: LocalStuckEntry[];
}

/** Three identical failures inside this window are evidence of being stuck. */
export const STUCK_WINDOW_MS = 120_000;
export const STUCK_THRESHOLD = 3;
/** After a pack, the same cause stays silent for this long (or until the action succeeds). */
export const STUCK_COOLDOWN_MS = 30 * 60_000;
const STUCK_MAX_ENTRIES = 8;
const STUCK_IGNORED_TOOLS = /^(?:updateplan|planupdate|todowrite|task(?:create|update|list|get|output|stop)?|agent|exitplanmode|enterplanmode)$/i;

function normalizedToolName(raw: unknown): string {
  return String(raw ?? "").split(/[.:]/).pop()!.replace(/^.*__/, "").replace(/[_-]/g, "");
}

/**
 * Pure state transition. A pack needs the same action (same tool and normalized
 * input) to fail, time out, or (for searches) return nothing three times within
 * two minutes. Unrelated calls neither add to nor reset the evidence; a success of
 * the same action clears it. Keywords and plain repetition never count.
 */
export function advanceStuckEvidence(
  previous: LocalStuckEvidence | undefined,
  event: CanonicalAutomationEvent,
  now = Date.now()
): { evidence?: LocalStuckEvidence; pack: string | null } {
  if (event.type !== "tool_result") return { evidence: previous, pack: null };
  const payload = event.payload ?? {};
  const toolName = String(payload.tool ?? "");
  const tool = normalizedToolName(toolName);
  const action = typeof payload.action_key === "string" ? payload.action_key : undefined;
  if (!tool || tool === "unknown" || STUCK_IGNORED_TOOLS.test(tool) || !action) {
    return { evidence: previous, pack: null };
  }
  const live = (previous?.entries ?? []).filter(
    (entry) =>
      now >= entry.lastAt &&
      (now - entry.lastAt <= STUCK_WINDOW_MS ||
        (entry.deliveredAt !== undefined && now - entry.deliveredAt < STUCK_COOLDOWN_MS))
  );
  const classification = payload.result_classification;
  const eligible =
    classification === "failure" ||
    classification === "timeout" ||
    (classification === "empty_result" && isSearchLike(toolName, String(payload.command ?? "")));
  if (!eligible) {
    // The action worked (or is not evidence): forget its failures.
    return { evidence: { entries: live.filter((entry) => entry.action !== action) }, pack: null };
  }
  const kind = String(classification);
  const existing = live.find((entry) => entry.action === action && entry.kind === kind);
  const rest = live.filter((entry) => entry !== existing);
  let entry: LocalStuckEntry;
  let pack: string | null = null;
  if (existing && existing.deliveredAt !== undefined) {
    entry = { ...existing, lastAt: now };
  } else {
    const hits = [...(existing?.hits ?? []).filter((hit) => hit <= now && now - hit <= STUCK_WINDOW_MS), now].slice(-STUCK_THRESHOLD);
    entry = { action, kind, tool: toolName.slice(0, 80), hits, lastAt: now };
    if (hits.length >= STUCK_THRESHOLD) {
      entry.deliveredAt = now;
      pack = [
        "SNIPARA_RESCUE_PACK",
        `The same ${entry.tool || "tool"} action ${kind === "empty_result" ? "found nothing" : "failed"} ${STUCK_THRESHOLD} times within two minutes.`,
        "Read the error and change approach before retrying.",
      ].join("\n");
    }
  }
  const entries = [entry, ...rest].sort((a, b) => b.lastAt - a.lastAt).slice(0, STUCK_MAX_ENTRIES);
  return { evidence: { entries }, pack };
}

function readStuckEvidence(raw: string): LocalStuckEvidence | undefined {
  try {
    const parsed = JSON.parse(raw) as LocalStuckEvidence | null;
    if (!parsed || !Array.isArray(parsed.entries)) return undefined;
    const entries = parsed.entries.slice(0, STUCK_MAX_ENTRIES).filter(
      (entry) =>
        entry &&
        typeof entry.action === "string" &&
        typeof entry.kind === "string" &&
        typeof entry.tool === "string" &&
        Array.isArray(entry.hits) &&
        entry.hits.length >= 1 &&
        entry.hits.length <= STUCK_THRESHOLD &&
        entry.hits.every((hit) => Number.isFinite(hit)) &&
        Number.isFinite(entry.lastAt) &&
        (entry.deliveredAt === undefined || Number.isFinite(entry.deliveredAt))
    );
    return { entries };
  } catch {
    return undefined; // missing or malformed local evidence cannot trigger
  }
}

const STUCK_STATE_MAX_AGE_MS = 7 * 24 * 3_600_000;
const STUCK_LOCK_STALE_MS = 10_000;

export function updateLocalStuckGuard(event: CanonicalAutomationEvent, now = Date.now()): string | null {
  const session = event.session_id;
  if (!session || session === "default" || event.type !== "tool_result") return null; // Never combine unrelated sessions.
  const directory = path.join(process.cwd(), ".snipara", "stuck-guard");
  const relative = `.snipara/stuck-guard/${createHash("sha256").update(session).digest("hex")}.json`;
  const file = resolveWorkflowContinuityFile({ cwd: process.cwd(), path: relative });
  fs.mkdirSync(directory, { recursive: true });
  // Skip overlapping hook writers instead of emitting the same cause twice.
  // A lock older than ten seconds belongs to a killed writer and is replaced.
  const lock = `${file}.lock`;
  let lockFd: number | undefined;
  for (let attempt = 0; attempt < 2 && lockFd === undefined; attempt++) {
    try {
      lockFd = fs.openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs <= STUCK_LOCK_STALE_MS) return null;
        fs.unlinkSync(lock);
      } catch {
        return null;
      }
    }
  }
  if (lockFd === undefined) return null;
  try {
    pruneStuckState(directory, now);
    let previous: LocalStuckEvidence | undefined;
    try {
      previous = readStuckEvidence(
        readWorkflowContinuityFile({ cwd: process.cwd(), path: relative, maxBytes: 8192 }).toString("utf8")
      );
    } catch {
      /* first event of the session */
    }
    const next = advanceStuckEvidence(previous, event, now);
    const fd = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
      0o600
    );
    try {
      fs.writeFileSync(fd, JSON.stringify(next.evidence ?? null));
    } finally {
      fs.closeSync(fd);
    }
    return next.pack;
  } finally {
    fs.closeSync(lockFd);
    try {
      fs.unlinkSync(lock);
    } catch {
      /* already replaced */
    }
  }
}

/** Remove evidence files of sessions that ended long ago. */
function pruneStuckState(directory: string, now: number): void {
  try {
    for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith(".json")) continue;
      const full = path.join(directory, name);
      if (now - fs.statSync(full).mtimeMs > STUCK_STATE_MAX_AGE_MS) fs.unlinkSync(full);
    }
  } catch {
    /* best effort */
  }
}
