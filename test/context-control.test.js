const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const cliPath = path.join(__dirname, "..", "dist", "index.js");

function runCli(args, options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  delete env.SNIPARA_API_KEY;
  delete env.SNIPARA_PROJECT_ID;
  delete env.SNIPARA_API_URL;
  delete env.SNIPARA_SESSION_ID;
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env,
  });
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Snipara Test",
      GIT_AUTHOR_EMAIL: "test@snipara.local",
      GIT_COMMITTER_NAME: "Snipara Test",
      GIT_COMMITTER_EMAIL: "test@snipara.local",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-context-control-"));
  runGit(dir, ["init", "-b", "dev"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# Fixture\n", "utf8");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "initial"]);
  return dir;
}

function extractContextControlPlanExamples(markdown) {
  const lines = markdown.split(/\r?\n/);
  const examples = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.includes("snipara-companion") || !line.includes("context-control plan")) continue;
    let command = line;
    while (command.endsWith("\\") && index + 1 < lines.length) {
      command = `${command.slice(0, -1).trimEnd()} ${lines[(index += 1)].trim()}`;
    }
    examples.push(command);
  }
  return examples;
}

test("published context-control plan examples use the supported CLI contract", () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  const fullReference = fs.readFileSync(
    path.join(__dirname, "..", "docs", "FULL_REFERENCE.md"),
    "utf8"
  );
  const expectedPlanPath = ".snipara/context-control/plans/demo.json";

  assert.match(
    readme,
    /context-control plan \\\n\s+--summary "record reviewed context state" \\\n\s+--output \.snipara\/context-control\/plans\/demo\.json/
  );
  assert.match(
    fullReference,
    /context-control plan --summary "record reviewed context state" --output \.snipara\/context-control\/plans\/demo\.json/
  );
  for (const publishedDoc of [readme, fullReference]) {
    const examples = extractContextControlPlanExamples(publishedDoc);
    assert.ok(examples.length > 0);
    for (const example of examples) {
      assert.doesNotMatch(example, /--operation\b/);
      assert.doesNotMatch(example, /--content\b/);
      const explicitTarget = example.match(/--target\s+(\S+)/)?.[1];
      if (explicitTarget) assert.match(explicitTarget, /^\.snipara\/context-control\//);
    }
  }

  const dir = createRepo();
  const result = runCli(
    [
      "context-control",
      "plan",
      "--summary",
      "record reviewed context state",
      "--output",
      expectedPlanPath,
      "--json",
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(dir, expectedPlanPath)), true);
});

test("context-control plan rejects targets outside its bounded write scope", () => {
  const dir = createRepo();
  const result = runCli(
    ["context-control", "plan", "--summary", "invalid target", "--target", "demo.json"],
    { cwd: dir }
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stderr || result.stdout,
    /Context-control apply can only write under \.snipara\/context-control/
  );
});

test("context-control plan and apply write local receipts idempotently", () => {
  const dir = createRepo();
  const planPath = ".snipara/context-control/plans/plan.json";
  const planResult = runCli(
    [
      "context-control",
      "plan",
      "--summary",
      "Preview memory state",
      "--output",
      planPath,
      "--json",
    ],
    { cwd: dir }
  );

  assert.equal(planResult.status, 0, planResult.stderr || planResult.stdout);
  const planPayload = JSON.parse(planResult.stdout);
  assert.equal(planPayload.plan.schemaVersion, "snipara.context_mutation_plan.v0");
  assert.equal(fs.existsSync(path.join(dir, planPath)), true);

  const applyResult = runCli(["context-control", "apply", "--plan", planPath, "--json"], {
    cwd: dir,
  });
  assert.equal(applyResult.status, 0, applyResult.stderr || applyResult.stdout);
  const applyPayload = JSON.parse(applyResult.stdout);
  assert.equal(applyPayload.receipt.status, "applied");
  assert.equal(
    applyPayload.writtenFiles.includes(".snipara/context-control/state/preview-memory-state.json"),
    true
  );
  assert.equal(
    applyPayload.writtenFiles.some((file) =>
      /^\.snipara\/context-control\/applied\/ctxapply-[a-f0-9]{16}\.json$/.test(file)
    ),
    true
  );
  assert.equal(
    fs.existsSync(path.join(dir, ".snipara/context-control/state/preview-memory-state.json")),
    true
  );

  const secondApply = runCli(["context-control", "apply", "--plan", planPath, "--json"], {
    cwd: dir,
  });
  assert.equal(secondApply.status, 0, secondApply.stderr || secondApply.stdout);
  const secondPayload = JSON.parse(secondApply.stdout);
  assert.equal(secondPayload.receipt.status, "already_applied");
  assert.deepEqual(secondPayload.writtenFiles, []);
});

test("context-control apply rejects stale Git base by default", () => {
  const dir = createRepo();
  const planPath = ".snipara/context-control/plans/plan.json";
  const planResult = runCli(
    ["context-control", "plan", "--summary", "Preview stale base", "--output", planPath, "--json"],
    { cwd: dir }
  );
  assert.equal(planResult.status, 0, planResult.stderr || planResult.stdout);

  fs.appendFileSync(path.join(dir, "README.md"), "\nchange\n", "utf8");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "move base"]);

  const applyResult = runCli(["context-control", "apply", "--plan", planPath, "--json"], {
    cwd: dir,
  });
  assert.equal(applyResult.status, 1);
  const payload = JSON.parse(applyResult.stdout);
  assert.equal(payload.receipt.status, "stale_base");
  assert.equal(
    fs.existsSync(path.join(dir, ".snipara/context-control/state/preview-stale-base.json")),
    false
  );
});

test("context-control drift reports pending and applied mutation plans", () => {
  const dir = createRepo();
  const planPath = ".snipara/context-control/plans/plan.json";
  const planResult = runCli(
    ["context-control", "plan", "--summary", "Preview drift state", "--output", planPath, "--json"],
    { cwd: dir }
  );
  assert.equal(planResult.status, 0, planResult.stderr || planResult.stdout);

  const pendingDrift = runCli(["context-control", "drift", "--json"], { cwd: dir });
  assert.equal(pendingDrift.status, 0, pendingDrift.stderr || pendingDrift.stdout);
  const pendingPayload = JSON.parse(pendingDrift.stdout);
  assert.equal(pendingPayload.schemaVersion, "snipara.project_drift_report.v0");
  assert.equal(pendingPayload.state, "DRIFT_DETECTED");
  assert.ok(
    pendingPayload.signals.some(
      (signal) =>
        signal.surface === "context_control" &&
        signal.state === "DRIFT_DETECTED" &&
        signal.reasonCodes.includes("context_control_plan_pending_apply")
    )
  );

  const applyResult = runCli(["context-control", "apply", "--plan", planPath, "--json"], {
    cwd: dir,
  });
  assert.equal(applyResult.status, 0, applyResult.stderr || applyResult.stdout);

  const appliedDrift = runCli(["context-control", "drift", "--json"], { cwd: dir });
  assert.equal(appliedDrift.status, 0, appliedDrift.stderr || appliedDrift.stdout);
  const appliedPayload = JSON.parse(appliedDrift.stdout);
  assert.ok(
    appliedPayload.signals.some(
      (signal) =>
        signal.surface === "context_control" &&
        signal.state === "IN_SYNC" &&
        signal.reasonCodes.includes("context_control_plan_applied")
    )
  );
});

test("context-control validates and reconciles a ProjectContext manifest", () => {
  const dir = createRepo();
  const manifestPath = path.join(dir, "snipara.project-context.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: "snipara.project_context_manifest.v0",
        project: { id: "proj_test", name: "Fixture" },
        sources: [{ path: "README.md", authority: "canonical", tier: "HOT" }],
        policies: [
          {
            id: "release-review",
            scope: "release",
            requirement: "Run release checks before deploy.",
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );

  const validateResult = runCli(["context-control", "validate", "--json"], { cwd: dir });
  assert.equal(validateResult.status, 0, validateResult.stderr || validateResult.stdout);
  const validation = JSON.parse(validateResult.stdout);
  assert.equal(validation.schemaVersion, "snipara.project_context_validation.v0");
  assert.equal(validation.status, "valid");

  const planPath = ".snipara/context-control/plans/project-context.json";
  const planResult = runCli(
    [
      "context-control",
      "plan",
      "--manifest",
      "snipara.project-context.json",
      "--output",
      planPath,
      "--json",
    ],
    { cwd: dir }
  );
  assert.equal(planResult.status, 0, planResult.stderr || planResult.stdout);
  const planPayload = JSON.parse(planResult.stdout);
  assert.equal(planPayload.plan.producer.kind, "project_context_manifest");
  assert.equal(
    planPayload.plan.operations[0].target,
    ".snipara/context-control/state/project-context-manifest.json"
  );

  const applyResult = runCli(["context-control", "apply", "--plan", planPath, "--json"], {
    cwd: dir,
  });
  assert.equal(applyResult.status, 0, applyResult.stderr || applyResult.stdout);
  const state = JSON.parse(
    fs.readFileSync(
      path.join(dir, ".snipara/context-control/state/project-context-manifest.json"),
      "utf8"
    )
  );
  assert.equal(state.validation.status, "valid");

  const driftResult = runCli(["context-control", "drift", "--json"], { cwd: dir });
  assert.equal(driftResult.status, 0, driftResult.stderr || driftResult.stdout);
  const drift = JSON.parse(driftResult.stdout);
  assert.ok(
    drift.signals.some(
      (signal) =>
        signal.surface === "project_context_manifest" &&
        signal.state === "IN_SYNC" &&
        signal.reasonCodes.includes("project_context_manifest_valid")
    )
  );
});
