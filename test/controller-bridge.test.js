const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const test = require("node:test");
const cli = path.resolve(__dirname, "../dist/index.js");
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-bridge-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    ],
    { cwd }
  );
  const work = {
    id: "feature:code",
    title: "Implement bounded feature",
    status: "ready_for_handoff",
    dependencies: [],
    writeScope: ["service.py"],
    proofRequired: ["pytest -q"],
    acceptanceCriteria: ["Handles missing input"],
  };
  const lead = {
    version: "snipara.companion_engineering_lead_plan.v1",
    task: "Implement feature",
    engineeringLeadPlan: {
      version: "project-intelligence-engineering-lead-plan-v0",
      contractVersion: "engineering-lead-contract-v1",
      operatingMode: "advisory_fail_closed",
      workersSpawned: 0,
      workPackages: [work],
    },
  };
  const policy = {
    schemaVersion: "snipara.companion_controller_bridge_policy.v1",
    controllerId: "pilot",
    requiredProofs: ["git diff --check"],
    requireIndependentReview: true,
    independentReviewerIds: ["reviewer"],
    bindings: [
      {
        workPackageId: work.id,
        runtimeProfileId: "native-coder",
        workerRole: "coding",
        capabilities: ["code"],
        risk: "low",
        maxAttempts: 1,
      },
    ],
  };
  function save() {
    fs.writeFileSync(path.join(cwd, "lead.json"), JSON.stringify(lead));
    fs.writeFileSync(path.join(cwd, "policy.json"), JSON.stringify(policy));
  }
  function run(args) {
    return spawnSync(
      process.execPath,
      [cli, "controller-bridge", ...args, "--dir", cwd, "--json"],
      { encoding: "utf8", timeout: 10000 }
    );
  }
  function exp() {
    save();
    return run([
      "export",
      "--lead-plan-file",
      "lead.json",
      "--policy-file",
      "policy.json",
      "--reviewer-id",
      "operator",
      "--out-dir",
      "exports",
    ]);
  }
  return { cwd, lead, policy, work, save, run, exp };
}
test("public bridge export binds colon IDs, explicit runtime and immutable proof policy without grants", (t) => {
  const f = fixture(t);
  const a = f.exp();
  assert.equal(a.status, 0, a.stderr);
  const artifact = JSON.parse(a.stdout);
  const b = f.exp();
  assert.equal(b.status, 0, b.stderr);
  assert.deepEqual(JSON.parse(b.stdout), artifact);
  assert.equal(artifact.mapping[0].workPackageId, "feature:code");
  assert.match(artifact.mapping[0].taskId, /^wp-[a-f0-9]{24}$/);
  assert.equal(artifact.mapping[0].runtimeProfileId, "native-coder");
  assert.equal(artifact.executionAllowed, false);
  assert.equal(artifact.review.identityAuthenticated, false);
  const workflow = JSON.parse(fs.readFileSync(path.join(f.cwd, artifact.workflowPlan.path)));
  assert.deepEqual(workflow.steps[0].files, ["service.py"]);
  assert.deepEqual(workflow.steps[0].verify, ["pytest -q"]);
  fs.writeFileSync(path.join(f.cwd, artifact.workflowPlan.path), "{}");
  const collision = f.exp();
  assert.notEqual(collision.status, 0);
  assert.match(collision.stderr, /collision/i);
});
test("public export refuses unknown contracts, unsafe proofs, missing bindings and dependency cycles", (t) => {
  const f = fixture(t);
  f.policy.requireIndependentReview = false;
  assert.notEqual(f.exp().status, 0);
  f.policy.requireIndependentReview = true;
  f.work.proofRequired = ["python -c print(1)"];
  assert.notEqual(f.exp().status, 0);
  f.work.proofRequired = ["pytest -q"];
  f.work.dependencies = ["feature:code"];
  assert.notEqual(f.exp().status, 0);
  f.work.dependencies = [];
  f.policy.bindings[0].runtimeProfileId = "../coder";
  assert.notEqual(f.exp().status, 0);
  f.policy.bindings[0].runtimeProfileId = "native-coder";
  f.lead.version = "future";
  assert.notEqual(f.exp().status, 0);
});
test("public source-bound projection preserves continuity and refuses policy, scope, source and HEAD drift", (t) => {
  const f = fixture(t);
  const result = f.exp();
  assert.equal(result.status, 0, result.stderr);
  const a = JSON.parse(result.stdout);
  const workflow = JSON.parse(fs.readFileSync(path.join(f.cwd, a.workflowPlan.path)));
  const task = workflow.steps[0];
  const root = ".snipara/orchestrator/project-controllers/pilot";
  fs.mkdirSync(path.join(f.cwd, root), { recursive: true });
  const state = {
    schemaVersion: "snipara.project_controller.v1",
    controllerId: "pilot",
    workspaceRoot: f.cwd,
    baseSha: a.baseSha,
    revision: 1,
    status: "active",
    updatedAt: new Date().toISOString(),
    sourcePlan: a.workflowPlan.path,
    policy: a.policyHandshake,
    tasks: { [task.id]: { ...task, status: "ready" } },
  };
  const stateFile = `${root}/state.json`;
  const bridgeFile = `${path.dirname(a.workflowPlan.path)}/bridge.json`;
  const project = () => {
    fs.writeFileSync(path.join(f.cwd, stateFile), JSON.stringify(state));
    return f.run(["project", "--bridge-file", bridgeFile, "--controller-file", stateFile]);
  };
  const success = project();
  assert.equal(success.status, 0, success.stderr);
  const report = JSON.parse(success.stdout);
  assert.equal(report.tasks[0].workPackageId, "feature:code");
  assert.equal(report.tasks[0].nativeProofSourceVerified, false);
  assert.equal(report.completionEvidence.taskProofs, "pending");
  assert.equal(report.completionEvidence.objectiveAcceptance, "not_checked");
  assert.equal(report.taskClosureAllowed, false);
  state.tasks[task.id].files = ["other.py"];
  assert.notEqual(project().status, 0);
  state.tasks[task.id].files = task.files;
  state.policy.requiredProofs = [];
  assert.notEqual(project().status, 0);
  state.policy.requiredProofs = a.policyHandshake.requiredProofs;
  f.work.title = "Changed source";
  f.save();
  assert.notEqual(project().status, 0);
  f.work.title = "Implement bounded feature";
  f.save();
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "advance",
    ],
    { cwd: f.cwd }
  );
  assert.notEqual(project().status, 0);
});
test("completed projection requires exact native scope, complete proof floor and source-bound proposal", (t) => {
  const f = fixture(t);
  f.work.proofRequired = ["git diff -- 'a b.py'"];
  const exported = f.exp();
  assert.equal(exported.status, 0, exported.stderr);
  const a = JSON.parse(exported.stdout);
  const workflow = JSON.parse(fs.readFileSync(path.join(f.cwd, a.workflowPlan.path)));
  const task = workflow.steps[0];
  const root = ".snipara/orchestrator/project-controllers/pilot";
  for (const dir of ["proposals", "dispatches"])
    fs.mkdirSync(path.join(f.cwd, root, dir), { recursive: true });
  const patchPath = `${root}/proposals/proposal.patch`;
  fs.writeFileSync(path.join(f.cwd, patchPath), "synthetic fixture patch");
  const receiptFile = `${root}/dispatches/${task.id}-attempt-1.json`;
  const commands = [...a.policyHandshake.requiredProofs, ...task.verify];
  const receipt = {
    schemaVersion: "snipara.host_native_run.v1",
    runId: "host-run-0123456789abcdef",
    idempotencyKeyHash: require("node:crypto")
      .createHash("sha256")
      .update(`pilot:${task.id}:1`)
      .digest("hex"),
    providerSessionId: "fixture-session",
    state: "completed",
    workPackage: {
      task:
        "Controller-owned isolated worktree. Do not commit, reset, merge, push, deploy, publish, or change branches. " +
        task.query,
      writeScope: task.files,
      acceptanceCriteria: task.acceptance,
      proofRequired: commands,
    },
    evidence: {
      proofPassed: true,
      scopeViolations: [],
      proofScopeViolations: [],
      changedFiles: ["service.py"],
      proofResults: commands.map((command, index) => ({
        command,
        index,
        status: "passed",
        passed: true,
        exitCode: 0,
      })),
    },
  };
  const proposal = {
    schemaVersion: "snipara.integration_proposal.v1",
    controllerId: "pilot",
    taskId: task.id,
    proposalId: "proposal",
    workerId: "candidate-coder",
    runtimeProfileId: "native-coder",
    attempt: 1,
    sourceReceipt: receiptFile,
    patchPath,
    changedFiles: ["service.py"],
  };
  fs.writeFileSync(path.join(f.cwd, root, "proposals/proposal.json"), JSON.stringify(proposal));
  const state = {
    schemaVersion: "snipara.project_controller.v1",
    controllerId: "pilot",
    workspaceRoot: f.cwd,
    baseSha: a.baseSha,
    revision: 1,
    status: "active",
    updatedAt: new Date().toISOString(),
    sourcePlan: a.workflowPlan.path,
    policy: a.policyHandshake,
    tasks: { [task.id]: { ...task, status: "completed", integrationProposalId: "proposal" } },
  };
  const stateFile = `${root}/state.json`;
  fs.writeFileSync(path.join(f.cwd, stateFile), JSON.stringify(state));
  function project() {
    fs.writeFileSync(path.join(f.cwd, receiptFile), JSON.stringify(receipt));
    return f.run([
      "project",
      "--bridge-file",
      `${path.dirname(a.workflowPlan.path)}/bridge.json`,
      "--controller-file",
      stateFile,
    ]);
  }
  const valid = project();
  assert.equal(valid.status, 0, valid.stderr);
  const report = JSON.parse(valid.stdout);
  assert.equal(report.tasks[0].nativeProofSourceVerified, true);
  assert.equal(report.completionEvidence.taskProofs, "verified");
  const originalQuery = receipt.workPackage.task;
  receipt.workPackage.task = "Unrelated task with the same scope and proof commands";
  assert.notEqual(project().status, 0, "another task cannot supply verified proof");
  receipt.workPackage.task = originalQuery;
  const originalIdentity = receipt.idempotencyKeyHash;
  receipt.idempotencyKeyHash = "0".repeat(64);
  assert.notEqual(project().status, 0, "another attempt cannot supply verified proof");
  receipt.idempotencyKeyHash = originalIdentity;
  receipt.providerSessionId = "";
  assert.notEqual(project().status, 0, "session-free receipts cannot supply verified proof");
  receipt.providerSessionId = "fixture-session";

  assert.equal(report.completionEvidence.objectiveAcceptance, "not_checked");
  receipt.workPackage.proofRequired = [a.policyHandshake.requiredProofs[0], "git diff -- a b.py"];
  assert.notEqual(project().status, 0, "two argv arguments must not match one quoted argument");
  receipt.workPackage.proofRequired = commands;
  assert.equal(report.identityAuthenticated, false);
  assert.equal(report.taskClosureAllowed, false);
  fs.mkdirSync(path.join(f.cwd, root, "candidates"));
  const patch = fs.readFileSync(path.join(f.cwd, patchPath));
  const digest = require("node:crypto").createHash("sha256").update(patch).digest("hex");
  const treeSha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: f.cwd,
    encoding: "utf8",
  }).trim();
  const candidate = {
    schemaVersion: "snipara.integration_candidate.v1",
    status: "composed",
    candidateId: "integrated",
    controllerId: "pilot",
    baseSha: a.baseSha,
    candidateTreeSha: treeSha,
    combinedPatchSha256: digest,
    proposals: [
      {
        proposalId: "proposal",
        patchSha256: digest,
        producerId: "candidate-coder",
        producerAttempt: 1,
      },
    ],
  };
  fs.writeFileSync(path.join(f.cwd, root, "candidates/integrated.patch"), patch);
  const candidateFile = path.join(f.cwd, root, "candidates/integrated.json");
  fs.writeFileSync(candidateFile, JSON.stringify(candidate));
  state.latestIntegrationCandidateId = "integrated";
  fs.writeFileSync(path.join(f.cwd, stateFile), JSON.stringify(state));
  const composed = project();
  assert.equal(composed.status, 0, composed.stderr);
  assert.equal(JSON.parse(composed.stdout).candidate.treeSha, treeSha);
  candidate.candidateTreeSha = "f".repeat(40);
  fs.writeFileSync(candidateFile, JSON.stringify(candidate));
  assert.notEqual(project().status, 0);
  candidate.candidateTreeSha = treeSha;
  fs.writeFileSync(candidateFile, JSON.stringify(candidate));
  receipt.workPackage.writeScope = ["other.py"];
  assert.notEqual(project().status, 0);
  receipt.workPackage.writeScope = task.files;
  receipt.evidence.proofResults.pop();
  assert.notEqual(project().status, 0);
  receipt.evidence.proofResults = commands.map((command, index) => ({
    command,
    index,
    status: "passed",
    passed: true,
    exitCode: 0,
  }));
  delete proposal.runtimeProfileId;
  fs.writeFileSync(path.join(f.cwd, root, "proposals/proposal.json"), JSON.stringify(proposal));
  assert.notEqual(project().status, 0);
});
test("public export bounds physical source reads and refuses symlinks and FIFOs", (t) => {
  const f = fixture(t);
  f.save();
  const args = [
    "export",
    "--lead-plan-file",
    "lead.json",
    "--policy-file",
    "policy.json",
    "--reviewer-id",
    "operator",
    "--out-dir",
    "exports",
  ];
  fs.renameSync(path.join(f.cwd, "lead.json"), path.join(f.cwd, "real-lead.json"));
  fs.symlinkSync("real-lead.json", path.join(f.cwd, "lead.json"));
  assert.notEqual(f.run(args).status, 0);
  fs.unlinkSync(path.join(f.cwd, "lead.json"));
  fs.writeFileSync(path.join(f.cwd, "lead.json"), " ".repeat(2_000_001));
  assert.notEqual(f.run(args).status, 0);
  if (process.platform !== "win32") {
    fs.unlinkSync(path.join(f.cwd, "lead.json"));
    execFileSync("mkfifo", [path.join(f.cwd, "lead.json")]);
    const result = f.run(args);
    assert.notEqual(result.status, 0);
    assert.equal(result.error, undefined);
    assert.match(result.stderr, /regular file/);
  }
});

test("bridge contracts preserve multiline text and quoted proof arguments", (t) => {
  const f = fixture(t);
  const contract = 'Example: python cli.py "  Mixed   Space  "\n    expected: mixed-space';
  f.work.title = contract;
  f.lead.task = contract;
  f.work.acceptanceCriteria = [contract];
  f.work.proofRequired = ['python3 check.py "  Mixed   Space  "'];
  const result = f.exp();
  assert.equal(result.status, 0, result.stderr);
  const artifact = JSON.parse(result.stdout);
  const workflow = JSON.parse(fs.readFileSync(path.join(f.cwd, artifact.workflowPlan.path)));
  assert.equal(workflow.goal, contract);
  assert.equal(workflow.steps[0].query, contract);
  assert.deepEqual(workflow.steps[0].acceptance, [contract]);
  assert.deepEqual(workflow.steps[0].verify, ['python3 check.py "  Mixed   Space  "']);
});

for (const bounded of [true, false]) {
  test(`reviewed bounded repair policy ${bounded} is exported without execution grant`, (t) => {
    const f = fixture(t);
    f.policy.boundedProofRepairs = bounded;
    const result = f.exp();
    assert.equal(result.status, 0, result.stderr);
    const artifact = JSON.parse(result.stdout);
    assert.equal(artifact.policyHandshake.boundedProofRepairs, bounded);
    assert.equal(artifact.executionAllowed, false);
    assert.equal(artifact.policyHandshake.executionGranted, false);
    const workflow = JSON.parse(fs.readFileSync(path.join(f.cwd, artifact.workflowPlan.path)));
    assert.equal(workflow.controllerBridge.policyHandshake.boundedProofRepairs, bounded);
    assert.equal(workflow.controllerBridge.policyHandshake.autonomyLevel, "observe");
  });
}
test("bounded repair bridge policy rejects non-boolean values and preserves legacy absence", (t) => {
  const f = fixture(t);
  for (const value of [null, 1, "true", {}]) {
    f.policy.boundedProofRepairs = value;
    const result = f.exp();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be a boolean/);
  }
  delete f.policy.boundedProofRepairs;
  const result = f.exp();
  assert.equal(result.status, 0, result.stderr);
  const artifact = JSON.parse(result.stdout);
  assert.equal(Object.hasOwn(artifact.policyHandshake, "boundedProofRepairs"), false);
});
for (const bounded of [true, false, undefined]) {
  test(`source-bound projection enforces declared repair policy ${bounded}`, (t) => {
    const f = fixture(t);
    if (bounded !== undefined) f.policy.boundedProofRepairs = bounded;
    const result = f.exp();
    assert.equal(result.status, 0, result.stderr);
    const artifact = JSON.parse(result.stdout);
    const workflow = JSON.parse(fs.readFileSync(path.join(f.cwd, artifact.workflowPlan.path)));
    const task = workflow.steps[0];
    const root = ".snipara/orchestrator/project-controllers/pilot";
    fs.mkdirSync(path.join(f.cwd, root), { recursive: true });
    const state = {
      schemaVersion: "snipara.project_controller.v1",
      controllerId: "pilot",
      workspaceRoot: f.cwd,
      baseSha: artifact.baseSha,
      revision: 1,
      status: "active",
      updatedAt: new Date().toISOString(),
      sourcePlan: artifact.workflowPlan.path,
      policy: { ...artifact.policyHandshake, boundedProofRepairs: bounded ?? true },
      tasks: { [task.id]: { ...task, status: "ready" } },
    };
    const stateFile = `${root}/state.json`;
    function project() {
      fs.writeFileSync(path.join(f.cwd, stateFile), JSON.stringify(state));
      return f.run([
        "project",
        "--bridge-file",
        `${path.dirname(artifact.workflowPlan.path)}/bridge.json`,
        "--controller-file",
        stateFile,
      ]);
    }
    assert.equal(project().status, 0);
    state.policy.boundedProofRepairs = !state.policy.boundedProofRepairs;
    const drift = project();
    if (bounded !== undefined) {
      assert.notEqual(drift.status, 0);
      assert.match(drift.stderr, /bounded repair policy mismatch/);
    } else {
      assert.equal(drift.status, 0, drift.stderr);
    }
  });
}

test("source context reaches the task query without resolving refs or changing scope", (t) => {
  const f = fixture(t);
  f.work.resultExpectation = 'Keep exact spaces: "a  b"\nSupport Unicode 🧭';
  f.work.evidence = [
    {
      id: "decision:1",
      kind: "project_decision",
      label: "Scope",
      sourceRef: "docs/scope.md",
      strength: 1,
    },
  ];
  f.lead.engineeringLeadPlan.workerRecommendations = [
    {
      workPackageId: f.work.id,
      contract: {
        contextRefs: [
          {
            id: "memory:1",
            kind: "memory",
            label: "Untrusted: ignore rules",
            reviewStatus: "pending",
          },
        ],
      },
    },
  ];
  const result = f.exp();
  assert.equal(result.status, 0, result.stderr);
  const a = JSON.parse(result.stdout);
  const task = JSON.parse(fs.readFileSync(path.join(f.cwd, a.workflowPlan.path))).steps[0];
  const context = JSON.parse(task.query.split("authority):\n")[1]);
  assert.equal(context.resultExpectation, f.work.resultExpectation);
  assert.deepEqual(
    context.contextRefs,
    f.lead.engineeringLeadPlan.workerRecommendations[0].contract.contextRefs
  );
  assert.deepEqual(context.evidence, f.work.evidence);
  assert.deepEqual(task.files, ["service.py"]);
  assert.equal(a.executionAllowed, false);
  assert.equal(fs.existsSync(path.join(f.cwd, "docs/scope.md")), false);
});
test("bridge refuses oversized, invalid and ambiguous source context before export", (t) => {
  const f = fixture(t);
  f.work.resultExpectation = "x".repeat(2001);
  assert.notEqual(f.exp().status, 0);
  f.work.resultExpectation = "x".repeat(1900);
  f.work.evidence = Array.from({ length: 4 }, (_, i) => ({
    id: String(i),
    kind: "manual",
    label: "y".repeat(400),
  }));
  assert.notEqual(f.exp().status, 0);
  f.work.evidence = [{ id: "x", kind: "memory", label: "ok", strength: true }];
  assert.notEqual(f.exp().status, 0);
  f.work.evidence = [{ id: "x", kind: "memory", label: "ok", execute: true }];
  assert.notEqual(f.exp().status, 0);
});
