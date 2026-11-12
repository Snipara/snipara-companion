/**
 * Short end-of-phase memories with source pointers, served-memory tracking and the phase outcome record.
 * Pure local helpers: the hosted calls stay in `api/client.ts`.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface SourcePointer {
  path?: string;
  heading?: string;
  json_pointer?: string;
  commit?: string;
  line_start?: number;
  line_end?: number;
}

export const MAX_SOURCES = 8;
export const BRIEF_SUMMARY_MAX_CHARS = 600;
const MAX_SERVED_PER_PHASE = 50; // the server takes 1 to 50 ids per outcome
const MAX_SERVED_PHASES = 32;
const MAX_PENDING_OUTCOMES = 20;
const MEMORY_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const WORKFLOW_DIR = path.join(".snipara", "workflow");

/** A few lines at most: collapse whitespace and cut at a word boundary. */
export function briefSummary(text: string, max = BRIEF_SUMMARY_MAX_CHARS): string {
  const lines = text.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n");
  if (lines.length <= max) return lines;
  const cut = lines.slice(0, max - 4);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max / 2)).trimEnd()} ...`;
}

export function isValidSource(value: SourcePointer): boolean {
  if (!value.path && !value.commit) return false;
  if (value.path !== undefined && (value.path.length === 0 || value.path.length > 300 || path.isAbsolute(value.path) ||
      value.path.split(/[\\/]/).includes(".."))) return false;
  if (value.heading !== undefined && (value.heading.length === 0 || value.heading.length > 200)) return false;
  if (value.json_pointer !== undefined && (value.json_pointer.length > 200 || !/^(\/[^/]*)*$/.test(value.json_pointer))) return false;
  if (value.commit !== undefined && !/^[0-9a-fA-F]{7,64}$/.test(value.commit)) return false;
  return true;
}

/** Drop malformed pointers and duplicates; keep at most MAX_SOURCES. */
export function sanitizeSources(values: SourcePointer[] | undefined): SourcePointer[] {
  const seen = new Set<string>();
  const out: SourcePointer[] = [];
  for (const value of values ?? []) {
    if (!isValidSource(value)) continue;
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length === MAX_SOURCES) break;
  }
  return out;
}

/** Index of the pointer a server validation error names (`sources[2]`, `sources.2`, `sources/2`), or none. */
export function rejectedSourceIndexes(message: string, count: number): number[] {
  const found = [...message.matchAll(/sources?\W{1,3}(\d+)/gi)].map((match) => Number(match[1]));
  return [...new Set(found)].filter((index) => index < count);
}

export function isSourcesValidationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bsources?\b/i.test(message) && /(invalid|validation|malformed|pointer|must|required|too long|max)/i.test(message);
}

/** `path` or `path#heading` (repeatable CLI value) to a pointer. */
export function parseDocSource(value: string): SourcePointer {
  const index = value.indexOf("#");
  const file = (index < 0 ? value : value.slice(0, index)).trim();
  const heading = index < 0 ? "" : value.slice(index + 1).trim();
  return { path: file, ...(heading ? { heading } : {}) };
}

function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; }
}

function relativeInside(cwd: string, file: string | undefined): string | undefined {
  if (!file) return undefined;
  const relative = path.relative(cwd, path.resolve(cwd, file)).split(path.sep).join("/");
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : undefined;
}

export function recentCommits(cwd: string, sinceIso: string | undefined, max: number): string[] {
  try {
    const args = ["log", "--format=%H", "-n", String(max), ...(sinceIso ? [`--since=${sinceIso}`] : [])];
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 })
      .split("\n").map((line) => line.trim()).filter((line) => /^[0-9a-f]{40,64}$/.test(line));
  } catch { return []; }
}

/** Pointers to where the detail lives: plan phase, workflow state, handoff, docs, then commits (max 8). */
export function collectSources(options: {
  cwd: string;
  planFile?: string;
  phaseId?: string;
  phaseIndex?: number;
  docs?: SourcePointer[];
  since?: string;
  commitLimit?: number;
}): SourcePointer[] {
  const out: SourcePointer[] = [];
  const plan = relativeInside(options.cwd, options.planFile);
  if (plan) {
    let pointer: string | undefined;
    const parsed = readJson(path.resolve(options.cwd, plan)) as Record<string, unknown> | undefined;
    for (const key of ["phases", "steps"]) {
      const list = parsed?.[key];
      if (!Array.isArray(list) || options.phaseId === undefined) continue;
      const found = list.findIndex((item) => item && typeof item === "object" && (item as { id?: unknown }).id === options.phaseId);
      if (found >= 0) { pointer = `/${key}/${found}`; break; }
    }
    out.push({ path: plan, ...(pointer ? { json_pointer: pointer } : {}) });
  }
  const state = path.join(WORKFLOW_DIR, "current.json").split(path.sep).join("/");
  if (fs.existsSync(path.join(options.cwd, state))) {
    out.push({ path: state, ...(options.phaseIndex !== undefined && options.phaseIndex >= 0 ? { json_pointer: `/phases/${options.phaseIndex}` } : {}) });
  }
  const handoff = ".snipara/orchestrator/handoff.json";
  if (fs.existsSync(path.join(options.cwd, handoff))) out.push({ path: handoff });
  out.push(...(options.docs ?? []));
  for (const sha of recentCommits(options.cwd, options.since, options.commitLimit ?? 3)) out.push({ commit: sha });
  return sanitizeSources(out);
}

// ---- served memory ids (ids only, never text) ----------------------------------------------------------------

interface ServedFile { version: 1; workflowId: string; phases: Record<string, string[]> }

function workflowRoot(cwd: string): { workflowId: string; phaseId: string } | undefined {
  const state = readJson(path.join(cwd, WORKFLOW_DIR, "current.json")) as { workflowId?: unknown; currentPhaseId?: unknown } | undefined;
  return typeof state?.workflowId === "string"
    ? { workflowId: state.workflowId, phaseId: typeof state.currentPhaseId === "string" ? state.currentPhaseId : "_" }
    : undefined;
}

function writeAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function readServedIds(cwd: string, workflowId: string, phaseId: string): string[] {
  const data = readJson(path.join(cwd, WORKFLOW_DIR, "served-memories.json")) as ServedFile | undefined;
  return data?.version === 1 && data.workflowId === workflowId ? (data.phases?.[phaseId] ?? []).filter((id) => MEMORY_ID.test(id)) : [];
}

/** Record served ids for the active workflow phase. Silent: tracking must never break a command. */
export function recordServedMemoryIds(ids: Iterable<unknown>, cwd = process.cwd()): void {
  try {
    if (process.env.SNIPARA_LOCAL_ONLY === "1") return;
    const active = workflowRoot(cwd);
    if (!active) return;
    const fresh = [...new Set([...ids].filter((id): id is string => typeof id === "string" && MEMORY_ID.test(id)))];
    if (fresh.length === 0) return;
    const file = path.join(cwd, WORKFLOW_DIR, "served-memories.json");
    const current = readJson(file) as ServedFile | undefined;
    const data: ServedFile = current?.version === 1 && current.workflowId === active.workflowId
      ? current : { version: 1, workflowId: active.workflowId, phases: {} };
    const merged = [...new Set([...(data.phases[active.phaseId] ?? []), ...fresh])].slice(-MAX_SERVED_PER_PHASE);
    data.phases[active.phaseId] = merged;
    const keys = Object.keys(data.phases);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SERVED_PHASES))) delete data.phases[key];
    writeAtomic(file, data);
  } catch { /* best effort */ }
}

export function clearServedIds(cwd: string, workflowId: string, phaseId: string): void {
  try {
    const file = path.join(cwd, WORKFLOW_DIR, "served-memories.json");
    const data = readJson(file) as ServedFile | undefined;
    if (data?.version === 1 && data.workflowId === workflowId && data.phases?.[phaseId]) {
      delete data.phases[phaseId];
      writeAtomic(file, data);
    }
  } catch { /* best effort */ }
}

/** Ids from a recall result (`memories[].memory_id`) or a session brief (`entries[].id|memory_id`); both response shapes. */
export function servedIdsFromResult(value: unknown): string[] {
  const out: string[] = [];
  const visit = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const id = record.memory_id ?? record.id;
      if (typeof id === "string") out.push(id);
    }
  };
  const record = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  visit(record.memories);
  for (const tier of [record.critical, record.daily]) {
    if (tier && typeof tier === "object") visit((tier as Record<string, unknown>).memories);
  }
  return out;
}

// ---- verified Sandbox receipts and phase outcome -------------------------------------------------------------

/** Wire shape of `snipara_memory_outcome` in its phase form (MEMORY_OUTCOME_CONTRACT.md); `phase_id` is the idempotency key. */
export interface PhaseOutcomePayload {
  phase_id: string;
  result: PhaseOutcomeResult;
  memory_ids: string[];
  receipt_ref?: string;
  verdicts?: Record<string, "helped" | "misled">;
  session_id?: string;
}
export type PhaseOutcomeResult = "succeeded_verified" | "succeeded_unverified" | "failed" | "abandoned";

export function recordVerifiedReceipt(runId: string, scope: string | undefined, cwd = process.cwd()): void {
  try {
    const file = path.join(cwd, WORKFLOW_DIR, "validation-receipts.json");
    const list = ((readJson(file) as { receipts?: unknown[] } | undefined)?.receipts ?? []) as Array<{ runId: string; verifiedAt: string; scope?: string }>;
    const next = [...list.filter((item) => item.runId !== runId), { runId, verifiedAt: new Date().toISOString(), ...(scope ? { scope } : {}) }];
    writeAtomic(file, { version: 1, receipts: next.slice(-MAX_PENDING_OUTCOMES) });
  } catch { /* best effort */ }
}

/** A verified Sandbox run recorded at or after the phase started. */
export function verifiedReceiptSince(cwd: string, since: string | undefined): string | undefined {
  const list = ((readJson(path.join(cwd, WORKFLOW_DIR, "validation-receipts.json")) as { receipts?: unknown[] } | undefined)?.receipts ?? []) as Array<{ runId: string; verifiedAt: string }>;
  const floor = since ? Date.parse(since) : 0;
  return [...list].reverse().find((item) => typeof item.runId === "string" && Date.parse(item.verifiedAt) >= floor)?.runId;
}

export function phaseOutcomeResult(outcome: string, receipt: string | undefined): PhaseOutcomeResult {
  if (outcome === "completed") return receipt ? "succeeded_verified" : "succeeded_unverified";
  return outcome === "abandoned" ? "abandoned" : "failed";
}

export function validMemoryIds(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((id) => MEMORY_ID.test(id)))].slice(0, MAX_SERVED_PER_PHASE);
}

const pendingFile = (cwd: string) => path.join(cwd, WORKFLOW_DIR, "outcome-pending.json");

export function readPendingOutcomes(cwd: string): PhaseOutcomePayload[] {
  const list = (readJson(pendingFile(cwd)) as { pending?: unknown[] } | undefined)?.pending;
  return Array.isArray(list) ? (list as PhaseOutcomePayload[]).filter((item) => item && typeof item.phase_id === "string") : [];
}

export function writePendingOutcomes(cwd: string, pending: PhaseOutcomePayload[]): void {
  try {
    if (pending.length === 0) { fs.rmSync(pendingFile(cwd), { force: true }); return; }
    writeAtomic(pendingFile(cwd), { version: 1, pending: pending.slice(-MAX_PENDING_OUTCOMES) });
  } catch { /* best effort */ }
}

/**
 * Send queued outcomes then this one. Never throws; a failed send stays queued for the next commit.
 * `send` is the single wire adapter (RLMClient.recordPhaseOutcome).
 */
export async function flushPhaseOutcomes(
  cwd: string,
  current: PhaseOutcomePayload | undefined,
  send: (payload: PhaseOutcomePayload) => Promise<unknown>
): Promise<{ sent: number; queued: number }> {
  const queue = [...readPendingOutcomes(cwd).filter((item) => item.phase_id !== current?.phase_id), ...(current ? [current] : [])];
  const remaining: PhaseOutcomePayload[] = [];
  let sent = 0;
  let failed = false;
  for (const payload of queue) {
    if (failed) { remaining.push(payload); continue; }
    try { await send(payload); sent += 1; } catch { failed = true; remaining.push(payload); }
  }
  writePendingOutcomes(cwd, remaining);
  return { sent, queued: remaining.length };
}
