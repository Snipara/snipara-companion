/** Local continuation snapshots: projections of receipts, never execution or new authority. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { packContext } from "./context-pack";
import { checkpointText } from "../session/checkpoint";
import { readTaskRepositoryInventory, TaskIntakeError } from "./task-intake";

type Data = Record<string, unknown>;
const MAX_BYTES = 500_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 256;
// Repository diagnostics are also carried into combined checkpoint summaries.
const MAX_REPOSITORY_ERRORS = 32;
const SHA = /^[a-f0-9]{64}$/;
const PACK = /^cpack_[a-f0-9]{16}$/;
const record = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const text = (value: unknown, limit = 4000): string => typeof value === "string" ? checkpointText(value, limit) : "";
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const strings = (value: unknown): string[] => list(value).filter((item): item is string => typeof item === "string");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
const hash = (value: unknown): string => digest(JSON.stringify(canonical(value)));
function safe(value: unknown, depth = 0): unknown {
  if (depth > 12) throw new Error("Continuity structure exceeds its depth limit");
  // Machine identities include significant whitespace (for example Git " M").
  if (typeof value === "string") return checkpointText(value, 4000, false);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    if (value.length > MAX_ENTRIES) throw new Error("Continuity list exceeds its entry limit");
    return value.map((item) => safe(item, depth + 1));
  }
  if (!record(value)) return null;
  if (Object.keys(value).length > MAX_ENTRIES) throw new Error("Continuity object exceeds its entry limit");
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /password|secret|authorization|bearer|api.?key|raw.?logs?|stdout|stderr|transcript/i.test(key)
      ? "[REDACTED]" : safe(item, depth + 1)]));
}

export interface WorkflowContinuityRef {
  version: "snipara.workflow.continuity-ref.v1";
  packId: string;
  sha256: string;
  capturedAt: string;
  workflowId: string;
}
export interface WorkflowContinuityTask {
  id: string; title?: string; query?: string; status?: string; attempt?: number;
  maxAttempts?: number; acceptance?: string; files?: string[]; verification?: string[];
  evidence?: string[]; summary?: string; lastError?: string; outcome?: string;
  attemptHistory?: unknown[]; contextReceipt?: unknown; contextRequest?: unknown;
  artifacts?: string[]; dependsOn?: string[];
}
export interface WorkflowAttemptHistoryRecord {
  attempt: number; capturedAt: string; status: string; summary?: string; outcome?: string;
  lastError?: string; evidence?: string[]; decision?: string; why?: string;
  alternatives?: string[]; constraints?: string[]; observedOutcome?: string; files?: string[];
  contextReceipt?: unknown; recoveryReason?: string;
}
export interface WorkflowContinuityState {
  workflowId: string; goal: string; status: string; currentPhaseId?: string;
  phases: Array<{ id: string; title: string; status: string; query?: string;
    acceptance?: string; files?: string[]; gates?: string[]; tasks?: WorkflowContinuityTask[];
    dependsOn?: string[]; summary?: string; outcome?: string; commitHistory?: unknown[] }>;
  phaseCommitReceipts?: unknown; runtime?: unknown; continuity?: WorkflowContinuityRef;
}
export interface WorkflowContinuityRepository {
  root: string; head: string | null; tree: string | null; branch: string | null;
  roots: string[]; indexHash: string | null;
  dirty: Array<{ path: string; status: string; fingerprint: string }>;
  errors: string[];
}
export interface WorkflowContinuityArtifact {
  path: string; sha256: string | null; kind: string; required: boolean;
  status: "observed" | "missing" | "unavailable"; expiresAt?: string | null;
}
export interface WorkflowContinuityNextAction {
  argv: string[];
  expectedResult: string;
  dispatchesWork: false;
}
export interface WorkflowContinuityCheckpoint {
  version: "snipara.workflow.continuity.v1"; workflowId: string; capturedAt: string;
  stateHash: string; contractHash: string; goal: string; status: string;
  repository: WorkflowContinuityRepository; baselineRepository: WorkflowContinuityRepository;
  taskChanges: string[]; preexistingChanges: string[];
  phases: unknown[]; attempts: Data[]; historyCompleteness: "complete" | "incomplete";
  decisions: Data[]; artifacts: WorkflowContinuityArtifact[]; evidence: Data[];
  decisionSourcesHash: string;
  sourceObservation?: { exhaustive: false; scopes: Data[] };
  remaining: Data[]; missingChecks: Data[]; blockers: string[]; unverified: string[];
  budget: unknown;
  nextAction: WorkflowContinuityNextAction;
  runtime: unknown; runtimeBoundary: string[];
  repair?: {
    predecessor: WorkflowContinuityRef; reason: string; previousStatus: WorkflowContinuityResume["status"];
    carriedForward: string[]; proofRefreshed: false;
  };
}
export interface WorkflowContinuityDiagnostic {
  code: string; path?: string; message: string; action: string; required: boolean;
}
export interface WorkflowContinuityResume {
  version: "snipara.workflow.continuity-resume.v1";
  status: "exact_snapshot" | "drift_revalidation_required" | "blocked";
  checkpoint: WorkflowContinuityCheckpoint | null; currentRepository: WorkflowContinuityRepository;
  relocated: boolean; changes: string[]; reasons: string[];
  artifactChecks: Array<{ path: string; status: string; code?: string; reason?: string }>;
  diagnostics: WorkflowContinuityDiagnostic[];
  currentDecisions: Data[];
  nextAction: WorkflowContinuityNextAction;
  coordination: { historical: true; refreshed: false };
  runtimeBoundary: string[];
}
class ContinuityArtifactError extends Error {
  constructor(readonly code: string, readonly artifactPath: string, message: string) { super(message); }
}
function diagnostic(error: unknown, artifactPath: string, required = true): WorkflowContinuityDiagnostic {
  const code = error instanceof ContinuityArtifactError ? error.code
    : record(error) && error.code === "ENOENT" ? "artifact_missing"
    : record(error) && ["EACCES", "EPERM"].includes(String(error.code)) ? "artifact_permission_denied"
    : "artifact_unreadable";
  const file = text(error instanceof ContinuityArtifactError ? error.artifactPath : artifactPath, 1000);
  const action = code === "artifact_missing" ? "Restore the exact artifact from its original receipt; do not regenerate it as passing proof."
    : code.includes("hash") ? "Restore the recorded bytes or rerun the original verification under its existing proof gates."
    : code.includes("unsafe") ? "Use an in-workspace regular file at the recorded path; symlinks and traversal are refused."
    : code.includes("oversized") ? "Keep the original evidence intact and use a bounded artifact; do not raise limits implicitly."
    : code.includes("schema") || code.includes("manifest") || code.includes("reference") ? "Restore the compatible original checkpoint/manifest; do not replace historical receipts with a new claim."
    : "Check read permissions and file stability, then retry the read without changing historical evidence.";
  return { code, path: file, required, message: `${code}: ${file}`, action };
}
export function diagnoseWorkflowContinuityArtifact(error: unknown, artifactPath: string): WorkflowContinuityDiagnostic {
  return diagnostic(error, artifactPath, false);
}
const RUNTIME_BOUNDARY = [
  "Snapshot files and workflow facts are historical local observations, not proof of functional correctness.",
  "Reading this snapshot does not reattach a runtime, restore a live process, dispatch work, or reset a budget.",
  "Use the existing runtime resume plan to check surviving sessions or explicitly rehydrate compatible state.",
  "Source context remains historical; remote refresh requires a separate receipt.",
];
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
function relative(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || normalized.length > 1000 || path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:/.test(normalized) || normalized.split("/").some((part) => part === ".." || !part) ||
    [...normalized].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    throw new ContinuityArtifactError("artifact_unsafe_path", value, "Unsafe continuity artifact path");
  return normalized.replace(/^\.\//, "");
}
/** Check every ancestor before reading: a local manifest must not redirect to another tree. */
function contained(cwd: string, value: string): string {
  const root = fs.realpathSync(cwd);
  const rel = relative(value);
  let current = root;
  for (const part of rel.split("/")) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new ContinuityArtifactError("artifact_unsafe_path", value, "Symlink continuity artifacts are not accepted"); }
    catch (error) { if (!(record(error) && error.code === "ENOENT")) throw error; }
  }
  if (path.relative(root, current).startsWith(`..${path.sep}`)) throw new Error("Continuity path escaped workspace");
  return current;
}
function readBytes(cwd: string, value: string, limit = MAX_BYTES): Buffer {
  const file = contained(cwd, value);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new ContinuityArtifactError(
      stat.size > limit ? "artifact_oversized" : "artifact_unsupported_type", value, "Continuity artifact is not a bounded regular file");
    contained(cwd, value);
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (bytes <= limit) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - bytes));
      const length = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!length) break;
      chunks.push(chunk.subarray(0, length)); bytes += length;
    }
    if (bytes > limit) throw new ContinuityArtifactError("artifact_oversized", value, "Continuity artifact exceeds its read limit");
    const after = fs.fstatSync(fd);
    if (stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs)
      throw new Error("Continuity artifact changed while being read");
    return Buffer.concat(chunks);
  } finally { fs.closeSync(fd); }
}
/** Bounded local reads shared by optional resume supplements; no engine or install dependency. */
export function readWorkflowContinuityFile(input: { cwd: string; path?: string; relativePath?: string; maxBytes?: number }): Buffer {
  const limit = input.maxBytes ?? MAX_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FILE_BYTES) throw new Error("Invalid local artifact read limit");
  const value = input.path ?? input.relativePath;
  if (typeof value !== "string" || (input.path && input.relativePath && input.path !== input.relativePath))
    throw new Error("Invalid local artifact path");
  return readBytes(input.cwd, value, limit);
}
export function listWorkflowContinuityDirectory(input: { cwd: string; relativePath: string; maxEntries?: number }): string[] {
  const limit = input.maxEntries ?? MAX_ENTRIES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ENTRIES) throw new Error("Invalid local artifact directory limit");
  const file = contained(input.cwd, input.relativePath);
  if (!fs.lstatSync(file).isDirectory()) throw new Error("Local artifact directory is not a directory");
  const handle = fs.opendirSync(file);
  try {
    contained(input.cwd, input.relativePath);
    const result: string[] = [];
    let entry: fs.Dirent | null;
    while ((entry = handle.readSync()) !== null) {
      if (result.length >= limit) throw new Error("Local artifact directory exceeds its entry limit");
      result.push(entry.name);
    }
    return result.sort();
  } finally { handle.closeSync(); }
}

/** Shared admission for the root pointer and its existing local artifacts. */
export function resolveWorkflowContinuityFile(input: { cwd: string; path: string }): string {
  return contained(input.cwd, input.path);
}
function fingerprint(cwd: string, value: string): string {
  try {
    const file = contained(cwd, value);
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return `mode:${stat.mode}`;
    return `file:${stat.mode & 0o777}:${digest(readBytes(cwd, value, MAX_FILE_BYTES))}`;
  } catch (error) {
    if (record(error) && error.code === "ENOENT") return "missing";
    throw error;
  }
}
export function captureWorkflowRepository(cwd = process.cwd()): WorkflowContinuityRepository {
  const root = path.resolve(cwd);
  const result: WorkflowContinuityRepository = { root, head: null, tree: null, branch: null,
    roots: [], indexHash: null, dirty: [], errors: [] };
  try {
    const actualRoot = git(root, ["rev-parse", "--show-toplevel"]).trim();
    if (fs.realpathSync(actualRoot) !== fs.realpathSync(root)) throw new Error("Continuity requires the Git workspace root");
    result.head = git(root, ["rev-parse", "--verify", "HEAD"]).trim();
    result.tree = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
    result.branch = git(root, ["branch", "--show-current"]).trim() || null;
    result.roots = git(root, ["rev-list", "--max-parents=0", "HEAD"]).trim().split(/\s+/).sort();
    result.indexHash = digest(git(root, ["ls-files", "--stage", "-z"]).split("\0")
      .filter((item) => !item.split("\t").slice(1).join("\t").startsWith(".snipara/"))
      .join("\0"));
    const inventory = readTaskRepositoryInventory(root, undefined, [], [".snipara"]);
    const dirty = new Map<string, string>();
    for (const entry of inventory.entries) {
      dirty.set(relative(entry.path), entry.status);
      if (entry.originalPath && !entry.originalPath.startsWith(".snipara/")) dirty.set(relative(entry.originalPath), entry.status);
    }
    if (inventory.incomplete || dirty.size > MAX_ENTRIES) result.errors.push("repository_inventory_incomplete: Only a bounded tracked/scoped inventory was observed; omitted untracked content is not clean. Reduce the unrelated inventory or review an explicit scoped task before relying on repository-wide proof.");
    let omittedFileErrors = 0;
    for (const [file, status] of [...dirty].sort(([a], [b]) => a.localeCompare(b)).slice(0, MAX_ENTRIES)) {
      let observed: string;
      try { observed = fingerprint(root, file); }
      catch (error) {
        const problem = diagnostic(error, file);
        observed = `unavailable:${problem.code}`;
        if (result.errors.length < MAX_REPOSITORY_ERRORS - 1) result.errors.push(
          `repository_file_unobserved: ${problem.code}: ${problem.path ?? text(file, 1000)}; ${problem.message}`);
        else omittedFileErrors++;
      }
      result.dirty.push({ path: file, status, fingerprint: observed });
    }
    if (omittedFileErrors) result.errors.push(
      `repository_file_unobserved: ${omittedFileErrors} additional files could not be fingerprinted; repository-wide proof remains incomplete.`);
  } catch (error) {
    if (error instanceof TaskIntakeError) result.errors.push(`${error.code}: ${error.message}`);
    else if (record(error) && error.code === "ENOBUFS") result.errors.push("repository_output_too_large: Git identity or index observation exceeded its output limit.");
    else if (record(error) && error.code === "ETIMEDOUT") result.errors.push("repository_read_timeout: Git identity or index observation exceeded its ten-second deadline.");
    else result.errors.push("repository_observation_unavailable: Repository identity or bounded file observation unavailable; check the workspace root and read permissions.");
  }
  return result;
}
function projectedState(state: WorkflowContinuityState): unknown {
  const { continuity: _continuity, ...rest } = state;
  return rest;
}
function contract(state: WorkflowContinuityState): unknown {
  return { workflowId: state.workflowId, goal: state.goal, phases: state.phases.map((phase) => ({
    id: phase.id, title: phase.title, query: phase.query, acceptance: phase.acceptance,
    files: phase.files, gates: phase.gates, dependsOn: phase.dependsOn,
    tasks: phase.tasks?.map((task) => ({ id: task.id, title: task.title, query: task.query,
      acceptance: task.acceptance, files: task.files, verification: task.verification,
      maxAttempts: task.maxAttempts, dependsOn: task.dependsOn, contextRequest: task.contextRequest })),
  })) };
}
function readPack(cwd: string, ref: { packId: string; sha256: string }): { content: Buffer; manifest: Data; manifestPath: string; blobPath: string } {
  if (!PACK.test(ref.packId) || !SHA.test(ref.sha256) || ref.packId !== `cpack_${ref.sha256.slice(0, 16)}`)
    throw new ContinuityArtifactError("checkpoint_reference_invalid", ".snipara/workflow/current.json", "Invalid continuity pack identity");
  const manifestPath = `.snipara/context-pack/items/${ref.packId}.json`;
  const packBytes = (file: string): Buffer => {
    try { return readBytes(cwd, file); }
    catch (error) {
      if (error instanceof ContinuityArtifactError) throw error;
      const problem = diagnostic(error, file);
      throw new ContinuityArtifactError(problem.code, file, error instanceof Error ? error.message : problem.message);
    }
  };
  let manifest: unknown;
  try { manifest = JSON.parse(packBytes(manifestPath).toString("utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) throw new ContinuityArtifactError("checkpoint_schema_invalid", manifestPath, "Invalid continuity pack manifest JSON");
    throw error;
  }
  const blobPath = `.snipara/context-pack/blobs/${ref.sha256}.txt`;
  if (!record(manifest) || manifest.version !== "snipara.context_pack.v1" || manifest.id !== ref.packId ||
    manifest.sha256 !== ref.sha256 || !record(manifest.storage) ||
    manifest.storage.manifestRelativePath !== manifestPath || manifest.storage.blobRelativePath !== blobPath)
    throw new ContinuityArtifactError("checkpoint_manifest_invalid", manifestPath, "Continuity pack manifest identity or path differs");
  const content = packBytes(blobPath);
  if (digest(content) !== ref.sha256 || manifest.bytes !== content.length)
    throw new ContinuityArtifactError("checkpoint_hash_mismatch", blobPath, "Continuity pack hash or byte length differs");
  return { content, manifest, manifestPath, blobPath };
}
/** Independent of Orchestrator; validates canonical paths before loading a local pack. */
export function readWorkflowContinuityPack(input: { cwd?: string; packId: string; sha256: string }): { content: string; record: Data } {
  const pack = readPack(path.resolve(input.cwd ?? process.cwd()), input);
  return { content: pack.content.toString("utf8"), record: pack.manifest };
}
function checkpoint(cwd: string, ref: WorkflowContinuityRef, workflowId: string): WorkflowContinuityCheckpoint {
  if (ref.version !== "snipara.workflow.continuity-ref.v1" || ref.workflowId !== workflowId)
    throw new ContinuityArtifactError("checkpoint_reference_invalid", ".snipara/workflow/current.json", "Continuity reference does not belong to workflow");
  let data: unknown;
  try { data = JSON.parse(readPack(cwd, ref).content.toString("utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) throw new ContinuityArtifactError("checkpoint_schema_invalid", `.snipara/context-pack/blobs/${ref.sha256}.txt`, "Invalid continuity checkpoint JSON");
    throw error;
  }
  if (!record(data) || data.version !== "snipara.workflow.continuity.v1" || data.workflowId !== workflowId ||
    data.capturedAt !== ref.capturedAt || !record(data.repository) || !record(data.baselineRepository) ||
    !SHA.test(String(data.stateHash)) || !SHA.test(String(data.contractHash)) ||
    !Array.isArray(data.repository.errors) || !Array.isArray(data.baselineRepository.errors) ||
    !Array.isArray(data.decisions) || !Array.isArray(data.artifacts) || !Array.isArray(data.attempts) || !Array.isArray(data.remaining))
    throw new ContinuityArtifactError("checkpoint_schema_invalid", `.snipara/context-pack/blobs/${ref.sha256}.txt`, "Invalid continuity checkpoint schema");
  return data as unknown as WorkflowContinuityCheckpoint;
}
function artifact(cwd: string, value: string, kind: string, required = true): WorkflowContinuityArtifact {
  const rel = relative(value);
  try { return { path: rel, sha256: digest(readBytes(cwd, rel, MAX_FILE_BYTES)), kind, required, status: "observed" }; }
  catch (error) {
    if (record(error) && error.code === "ENOENT") return { path: rel, sha256: null, kind, required, status: "missing" };
    throw error;
  }
}
function localDecisions(cwd: string, state: WorkflowContinuityState, unverified: string[], artifacts: WorkflowContinuityArtifact[] = []): Data[] {
  const decisions: Data[] = [];
  for (const area of ["pending", "resolved"]) {
    const dir = `.snipara/decisions/${area}`;
    let names: string[];
    try { names = fs.readdirSync(contained(cwd, dir)).filter((name) => name.endsWith(".json")).sort(); }
    catch (error) {
      if (!(record(error) && error.code === "ENOENT")) unverified.push(`Local ${area} decisions unavailable`);
      continue;
    }
    if (names.length > MAX_ENTRIES) { unverified.push(`Local ${area} decisions exceed bounded scan`); continue; }
    for (const name of names) {
      try {
        const value: unknown = JSON.parse(readBytes(cwd, `${dir}/${name}`, 128_000).toString("utf8"));
        if (!record(value)) throw new Error("Invalid local decision");
        const request = area === "resolved" ? value.request : value;
        if (!record(request)) throw new Error("Invalid local request");
        const producer = record(request.producer) ? request.producer : {};
        const evidence = record(request.evidence) ? request.evidence : {};
        const scoped = request.workflowId === state.workflowId || producer.workflowId === state.workflowId ||
          (typeof producer.sourceRef === "string" && producer.sourceRef.split(/[/:#]/).includes(state.workflowId)) ||
          list(evidence.items).some((item) => record(item) && record(item.metadata) && item.metadata.workflowId === state.workflowId);
        if (!scoped) continue;
        const response = record(value.response) ? value.response : {};
        artifacts.push(artifact(cwd, `${dir}/${name}`, "local_decision", false));
        const declaredStatus = request.status ?? request.reviewStatus;
        decisions.push(safe({ id: request.requestId, decision: request.decision,
          rationale: request.rationale, choice: response.choice, note: response.note,
          status: ["invalidated", "superseded", "rejected", "expired"].includes(String(declaredStatus)) ? declaredStatus : area === "pending" ? "pending" : "resolved",
          blocking: request.blocking === true, expiresAt: request.expiresAt,
          validUntil: request.validUntil, staleAt: request.staleAt, invalidatedAt: request.invalidatedAt,
          source: `${dir}/${name}`, authority: "local_operator_declaration",
          identityAuthenticated: false }) as Data);
      } catch { unverified.push(`Local decision unavailable or invalid: ${text(name, 200)}`); }
    }
  }
  return decisions;
}
export function captureWorkflowContinuity(input: {
  cwd?: string; state: WorkflowContinuityState; baseline?: WorkflowContinuityRef;
}): WorkflowContinuityRef {
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const state = input.state;
  const repository = captureWorkflowRepository(cwd);
  const previous = input.baseline ?? state.continuity;
  const baselineRepository = previous ? checkpoint(cwd, previous, state.workflowId).baselineRepository : repository;
  const attempts: Data[] = [], evidence: Data[] = [], remaining: Data[] = [], missingChecks: Data[] = [];
  const artifacts: WorkflowContinuityArtifact[] = [], decisions: Data[] = [], blockers: string[] = [], unverified: string[] = [];
  const sourceScopes: Data[] = [];
  let complete = true;
  // A plan's file scope may denote a directory, the whole repository, or a glob.
  // It is a contract declaration, not permission to traverse or read arbitrary files.
  const observeSourceScope = (scope: string, phaseId: string, taskId?: string): void => {
    const observed = (status: string): void => {
      sourceScopes.push({ phaseId, ...(taskId ? { taskId } : {}), scope: text(scope, 1000), status });
      if (status !== "observed_file") unverified.push(`${phaseId}${taskId ? `/${taskId}` : ""}: source scope ${text(scope, 1000)}: ${status}; scope observation is not exhaustive`);
    };
    const normalized = scope.replace(/\\/g, "/");
    if (!normalized || normalized.length > 1000 || path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) ||
      normalized.split("/").includes("..") || [...normalized].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
      observed("unsafe_scope_not_read"); return;
    }
    if ([...normalized].some((char) => "?*[]{}".includes(char))) { observed("pattern_not_expanded"); return; }
    const rel = normalized.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
    if (!rel || rel === ".") { observed("repository_scope_not_expanded"); return; }
    try {
      const candidate = contained(cwd, rel);
      const stat = fs.lstatSync(candidate);
      if (stat.isDirectory()) { observed("directory_not_expanded"); return; }
      if (!stat.isFile()) { observed("non_file_scope_not_read"); return; }
      const item = artifact(cwd, rel, "task_file", false);
      artifacts.push(item); observed("observed_file");
    } catch { observed("unavailable_or_unsafe_scope_not_read"); }
  };
  const addContext = (receipt: unknown, phaseId: string, taskId: string, expectedAttempt: unknown): void => {
    if (!record(receipt)) return;
    if (receipt.workflowId !== state.workflowId || receipt.phaseId !== phaseId || receipt.taskId !== taskId ||
      !Number.isSafeInteger(receipt.attempt) || Number(receipt.attempt) < 1 ||
      receipt.attempt !== expectedAttempt || !SHA.test(String(receipt.requestHash)))
      throw new Error("Task context receipt does not belong to this continuation task");
    const pack = readPack(cwd, { packId: String(receipt.packId), sha256: String(receipt.sha256) });
    const payload: unknown = JSON.parse(pack.content.toString("utf8"));
    if (!record(payload) || payload.version !== "snipara.workflow.loaded-context.v1" ||
      ["workflowId", "phaseId", "taskId", "attempt", "requestHash"].some((key) => payload[key] !== receipt[key]))
      throw new Error("Task context body identity differs from receipt");
    artifacts.push(artifact(cwd, pack.manifestPath, "task_context_manifest"),
      { ...artifact(cwd, pack.blobPath, "task_context_snapshot"), expiresAt: typeof pack.manifest.expiresAt === "string" ? pack.manifest.expiresAt : null });
    evidence.push(safe({ taskId, attempt: receipt.attempt, receipt, authority: "local_client_observed", semanticUseVerified: false }) as Data);
  };
  for (const phase of state.phases) {
    for (const task of phase.tasks ?? []) {
      const history = task.attemptHistory ?? [];
      const activeAttempt = task.status === "in_progress" ? 1 : 0;
      const attempt = task.attempt ?? 0;
      const maxAttempts = task.maxAttempts ?? 20;
      const validCounter = Number.isSafeInteger(attempt) && attempt >= activeAttempt &&
        attempt <= 20 && Number.isSafeInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 20 && attempt <= maxAttempts;
      const expectedFinished = validCounter ? attempt - activeAttempt : 0;
      const seenAttempts = new Set<number>();
      const historyIssues: string[] = [];
      if (!validCounter) historyIssues.push("invalid or out-of-bounds current attempt counter");
      for (const raw of history) {
        if (!record(raw)) { historyIssues.push("invalid historical attempt record"); continue; }
        const id = raw.attempt;
        const terminal = ["completed", "blocked", "skipped"].includes(String(raw.status));
        const expectedStatus = raw.outcome === "completed" ? "completed"
          : raw.outcome === "abandoned" ? "skipped"
            : ["partial", "blocked"].includes(String(raw.outcome)) ? "blocked" : undefined;
        if (!Number.isSafeInteger(id) || Number(id) < 1 || Number(id) > expectedFinished || !terminal ||
          (raw.outcome !== undefined && expectedStatus !== raw.status)) historyIssues.push(`invalid identity or outcome for attempt ${String(id)}`);
        else if (seenAttempts.has(Number(id))) historyIssues.push(`duplicate historical attempt ${String(id)}`);
        else seenAttempts.add(Number(id));
        const item = safe({ ...raw, workflowId: state.workflowId, phaseId: phase.id, taskId: task.id,
          authority: "caller_declaration", objectiveVerified: false }) as Data;
        attempts.push(item);
        addContext(raw.contextReceipt, phase.id, task.id, raw.attempt);
        if (raw.decision || raw.why) decisions.push(safe({ taskId: task.id, attempt: raw.attempt,
          decision: raw.decision, rationale: raw.why, alternatives: raw.alternatives,
          constraints: raw.constraints, observedOutcome: raw.observedOutcome,
          status: raw.decisionStatus ?? "recorded", source: "task_attempt_receipt",
          authority: "caller_declaration" }) as Data);
      }
      for (let id = 1; id <= expectedFinished; id++) if (!seenAttempts.has(id)) historyIssues.push(`missing historical attempt ${id}`);
      if (historyIssues.length) {
        complete = false;
        unverified.push(...historyIssues.map((issue) => `${phase.id}/${task.id}: ${issue}`));
      }
      if (task.summary && !history.length) attempts.push(safe({ phaseId: phase.id, taskId: task.id,
        attempt: task.attempt, summary: task.summary, lastError: task.lastError, outcome: task.outcome,
        authority: "caller_declaration", historyIncomplete: true }) as Data);
      if (activeAttempt) attempts.push(safe({ phaseId: phase.id, taskId: task.id, attempt: task.attempt,
        status: "in_progress", outcome: "not_recorded_yet", authority: "caller_declaration" }) as Data);
      for (const item of task.evidence ?? []) evidence.push({ taskId: task.id, declaration: text(item),
        authority: "caller_declaration", resultVerified: false });
      if (!["completed", "skipped"].includes(task.status ?? "pending")) remaining.push(safe({
        phaseId: phase.id, taskId: task.id, title: task.title, status: task.status,
        attempt: task.attempt, maxAttempts: task.maxAttempts, acceptance: task.acceptance,
        dependencies: task.dependsOn, lastError: task.lastError,
      }) as Data);
      for (const command of task.verification ?? []) missingChecks.push({ taskId: task.id, command: text(command),
        status: "not_individually_verified", reason: "Task declarations do not establish host-observed command results" });
      if (task.status === "blocked" || task.lastError) blockers.push(`${phase.id}/${task.id}: ${text(task.lastError ?? task.summary ?? "Task blocked")}`);
      addContext(task.contextReceipt, phase.id, task.id, task.attempt);
      for (const file of task.artifacts ?? []) artifacts.push(artifact(cwd, file, "task_artifact"));
      for (const scope of task.files ?? []) observeSourceScope(scope, phase.id, task.id);
    }
    for (const scope of phase.files ?? []) observeSourceScope(scope, phase.id);
    for (const raw of phase.commitHistory ?? []) {
      if (!record(raw)) { complete = false; unverified.push(`${phase.id}: invalid phase commit receipt`); continue; }
      if (raw.decision || raw.why) decisions.push(safe({ phaseId: phase.id, decision: raw.decision,
        rationale: raw.why, alternatives: raw.alternatives, constraints: raw.constraints,
        observedOutcome: raw.observedOutcome, capturedAt: raw.capturedAt,
        status: raw.decisionStatus ?? "recorded", source: "phase_commit_receipt", authority: "caller_declaration" }) as Data);
      for (const declared of strings(raw.evidence)) evidence.push({ phaseId: phase.id, declaration: text(declared),
        authority: "caller_declaration", resultVerified: false });
    }
    if (!(phase.tasks?.length) && !["completed", "skipped"].includes(phase.status)) remaining.push({ phaseId: phase.id,
      title: text(phase.title), status: phase.status, acceptance: text(phase.acceptance) });
  }
  for (const raw of list(state.phaseCommitReceipts)) {
    if (!record(raw) || !record(raw.whyCapture)) continue;
    for (const candidate of list(raw.whyCapture.previewCandidates)) if (record(candidate) && (candidate.decision || candidate.rationale))
      decisions.push(safe({ ...candidate, phaseId: raw.phaseId, source: "phase_why_capture",
        status: "pending_review", authority: "unreviewed_candidate" }) as Data);
  }
  const scopedLocalDecisions = localDecisions(cwd, state, unverified, artifacts);
  decisions.push(...scopedLocalDecisions);
  const runtime = record(state.runtime) ? state.runtime : {};
  const sandbox = record(runtime.sandbox) ? runtime.sandbox : {};
  for (const binding of list(sandbox.bindings)) if (record(binding) && record(binding.lastCheckpoint)) {
    for (const file of strings(binding.lastCheckpoint.artifacts)) artifacts.push(artifact(cwd, file, "runtime_artifact"));
  }
  if (!complete) unverified.push("Earlier task attempts were not fully recorded locally; legacy history is incomplete");
  if (repository.errors.length) unverified.push(...repository.errors);
  unverified.push("No raw conversation, hidden reasoning, live-process state or automatic memory promotion is included");
  const baselineFiles = new Map(baselineRepository.dirty.map((item) => [item.path, item.fingerprint]));
  const currentFiles = new Map(repository.dirty.map((item) => [item.path, item.fingerprint]));
  const first = remaining[0];
  const firstPhase = first && state.phases.find((item) => item.id === first.phaseId);
  const firstTask = firstPhase?.tasks?.find((item) => item.id === first?.taskId);
  const done = new Set(state.phases.filter((item) => ["completed", "skipped"].includes(item.status)).map((item) => item.id));
  state.phases.flatMap((item) => item.tasks ?? []).filter((item) => ["completed", "skipped"].includes(item.status ?? ""))
    .forEach((item) => done.add(item.id));
  const ready = firstTask?.status === "pending" && [...(firstTask.dependsOn ?? []), ...(firstPhase?.dependsOn ?? [])].every((id) => done.has(id));
  const nextAction = first ? {
    argv: ready ? ["snipara-companion", "workflow", "task-start", String(first.phaseId), String(first.taskId), "--json"]
      : ["snipara-companion", "workflow", "task-status", String(first.phaseId), "--json"],
    expectedResult: ready ? "Prepare the eligible task with its saved contract and task-local source context; no agent is dispatched"
      : "Inspect active work, dependency blockers or failed attempts; choose and record a recovery reason before an explicit retry",
    dispatchesWork: false as const,
  } : { argv: ["snipara-companion", "workflow", "status", "--json"],
    expectedResult: "Inspect completed workflow status and outstanding verification before any integration action", dispatchesWork: false as const };
  const value: WorkflowContinuityCheckpoint = {
    version: "snipara.workflow.continuity.v1", workflowId: state.workflowId,
    capturedAt: new Date().toISOString(), stateHash: hash(projectedState(state)), contractHash: hash(contract(state)),
    goal: text(state.goal), status: text(state.status), repository, baselineRepository,
    preexistingChanges: [...baselineFiles.keys()], taskChanges: [...new Set([...baselineFiles.keys(), ...currentFiles.keys()])]
      .filter((file) => baselineFiles.get(file) !== currentFiles.get(file)),
    phases: safe(state.phases.map((phase) => ({ id: phase.id, title: phase.title, status: phase.status,
      query: phase.query, acceptance: phase.acceptance, files: phase.files, gates: phase.gates,
      dependsOn: phase.dependsOn, summary: phase.summary, outcome: phase.outcome, commitHistory: phase.commitHistory,
      tasks: phase.tasks?.map((task) => ({ id: task.id, title: task.title, query: task.query,
        acceptance: task.acceptance, status: task.status, files: task.files,
        verification: task.verification, maxAttempts: task.maxAttempts, dependsOn: task.dependsOn })) }))) as unknown[],
    attempts, historyCompleteness: complete ? "complete" : "incomplete", decisions,
    artifacts: [...new Map(artifacts.map((item) => [item.path, item])).values()], evidence, remaining,
    decisionSourcesHash: hash(scopedLocalDecisions),
    sourceObservation: { exhaustive: false, scopes: sourceScopes },
    missingChecks, blockers, unverified, budget: { status: "unknown", source: null },
    nextAction, runtime: safe(state.runtime ?? null), runtimeBoundary: RUNTIME_BOUNDARY,
  };
  const content = JSON.stringify(safe(value));
  if (Buffer.byteLength(content, "utf8") > MAX_BYTES) throw new Error("Continuity snapshot exceeds its byte limit");
  const packed = packContext({ cwd, content, kind: "note", label: "Workflow continuity snapshot",
    source: "workflow_continuity", maxBytes: MAX_BYTES, tags: ["workflow-continuity", state.workflowId] });
  return { version: "snipara.workflow.continuity-ref.v1", packId: packed.record.id,
    sha256: packed.record.sha256, capturedAt: value.capturedAt, workflowId: state.workflowId };
}
export function resumeWorkflowContinuity(input: { cwd?: string; state: WorkflowContinuityState }): WorkflowContinuityResume {
  const cwd = path.resolve(input.cwd ?? process.cwd()), state = input.state;
  const currentRepository = captureWorkflowRepository(cwd);
  const result: WorkflowContinuityResume = {
    version: "snipara.workflow.continuity-resume.v1", status: "blocked", checkpoint: null,
    currentRepository, relocated: false, changes: [], reasons: [], artifactChecks: [], diagnostics: [], currentDecisions: [],
    nextAction: {
      argv: ["snipara-companion", "workflow", "task-status", "--json"],
      expectedResult: "Inspect saved task state and the reported blockers or drift before preparing, retrying or continuing work",
      dispatchesWork: false,
    },
    coordination: { historical: true, refreshed: false }, runtimeBoundary: RUNTIME_BOUNDARY,
  };
  if (!state.continuity) { result.status = "drift_revalidation_required"; result.reasons.push("No historical continuity snapshot; legacy checkpoint is incomplete"); return result; }
  try {
    const value = checkpoint(cwd, state.continuity, state.workflowId);
    result.checkpoint = value;
    result.relocated = value.repository.root !== currentRepository.root;
    for (const [origin, errors] of [["current", currentRepository.errors], ["historical", value.repository.errors]] as const) {
      if (errors.length) {
        const item = { code: `${origin}_repository_observation_incomplete`, required: true,
          message: `${origin} repository observation is incomplete: ${errors.map((item) => text(item)).join("; ")}`,
          action: origin === "current" ? "Resolve the reported inventory/root/permission limit before relying on repository-wide proof."
            : "Preserve this historical gap; preview a linked checkpoint refresh after current repository observation succeeds." };
        result.diagnostics.push(item); result.reasons.push(item.message);
      }
    }
    for (const [key, label] of [["head", "HEAD"], ["tree", "committed tree"], ["branch", "branch"],
      ["roots", "repository ancestry"], ["indexHash", "index"], ["dirty", "dirty file content"]] as const) {
      if (hash(value.repository[key]) !== hash(currentRepository[key])) result.changes.push(label);
    }
    if (hash(contract(state)) !== value.contractHash) result.changes.push("workflow contract");
    if (hash(projectedState(state)) !== value.stateHash) result.changes.push("workflow state");
    for (const item of value.artifacts) {
      if (!record(item) || typeof item.path !== "string" || typeof item.required !== "boolean")
        throw new ContinuityArtifactError("checkpoint_schema_invalid", `.snipara/context-pack/blobs/${state.continuity.sha256}.txt`, "Invalid checkpoint artifact reference");
      try {
        const actual = digest(readBytes(cwd, item.path, MAX_FILE_BYTES));
        if (!item.sha256 || actual !== item.sha256)
          throw new ContinuityArtifactError("artifact_hash_mismatch", item.path, "Artifact content differs from checkpoint");
        const expired = typeof item.expiresAt === "string" && (!Number.isFinite(Date.parse(item.expiresAt)) || Date.parse(item.expiresAt) <= Date.now());
        result.artifactChecks.push({ path: item.path, status: expired ? "expired" : "matched" });
        if (expired) result.changes.push(`expired artifact: ${item.path}`);
      } catch (error) {
        const problem = diagnostic(error, item.path, item.required);
        result.diagnostics.push(problem);
        result.artifactChecks.push({ path: text(item.path, 1000), status: "unavailable_or_changed", code: problem.code, reason: problem.action });
        if (item.required) result.reasons.push(`Required artifact cannot be verified: ${problem.message}`);
        else result.changes.push(`Changed or unavailable snapshot file: ${text(item.path, 1000)}`);
      }
    }
    const decisionErrors: string[] = [];
    const currentDecisions = localDecisions(cwd, state, decisionErrors);
    result.currentDecisions = currentDecisions;
    if (hash(currentDecisions) !== value.decisionSourcesHash) result.changes.push("local decision authority or membership");
    if (decisionErrors.length) result.reasons.push("Current local decision records cannot be fully validated");
    for (const decision of [...value.decisions.filter((item) => !String(item.source).startsWith(".snipara/decisions/")), ...currentDecisions]) {
      const expiry = decision.expiresAt ?? decision.validUntil ?? decision.staleAt;
      const invalid = ["invalidated", "superseded", "rejected", "expired"].includes(String(decision.status)) || decision.invalidatedAt ||
        (typeof expiry === "string" && (!Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now()));
      if (invalid) result.changes.push(`Decision requires revalidation: ${text(decision.id ?? decision.decision)}`);
      if (decision.blocking === true && (decision.status === "pending" || invalid)) result.reasons.push("A required decision is pending or invalidated");
    }
    if (value.historyCompleteness !== "complete") result.changes.push("incomplete historical attempt receipts");
    if (value.repair) result.changes.push("Linked successor is a new local observation; historical proof was not refreshed",
      ...strings(value.repair.carriedForward).map((item) => `Prior checkpoint requires revalidation: ${text(item)}`));
    result.status = result.reasons.length ? "blocked" : result.changes.length ? "drift_revalidation_required" : "exact_snapshot";
    if (result.status === "exact_snapshot") result.nextAction = value.nextAction;
  } catch (error) {
    const problem = diagnostic(error, `.snipara/context-pack/items/${state.continuity.packId}.json`);
    result.diagnostics.push(problem); result.reasons.push(`Historical checkpoint cannot be verified: ${problem.message}`);
  }
  return result;
}
/** Preview is read-only. Refresh creates a linked observation, never replacement proof or execution. */
export function previewWorkflowContinuityRepair(input: { cwd?: string; state: WorkflowContinuityState }): {
  allowed: boolean; continuity: WorkflowContinuityResume; reasons: string[];
} {
  const continuity = resumeWorkflowContinuity(input);
  const reasons: string[] = [];
  if (!input.state.continuity || !continuity.checkpoint) reasons.push("The original checkpoint must be readable and verified before linking a successor; restore its exact pack first.");
  if (continuity.currentRepository.errors.length) reasons.push("Current repository observation is incomplete; resolve its diagnosed limit or boundary first.");
  if (continuity.diagnostics.some((item) => item.required && item.code !== "historical_repository_observation_incomplete"))
    reasons.push("Mandatory checkpoint or evidence verification failed; restore the original artifact or rerun its proof gate.");
  if (continuity.changes.some((item) => ["workflow contract", "workflow state", "local decision authority or membership"].includes(item)))
    reasons.push("Workflow contract, state or decision authority changed; checkpoint repair cannot validate a changed request or authority.");
  if (continuity.artifactChecks.some((item) => item.status === "expired") ||
    continuity.reasons.some((item) => item.includes("decision"))) reasons.push("Expired evidence or unresolved decisions require their existing review gates.");
  return { allowed: reasons.length === 0, continuity, reasons };
}
export function refreshWorkflowContinuity(input: { cwd?: string; state: WorkflowContinuityState; reason: string }): WorkflowContinuityRef {
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const reason = text(input.reason);
  if (!reason) throw new Error("Checkpoint refresh requires an explicit recovery reason");
  const preview = previewWorkflowContinuityRepair({ cwd, state: input.state });
  if (!preview.allowed) throw new Error(`Checkpoint refresh refused: ${preview.reasons.join(" ")}`);
  const predecessor = input.state.continuity!;
  const ref = captureWorkflowContinuity({ cwd, state: input.state });
  const value = checkpoint(cwd, ref, input.state.workflowId);
  value.repair = { predecessor, reason, previousStatus: preview.continuity.status,
    carriedForward: [...preview.continuity.reasons, ...preview.continuity.changes], proofRefreshed: false };
  const packed = packContext({ cwd, content: JSON.stringify(safe(value)), kind: "note", label: "Linked workflow continuity refresh",
    source: "workflow_continuity", maxBytes: MAX_BYTES, tags: ["workflow-continuity", input.state.workflowId] });
  return { ...ref, packId: packed.record.id, sha256: packed.record.sha256 };
}
export function formatWorkflowContinuity(report: WorkflowContinuityResume): string {
  const value = report.checkpoint;
  const lines = ["Work continuation", `Status: ${report.status}`,
    ...(report.relocated ? ["Workspace relocated; relative repository and artifact identities were compared."] : []),
    ...report.reasons.map((item) => `Blocked: ${item}`), ...report.changes.map((item) => `Revalidate: ${item}`)];
  for (const item of report.diagnostics ?? []) lines.push(`Diagnosis: ${item.code}${item.path ? ` (${item.path})` : ""}; ${item.action}`);
  if (value) {
    lines.push(`Goal: ${value.goal}`, `Checkpoint: ${value.capturedAt} (historical)`,
      `History: ${value.historyCompleteness}`, "Decisions and reasons:",
      ...value.decisions.map((item) => `- [${text(item.status)}] ${text(item.decision ?? item.choice)}; reason: ${text(item.rationale ?? item.note) || "not recorded"}`),
      "Attempts, including failed work:", ...value.attempts.map((item) =>
        `- ${text(item.taskId)} attempt ${String(item.attempt ?? "unknown")}: ${text(item.outcome ?? item.status)}; ${text(item.summary)}${item.lastError ? `; error: ${text(item.lastError)}` : ""}${item.recoveryReason ? `; recovery: ${text(item.recoveryReason)}` : ""}`),
      "Evidence:", ...value.artifacts.map((item) => `- ${item.kind}: ${item.path} (${item.sha256 ?? item.status})`),
      ...(value.sourceObservation ? ["Source scope observation is not exhaustive; directory and pattern scopes are not expanded."] : []),
      ...report.artifactChecks.filter((item) => item.status !== "matched").map((item) => `- Current check: ${item.path}: ${item.status}`),
      "Remaining work:", ...value.remaining.map((item) => `- ${text(item.title ?? item.taskId ?? item.phaseId)} [${text(item.status)}]`),
      "Checks still to validate:", ...value.missingChecks.map((item) => `- ${text(item.command)} (${text(item.status)})`),
      `Historical next action at checkpoint: ${value.nextAction.argv.map((item) => JSON.stringify(item)).join(" ")}`,
      "Budget: unknown in Companion; no Controller or provider usage is inferred",
      ...value.blockers.map((item) => `Work blocker: ${item}`),
      ...value.unverified.map((item) => `Unverified: ${item}`));
    if (report.changes.includes("local decision authority or membership")) lines.push("Current local decision state:",
      ...report.currentDecisions.map((item) => `- [${text(item.status)}] ${text(item.decision)}; reason: ${text(item.rationale ?? item.note) || "not recorded"}`));
  }
  lines.push(`Current next action: ${report.nextAction.argv.map((item) => JSON.stringify(item)).join(" ")}`,
    `Expected result: ${report.nextAction.expectedResult}`);
  lines.push(...report.runtimeBoundary);
  return lines.join("\n");
}
