/** Local, read-only Codex accounting. This never dispatches or stops model work. */
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { open, opendir, lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type Data = Record<string, unknown>;
const object = (value: unknown): Data => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): number | undefined => typeof value === "string" && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined;
export type EfficiencyProfile = "lite" | "standard" | "full";
export interface EfficiencyThresholds {
  maxResponses: number; maxUncachedInputTokens: number; maxOutputTokens: number; maxElapsedMinutes: number;
}
export interface WorkflowEfficiencyOptions extends Partial<EfficiencyThresholds> {
  cwd?: string; sessionsDir?: string; rootThreadId?: string; since?: string;
  profile?: EfficiencyProfile; enforce?: boolean; json?: boolean;
}
export const WORKFLOW_EFFICIENCY_PROFILES: Record<EfficiencyProfile, EfficiencyThresholds> = {
  lite: { maxResponses: 40, maxUncachedInputTokens: 100000, maxOutputTokens: 30000, maxElapsedMinutes: 30 },
  standard: { maxResponses: 150, maxUncachedInputTokens: 500000, maxOutputTokens: 150000, maxElapsedMinutes: 120 },
  full: { maxResponses: 400, maxUncachedInputTokens: 2000000, maxOutputTokens: 400000, maxElapsedMinutes: 360 },
};
const LIMITS = { entries: 20000, files: 4000, depth: 8, headerBytes: 65536,
  discoveryBytes: 32 * 1024 * 1024, fileBytes: 128 * 1024 * 1024, totalBytes: 512 * 1024 * 1024, lineBytes: 1024 * 1024 };
interface Usage {
  inputTokens: number; cachedInputTokens: number; uncachedInputTokens: number;
  outputTokens: number; reasoningOutputTokens: number; cacheWriteInputTokens: number;
}
export interface WorkflowEfficiencyReport {
  version: "snipara.workflow.efficiency.v1";
  status: "within_advisory_limits" | "limits_exceeded" | "incomplete" | "unavailable";
  scope: { provider: "codex-local-session-tree"; since: string | null; sinceSource: string; observedAt: string;
    sessions: number; externalProviders: "excluded" };
  coverage: { status: "complete" | "partial" | "unavailable"; gaps: Record<string, number>; discoveredFiles: number;
    measuredFiles: number; duplicateResponses: number; conflictingResponses: number };
  totals: Usage & { responses: number; elapsedMinutes: number | null };
  profile: EfficiencyProfile; thresholds: EfficiencyThresholds;
  exceeded: (keyof EfficiencyThresholds)[];
  mode: "advisory" | "enforce-check";
  caveats: string[];
}
interface Session { file: string; id: string; parent?: string; time?: number; size: number; dev: number; ino: number; headerHash: string }
const hashHeader = (header: string) => createHash("sha256").update(header).digest("hex");

async function contained(file: string, root: string): Promise<void> {
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("outside_scope");
  let current = root;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe_ancestor");
  }
  if (await realpath(file) !== file) throw new Error("unsafe_path");
}

async function safeOpen(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  if (!(await handle.stat()).isFile()) { await handle.close(); throw new Error("not_regular"); }
  return handle;
}
async function readHeader(handle: Awaited<ReturnType<typeof open>>, limit: number): Promise<{ text: string; bytes: number; newline: boolean }> {
  const parts: Buffer[] = [];
  let bytes = 0;
  while (bytes < limit) {
    const buffer = Buffer.alloc(Math.min(2048, limit - bytes));
    const read = await handle.read(buffer, 0, buffer.length, bytes);
    if (!read.bytesRead) break;
    bytes += read.bytesRead;
    const end = buffer.subarray(0, read.bytesRead).indexOf(10);
    parts.push(buffer.subarray(0, end < 0 ? read.bytesRead : end));
    if (end >= 0) return { text: Buffer.concat(parts).toString("utf8"), bytes, newline: true };
  }
  return { text: Buffer.concat(parts).toString("utf8"), bytes, newline: false };
}
function usage(value: unknown): Usage | undefined {
  const raw = object(value);
  const { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning } = raw;
  const cacheWrite = raw.cache_write_input_tokens ?? 0;
  if (![input, cached, output, reasoning, cacheWrite].every(integer)) return undefined;
  const i = input as number, c = cached as number, o = output as number, r = reasoning as number, w = cacheWrite as number;
  if (c > i || r > o || w > i || !Number.isSafeInteger(i + o) ||
    (raw.total_tokens !== undefined && raw.total_tokens !== i + o)) return undefined;
  return { inputTokens: i, cachedInputTokens: c, uncachedInputTokens: i - c,
    outputTokens: o, reasoningOutputTokens: r, cacheWriteInputTokens: w };
}

export async function measureWorkflowEfficiency(options: WorkflowEfficiencyOptions = {}): Promise<WorkflowEfficiencyReport> {
  const profile = options.profile ?? "standard";
  if (!Object.hasOwn(WORKFLOW_EFFICIENCY_PROFILES, profile)) throw new Error("Efficiency profile must be lite, standard or full");
  const thresholds = { ...WORKFLOW_EFFICIENCY_PROFILES[profile] };
  for (const key of Object.keys(thresholds) as (keyof EfficiencyThresholds)[]) {
    const value = options[key];
    if (value !== undefined) {
      if (!Number.isFinite(value) || value < 0 || (key !== "maxElapsedMinutes" && !Number.isSafeInteger(value)))
        throw new Error(`Invalid efficiency threshold: ${key}`);
      thresholds[key] = value;
    }
  }
  const now = Date.now(), gaps: Record<string, number> = {};
  const gap = (code: string) => { gaps[code] = (gaps[code] ?? 0) + 1; };
  let since = timestamp(options.since), sinceSource = options.since === undefined ? "unavailable" : "explicit";
  if (options.since !== undefined && since === undefined) throw new Error("Efficiency since must be an ISO timestamp with timezone");
  const rootId = options.rootThreadId ?? process.env.CODEX_THREAD_ID;
  if (!rootId) gap("root_thread_id_missing");
  let directory = path.resolve(options.sessionsDir ?? path.join(os.homedir(), ".codex", "sessions"));
  try {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error("unsafe_root");
    directory = await realpath(directory);
  } catch { gap("sessions_directory_unavailable"); }
  const sessions: Session[] = [];
  let entries = 0, discoveredFiles = 0, discoveryBytes = 0, discoveryStopped = false;
  async function discover(dir: string, depth: number): Promise<void> {
    if (discoveryStopped) return;
    let listing;
    try {
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) { gap("discovery_directory_unsupported"); return; }
      listing = await opendir(dir);
      for await (const entry of listing) {
        if (++entries > LIMITS.entries) { gap("discovery_entry_limit"); discoveryStopped = true; break; }
        const file = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) { gap("symlink_skipped"); continue; }
        if (entry.isDirectory()) {
          if (depth >= LIMITS.depth) gap("discovery_depth_limit"); else await discover(file, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          if (++discoveredFiles > LIMITS.files || discoveryBytes >= LIMITS.discoveryBytes) {
            gap("discovery_budget_limit"); discoveryStopped = true; break;
          }
          try {
            await contained(file, directory);
            const handle = await safeOpen(file);
            try {
              const stat = await handle.stat(), size = stat.size;
              const bytes = Math.min(size, LIMITS.headerBytes, LIMITS.discoveryBytes - discoveryBytes);
              const header = await readHeader(handle, bytes);
              discoveryBytes += header.bytes;
              if (!header.newline && size > header.bytes) { gap("metadata_header_truncated"); continue; }
              const record = object(JSON.parse(header.text));
              const meta = object(record.payload), spawn = object(object(object(meta.source).subagent).thread_spawn);
              if (record.type !== "session_meta" || typeof meta.id !== "string" || !meta.id) { gap("metadata_unknown"); continue; }
              if (object(meta.source).subagent !== undefined && typeof spawn.parent_thread_id !== "string") gap("metadata_parent_unknown");
              sessions.push({ file, id: meta.id, parent: typeof spawn.parent_thread_id === "string" ? spawn.parent_thread_id : undefined,
                time: timestamp(meta.timestamp) ?? timestamp(record.timestamp), size, dev: stat.dev, ino: stat.ino,
                headerHash: hashHeader(header.text) });
            } finally { await handle.close(); }
          } catch { gap("metadata_unreadable"); }
        }
        if (discoveryStopped) break;
      }
    } catch { gap("discovery_unavailable"); }
  }
  if (rootId) await discover(directory, 0);
  const roots = sessions.filter(session => session.id === rootId);
  if (rootId && !roots.length) gap("root_session_missing");
  const selectedIds = new Set(rootId ? [rootId] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const session of sessions) if (session.parent && selectedIds.has(session.parent) && !selectedIds.has(session.id)) {
      selectedIds.add(session.id); changed = true;
    }
  }
  const selected = sessions.filter(session => selectedIds.has(session.id));
  for (const id of new Set(selected.map(session => session.id))) {
    if (new Set(selected.filter(session => session.id === id).map(session => session.parent)).size > 1) gap("session_parent_conflict");
  }
  if (since === undefined) {
    try {
      const handle = await safeOpen(path.join(options.cwd ?? process.cwd(), ".snipara", "workflow", "current.json"));
      try {
        const stat = await handle.stat();
        if (stat.size > LIMITS.lineBytes) gap("workflow_scope_oversized");
        else {
          const buffer = Buffer.alloc(stat.size);
          let bytes = 0;
          while (bytes < buffer.length) {
            const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
            if (!read.bytesRead) break;
            bytes += read.bytesRead;
          }
          const after = await handle.stat();
          if (bytes !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.dev !== stat.dev || after.ino !== stat.ino)
            gap("workflow_scope_changed");
          else {
            const workflow = object(JSON.parse(buffer.toString("utf8")));
            since = timestamp(workflow.createdAt);
            if (since !== undefined) sinceSource = "current-workflow-createdAt";
            else gap("workflow_scope_invalid");
          }
        }
      } finally { await handle.close(); }
    } catch (error) {
      if (object(error).code !== "ENOENT") gap("workflow_scope_unreadable");
    }
    if (since === undefined) {
      since = roots.map(session => session.time).filter((value): value is number => value !== undefined).sort((a, b) => a - b)[0];
      if (since !== undefined) sinceSource = "root-session-start";
    }
  }
  if (since === undefined) gap("since_scope_missing");
  if (since !== undefined && since > now) gap("since_scope_in_future");
  const responses = new Map<string, Usage>(), conflicted = new Set<string>(), supportedSessions = new Set<string>();
  let duplicateResponses = 0, measuredFiles = 0, bodyBytes = 0;
  for (const session of selected) {
    let previousTime: number | undefined;
    const parseLine = (line: string, trailing = false) => {
      if (!line.trim()) return;
      let record: Data;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) { gap("record_unknown"); return; }
        record = object(parsed);
      } catch { gap(trailing ? "trailing_partial_record" : "malformed_record"); return; }
      if (record.type !== "session_meta" && record.timestamp !== undefined) previousTime = timestamp(record.timestamp);
      if (record.type !== "token_usage_record") return;
      const payload = object(record.payload), amount = usage(payload.usage);
      if (!amount || typeof payload.response_id !== "string" || !payload.response_id ||
        payload.thread_id !== session.id) { gap("usage_record_unknown"); return; }
      supportedSessions.add(session.id);
      if (previousTime === undefined || since === undefined) { gap("usage_timestamp_unavailable"); return; }
      if (previousTime < since) return;
      if (previousTime > now) { gap("usage_timestamp_in_future"); return; }
      const id = payload.response_id, previous = responses.get(id);
      if (previous) {
        duplicateResponses++;
        if (JSON.stringify(previous) !== JSON.stringify(amount) && !conflicted.has(id)) {
          conflicted.add(id); gap("conflicting_duplicate_usage");
        }
      } else responses.set(id, amount);
    };
    try {
      await contained(session.file, directory);
      const handle = await safeOpen(session.file);
      try {
        const stat = await handle.stat();
        if (stat.dev !== session.dev || stat.ino !== session.ino || stat.size < session.size) { gap("session_identity_changed"); continue; }
        const header = await readHeader(handle, Math.min(session.size, LIMITS.headerBytes));
        if (hashHeader(header.text) !== session.headerHash) { gap("session_metadata_changed"); continue; }
        await contained(session.file, directory);
        const size = session.size;
        const limit = Math.min(size, LIMITS.fileBytes, Math.max(0, LIMITS.totalBytes - bodyBytes));
        if (size > limit) gap("session_bytes_truncated");
        if (!limit) continue;
        measuredFiles++;
        const stream = handle.createReadStream({ start: 0, end: limit - 1, autoClose: false, encoding: "utf8", highWaterMark: 65536 });
        let pending = "", dropping = false;
        for await (const chunk of stream) {
          const value = String(chunk); bodyBytes += Buffer.byteLength(value);
          const parts = value.split("\n");
          for (let index = 0; index < parts.length; index++) {
            const part = parts[index];
            if (!dropping) pending += part;
            if (Buffer.byteLength(pending) > LIMITS.lineBytes) { gap("record_bytes_truncated"); pending = ""; dropping = true; }
            if (index < parts.length - 1) {
              if (!dropping) parseLine(pending);
              pending = ""; dropping = false;
            }
          }
        }
        if (pending && !dropping) parseLine(pending, true);
        const after = await handle.stat();
        if (after.size < session.size || (after.size === stat.size && after.mtimeMs !== stat.mtimeMs)) gap("session_changed_during_read");
      } finally { await handle.close(); }
    } catch { gap("session_unreadable"); }
  }
  for (const id of new Set(selected.map(session => session.id))) if (!supportedSessions.has(id)) gap("authoritative_usage_unavailable");
  const totals: WorkflowEfficiencyReport["totals"] = { responses: responses.size,
    inputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
    cacheWriteInputTokens: 0, elapsedMinutes: since === undefined ? null : Math.max(0, (now - since) / 60000) };
  for (const amount of responses.values()) for (const key of Object.keys(amount) as (keyof Usage)[]) {
    if (!Number.isSafeInteger(totals[key] + amount[key])) gap("aggregate_overflow");
    else totals[key] += amount[key];
  }
  const values: EfficiencyThresholds = { maxResponses: totals.responses, maxUncachedInputTokens: totals.uncachedInputTokens,
    maxOutputTokens: totals.outputTokens, maxElapsedMinutes: totals.elapsedMinutes ?? 0 };
  const exceeded = (Object.keys(thresholds) as (keyof EfficiencyThresholds)[]).filter(key => values[key] > thresholds[key]);
  const coverage = !selected.length || !supportedSessions.size ? "unavailable" : Object.keys(gaps).length ? "partial" : "complete";
  return {
    version: "snipara.workflow.efficiency.v1",
    status: coverage === "unavailable" ? "unavailable" : coverage === "partial" ? "incomplete" : exceeded.length ? "limits_exceeded" : "within_advisory_limits",
    scope: { provider: "codex-local-session-tree", since: since === undefined ? null : new Date(since).toISOString(), sinceSource,
      observedAt: new Date(now).toISOString(), sessions: new Set(selected.map(session => session.id)).size, externalProviders: "excluded" },
    coverage: { status: coverage, gaps, discoveredFiles, measuredFiles, duplicateResponses, conflictingResponses: conflicted.size },
    totals, profile, thresholds, exceeded, mode: options.enforce ? "enforce-check" : "advisory",
    caveats: ["Coverage is limited to the discovered local Codex root session and linked descendants; external provider runs are excluded.",
      "Cached input is part of input; reasoning output is part of output. No monetary cost is inferred.",
      "Elapsed minutes are wall time since the scope boundary, including idle time, not active CPU or model time.",
      "Profiles are advisory. Enforce only fails this check; it does not stop Codex, providers or change Controller budgets.",
      "Local logs are a point-in-time observation; undiscovered, unflushed or future usage is not measured."] };
}

export function renderWorkflowEfficiency(report: WorkflowEfficiencyReport, json = false): string {
  if (json) return JSON.stringify(report, null, 2);
  const t = report.totals;
  return [`Workflow efficiency: ${report.status} (${report.mode})`,
    `Coverage: ${report.coverage.status}; ${report.scope.sessions} local Codex sessions; external providers excluded`,
    `Scope: ${report.scope.since ?? "unavailable"} (${report.scope.sinceSource})`,
    `Responses: ${t.responses}; input: ${t.inputTokens} (${t.cachedInputTokens} cached, ${t.uncachedInputTokens} uncached); output: ${t.outputTokens} (${t.reasoningOutputTokens} reasoning subset)`,
    `Wall time: ${t.elapsedMinutes === null ? "unavailable" : t.elapsedMinutes.toFixed(1)} minutes (includes idle time)`,
    `Thresholds exceeded: ${report.exceeded.join(", ") || "none"}; coverage gaps: ${Object.keys(report.coverage.gaps).join(", ") || "none"}`,
    "Advisory accounting; no cost estimate, provider stop or Controller budget change."].join("\n");
}

export async function workflowEfficiencyCommand(options: WorkflowEfficiencyOptions = {}): Promise<{ report: WorkflowEfficiencyReport; exitCode: number }> {
  const report = await measureWorkflowEfficiency(options);
  return { report, exitCode: options.enforce && (report.coverage.status !== "complete" || report.exceeded.length > 0) ? 1 : 0 };
}
