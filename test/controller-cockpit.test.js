const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const cli = path.resolve(__dirname, "../dist/index.js");
function fixture(t) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "snipara-cockpit-")));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const root = path.join(cwd, ".snipara/orchestrator/project-controllers/pilot");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "state.json"),
    JSON.stringify({
      schemaVersion: "snipara.project_controller.v1",
      controllerId: "pilot",
      workspaceRoot: cwd,
      baseSha: "a".repeat(40),
      revision: 1,
      status: "active",
      updatedAt: new Date().toISOString(),
      tasks: { code: { id: "code", status: "ready", dependsOn: [] } },
    })
  );
  const executable = path.join(cwd, "snipara-orchestrator");
  // Synthetic operator-selected executable records argv; it does not emulate reviewer authentication.
  fs.writeFileSync(
    executable,
    `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`,
    { mode: 0o700 }
  );
  const run = (args) =>
    spawnSync(
      process.execPath,
      [cli, "controller-cockpit", "--dir", cwd, "--controller-id", "pilot", "--json", ...args],
      { encoding: "utf8", timeout: 10000 }
    );
  return { cwd, executable, run };
}
test("cockpit default inspects continuity and recommends official commands without spawning", (t) => {
  const f = fixture(t);
  const result = f.run([]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.executionAllowed, false);
  assert.equal(report.identityAuthenticated, false);
  assert.equal(report.recommendedCommands.show[1], "status");
  assert.ok(!report.recommendedCommands.land);
  assert.ok(!report.recommendedCommands.run);
});
test("explicit cockpit stop forwards cancel only on explicit flag with shell-free argv", (t) => {
  const f = fixture(t);
  const base = ["--orchestrator-bin", f.executable, "--action", "stop"];
  const stopped = f.run(base);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.ok(!JSON.parse(JSON.parse(stopped.stdout).output).includes("--cancel-active"));
  const canceled = f.run([...base, "--cancel-active"]);
  assert.equal(canceled.status, 0, canceled.stderr);
  assert.ok(JSON.parse(JSON.parse(canceled.stdout).output).includes("--cancel-active"));
  assert.notEqual(f.run(["--action", "land", "--orchestrator-bin", f.executable]).status, 0);
  assert.notEqual(
    f.run(["--action", "resume", "--cancel-active", "--orchestrator-bin", f.executable]).status,
    0
  );
  assert.notEqual(
    f.run(["--action", "show", "--orchestrator-bin", f.executable, "--timeout-seconds", "61"])
      .status,
    0
  );
});
test("cockpit never creates review receipts and refuses mismatched receipt identity", (t) => {
  const f = fixture(t);
  const base = ["--orchestrator-bin", f.executable, "--action", "review-attach"];
  assert.notEqual(f.run(base).status, 0);
  fs.writeFileSync(
    path.join(f.cwd, "review.json"),
    JSON.stringify({
      schemaVersion: "snipara.candidate_review.v1",
      controllerId: "other",
      candidateId: "candidate",
    })
  );
  assert.notEqual(f.run([...base, "--receipt-file", "review.json"]).status, 0);
  assert.equal(
    fs.existsSync(
      path.join(f.cwd, ".snipara/orchestrator/project-controllers/pilot/candidate-reviews")
    ),
    false
  );
});
