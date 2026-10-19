/** A bounded local contract. Selected issue text is source material, never execution authority. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { TextDecoder } from "node:util";
import { checkpointText } from "../session/checkpoint";

type Data = Record<string, unknown>;
export type IntakeCommandRunner = (program: "git" | "gh", args: string[], cwd: string) => {
  status: number | null; stdout: string; stderr?: string;
};
export interface TaskIntakeSource {
  kind: "local" | "github"; repository: string | null; issueNumber?: number;
  url?: string; updatedAt?: string; bodySha256: string; observedAt: string;
  authority: "untrusted_source";
}
export interface TaskIntakeRepositorySnapshot {
  headSha: string | null; branch: string | null;
  indexSha256?: string;
  dirtyBaseline: Array<{ path: string; status: string; sha256: string | null }>;
  dirtyBaselineTruncated: boolean; observedAt: string;
}
export interface TaskIntake {
  version: "snipara.task_intake.v1"; id: string; goal: string; criteria: string[];
  files: string[]; verification: string[]; source: TaskIntakeSource;
  sourceContext?: { title: string; body: string; redacted: boolean };
  repositorySnapshot: TaskIntakeRepositorySnapshot; contentSha256: string;
}
export interface TaskIntakeOptions {
  workspaceRoot: string; goal: string; criteria?: string[]; files?: string[];
  verification?: string[]; githubIssue?: string | number; id?: string;
  observedAt?: string; runCommand?: IntakeCommandRunner;
}
export class TaskIntakeError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "TaskIntakeError"; }
}
const MAX_BYTES = 256_000;
const MAX_BODY = 64_000;
const MAX_OUTPUT = 2_000_000;
const SHA = /^[a-f0-9]{64}$/;
const record = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
function fail(code: string, message: string): never { throw new TaskIntakeError(code, message); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
export function taskIntakeHash(value: unknown): string { return digest(JSON.stringify(canonical(value))); }
function timestamp(value?: string): string {
  const time = value ?? new Date().toISOString();
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(time) || !Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== time)
    fail("invalid_timestamp", "Use an ISO UTC timestamp with millisecond precision.");
  return time;
}
function unsupportedCharacters(value: string, multiline = true): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 127 || (code < 32 && (!multiline || ![9, 10, 13].includes(code)))) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
function boundedText(value: unknown, name: string, limit: number, empty = false): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > limit || unsupportedCharacters(value) || (!empty && !value.trim()))
    fail("invalid_input", `${name} is missing, oversized, or contains unsupported control characters.`);
  return value;
}
function texts(value: unknown, name: string, limit = 2000): string[] {
  if (!Array.isArray(value) || value.length > 64) fail("invalid_input", `${name} must contain at most 64 entries.`);
  return [...new Set(value.map((item) => boundedText(item, name, limit).trim()))];
}
function scopedPath(value: string): string {
  if (value.length > 1000 || unsupportedCharacters(value, false) || value.includes("\\") || path.posix.isAbsolute(value) || /^[a-z]:/i.test(value))
    fail("unsafe_path", "File scope must use bounded repository-relative paths.");
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part === ".git"))
    fail("unsafe_path", "File scope cannot traverse directories or enter .git.");
  return value;
}
// Declared scope supports the existing root/directory/glob grammar. It is not
// a path to an artifact to open or write.
function scopePath(value: string): string {
  if (value === "." || value === "./") return value;
  const relative = value.replace(/^\.\//, "").replace(/\/$/, "");
  scopedPath(relative);
  return value;
}
function scopeLocalPath(root: string, value: string): void {
  scopePath(value);
  const relative = value.replace(/^\.\//, "").replace(/\/$/, "");
  if (!relative || relative === ".") return;
  const parts = relative.split("/");
  const prefix: string[] = [];
  for (const part of parts) {
    if (/[*?[{]/.test(part)) break;
    prefix.push(part);
  }
  if (prefix.length) localPath(root, prefix.join("/"));
}
function localPath(root: string, relative: string): string {
  scopedPath(relative);
  const absolute = path.join(root, relative);
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail("unsafe_path", "Symlink paths are not intake artifacts.");
    // existsSync returns false for a dangling symlink.
    try { if (fs.lstatSync(current).isSymbolicLink()) fail("unsafe_path", "Symlink paths are not intake artifacts."); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  }
  return absolute;
}
function readBounded(file: string, limit: number): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) fail("invalid_brief", "Intake input is not a bounded regular file.");
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!read) break;
      length += read;
    }
    if (length > limit) fail("invalid_brief", "Intake input exceeds its byte limit.");
    return bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
const defaultRunner: IntakeCommandRunner = (program, args, cwd) => {
  const result = spawnSync(program, args, { cwd, encoding: "utf8", timeout: 10_000,
    maxBuffer: MAX_OUTPUT, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0",
      GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" }, stdio: ["ignore", "pipe", "pipe"] });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? (result.error ? String(result.error) : "") };
};
function command(runner: IntakeCommandRunner, program: "git" | "gh", args: string[], cwd: string): string {
  let result;
  try { result = runner(program, args, cwd); } catch { fail(program === "gh" ? "github_unavailable" : "repository_unavailable", `${program} read could not complete.`); }
  if (result.status !== 0) {
    if (program === "gh") {
      const reason = /401|403|404|denied|authentication|not logged/i.test(result.stderr ?? "") ? "github_access_denied" : "github_unavailable";
      fail(reason, "Selected GitHub source could not be read. Check existing gh authentication and repository read access; no login or write was attempted.");
    }
    fail("repository_unavailable", "Current repository identity could not be read.");
  }
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_OUTPUT) fail("output_too_large", "Source read exceeded its output limit.");
  return result.stdout;
}
function repoIdentity(remote: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (!match || [match[1], match[2]].some((part) => part === "." || part === "..")) return null;
  return `${match[1]}/${match[2]}`;
}
function currentRemote(root: string, runner: IntakeCommandRunner): string | null {
  try { return repoIdentity(command(runner, "git", ["remote", "get-url", "origin"], root)); }
  catch { return null; }
}
function repositorySnapshot(root: string, runner: IntakeCommandRunner, observedAt: string): TaskIntakeRepositorySnapshot {
  let headSha: string | null = null;
  let branch: string | null = null;
  try { headSha = command(runner, "git", ["rev-parse", "HEAD"], root).trim(); } catch { /* Unborn repository. */ }
  try { branch = command(runner, "git", ["symbolic-ref", "--short", "HEAD"], root).trim(); } catch { /* Detached HEAD. */ }
  let output: string;
  try { output = command(runner, "git", ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"], root); }
  catch { fail("repository_unavailable", "Intake needs a readable local Git repository; GitHub and authentication are optional."); }
  const dirty: TaskIntakeRepositorySnapshot["dirtyBaseline"] = [];
  const records = output.split("\0");
  for (let index = 0; index < records.length; index++) {
    const entry = records[index];
    if (!entry) continue;
    if (entry.length < 4 || entry[2] !== " ") fail("repository_unavailable", "Git returned an invalid status record.");
    const status = entry.slice(0, 2);
    const file = scopedPath(entry.slice(3));
    if (/[RC]/.test(status)) index++; // -z emits destination, then original path.
    let sha256: string | null = null;
    const absolute = path.join(root, file);
    try {
      localPath(root, file);
      sha256 = digest(readBounded(absolute, MAX_OUTPUT));
    } catch { /* Missing, oversized and symlink contents are explicitly unobserved. */ }
    dirty.push({ path: file, status, sha256 });
  }
  dirty.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const indexSha256 = digest(command(runner, "git", ["ls-files", "--stage", "-z"], root));
  return { headSha, branch, indexSha256, dirtyBaseline: dirty.slice(0, 256), dirtyBaselineTruncated: dirty.length > 256, observedAt };
}
function selectedIssue(selection: string | number, repository: string | null): number {
  if (!repository) fail("github_repository_mismatch", "Selected GitHub issue needs the current repository's GitHub origin.");
  const text = String(selection);
  let number = text;
  if (!/^[1-9][0-9]{0,9}$/.test(text)) {
    const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]{0,9})\/?$/.exec(text);
    if (!match || match[1].toLowerCase() !== repository.toLowerCase())
      fail("github_repository_mismatch", "Choose an issue URL from the current GitHub origin; pull requests and foreign hosts are not accepted.");
    number = match[2];
  }
  return Number(number);
}
function jsonObject(output: string): Data {
  try {
    const value: unknown = JSON.parse(output);
    // JSON.parse silently accepts duplicate keys; the Python consumer rejects
    // them. Inspect key tokens only after the normal parser validates grammar.
    const stack: Array<Set<string> | null> = [];
    for (let index = 0; index < output.length; index++) {
      const char = output[index];
      if (char === "{") stack.push(new Set());
      else if (char === "[") stack.push(null);
      else if (char === "}" || char === "]") stack.pop();
      else if (char === '"') {
        const start = index;
        while (++index < output.length) {
          if (output[index] === "\\") index++;
          else if (output[index] === '"') break;
        }
        let next = index + 1;
        while (/\s/.test(output[next] ?? "") && next < output.length) next++;
        if (output[next] === ":") {
          const key = JSON.parse(output.slice(start, index + 1)) as string;
          const keys = stack.at(-1);
          if (!keys || keys.has(key)) throw new Error("Duplicate JSON key");
          keys.add(key);
        }
      }
    }
    if (record(value)) return value;
  } catch { /* Generic diagnostic avoids echoing source output. */ }
  return fail("github_invalid_response", "GitHub returned an invalid source response.");
}
function githubSource(root: string, selection: string | number, runner: IntakeCommandRunner, observedAt: string) {
  const repository = currentRemote(root, runner);
  const issueNumber = selectedIssue(selection, repository);
  const repoEndpoint = `repos/${repository}`;
  const issueEndpoint = `${repoEndpoint}/issues/${issueNumber}`;
  const repo = jsonObject(command(runner, "gh", ["api", "--hostname", "github.com", "--method", "GET", repoEndpoint], root));
  if (typeof repo.full_name !== "string" || repo.full_name.toLowerCase() !== repository?.toLowerCase() || !record(repo.permissions) || repo.permissions.pull !== true)
    fail("github_access_denied", "GitHub repository read permission was not confirmed.");
  const issue = jsonObject(command(runner, "gh", ["api", "--hostname", "github.com", "--method", "GET", issueEndpoint], root));
  const url = `https://github.com/${repository}/issues/${issueNumber}`;
  if (issue.number !== issueNumber || issue.pull_request !== undefined || typeof issue.html_url !== "string" || issue.html_url.toLowerCase() !== url.toLowerCase())
    fail("github_invalid_response", "The selected response is not the requested repository issue.");
  const body = boundedText(issue.body ?? "", "Issue body", MAX_BODY, true);
  const title = boundedText(issue.title, "Issue title", 1000);
  const updatedAt = boundedText(issue.updated_at, "Issue update timestamp", 100);
  if (!Number.isFinite(Date.parse(updatedAt))) fail("github_invalid_response", "Issue update timestamp is invalid.");
  const safeBody = checkpointText(body, MAX_BODY, false);
  const safeTitle = checkpointText(title, 1000, false);
  const source: TaskIntakeSource = { kind: "github", repository, issueNumber, url, updatedAt,
    bodySha256: digest(body), observedAt, authority: "untrusted_source" };
  return { source, sourceContext: { title: safeTitle, body: safeBody, redacted: safeBody !== body || safeTitle !== title },
    capability: { available: true, observed: true, readOnly: true, reasonCodes: [] as string[],
      receipt: { repositoryEndpoint: repoEndpoint, issueEndpoint, repositoryReadPermission: true, observedAt,
        issueNumber, updatedAt, bodySha256: source.bodySha256 } } };
}
export function createTaskIntake(options: TaskIntakeOptions) {
  const root = fs.realpathSync(options.workspaceRoot);
  const runner = options.runCommand ?? defaultRunner;
  const observedAt = timestamp(options.observedAt);
  const goal = boundedText(options.goal, "Goal", 8000).trim();
  const criteria = texts(options.criteria ?? [], "Criteria");
  const files = texts(options.files ?? [], "Files", 1000).map(scopePath);
  files.forEach((file) => scopeLocalPath(root, file));
  const verification = texts(options.verification ?? [], "Verification");
  const repository = repositorySnapshot(root, runner, observedAt);
  const selected = options.githubIssue === undefined ? null : githubSource(root, options.githubIssue, runner, observedAt);
  const source: TaskIntakeSource = selected?.source ?? { kind: "local", repository: currentRemote(root, runner),
    bodySha256: digest(goal), observedAt, authority: "untrusted_source" };
  const normalizedInput = { goal, criteria, files, verification, source };
  const id = options.id ?? `task_${taskIntakeHash(normalizedInput).slice(0, 16)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(id)) fail("invalid_input", "Task id must use 1-80 letters, digits, dots, underscores or hyphens.");
  const content = { version: "snipara.task_intake.v1" as const, id, goal, criteria, files, verification, source,
    ...(selected ? { sourceContext: selected.sourceContext } : {}), repositorySnapshot: repository };
  const brief: TaskIntake = { ...content, contentSha256: taskIntakeHash(content) };
  validateTaskIntake(brief);
  return { brief, normalizedInput, capabilities: {
    local: { available: true, observed: true },
    github: selected?.capability ?? { available: false, observed: false, readOnly: true, reasonCodes: ["not_requested"] },
  } };
}
export function validateTaskIntake(value: unknown): TaskIntake {
  if (!record(value) || Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_BYTES) fail("invalid_brief", "Intake must be a bounded JSON object.");
  const allowed = new Set(["version", "id", "goal", "criteria", "files", "verification", "source", "sourceContext", "repositorySnapshot", "contentSha256"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || value.version !== "snipara.task_intake.v1" || typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(value.id))
    fail("invalid_brief", "Unknown or invalid intake contract.");
  boundedText(value.goal, "Goal", 8000);
  for (const field of ["criteria", "files", "verification"] as const) {
    const entries = texts(value[field], field, field === "files" ? 1000 : 2000);
    if (JSON.stringify(entries) !== JSON.stringify(value[field])) fail("invalid_brief", "Intake lists must be normalized and unique.");
  }
  (value.files as string[]).forEach(scopePath);
  const source = value.source;
  if (!record(source) || Object.keys(source).some((key) => !["kind", "repository", "issueNumber", "url", "updatedAt", "bodySha256", "observedAt", "authority"].includes(key)) || typeof source.observedAt !== "string" || (source.kind !== "local" && source.kind !== "github") || source.authority !== "untrusted_source" || typeof source.bodySha256 !== "string" || !SHA.test(source.bodySha256) || !(source.repository === null || (typeof source.repository === "string" && repoIdentity(`https://github.com/${source.repository}`) === source.repository)))
    fail("invalid_brief", "Intake source identity or authority is invalid.");
  timestamp(source.observedAt as string);
  if (source.kind === "github") {
    if (typeof source.repository !== "string" || typeof source.issueNumber !== "number" || !Number.isSafeInteger(source.issueNumber) || source.issueNumber < 1 || source.issueNumber > 9_999_999_999 || source.url !== `https://github.com/${source.repository}/issues/${source.issueNumber}` || typeof source.updatedAt !== "string" || !Number.isFinite(Date.parse(source.updatedAt)) || !record(value.sourceContext))
      fail("invalid_brief", "GitHub intake source is incomplete.");
    boundedText(value.sourceContext.title, "Issue title", 1000);
    boundedText(value.sourceContext.body, "Issue body", MAX_BODY, true);
    if (Object.keys(value.sourceContext).some((key) => !["title", "body", "redacted"].includes(key)) || typeof value.sourceContext.redacted !== "boolean" || (value.sourceContext.redacted === false && digest(value.sourceContext.body as string) !== source.bodySha256)) fail("invalid_brief", "Issue snapshot hash does not match source body.");
  } else if (source.issueNumber !== undefined || source.url !== undefined || source.updatedAt !== undefined || value.sourceContext !== undefined || source.bodySha256 !== digest(value.goal as string)) fail("invalid_brief", "Local intake source does not match the operator goal.");
  const snapshot = value.repositorySnapshot;
  if (!record(snapshot) || Object.keys(snapshot).some((key) => !["headSha", "branch", "indexSha256", "dirtyBaseline", "dirtyBaselineTruncated", "observedAt"].includes(key)) || (snapshot.indexSha256 !== undefined && (typeof snapshot.indexSha256 !== "string" || !SHA.test(snapshot.indexSha256))) || typeof snapshot.observedAt !== "string" || !(snapshot.headSha === null || (typeof snapshot.headSha === "string" && /^[a-f0-9]{40,64}$/.test(snapshot.headSha))) || !(snapshot.branch === null || (typeof snapshot.branch === "string" && snapshot.branch.length <= 1000)) || !Array.isArray(snapshot.dirtyBaseline) || snapshot.dirtyBaseline.length > 256 || typeof snapshot.dirtyBaselineTruncated !== "boolean")
    fail("invalid_brief", "Repository snapshot is invalid.");
  timestamp(snapshot.observedAt as string);
  for (const entry of snapshot.dirtyBaseline) {
    if (!record(entry) || Object.keys(entry).some((key) => !["path", "status", "sha256"].includes(key)) || typeof entry.path !== "string" || typeof entry.status !== "string" || !/^[ MADRCTU?!]{2}$/.test(entry.status) || !(entry.sha256 === null || (typeof entry.sha256 === "string" && SHA.test(entry.sha256)))) fail("invalid_brief", "Dirty baseline entry is invalid.");
    scopedPath(entry.path);
  }
  const { contentSha256, ...content } = value;
  if (typeof contentSha256 !== "string" || !SHA.test(contentSha256) || taskIntakeHash(content) !== contentSha256) fail("brief_integrity_mismatch", "Intake content hash does not match its snapshot.");
  return value as unknown as TaskIntake;
}
export function readTaskIntake(file: string): TaskIntake {
  const raw = new TextDecoder("utf8", { fatal: true }).decode(readBounded(file, MAX_BYTES));
  return validateTaskIntake(jsonObject(raw));
}
export function writeTaskIntake(workspaceRoot: string, relativePath: string, brief: TaskIntake): string {
  validateTaskIntake(brief);
  const root = fs.realpathSync(workspaceRoot);
  const target = localPath(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  localPath(root, relativePath);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(brief, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    // link is atomic and refuses an existing name; rename would silently overwrite another brief.
    fs.linkSync(temporary, target);
  } finally { try { fs.unlinkSync(temporary); } catch { /* Absent on pre-write failure. */ } }
  return target;
}
export function revalidateTaskIntake(brief: TaskIntake, options: Pick<TaskIntakeOptions, "workspaceRoot" | "runCommand" | "observedAt"> & { refreshSource?: boolean }) {
  validateTaskIntake(brief);
  const root = fs.realpathSync(options.workspaceRoot);
  const runner = options.runCommand ?? defaultRunner;
  const observedAt = timestamp(options.observedAt);
  const current = repositorySnapshot(root, runner, observedAt);
  const reasons: string[] = [];
  if (current.headSha !== brief.repositorySnapshot.headSha) reasons.push("repository_head_changed");
  if (current.branch !== brief.repositorySnapshot.branch) reasons.push("repository_branch_changed");
  if (!brief.repositorySnapshot.indexSha256) reasons.push("repository_index_not_observed");
  else if (current.indexSha256 !== brief.repositorySnapshot.indexSha256) reasons.push("repository_index_changed");
  if (taskIntakeHash(current.dirtyBaseline) !== taskIntakeHash(brief.repositorySnapshot.dirtyBaseline)) reasons.push("repository_dirty_baseline_changed");
  if (current.dirtyBaselineTruncated || brief.repositorySnapshot.dirtyBaselineTruncated) reasons.push("repository_dirty_baseline_incomplete");
  if (brief.source.repository !== currentRemote(root, runner)) reasons.push("repository_origin_changed");
  let sourceObservation: Data = { status: "not_requested", historical: true };
  let blocked = false;
  if (options.refreshSource && brief.source.kind === "github") {
    try {
      const fresh = githubSource(root, brief.source.url!, runner, observedAt);
      const changed = fresh.source.bodySha256 !== brief.source.bodySha256 || fresh.source.updatedAt !== brief.source.updatedAt;
      sourceObservation = { status: changed ? "changed" : "unchanged", source: fresh.source, readReceipt: fresh.capability.receipt };
      if (changed) reasons.push("github_issue_changed");
    } catch (error) {
      blocked = true;
      reasons.push(error instanceof TaskIntakeError ? error.code : "github_unavailable");
      sourceObservation = { status: "unavailable", historical: true };
    }
  }
  return { version: "snipara.task_intake.revalidation.v1", intakeId: brief.id, contentSha256: brief.contentSha256,
    status: blocked ? "blocked" : reasons.length ? "drift" : "exact", reasonCodes: reasons,
    currentRepositorySnapshot: current, sourceObservation, doesNotAuthorizeExecution: true };
}
