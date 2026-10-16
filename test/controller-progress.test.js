const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  buildCompanionEngineeringLeadPlanReport,
  formatCompanionEngineeringLeadPlanReport,
} = require("../dist/index.js");

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-controller-progress-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, "controller.json");
  const state = {
    schemaVersion: "snipara.project_controller.v1",
    controllerId: "pilot",
    workspaceRoot: cwd,
    baseSha: "a".repeat(40),
    revision: 2,
    status: "accepted",
    updatedAt: "2026-10-09T12:00:00Z",
    policy: { privateProviderValue: "must-not-leak" },
    tasks: {
      code: { id: "code", status: "completed", dependsOn: [], assignedWorkerId: "coder" },
      review: {
        id: "review",
        status: "running",
        dependsOn: ["code"],
        assignedWorkerId: "reviewer",
      },
    },
  };
  function report(patch = {}, now = "2026-10-09T12:01:00Z") {
    fs.writeFileSync(file, JSON.stringify({ ...state, ...patch }));
    return buildCompanionEngineeringLeadPlanReport({
      cwd,
      fromController: file,
      now: new Date(now),
    });
  }
  return { cwd, file, state, report };
}

test("Controller status round-trips IDs and dependencies without accepting authority or secrets", (t) => {
  const { report } = fixture(t);
  const a = report();
  const b = report();
  assert.deepEqual(a.controllerProgress, b.controllerProgress);
  assert.equal(a.controllerProgress.reportedStatus, "accepted");
  assert.equal(a.controllerProgress.completionEvidence.objectiveAcceptance, "not_checked");
  assert.equal(a.controllerProgress.completionEvidence.taskProofs, "not_checked");
  assert.equal(a.controllerProgress.authority, "unverified_local_snapshot");
  assert.equal(a.controllerProgress.executionAllowed, false);
  assert.equal(a.controllerProgress.reviewRequired, true);
  assert.deepEqual(a.controllerProgress.tasks[1].dependsOn, ["code"]);
  assert.equal(a.engineeringLeadPlan.workersSpawned, 0);
  assert.ok(!JSON.stringify(a).includes("must-not-leak"));
  assert.match(formatCompanionEngineeringLeadPlanReport(a), /unverified local snapshot/);
});

test("Controller snapshot rejects incompatible schemas, workspace and task mappings", (t) => {
  const { report, state } = fixture(t);
  assert.throws(() => report({ schemaVersion: "snipara.project_controller.v2" }), /schema/);
  assert.throws(() => report({ workspaceRoot: os.tmpdir() }), /different workspace/);
  assert.throws(
    () => report({ tasks: { code: { ...state.tasks.code, id: "other" } } }),
    /key mismatch/
  );
  assert.throws(
    () => report({ tasks: { code: { ...state.tasks.code, dependsOn: ["missing"] } } }),
    /unknown dependency/
  );
  assert.throws(
    () => report({ tasks: { code: { ...state.tasks.code, status: "approved_future" } } }),
    /invalid task/
  );
  assert.throws(() => report({ tasks: {} }), /invalid state/);
  assert.throws(
    () =>
      report({
        tasks: { code: { ...state.tasks.code, dependsOn: ["review"] }, review: state.tasks.review },
      }),
    /cyclic/
  );
  assert.throws(() => report({ controllerId: "." }), /identifier/);
});

test("Controller snapshot refuses a FIFO without waiting for a writer", (t) => {
  if (process.platform === "win32") return t.skip("POSIX FIFO check");
  const { cwd } = fixture(t);
  const file = path.join(cwd, "snapshot.fifo");
  const result = require("node:child_process").spawnSync("mkfifo", [file]);
  assert.equal(result.status, 0);
  assert.throws(
    () => buildCompanionEngineeringLeadPlanReport({ cwd, fromController: file }),
    /regular file/
  );
});

test("Controller snapshot freshness and bounds fail closed", (t) => {
  const { file, cwd, report } = fixture(t);
  assert.equal(report({}, "2026-10-09T13:00:00Z").controllerProgress.freshness, "stale");
  assert.throws(() => report({ updatedAt: "2026-10-10T12:00:00Z" }), /future-dated/);
  assert.throws(() => report({ revision: -1 }), /invalid state/);
  assert.throws(() => report({ baseSha: "not-a-sha" }), /base SHA/);
  fs.writeFileSync(file, " ".repeat(2 * 1024 * 1024 + 1));
  assert.throws(
    () => buildCompanionEngineeringLeadPlanReport({ cwd, fromController: file }),
    /2 MiB/
  );
});
