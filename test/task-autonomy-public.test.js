/** Public CLI acceptance. Synthetic repositories/dossiers do not prove native execution. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const override = process.env.SNIPARA_COMPANION_TEST_CLI;
const cli = path.resolve(override === undefined ? path.join(__dirname, "../dist/index.js") : override);
if (override !== undefined && (!override || !fs.existsSync(cli) || !fs.statSync(cli).isFile()))
  throw new Error(`SNIPARA_COMPANION_TEST_CLI must name an existing CLI file: ${override}`);

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-autonomy-public-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...argv) => execFileSync("git", argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--initial-branch=dev", "-q");
  git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".snipara/\n");
  fs.writeFileSync(path.join(cwd, "service.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(cwd, "other.js"), "module.exports = 2;\n");
  git("add", "."); git("commit", "-qm", "fixture");
  const folder = path.join(cwd, ".snipara"); fs.mkdirSync(folder);
  const calls = path.join(folder, "implicit-calls.jsonl"), preload = path.join(folder, "deny-network.cjs");
  fs.writeFileSync(preload, `globalThis.fetch=async()=>{require('node:fs').appendFileSync(${JSON.stringify(calls)},'network\\n');throw new Error('UNEXPECTED NETWORK');};`);
  const proofMarker = path.join(folder, "proof-executed");
  fs.writeFileSync(path.join(folder, "required-check.cjs"), `require('node:fs').writeFileSync(${JSON.stringify(proofMarker)},'ran');`);
  const check = "node .snipara/required-check.cjs";
  function run(args) {
    return spawnSync(process.execPath, ["--require", preload, cli, "task", ...args], {
      cwd, encoding: "utf8", timeout: 30000,
      env: { ...process.env, NODE_OPTIONS: `--require=${preload}`, SNIPARA_LOCAL_ONLY: "1",
        SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK: "1", SNIPARA_API_KEY: "fixture-only", SNIPARA_PROJECT_ID: "fixture-only" },
    });
  }
  function json(args) {
    const r = run([...args, "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return JSON.parse(r.stdout);
  }
  const start = (extras = []) => json(["start", "Preserve agreed service behavior", "--id", "bounded-task",
    "--accept", "The agreed service output is preserved", "--file", "service.js", "--check", check, ...extras]);
  const stateFile = path.join(folder, "workflow/current.json");
  const state = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
  function unchangedEffects(card) {
    assert.equal(card.authority.executionGranted, false);
    assert.equal(card.authority.integrationGranted, false);
    assert.equal(card.authority.deploymentGranted, false);
    assert.equal(card.nextAction.automaticExecution, false);
    assert.equal(card.nextAction.dispatchesAgent, false);
    assert.equal(fs.existsSync(calls), false, "local guidance made an implicit hosted call");
    assert.equal(fs.existsSync(proofMarker), false, "local guidance executed a declared proof command");
    assert.equal(fs.existsSync(path.join(folder, "orchestrator")), false, "Companion silently created an Orchestrator");
  }
  return { cwd, git, run, json, start, state, stateFile, check, unchangedEffects };
}

function supervision(card, expected) {
  assert.ok(card.supervision && typeof card.supervision === "object", "public task card has no supervision projection");
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map((key) => [key, card.supervision[key]])), expected);
  assert.ok(Array.isArray(card.supervision.reasonCodes) && card.supervision.reasonCodes.length > 0);
  assert.ok(card.supervision.reasonCodes.every((value) => typeof value === "string" && value.length > 0));
  assert.ok(typeof card.supervision.reason === "string" && card.supervision.reason.length > 0);
}

test("public complete local framing assigns routine work to the agent without granting execution", (t) => {
  const f = fixture(t), card = f.start();
  supervision(card, { owner: "agent", disposition: "continue", humanRequired: false });
  f.unchangedEffects(card);
  assert.equal(f.state().phases[0].tasks[0].attempt, 0);
  assert.equal(f.git("rev-parse", "--abbrev-ref", "HEAD").trim(), "dev");
});

test("public missing framing asks for the missing choice rather than proposing autonomous work", (t) => {
  for (const missing of ["criteria", "scope"]) {
    const f = fixture(t);
    const argv = ["start", "Preserve service behavior", "--id", "incomplete-task", "--check", f.check];
    if (missing !== "criteria") argv.push("--accept", "Preserve output");
    if (missing !== "scope") argv.push("--file", "service.js");
    const card = f.json(argv);
    supervision(card, { owner: "human", disposition: "decision", humanRequired: true });
    f.unchangedEffects(card);
    assert.equal(fs.existsSync(f.stateFile), false, "incomplete framing created an executable-looking workflow");
  }
});

test("public ongoing work continues and explicit verification or decision keeps missing proof with the agent", (t) => {
  const f = fixture(t); f.start();
  const work = f.json(["work", "bounded-task"]);
  supervision(work, { owner: "agent", disposition: "continue", humanRequired: false });
  const verify = f.json(["verify", "bounded-task"]);
  assert.ok(verify.verificationPlan);
  supervision(verify, { owner: "agent", disposition: "verify", humanRequired: false });
  const decision = f.json(["decide", "bounded-task"]);
  supervision(decision, { owner: "agent", disposition: "verify", humanRequired: false });
  assert.notEqual(decision.status, "review_required");
  assert.equal(decision.recommendation.action, "block");
  assert.equal(decision.recommendation.source, "verification_not_observed");
  for (const card of [work, verify, decision]) f.unchangedEffects(card);
});

test("public declared completion remains an agent verification task and does not prove functional success", (t) => {
  const f = fixture(t); f.start(); f.json(["work", "bounded-task"]);
  fs.writeFileSync(path.join(f.cwd, "service.js"), "module.exports = 1; // agreed implementation\n");
  const card = f.json(["work", "bounded-task", "--summary", "Agent declares the scoped change done",
    "--outcome", "completed", "--evidence", "unknown:required check has not been observed"]);
  supervision(card, { owner: "agent", disposition: "verify", humanRequired: false });
  assert.equal(card.status, "verification_required");
  assert.equal(card.steps.find((step) => step.id === "verify").status, "unverified");
  assert.equal(card.authority.declarationsAreFunctionalProof, false);
  f.unchangedEffects(card);
});

test("public scoped edits during implementation remain agent work without adopting a replacement snapshot", (t) => {
  const f = fixture(t); f.start(); f.json(["work", "bounded-task"]);
  const before = fs.readFileSync(f.stateFile, "utf8");
  fs.writeFileSync(path.join(f.cwd, "service.js"), "module.exports = 1; // implementation in progress\n");
  const shown = f.json(["show", "bounded-task"]);
  supervision(shown, { owner: "agent", disposition: "continue", humanRequired: false });
  assert.equal(shown.status, "working");
  const verification = f.json(["verify", "bounded-task"]);
  supervision(verification, { owner: "agent", disposition: "verify", humanRequired: false });
  assert.equal(fs.readFileSync(f.stateFile, "utf8"), before, "inspection silently adopted a replacement workflow snapshot");
  f.unchangedEffects(shown); f.unchangedEffects(verification);
});

test("public recorded failed check permits scoped repair while retaining failure and explicit retry rationale", (t) => {
  const f = fixture(t); f.start(); f.json(["work", "bounded-task"]);
  const failed = f.json(["work", "bounded-task", "--summary", "Required check failed for the agreed input",
    "--outcome", "blocked", "--why", "Preserve the agreed behavior", "--evidence", "failed:required check returned the wrong output"]);
  supervision(failed, { owner: "agent", disposition: "repair", humanRequired: false });
  f.unchangedEffects(failed);
  assert.ok(f.state().phases[0].tasks[0].attempt < f.state().phases[0].tasks[0].maxAttempts);
  const noReason = f.run(["work", "bounded-task", "--json"]);
  assert.notEqual(noReason.status, 0);
  assert.match(noReason.stdout + noReason.stderr, /explicit reason/);
  const retry = f.json(["work", "bounded-task", "--why", "Correct the agreed input branch and rerun the same check"]);
  supervision(retry, { owner: "agent", disposition: "continue", humanRequired: false });
  const task = f.state().phases[0].tasks[0];
  assert.equal(task.attempt, 2);
  assert.match(JSON.stringify(task.attemptHistory), /required check returned the wrong output/);
  assert.match(JSON.stringify(task.attemptHistory), /Correct the agreed input branch/);
  f.unchangedEffects(retry);
});

test("public unexplained blockage never becomes a fabricated automatic repair", (t) => {
  const f = fixture(t); f.start(); f.json(["work", "bounded-task"]);
  const card = f.json(["work", "bounded-task", "--summary", "Work stopped for an unknown reason", "--outcome", "blocked"]);
  supervision(card, { disposition: "blocked" });
  assert.equal(f.state().phases[0].tasks[0].attempt, 1);
  f.unchangedEffects(card);
});

test("public exhausted retries preserve the existing ceiling instead of proposing another automatic repair", (t) => {
  const f = fixture(t); f.start(); f.json(["work", "bounded-task"]);
  const ceiling = f.state().phases[0].tasks[0].maxAttempts;
  assert.ok(ceiling >= 1 && ceiling <= 20, "fixture requires a finite existing retry limit");
  let card;
  for (let attempt = 1; attempt <= ceiling; attempt += 1) {
    card = f.json(["work", "bounded-task", "--summary", `Declared required check failure at attempt ${attempt}`,
      "--outcome", "blocked", "--evidence", "failed:agreed output still differs"]);
    assert.equal(f.state().phases[0].tasks[0].attempt, attempt);
    if (attempt < ceiling) {
      supervision(card, { owner: "agent", disposition: "repair", humanRequired: false });
      f.json(["work", "bounded-task", "--why", `Correct the agreed branch after attempt ${attempt}`]);
    }
  }
  assert.ok(["decision", "blocked"].includes(card.supervision.disposition));
  assert.notEqual(card.supervision.disposition, "repair");
  const before = f.state().phases[0].tasks[0];
  f.run(["work", "bounded-task", "--why", "Try beyond the existing ceiling", "--json"]);
  assert.deepEqual(f.state().phases[0].tasks[0], before);
  f.unchangedEffects(card);
});

for (const kind of ["outside_scope", "head", "index", "contract"]) {
  test(`public ${kind} drift requires a bounded human decision without absorbing the divergence`, (t) => {
    const f = fixture(t); f.start(); f.json(["work", "bounded-task"]);
    if (kind === "outside_scope") fs.writeFileSync(path.join(f.cwd, "other.js"), "module.exports = 99;\n");
    if (kind === "head") f.git("commit", "--allow-empty", "-qm", "external movement");
    if (kind === "index") {
      fs.writeFileSync(path.join(f.cwd, "service.js"), "module.exports = 99;\n"); f.git("add", "service.js");
    }
    if (kind === "contract") {
      const state = f.state(); state.phases[0].tasks[0].acceptance = "A different product decision";
      fs.writeFileSync(f.stateFile, JSON.stringify(state));
    }
    const before = fs.readFileSync(f.stateFile, "utf8");
    for (const verb of ["show", "decide", "work"]) {
      const card = f.json([verb, "bounded-task"]);
      supervision(card, { owner: "human", disposition: "decision", humanRequired: true });
      f.unchangedEffects(card);
      assert.equal(fs.readFileSync(f.stateFile, "utf8"), before, `${verb} mutated workflow during ${kind} drift`);
    }
  });
}

function syntheticDossier(f) {
  return {
    schemaVersion: "snipara.evidence_dossier.v1",
    subject: { controllerId: "synthetic-controller", candidateId: "synthetic-candidate", repository: { path: f.cwd } },
    contract: { objective: "Preserve agreed service behavior", featureAcceptance: { criteria: ["The agreed service output is preserved"] },
      scope: [{ files: ["service.js"], acceptance: ["The agreed service output is preserved"] }] },
    after: { candidateCommitSha: "a".repeat(40), candidateTreeSha: "b".repeat(40) },
    commands: [{ command: f.check, status: "passed", passed: true, exitCode: 0, authority: "host_runner_observed",
      evidenceRef: "synthetic-evaluation", cwdIdentity: { candidateCommitSha: "a".repeat(40), candidateTreeSha: "b".repeat(40) } }],
    gates: [{ id: "required-verification", required: true, status: "passed" }], recommendation: { action: "integrate" },
  };
}

function syntheticBinding(f, dossier) {
  const file = path.join(f.cwd, ".snipara/synthetic-bin/snipara-orchestrator");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ dossier }))});\n`, { mode: 0o700 });
  return ["decide", "bounded-task", "--refresh-dossier", "--controller-id", "synthetic-controller",
    "--candidate-id", "synthetic-candidate", "--orchestrator-bin", file];
}

test("public synthetic fresh dossier completes the work without granting integration or executing proof", (t) => {
  const f = fixture(t); f.start();
  const before = f.git("rev-parse", "HEAD");
  const card = f.json(syntheticBinding(f, syntheticDossier(f)));
  supervision(card, { owner: "agent", disposition: "complete", humanRequired: false });
  assert.equal(card.status, "integration_possible");
  assert.equal(card.recommendation.fresh, true);
  f.unchangedEffects(card);
  assert.equal(f.git("rev-parse", "HEAD"), before);
});

test("public fresh dossier cannot turn unrecorded scoped edits into completed work", (t) => {
  const f = fixture(t); f.start(); f.json(["work", "bounded-task"]);
  fs.writeFileSync(path.join(f.cwd, "service.js"), "module.exports = 999; // still in progress\n");
  const before = fs.readFileSync(f.stateFile, "utf8");
  const card = f.json(syntheticBinding(f, syntheticDossier(f)));
  supervision(card, { owner: "human", disposition: "decision", humanRequired: true });
  assert.equal(card.status, "blocked");
  assert.notEqual(card.supervision.disposition, "complete");
  assert.equal(fs.readFileSync(f.stateFile, "utf8"), before);
  f.unchangedEffects(card);
});

test("public synthetic dossier blocked only by an unrun prerequisite assigns verification to the agent", (t) => {
  const f = fixture(t); f.start();
  const dossier = syntheticDossier(f);
  dossier.gates = [{ id: "required-verification", category: "prerequisite", required: true, status: "not_run",
    reasonCodes: [], evidenceRefs: ["synthetic:pending-check"], nextAction: "Run the agreed check for this candidate" }];
  dossier.commands = [];
  dossier.recommendation = { action: "block", reasonCodes: ["dossier_gate_not_run"], unmetGates: ["required-verification"],
    nextActions: ["Run the agreed check for this candidate"], evidenceRefs: ["synthetic:pending-check"] };
  const card = f.json(syntheticBinding(f, dossier));
  supervision(card, { owner: "agent", disposition: "verify", humanRequired: false });
  assert.equal(card.recommendation.action, "block");
  assert.equal(card.recommendation.fresh, true);
  assert.notEqual(card.status, "integration_possible");
  assert.deepEqual(card.dossier, dossier);
  f.unchangedEffects(card);
});

for (const mutation of ["gate_unknown", "caller_claim", "foreign_candidate", "other_check"]) {
  test(`public synthetic ${mutation} cannot bypass existing dossier proof admission`, (t) => {
    const f = fixture(t); f.start();
    const dossier = syntheticDossier(f);
    if (mutation === "gate_unknown") dossier.gates[0].status = "unknown";
    if (mutation === "caller_claim") dossier.commands[0].authority = "caller_declaration";
    if (mutation === "foreign_candidate") dossier.commands[0].cwdIdentity.candidateCommitSha = "c".repeat(40);
    if (mutation === "other_check") dossier.commands[0].command = "git diff --check";
    const before = fs.readFileSync(f.stateFile, "utf8"), result = f.run([...syntheticBinding(f, dossier), "--json"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /mandatory gate|verification command/);
    assert.equal(fs.readFileSync(f.stateFile, "utf8"), before);
    f.unchangedEffects(f.json(["show", "bounded-task"]));
  });
}

test("public text export exposes responsibility with the same non-authorizing local state", (t) => {
  const f = fixture(t); f.start();
  const card = f.json(["show", "bounded-task"]), result = f.run(["export", "bounded-task", "--format", "markdown"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /agent/i);
  assert.ok(result.stdout.includes(card.supervision.reason), "text export omitted the readable supervision reason");
  f.unchangedEffects(card);
});
