const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const test = require("node:test");
const {
  captureWorkflowContinuity, resumeWorkflowContinuity, formatWorkflowContinuity,
  captureWorkflowRepository, packContext,
} = require("../dist/index.js");

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-continuity-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--initial-branch=dev");
  git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".snipara/\n");
  fs.writeFileSync(path.join(cwd, "code.txt"), "initial\n");
  git("add", ".gitignore", "code.txt"); git("commit", "-m", "fixture");
  const state = {
    workflowId: "workflow-fixture", goal: "Resume without the original conversation", status: "active", currentPhaseId: "code",
    phases: [{ id: "code", title: "Implement", status: "in_progress", query: "Preserve behavior",
      acceptance: "Expected result is repeatable", files: ["code.txt"], gates: ["check"],
      tasks: [{ id: "edit", title: "Edit source", query: "Make the change", status: "pending", attempt: 0,
        maxAttempts: 3, acceptance: "Source is correct", files: ["code.txt"], verification: ["node verify.js"] }] }],
  };
  const task = state.phases[0].tasks[0];
  const capture = () => { state.continuity = captureWorkflowContinuity({ cwd, state }); return state.continuity; };
  const resume = () => resumeWorkflowContinuity({ cwd, state });
  const blob = () => path.join(cwd, ".snipara/context-pack/blobs", `${state.continuity.sha256}.txt`);
  return { cwd, state, task, git, capture, resume, blob };
}
function decision(f, area, name, extra = {}) {
  const dir = path.join(f.cwd, ".snipara/decisions", area); fs.mkdirSync(dir, { recursive: true });
  const request = { requestId: name, workflowId: f.state.workflowId, decision: "Keep scope bounded",
    rationale: "Preserve existing callers", blocking: false, expiresAt: null, ...extra };
  const value = area === "resolved" ? { schemaVersion: "snipara.decision_resolution.v0", request,
    response: { choice: "accept", note: "Accepted after checking callers", reviewer: "operator" } } : request;
  const file = path.join(dir, `${name}.json`); fs.writeFileSync(file, JSON.stringify(value)); return file;
}
function context(f, attempt) {
  const requestHash = "a".repeat(64);
  const payload = { version: "snipara.workflow.loaded-context.v1", workflowId: f.state.workflowId,
    phaseId: "code", taskId: "edit", attempt, requestHash, output: {}, chunks: [{ id: "source", content: "historical source" }] };
  const packed = packContext({ cwd: f.cwd, content: JSON.stringify(payload), kind: "note" });
  return { version: "snipara.workflow.task-context-receipt.v1", workflowId: f.state.workflowId,
    phaseId: "code", taskId: "edit", attempt, requestHash, packId: packed.record.id,
    sha256: packed.record.sha256, loadedAt: new Date().toISOString(), chunkIds: ["source"],
    authority: "local_client_observed", semanticUseVerified: false };
}

test("standalone snapshot resumes exactly without Orchestrator, network or model state", (t) => {
  const f = fixture(t); f.capture(); const report = f.resume();
  assert.equal(report.status, "exact_snapshot", JSON.stringify(report));
  assert.equal(fs.existsSync(path.join(f.cwd, ".snipara/orchestrator")), false);
  assert.deepEqual(report.checkpoint.budget, { status: "unknown", source: null });
  assert.deepEqual(report.checkpoint.nextAction.argv.slice(0, 5), ["snipara-companion", "workflow", "task-start", "code", "edit"]);
  assert.deepEqual(report.nextAction, report.checkpoint.nextAction);
  assert.equal(report.coordination.refreshed, false);
  assert.match(formatWorkflowContinuity(report), /does not reattach a runtime/);
  assert.equal(report.checkpoint.phases[0].tasks[0].acceptance, "Source is correct");
  assert.equal(report.checkpoint.phases[0].gates[0], "check");
});

test("same dirty status with changed bytes is drift, while immutable snapshot remains historical", (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.cwd, "code.txt"), "first change\n"); f.capture();
  const before = fs.readFileSync(f.blob(), "utf8");
  fs.writeFileSync(path.join(f.cwd, "code.txt"), "second change\n");
  const report = f.resume();
  assert.ok(report.changes.includes("dirty file content"));
  assert.equal(report.status, "drift_revalidation_required", "source drift remains visible for revalidation");
  assert.equal(fs.readFileSync(f.blob(), "utf8"), before);
});

test("index-only drift is observed even if working bytes and status shape stay the same", (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.cwd, "code.txt"), "stage one\n"); f.git("add", "code.txt");
  fs.writeFileSync(path.join(f.cwd, "code.txt"), "final working bytes\n"); f.capture();
  const status = f.git("status", "--porcelain");
  fs.writeFileSync(path.join(f.cwd, "code.txt"), "stage two\n"); f.git("add", "code.txt");
  fs.writeFileSync(path.join(f.cwd, "code.txt"), "final working bytes\n");
  assert.equal(f.git("status", "--porcelain"), status);
  const report = f.resume(); assert.equal(report.status, "drift_revalidation_required");
  assert.ok(report.changes.includes("index"));
  assert.equal(report.checkpoint.nextAction.argv[2], "task-start");
  assert.deepEqual(report.nextAction.argv, ["snipara-companion", "workflow", "task-status", "--json"]);
});

test("original dirty baseline survives subsequent captures and new task changes are separate", (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.cwd, "unrelated.txt"), "before task"); f.capture();
  fs.writeFileSync(path.join(f.cwd, "code.txt"), "task change"); f.capture();
  const value = f.resume().checkpoint;
  assert.deepEqual(value.preexistingChanges, ["unrelated.txt"]);
  assert.deepEqual(value.taskChanges, ["code.txt"]);
});

test("a relocated workspace with identical Git and relative artifact identities resumes exactly", (t) => {
  const f = fixture(t); f.capture();
  const moved = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-continuity-moved-"));
  t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
  fs.cpSync(f.cwd, moved, { recursive: true });
  const result = resumeWorkflowContinuity({ cwd: moved, state: f.state });
  assert.equal(result.status, "exact_snapshot", JSON.stringify(result)); assert.equal(result.relocated, true);
});

test("new branch and HEAD are declared without refreshing old evidence", (t) => {
  const f = fixture(t); f.capture(); f.git("switch", "-c", "fixture-branch");
  fs.writeFileSync(path.join(f.cwd, "other.txt"), "new commit"); f.git("add", "other.txt"); f.git("commit", "-m", "moved");
  const result = f.resume(); assert.equal(result.status, "drift_revalidation_required");
  assert.ok(result.changes.includes("HEAD")); assert.ok(result.changes.includes("branch"));
});

test("failed attempts, decisions, reasons, constraints and historical context survive a later active attempt", (t) => {
  const f = fixture(t); const receipt = context(f, 1);
  f.task.status = "in_progress"; f.task.attempt = 2;
  f.task.attemptHistory = [{ attempt: 1, capturedAt: new Date().toISOString(), status: "blocked", outcome: "blocked",
    summary: "Parser approach failed", lastError: "Input not supported", decision: "Reuse parser",
    why: "Existing caller contract matters", alternatives: ["Rewrite"], constraints: ["No deployment"],
    evidence: ["failed:parser regression"], recoveryReason: "Handle empty input", contextReceipt: receipt }];
  f.capture(); const value = f.resume().checkpoint;
  assert.equal(value.historyCompleteness, "complete"); assert.equal(value.attempts.length, 2);
  assert.equal(value.decisions[0].rationale, "Existing caller contract matters");
  assert.ok(value.artifacts.some((item) => item.kind === "task_context_snapshot"));
  assert.equal(value.attempts[0].recoveryReason, "Handle empty input");
  assert.equal(value.evidence.find((item) => item.receipt)?.semanticUseVerified, false);
});

test("legacy attempts cannot become a complete history and missing snapshot remains explicit", (t) => {
  const f = fixture(t); assert.equal(f.resume().status, "drift_revalidation_required");
  f.task.status = "blocked"; f.task.attempt = 2; f.task.summary = "Latest failure only"; f.capture();
  const report = f.resume(); assert.equal(report.checkpoint.historyCompleteness, "incomplete");
  assert.ok(report.changes.includes("incomplete historical attempt receipts"));
});

test("in-progress first attempt is current work, not lost outcome history", (t) => {
  const f = fixture(t); f.task.status = "in_progress"; f.task.attempt = 1; f.capture();
  assert.equal(f.resume().checkpoint.historyCompleteness, "complete");
  assert.equal(f.resume().checkpoint.attempts[0].outcome, "not_recorded_yet");
});

test("required missing or tampered artifact blocks rather than turning an old declaration into proof", (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.cwd, "proof.json"), "{\"passed\":true}");
  f.task.artifacts = ["proof.json"]; f.capture();
  fs.unlinkSync(path.join(f.cwd, "proof.json")); assert.equal(f.resume().status, "blocked");
  fs.writeFileSync(path.join(f.cwd, "proof.json"), "{\"passed\":false}"); assert.equal(f.resume().status, "blocked");
});

test("symlink and traversal artifacts are refused before reading another workspace", (t) => {
  const f = fixture(t); fs.symlinkSync(os.tmpdir(), path.join(f.cwd, "outside"));
  f.task.artifacts = ["outside/private-proof.json"]; assert.throws(f.capture, /Symlink/);
  f.task.artifacts = ["../private-proof.json"]; assert.throws(f.capture, /Unsafe/);
});

test("changed context-pack storage paths, blob bytes and absent historical packs block", (t) => {
  const f = fixture(t); f.task.contextReceipt = context(f, 1); f.task.attempt = 1; f.task.status = "in_progress";
  f.capture();
  const manifestPath = path.join(f.cwd, ".snipara/context-pack/items", `${f.task.contextReceipt.packId}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.storage.blobRelativePath = "../../outside.txt"; fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal(f.resume().status, "blocked");
  assert.throws(f.capture, /identity or path/);
});

test("corrupt or tampered continuity snapshot blocks and cannot silently reset original baseline", (t) => {
  const f = fixture(t); f.capture(); fs.writeFileSync(f.blob(), "{}");
  assert.equal(f.resume().status, "blocked"); assert.throws(f.capture, /hash or byte length differs/);
});

test("new blocking pending decision after checkpoint is observed without rewriting history", (t) => {
  const f = fixture(t); f.capture(); decision(f, "pending", "decision-new", { blocking: true });
  const result = f.resume(); assert.equal(result.status, "blocked");
  assert.ok(result.changes.includes("local decision authority or membership"));
  assert.equal(result.checkpoint.decisions.length, 0, "historical decision list stays unchanged");
  assert.equal(result.checkpoint.nextAction.argv[2], "task-start", "historical planned action remains preserved");
  assert.deepEqual(result.nextAction.argv, ["snipara-companion", "workflow", "task-status", "--json"]);
  assert.match(formatWorkflowContinuity(result), /Historical next action at checkpoint:/);
  assert.match(formatWorkflowContinuity(result), /Current next action:.*task-status/);
});

test("expired and invalidated scoped decisions remain stale while unrelated records are excluded", (t) => {
  const f = fixture(t);
  decision(f, "resolved", "old", { expiresAt: "2000-01-01T00:00:00Z" });
  decision(f, "resolved", "unrelated", { workflowId: "other-workflow", blocking: true }); f.capture();
  let result = f.resume(); assert.equal(result.checkpoint.decisions.length, 1);
  assert.equal(result.status, "drift_revalidation_required");
  decision(f, "resolved", "old", { status: "invalidated", invalidatedAt: new Date().toISOString(), blocking: true });
  result = f.resume(); assert.equal(result.status, "blocked");
});

test("changing workflow contract invalidates snapshot even with identical repository bytes", (t) => {
  const f = fixture(t); f.capture(); f.task.acceptance = "Different objective";
  const report = f.resume(); assert.equal(report.status, "drift_revalidation_required");
  assert.ok(report.changes.includes("workflow contract"));
});

test("checkpoint summaries redact secrets and never import raw transcript fields", (t) => {
  const f = fixture(t); f.task.attempt = 1; f.task.status = "blocked";
  f.task.attemptHistory = [{ attempt: 1, status: "blocked", summary: "api_key=private-value", why: "Chosen for scope",
    transcript: "raw original conversation", stdout: "raw command output" }];
  f.capture(); const blob = fs.readFileSync(f.blob(), "utf8");
  assert.doesNotMatch(blob, /private-value|raw original conversation|raw command output/);
  assert.match(blob, /REDACTED/);
});

test("runtime checkpoint file restore is separate from live process restoration and network availability", (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.cwd, "runtime.json"), "{\"counter\":2}");
  f.state.runtime = { sandbox: { bindings: [{ phaseId: "code", sessionId: "missing-runtime-session",
    lastCheckpoint: { summary: "Counter saved", capturedAt: new Date().toISOString(), artifacts: ["runtime.json"], rehydratableState: { counter: 2 } } }] } };
  f.capture(); const result = f.resume(); assert.equal(result.status, "exact_snapshot");
  assert.match(formatWorkflowContinuity(result), /restore a live process/);
  assert.equal(result.checkpoint.runtime.sandbox.bindings[0].sessionId, "missing-runtime-session");
});

test("bounded file reads reject a FIFO instead of waiting for a producer", (t) => {
  const f = fixture(t); execFileSync("mkfifo", [path.join(f.cwd, "pipe")]);
  f.task.artifacts = ["pipe"]; assert.throws(f.capture, /bounded regular file/);
});

test("Git observation does not write index or reflogs", (t) => {
  const f = fixture(t); const idx = path.join(f.cwd, ".git/index");
  const before = createHash("sha256").update(fs.readFileSync(idx)).digest("hex");
  const logs = fs.readFileSync(path.join(f.cwd, ".git/logs/HEAD"), "utf8");
  captureWorkflowRepository(f.cwd); f.capture(); f.resume();
  assert.equal(createHash("sha256").update(fs.readFileSync(idx)).digest("hex"), before);
  assert.equal(fs.readFileSync(path.join(f.cwd, ".git/logs/HEAD"), "utf8"), logs);
});

test("context receipts from another task or workflow cannot be imported as local observed evidence", (t) => {
  const f = fixture(t); f.task.contextReceipt = { ...context(f, 1), workflowId: "other-workflow" };
  assert.throws(f.capture, /does not belong/);
});

test("a missing checkpoint stays blocked and explicit capture cannot silently discard its baseline", (t) => {
  const f = fixture(t); f.capture();
  fs.unlinkSync(path.join(f.cwd, ".snipara/context-pack/items", `${f.state.continuity.packId}.json`));
  assert.equal(f.resume().status, "blocked"); assert.throws(f.capture, /ENOENT/);
});

test("symlink substitution after checkpoint blocks a required evidence artifact", (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.cwd, "proof.json"), "proof");
  f.task.artifacts = ["proof.json"]; f.capture(); fs.unlinkSync(path.join(f.cwd, "proof.json"));
  fs.symlinkSync(path.join(f.cwd, "code.txt"), path.join(f.cwd, "proof.json"));
  assert.equal(f.resume().status, "blocked");
});

test("large histories fail explicitly instead of silently truncating failed work", (t) => {
  const f = fixture(t); f.task.attemptHistory = Array.from({ length: 257 }, (_, i) => ({ attempt: i + 1,
    summary: "Failed case", outcome: "blocked", constraints: ["preserve" ] }));
  assert.throws(f.capture, /byte limit|entry limit/);
});

test("duplicate history rows cannot mask missing attempt identities", (t) => {
  const f = fixture(t); f.task.status = "completed"; f.task.attempt = 3;
  f.task.attemptHistory = Array.from({ length: 3 }, () => ({ attempt: 1, status: "blocked", outcome: "blocked", summary: "Repeated same attempt" }));
  f.capture(); const report = f.resume();
  assert.equal(report.checkpoint.historyCompleteness, "incomplete");
  assert.equal(report.status, "drift_revalidation_required");
  assert.ok(report.checkpoint.unverified.some((item) => item.includes("duplicate historical attempt 1")));
  assert.ok(report.checkpoint.unverified.some((item) => item.includes("missing historical attempt 2")));
  assert.ok(report.checkpoint.unverified.some((item) => item.includes("missing historical attempt 3")));
});

test("wrong status, noninteger identity and out-of-range history stay explicitly incomplete", (t) => {
  const f = fixture(t); f.task.status = "completed"; f.task.attempt = 3;
  f.task.attemptHistory = [
    { attempt: 1, status: "in_progress", outcome: "completed" },
    { attempt: "2", status: "completed", outcome: "completed" },
    { attempt: 4, status: "completed", outcome: "completed" },
  ];
  f.capture(); assert.equal(f.resume().checkpoint.historyCompleteness, "incomplete");
});

test("receipt from an earlier attempt cannot be relabeled as current context", (t) => {
  const f = fixture(t); f.task.status = "in_progress"; f.task.attempt = 2;
  f.task.attemptHistory = [{ attempt: 1, status: "blocked", outcome: "blocked" }];
  f.task.contextReceipt = context(f, 1);
  assert.throws(f.capture, /does not belong/);
});

test("receipt from another attempt cannot be imported by a history row", (t) => {
  const f = fixture(t); f.task.status = "completed"; f.task.attempt = 2;
  f.task.attemptHistory = [{ attempt: 1, status: "blocked", outcome: "blocked" },
    { attempt: 2, status: "completed", outcome: "completed", contextReceipt: context(f, 1) }];
  assert.throws(f.capture, /does not belong/);
});

test("phase-only decisions and evidence are retained without duplicating task attempts", (t) => {
  const f = fixture(t); f.task.status = "completed"; f.task.attempt = 1;
  f.task.attemptHistory = [{ attempt: 1, status: "completed", outcome: "completed", summary: "Task done" }];
  f.state.phases[0].commitHistory = [{ attempt: 1, status: "completed", outcome: "completed",
    decision: "Keep compatibility", why: "Callers rely on this shape", constraints: ["No deployment"],
    evidence: ["passed:compatibility suite"] }];
  f.capture(); const value = f.resume().checkpoint;
  assert.equal(value.historyCompleteness, "complete"); assert.equal(value.attempts.length, 1);
  assert.equal(value.decisions[0].source, "phase_commit_receipt");
  assert.equal(value.decisions[0].rationale, "Callers rely on this shape");
  assert.equal(value.evidence.find((item) => item.phaseId === "code")?.declaration, "passed:compatibility suite");
  assert.equal(value.phases[0].commitHistory[0].constraints[0], "No deployment");
});

test("missing required evidence proposes inspection while preserving the historical start action", (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.cwd, "proof.json"), "proof");
  f.task.artifacts = ["proof.json"]; f.capture(); fs.unlinkSync(path.join(f.cwd, "proof.json"));
  const result = f.resume(); assert.equal(result.status, "blocked");
  assert.equal(result.checkpoint.nextAction.argv[2], "task-start");
  assert.deepEqual(result.nextAction.argv, ["snipara-companion", "workflow", "task-status", "--json"]);
  assert.equal(result.nextAction.dispatchesWork, false);
});

test("directory, repository and pattern plan scopes remain valid and explicitly nonexhaustive", (t) => {
  const f = fixture(t); fs.mkdirSync(path.join(f.cwd, "src")); fs.writeFileSync(path.join(f.cwd, "src/file.txt"), "source");
  const scopes = ["src/", "./src", ".", "./", "src/**", "src/*.ts"];
  f.task.files = scopes; f.state.phases[0].files = ["src/"];
  f.capture(); const value = f.resume().checkpoint;
  assert.deepEqual(value.phases[0].tasks[0].files, scopes, "declared contract scope remains intact");
  assert.equal(value.sourceObservation.exhaustive, false);
  const statuses = value.sourceObservation.scopes.filter((item) => item.taskId === "edit").map((item) => item.status);
  assert.deepEqual(statuses, ["directory_not_expanded", "directory_not_expanded", "repository_scope_not_expanded",
    "repository_scope_not_expanded", "pattern_not_expanded", "pattern_not_expanded"]);
  assert.ok(value.unverified.some((item) => item.includes("scope observation is not exhaustive")));
  assert.match(formatWorkflowContinuity(f.resume()), /directory and pattern scopes are not expanded/);
});

test("optional outside and traversal plan scopes never read outside the workspace or weaken required artifacts", (t) => {
  const f = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-outside-scope-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const secret = path.join(outside, "private.txt"); fs.writeFileSync(secret, "private external content");
  f.task.files = [secret, "../private.txt", "src/../../private.txt", "C:\\private.txt"];
  const originalOpen = fs.openSync;
  const attemptedOutsideReads = [];
  fs.openSync = function (file, ...args) {
    if (typeof file === "string" && path.resolve(file) === secret) attemptedOutsideReads.push(file);
    return originalOpen.call(this, file, ...args);
  };
  try { f.capture(); } finally { fs.openSync = originalOpen; }
  assert.deepEqual(attemptedOutsideReads, []);
  const value = f.resume().checkpoint;
  assert.equal(value.sourceObservation.scopes.filter((item) => item.taskId === "edit")
    .every((item) => item.status === "unsafe_scope_not_read"), true);
  assert.doesNotMatch(fs.readFileSync(f.blob(), "utf8"), /private external content/);
  f.task.artifacts = [secret]; assert.throws(f.capture, /Unsafe continuity artifact path/);
  f.task.artifacts = ["../private.txt"]; assert.throws(f.capture, /Unsafe continuity artifact path/);
});

test("optional symlink source scope is unobserved while a required symlink artifact is still refused", (t) => {
  const f = fixture(t); fs.symlinkSync("code.txt", path.join(f.cwd, "source-link"));
  f.git("add", "source-link"); f.git("commit", "-m", "link fixture");
  f.task.files = ["source-link"]; f.capture();
  const value = f.resume().checkpoint;
  assert.equal(value.sourceObservation.scopes.find((item) => item.taskId === "edit").status,
    "unavailable_or_unsafe_scope_not_read");
  f.task.artifacts = ["source-link"]; assert.throws(f.capture, /Symlink continuity artifacts/);
});
