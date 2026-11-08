const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { captureWorkflowContinuity, resumeWorkflowContinuity, previewWorkflowContinuityRepair,
  refreshWorkflowContinuity, formatWorkflowContinuity, packContext } = require("../dist/index.js");

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "continuity-repair-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git("init", "-b", "dev"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".snipara/\n");
  fs.writeFileSync(path.join(cwd, "code.txt"), "original\n");
  fs.writeFileSync(path.join(cwd, "proof.json"), '{"passed":true}');
  git("add", "."); git("commit", "-m", "Fixture");
  const state = { workflowId: "repair-fixture", goal: "Retain stopped work", status: "blocked", currentPhaseId: "code",
    phases: [{ id: "code", title: "Code", status: "blocked", files: ["code.txt"], tasks: [{ id: "edit", title: "Edit", query: "Preserve behavior",
      status: "blocked", outcome: "abandoned", attempt: 2, maxAttempts: 3, recoveryTaskId: "recover-edit", artifacts: ["proof.json"],
      files: ["code.txt"], contextRequest: { queries: ["original contract"] },
      attemptHistory: [1, 2].map(attempt => ({ attempt, capturedAt: "2026-10-26T10:00:00Z", status: "blocked", outcome: "abandoned" })) }] }],
    runtime: { sandbox: { bindings: [] }, controllerBudget: { spent: 2, remaining: 1, stopped: true } } };
  const capture = () => { state.continuity = captureWorkflowContinuity({ cwd, state }); };
  const resume = () => resumeWorkflowContinuity({ cwd, state });
  const replaceCheckpoint = (change) => {
    const value = resume().checkpoint; change(value);
    const packed = packContext({ cwd, content: JSON.stringify(value), kind: "note" });
    state.continuity = { ...state.continuity, packId: packed.record.id, sha256: packed.record.sha256 };
  };
  capture();
  return { cwd, state, capture, resume, replaceCheckpoint,
    blob: () => path.join(cwd, ".snipara/context-pack/blobs", state.continuity.sha256 + ".txt") };
}

test("historical repository failure is diagnosed separately from a valid checkpoint and optional history", t => {
  const f = fixture(t);
  f.replaceCheckpoint(cp => { cp.repository.errors = ["repository_output_too_large: bounded inventory exceeded"]; });
  const result = f.resume();
  assert.equal(result.status, "blocked");
  assert.ok(result.checkpoint);
  assert.equal(result.diagnostics[0].code, "historical_repository_observation_incomplete");
  assert.match(result.reasons[0], /repository_output_too_large/);
  assert.ok(result.artifactChecks.some(x => x.path === "proof.json" && x.status === "matched"));
  assert.doesNotMatch(result.reasons.join(" "), /snapshot is missing|hash no longer/);
  assert.match(formatWorkflowContinuity(result), /preview a linked checkpoint refresh/);
  assert.equal(previewWorkflowContinuityRepair({ cwd: f.cwd, state: f.state }).allowed, true);
});

for (const kind of ["missing", "hash", "unsafe", "oversized"]) test(`mandatory ${kind} artifact has an exact diagnosis and blocks repair`, t => {
  const f = fixture(t), file = path.join(f.cwd, "proof.json");
  if (kind === "missing") fs.unlinkSync(file);
  if (kind === "hash") fs.writeFileSync(file, '{"passed":false}');
  if (kind === "unsafe") { fs.unlinkSync(file); fs.symlinkSync("code.txt", file); }
  if (kind === "oversized") fs.writeFileSync(file, Buffer.alloc(16 * 1024 * 1024 + 1));
  const result = f.resume();
  const problem = result.diagnostics.find(x => x.path === "proof.json");
  assert.equal(problem.code, { missing: "artifact_missing", hash: "artifact_hash_mismatch", unsafe: "artifact_unsafe_path", oversized: "artifact_oversized" }[kind]);
  assert.equal(problem.required, true);
  assert.ok(problem.action);
  assert.equal(result.status, "blocked");
  assert.equal(previewWorkflowContinuityRepair({ cwd: f.cwd, state: f.state }).allowed, false);
  assert.throws(() => refreshWorkflowContinuity({ cwd: f.cwd, state: f.state, reason: "Cannot revalidate evidence by relabeling it" }), /refresh refused/);
});

for (const kind of ["missing", "hash", "schema"]) test(`checkpoint ${kind} identifies its path and refuses successor repair`, t => {
  const f = fixture(t);
  if (kind === "schema") f.replaceCheckpoint(cp => { cp.version = "unsupported"; });
  if (kind === "missing") fs.unlinkSync(f.blob());
  if (kind === "hash") fs.appendFileSync(f.blob(), "corrupt");
  const result = f.resume();
  assert.equal(result.checkpoint, null);
  assert.equal(result.diagnostics[0].code, { missing: "artifact_missing", hash: "checkpoint_hash_mismatch", schema: "checkpoint_schema_invalid" }[kind]);
  assert.match(result.diagnostics[0].path, /context-pack\/blobs\/.*\.txt$/);
  assert.equal(previewWorkflowContinuityRepair({ cwd: f.cwd, state: f.state }).allowed, false);
});

test("preview is read-only and refresh links immutable history without resetting stopped work or proof", t => {
  const f = fixture(t);
  f.replaceCheckpoint(cp => { cp.repository.errors = ["Historical repository observation failed"]; });
  const predecessor = { ...f.state.continuity }, original = fs.readFileSync(f.blob());
  const before = structuredClone(f.state), directory = path.dirname(f.blob());
  const names = fs.readdirSync(directory);
  const preview = previewWorkflowContinuityRepair({ cwd: f.cwd, state: f.state });
  assert.equal(preview.allowed, true);
  assert.deepEqual(f.state, before); assert.deepEqual(fs.readdirSync(directory), names);
  assert.throws(() => refreshWorkflowContinuity({ cwd: f.cwd, state: f.state, reason: " " }), /explicit recovery reason/);
  const next = refreshWorkflowContinuity({ cwd: f.cwd, state: f.state, reason: "Current bounded observation now succeeds" });
  assert.notEqual(next.packId, predecessor.packId);
  assert.deepEqual(f.state, before);
  f.state.continuity = next;
  const resumed = f.resume();
  assert.equal(resumed.status, "drift_revalidation_required");
  assert.deepEqual(resumed.checkpoint.repair.predecessor, predecessor);
  assert.equal(resumed.checkpoint.repair.proofRefreshed, false);
  assert.ok(resumed.checkpoint.repair.carriedForward.some(x => /Historical repository/.test(x)));
  assert.equal(resumed.nextAction.argv[2], "task-status");
  assert.deepEqual(fs.readFileSync(path.join(directory, predecessor.sha256 + ".txt")), original);
  assert.deepEqual({ ...f.state, continuity: predecessor }, before);
});

test("source drift survives a linked refresh and a changed context request is never repairable", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.cwd, "code.txt"), "changed source\n");
  const ref = refreshWorkflowContinuity({ cwd: f.cwd, state: f.state, reason: "Observe new source without claiming verification" });
  f.state.continuity = ref;
  assert.equal(f.resume().status, "drift_revalidation_required");
  assert.ok(f.resume().checkpoint.repair.carriedForward.some(x => /dirty file content|snapshot file/.test(x)));
  f.state.phases[0].tasks[0].contextRequest.queries = ["different request"];
  assert.equal(previewWorkflowContinuityRepair({ cwd: f.cwd, state: f.state }).allowed, false);
  assert.throws(() => refreshWorkflowContinuity({ cwd: f.cwd, state: f.state, reason: "Changed request" }), /refresh refused/);
});
