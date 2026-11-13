/**
 * Separate review of a candidate, and the verdict of a commit.
 *
 * `review` runs a reviewer in a fresh, read-only session (another coding client, or any command) on the diff of
 * the current commit, and keeps a receipt bound to that commit's tree. `verdict` reads the receipts of a tree and
 * says what was checked: verified, partial or not verified. It qualifies, it does not block: the Sandbox and a second
 * model are optional, so the answer states what is missing instead of refusing.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const REVIEW_RECEIPT_SCHEMA = "snipara.review-receipt.v1";
export const CHECK_RECEIPT_SCHEMA = "snipara.check-receipt.v1";
const RECEIPTS = path.join(".snipara", "receipts");
const MAX_DIFF_CHARS = 60_000;
const MAX_FINDINGS = 50;
const SEVERITIES = ["blocker", "major", "minor"] as const;

export type ReviewFinding = { severity: (typeof SEVERITIES)[number]; file?: string; line?: number; summary: string };
export type ReviewReceipt = {
  schema: typeof REVIEW_RECEIPT_SCHEMA;
  commit: string;
  tree: string;
  dirty: boolean;
  base: string;
  reviewer: string;
  /** False for a custom reviewer command: Companion cannot keep it from writing. */
  readOnlyEnforced: boolean;
  briefSha256: string;
  /** Characters of the diff, and how many of them the reviewer was given. */
  diffChars: number;
  reviewedChars: number;
  verdict: "pass" | "blockers" | "unreadable";
  findings: ReviewFinding[];
  createdAt: string;
};
export type CheckReceipt = {
  schema: typeof CHECK_RECEIPT_SCHEMA;
  name: string;
  ok: boolean;
  tree: string;
  dirty: boolean;
  at: string;
  detail?: string;
};
export type CommitVerdict = { state: "verified" | "partial" | "not_verified"; tree: string; has: string[]; missing: string[] };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
}

/**
 * The commit and tree a receipt is bound to. A working tree with uncommitted changes is not the tree of HEAD.
 * A check runs on the files on disk, so for a check an untracked file counts as a difference too.
 */
export function gitState(cwd: string, options: { untracked?: boolean } = {}): { commit: string; tree: string; dirty: boolean } {
  return {
    commit: git(cwd, ["rev-parse", "HEAD"]),
    tree: git(cwd, ["rev-parse", "HEAD^{tree}"]),
    // Companion's own state directory is not part of the candidate.
    dirty: git(cwd, ["status", "--porcelain", ...(options.untracked ? [] : ["--untracked-files=no"]), "--", ".", ":(exclude).snipara"]).length > 0,
  };
}

function defaultBase(cwd: string): string {
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    try {
      const base = git(cwd, ["merge-base", "HEAD", ref]);
      if (base && base !== git(cwd, ["rev-parse", "HEAD"])) return base;
    } catch {
      /* ref absent: try the next one */
    }
  }
  return git(cwd, ["rev-parse", "HEAD~1"]);
}

export function buildReviewBrief(input: {
  task: string;
  base: string;
  commit: string;
  stat: string;
  diff: string;
  checks?: CheckReceipt[];
  memories?: string[];
}): string {
  const diff = input.diff.length > MAX_DIFF_CHARS
    ? `${input.diff.slice(0, MAX_DIFF_CHARS)}\n[diff cut at ${MAX_DIFF_CHARS} characters of ${input.diff.length}; say so if what you need is beyond it]`
    : input.diff;
  const checks = (input.checks ?? []).map(check => `- ${check.name}: ${check.ok ? "passed" : "FAILED"}${check.detail ? ` (${check.detail})` : ""}`);
  return [
    "You are the separate reviewer of a code change. You did not write it. You have read-only access: do not edit, run or install anything.",
    "Look for what would be wrong after this change is integrated: broken behaviour, a case the change misses, a test that no longer proves what it claims, a security or data problem, a contradiction with the task, and additions the task did not need.",
    "Do not praise and do not restate the diff. Report only findings you can point to in the diff. If you find nothing, return an empty list.",
    'Answer with one JSON object and nothing else: {"findings": [{"severity": "blocker" | "major" | "minor", "file": "path", "line": 0, "summary": "one sentence"}]}',
    "blocker = must be fixed before integration; major = should be fixed; minor = worth a note.",
    "",
    `## Task\n${input.task}`,
    `## Change\nbase ${input.base.slice(0, 12)}, candidate ${input.commit.slice(0, 12)}\n${input.stat}`,
    ...(checks.length ? [`## Checks already run on this tree\n${checks.join("\n")}`] : ["## Checks already run on this tree\nNone recorded."]),
    ...(input.memories?.length ? [`## What the project already recorded about this\n${input.memories.map(memory => `- ${memory}`).join("\n")}`] : []),
    `## Diff\n${diff}`,
  ].join("\n");
}

/**
 * The reviewer's findings, or null when its answer cannot be trusted as a review: no JSON object, no findings list,
 * or a finding that is not well formed (dropping it could turn an objection into a pass).
 */
export function parseReviewerOutput(text: string): { verdict: "pass" | "blockers"; findings: ReviewFinding[] } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const raw = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(raw)) return null;
  const findings: ReviewFinding[] = [];
  if (raw.length > MAX_FINDINGS) return null; // never cut the list: the blocker could be past the cut
  for (const item of raw) {
    const value = item as Record<string, unknown>;
    const severity = SEVERITIES.find(name => name === value?.severity);
    const summary = typeof value?.summary === "string" ? value.summary.replace(/\s+/g, " ").trim().slice(0, 400) : "";
    if (!severity || !summary) return null;
    findings.push({
      severity,
      summary,
      ...(typeof value.file === "string" && value.file ? { file: value.file.slice(0, 300) } : {}),
      ...(Number.isInteger(value.line) && (value.line as number) > 0 ? { line: value.line as number } : {}),
    });
  }
  return { verdict: findings.some(finding => finding.severity === "blocker") ? "blockers" : "pass", findings };
}

function readJsonFiles<T>(directory: string): T[] {
  if (!fs.existsSync(directory)) return [];
  const out: T[] = [];
  for (const name of fs.readdirSync(directory).filter(file => file.endsWith(".json")).sort()) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")) as T);
    } catch {
      /* an unreadable receipt proves nothing: skip it */
    }
  }
  return out;
}

export function readCheckReceipts(cwd: string): CheckReceipt[] {
  return readJsonFiles<CheckReceipt>(path.join(cwd, RECEIPTS, "checks")).filter(receipt => receipt?.schema === CHECK_RECEIPT_SCHEMA && typeof receipt.tree === "string");
}

export function readReviewReceipt(cwd: string, tree: string): ReviewReceipt | null {
  const file = path.join(cwd, RECEIPTS, "review", `${tree}.json`);
  try {
    const receipt = JSON.parse(fs.readFileSync(file, "utf8")) as ReviewReceipt;
    return receipt?.schema === REVIEW_RECEIPT_SCHEMA && receipt.tree === tree ? receipt : null;
  } catch {
    return null;
  }
}

function writeReceipt(cwd: string, kind: "review" | "checks", name: string, receipt: unknown): string {
  const directory = path.join(cwd, RECEIPTS, kind);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${name.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
  return path.relative(cwd, file);
}

/** What the receipts of one tree establish. Receipts taken on a tree with uncommitted changes do not count. */
export function computeVerdict(input: { tree: string; dirty: boolean; checks: CheckReceipt[]; review: ReviewReceipt | null }): CommitVerdict {
  const has: string[] = [];
  const missing: string[] = [];
  const checks = input.checks.filter(check => check.tree === input.tree && !check.dirty);
  const failed = checks.filter(check => !check.ok);
  if (!checks.length) missing.push("no check receipt for this tree (run the checks in the Sandbox, or record one)");
  else if (failed.length) missing.push(`failed checks: ${failed.map(check => check.name).join(", ")}`);
  else has.push(`checks passed: ${checks.map(check => check.name).join(", ")}`);
  const review = input.review && input.review.tree === input.tree && !input.review.dirty ? input.review : null;
  const blockers = review?.findings.filter(finding => finding.severity === "blocker").length ?? 0;
  if (!review) missing.push("no review receipt for this tree (snipara-companion review)");
  else if (review.verdict === "unreadable") missing.push("the reviewer's answer could not be read");
  else if (blockers) missing.push(`the review found ${blockers} blocker${blockers > 1 ? "s" : ""}`);
  else if (review.reviewedChars < review.diffChars) missing.push(`the review saw only the first ${review.reviewedChars} of ${review.diffChars} characters of the diff`);
  else has.push(`separate review passed (${review.reviewer}${review.readOnlyEnforced ? "" : ", read-only access not enforced"}; ${review.findings.length} finding${review.findings.length === 1 ? "" : "s"}, none blocking)`);
  if (input.dirty) missing.push("the working tree has uncommitted changes: receipts describe the last commit, not what is on disk");
  const state = !missing.length ? "verified" : !checks.length && !review ? "not_verified" : "partial";
  return { state, tree: input.tree, has, missing };
}

function findExecutable(name: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* not here */
    }
  }
  return null;
}

/** The reviewer to run: an explicit command, else another coding client found on this machine. */
export function resolveReviewer(explicit?: string, env = process.env): { label: string; readOnly: boolean; run: (brief: string, cwd: string, timeoutMs: number) => string } | null {
  const command = explicit ?? env.SNIPARA_REVIEW_COMMAND;
  const shell = (line: string) => (brief: string, cwd: string, timeoutMs: number) => {
    const result = spawnSync("sh", ["-c", line], { cwd, input: brief, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`reviewer exited ${result.status}: ${(result.stderr ?? "").slice(-300)}`);
    return result.stdout ?? "";
  };
  // A custom command runs in the host shell: Companion asks it to be read-only and cannot enforce it.
  if (command) return { label: command.split(/\s+/)[0] ?? "custom", readOnly: false, run: shell(command) };
  const codex = findExecutable("codex") ?? (fs.existsSync("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex") ? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex" : null);
  if (codex) {
    return {
      label: "codex",
      readOnly: true,
      run: (brief, cwd, timeoutMs) => {
        const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "snipara-review-")), "answer.txt");
        const result = spawnSync(codex, ["exec", "-s", "read-only", "-C", cwd, "--skip-git-repo-check", "--ephemeral", "-o", out, "-"],
          { cwd, input: brief, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
        if (result.error) throw result.error;
        const answer = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
        fs.rmSync(path.dirname(out), { recursive: true, force: true });
        if (!answer && result.status !== 0) throw new Error(`codex exited ${result.status}: ${(result.stderr ?? "").slice(-300)}`);
        return answer || result.stdout || "";
      },
    };
  }
  const claude = findExecutable("claude");
  if (claude) return { label: "claude", readOnly: true, run: shell(`'${claude}' -p --permission-mode plan`) };
  return null;
}

export async function reviewCommand(options: {
  task?: string;
  base?: string;
  reviewer?: string;
  timeoutSeconds?: number;
  memories?: string[];
  json?: boolean;
  cwd?: string;
}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const state = gitState(cwd);
  const base = options.base ?? defaultBase(cwd);
  const task = options.task?.trim() || git(cwd, ["log", "-1", "--format=%s%n%n%b"]);
  const reviewer = resolveReviewer(options.reviewer);
  if (!reviewer) {
    console.error("No reviewer available: install another coding client (codex or claude), or set SNIPARA_REVIEW_COMMAND to a command that reads the brief on stdin and prints its findings as JSON.");
    return 3;
  }
  const diff = git(cwd, ["diff", `${base}..HEAD`]);
  const brief = buildReviewBrief({
    task,
    base,
    commit: state.commit,
    stat: git(cwd, ["diff", "--stat", `${base}..HEAD`]),
    diff,
    checks: readCheckReceipts(cwd).filter(check => check.tree === state.tree && !check.dirty),
    memories: options.memories,
  });
  let answer = "";
  let failure = "";
  try {
    answer = reviewer.run(brief, cwd, (options.timeoutSeconds ?? 600) * 1000);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const parsed = failure ? null : parseReviewerOutput(answer);
  const receipt: ReviewReceipt = {
    schema: REVIEW_RECEIPT_SCHEMA,
    commit: state.commit,
    tree: state.tree,
    dirty: state.dirty,
    base,
    reviewer: reviewer.label,
    readOnlyEnforced: reviewer.readOnly,
    briefSha256: createHash("sha256").update(brief).digest("hex"),
    diffChars: diff.length,
    reviewedChars: Math.min(diff.length, MAX_DIFF_CHARS),
    verdict: parsed?.verdict ?? "unreadable",
    findings: parsed?.findings ?? [],
    createdAt: new Date().toISOString(),
  };
  const file = writeReceipt(cwd, "review", state.tree, receipt);
  if (options.json) {
    console.log(JSON.stringify({ ...receipt, receipt: file, ...(failure ? { error: failure } : {}) }, null, 2));
  } else {
    console.log(`review: ${receipt.verdict}; reviewer ${reviewer.label}; commit ${state.commit.slice(0, 12)}${state.dirty ? " (uncommitted changes not reviewed)" : ""}`);
    for (const finding of receipt.findings) console.log(`${finding.severity}: ${finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""} — ` : ""}${finding.summary}`);
    if (failure) console.log(`The reviewer could not be run: ${failure}`);
    else if (!parsed) console.log("The reviewer's answer held no usable findings object.");
    if (receipt.reviewedChars < receipt.diffChars) console.log(`Only the first ${receipt.reviewedChars} of ${receipt.diffChars} characters of the diff were reviewed: narrow the range with --base.`);
    console.log(`Receipt: ${file}`);
  }
  return receipt.verdict === "pass" ? 0 : receipt.verdict === "blockers" ? 2 : 3;
}

export function recordCheckCommand(options: { name: string; ok: boolean; detail?: string; cwd?: string; json?: boolean }): number {
  const cwd = options.cwd ?? process.cwd();
  const state = gitState(cwd, { untracked: true });
  const receipt: CheckReceipt = {
    schema: CHECK_RECEIPT_SCHEMA,
    name: options.name,
    ok: options.ok,
    tree: state.tree,
    dirty: state.dirty,
    at: new Date().toISOString(),
    ...(options.detail ? { detail: options.detail.slice(0, 300) } : {}),
  };
  const file = writeReceipt(cwd, "checks", `${options.name}-${state.tree.slice(0, 12)}`, receipt);
  console.log(options.json ? JSON.stringify({ ...receipt, receipt: file }, null, 2) : `check ${options.name}: ${options.ok ? "passed" : "failed"} on tree ${state.tree.slice(0, 12)}${state.dirty ? " (uncommitted changes: will not count)" : ""}; ${file}`);
  return 0;
}

export function verdictCommand(options: { require?: string; json?: boolean; cwd?: string }): number {
  const cwd = options.cwd ?? process.cwd();
  const state = gitState(cwd);
  const verdict = computeVerdict({ tree: state.tree, dirty: state.dirty, checks: readCheckReceipts(cwd), review: readReviewReceipt(cwd, state.tree) });
  if (options.json) console.log(JSON.stringify({ commit: state.commit, ...verdict }, null, 2));
  else {
    console.log(`verdict: ${verdict.state.replace("_", " ")}; commit ${state.commit.slice(0, 12)}`);
    for (const line of verdict.has) console.log(`+ ${line}`);
    for (const line of verdict.missing) console.log(`- ${line}`);
  }
  return options.require === "verified" && verdict.state !== "verified" ? 2 : 0;
}
