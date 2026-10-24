const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const test = require("node:test");
const { executeTaskJourney, buildTaskJourneyCard, formatTaskJourneyCard, createTaskIntake, writeTaskIntake, taskIntakeHash, validateTaskIntake } = require("../dist/index.js");

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-task-journey-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--initial-branch=dev"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".snipara/\n"); fs.writeFileSync(path.join(cwd, "code.txt"), "source\n");
  git("add", "."); git("commit", "-m", "fixture");
  const input = { goal: "Preserve the expected behavior", criteria: ["The known example succeeds"], files: ["code.txt"], verification: ["node known-check.js"] };
  const run = (action, extra = {}) => executeTaskJourney({ cwd, slug: "known-task", action, ...extra });
  const state = () => JSON.parse(fs.readFileSync(path.join(cwd, ".snipara/workflow/current.json")));
  return { cwd, git, input, run, state };
}
async function environment(values, fn) {
  const original = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try { for (const [key, value] of Object.entries(values)) { if (value == null) delete process.env[key]; else process.env[key] = value; } return await fn(); }
  finally { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
function blockNetwork(f) {
  const marker = path.join(f.cwd, ".snipara/network-attempts.jsonl");
  const preload = path.join(f.cwd, "block-network.cjs");
  fs.writeFileSync(preload, `globalThis.fetch=async()=>{require('node:fs').appendFileSync(${JSON.stringify(marker)},'called\\n');throw new Error('unexpected network')}`);
  f.git("add", "block-network.cjs"); f.git("commit", "-m", "transport fixture");
  return { marker, preload };
}
function controller(f, dossier) {
  const bin = path.join(f.cwd, ".snipara/bin/snipara-orchestrator"); fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(dossier))});\n`, { mode: 0o700 });
  return bin;
}

test("local framing and preparation reuse feature/workflow without GitHub, account or Orchestrator", async (t) => {
  const f = fixture(t), transport = blockNetwork(f);
  await environment({ NODE_OPTIONS: `--require=${transport.preload}`, SNIPARA_API_KEY: "configured-fixture-key", SNIPARA_PROJECT_ID: "fixture" }, async () => {
    const card = await f.run("start", { input: f.input });
    assert.equal(card.schemaVersion, "snipara.task_journey.v1"); assert.equal(card.status, "ready", JSON.stringify(card.blockers));
    assert.equal(f.state().goal, f.input.goal); assert.equal(f.state().coordination.mode, "standard");
    assert.equal(fs.existsSync(path.join(f.cwd, ".snipara/tasks/known-task/feature.json")), true);
    assert.deepEqual(card.steps.map((item) => item.id), ["frame", "work", "verify", "decide", "resume"]);
    const working = await f.run("work"); assert.equal(working.status, "working");
    assert.equal(working.runtimeDelivery.status, "caller_output_observed");
    assert.equal(working.authority.executionGranted, false); assert.equal(working.authority.semanticUseVerified, false);
    assert.equal(fs.existsSync(transport.marker), false, "local-only opt-in must suppress account/global configuration calls");
    assert.equal(fs.existsSync(path.join(f.cwd, ".snipara/orchestrator")), false);
  });
});

test("incomplete framing cannot prepare work or replace an existing workflow", async (t) => {
  const f = fixture(t); const card = await f.run("start", { input: { ...f.input, criteria: [] } });
  assert.equal(card.status, "needs_clarification"); assert.equal(card.task.goal, f.input.goal);
  assert.equal(fs.existsSync(path.join(f.cwd, ".snipara/workflow/current.json")), false);
  assert.equal((await f.run("start", { input: f.input })).status, "ready");
});

test("repeat admission is idempotent and an unrelated active workflow is preserved", async (t) => {
  const f = fixture(t); await f.run("start", { input: f.input }); const original = fs.readFileSync(path.join(f.cwd, ".snipara/workflow/current.json"), "utf8");
  await f.run("start", { input: f.input });
  assert.equal(fs.readFileSync(path.join(f.cwd, ".snipara/workflow/current.json"), "utf8"), original);
  await assert.rejects(executeTaskJourney({ cwd: f.cwd, slug: "other-task", action: "start", input: f.input }), /active workflow was preserved/);
  assert.equal(fs.readFileSync(path.join(f.cwd, ".snipara/workflow/current.json"), "utf8"), original);
  await assert.rejects(f.run("start", { input: { ...f.input, criteria: ["Different contract"] } }), /contract differs/);
});

test("repeat admission binds stable source provenance while ignoring its observation time", async (t) => {
  const f = fixture(t);
  f.git("remote", "add", "origin", "https://github.com/acme/example.git");
  const base = createTaskIntake({ workspaceRoot: f.cwd, ...f.input }).brief;
  const sourceContext = { title: "Same title", body: "Same body", redacted: false };
  const bodySha256 = require("node:crypto").createHash("sha256").update(sourceContext.body).digest("hex");
  const intakeFor = (changes = {}) => {
    const content = { ...base, sourceContext, source: { kind: "github", repository: "acme/example", issueNumber: 7,
      url: "https://github.com/acme/example/issues/7", updatedAt: "2026-10-19T10:00:00.000Z",
      bodySha256, observedAt: base.source.observedAt, authority: "untrusted_source", ...changes } };
    delete content.contentSha256;
    return validateTaskIntake({ ...content, contentSha256: taskIntakeHash(content) });
  };
  await f.run("start", { intake: intakeFor() });
  const pointer = path.join(f.cwd, ".snipara/workflow/current.json"), original = fs.readFileSync(pointer, "utf8");
  await assert.rejects(f.run("start", { intake: intakeFor({ issueNumber: 8, url: "https://github.com/acme/example/issues/8" }) }), /contract differs/);
  await assert.rejects(f.run("start", { intake: intakeFor({ updatedAt: "2026-10-19T11:00:00.000Z" }) }), /contract differs/);
  const repeated = await f.run("start", { intake: intakeFor({ observedAt: "2026-10-19T12:00:00.000Z" }) });
  assert.equal(repeated.task.intake.source.issueNumber, 7);
  assert.equal(fs.readFileSync(pointer, "utf8"), original);
});

test("façade admission refuses a concurrent lock without replacing its owner", async (t) => {
  const f = fixture(t); const file = path.join(f.cwd, ".snipara/workflow/task-journey.lock"); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "another owner");
  await assert.rejects(f.run("start", { input: f.input }), /admission lock/);
  assert.equal(fs.readFileSync(file, "utf8"), "another owner");
});

test("same dirty status with changed source bytes blocks preparation and leaves attempts untouched", async (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.cwd, "code.txt"), "before start\n"); await f.run("start", { input: f.input });
  fs.writeFileSync(path.join(f.cwd, "code.txt"), "changed again\n");
  const card = await f.run("work"); assert.equal(card.status, "blocked");
  assert.equal(f.state().phases[0].tasks[0].attempt, 0); assert.equal(card.nextAction.kind, "resume");
});

test("verification and decision keep missing checks with the agent without executing declared checks", async (t) => {
  const f = fixture(t); f.input.verification = ["touch forbidden-proof-effect"];
  await f.run("start", { input: f.input }); await f.run("work");
  const verified = await f.run("verify"); assert.equal(verified.verificationPlan.version, "snipara.verification_plan.v1");
  assert.equal(fs.existsSync(path.join(f.cwd, "forbidden-proof-effect")), false);
  const decision = await f.run("decide"); assert.equal(decision.recommendation.action, "block");
  assert.equal(decision.supervision.owner, "agent"); assert.equal(decision.supervision.disposition, "verify");
  assert.equal(decision.recommendation.fresh, false); assert.equal(decision.authority.integrationGranted, false);
  const shown = buildTaskJourneyCard({ cwd: f.cwd, slug: "known-task" });
  assert.equal(shown.task.intakeSha256, decision.task.intakeSha256);
  assert.match(formatTaskJourneyCard(decision), /Cadrer:.*recorded/);
});

test("declared completion and local closeout never become observed functional success", async (t) => {
  const f = fixture(t), transport = blockNetwork(f);
  await environment({ NODE_OPTIONS: `--require=${transport.preload}` }, async () => {
    await f.run("start", { input: f.input }); await f.run("work");
    const result = await f.run("work", { summary: "Agent declares its change done", outcome: "completed", evidence: ["unknown:host checks not observed"] });
    assert.equal(result.status, "verification_required");
    assert.equal(result.steps.find((item) => item.id === "verify").status, "unverified");
    const closed = await f.run("close", { summary: "Handed to human review", outcome: "completed" });
    assert.equal(closed.status, "closed", JSON.stringify(closed.blockers));
    assert.equal(closed.recommendation.action, "block"); assert.equal(closed.authority.declarationsAreFunctionalProof, false);
    const saved = f.state(); assert.equal(saved.phaseCommitReceipts[0].hostedStatus, "local_fallback");
    assert.equal(fs.existsSync(transport.marker), false);
  });
});

test("failed attempts retain the error and require an explicit reason before retry", async (t) => {
  const f = fixture(t); await f.run("start", { input: f.input }); await f.run("work");
  await f.run("work", { summary: "Parser failed on empty input", outcome: "blocked", why: "Keep old behavior" });
  await assert.rejects(f.run("work"), /explicit reason/);
  const retried = await f.run("work", { why: "Reuse the existing empty-input branch" });
  assert.equal(retried.status, "working");
  assert.equal(f.state().phases[0].tasks[0].attempt, 2);
  assert.match(f.state().phases[0].tasks[0].attemptHistory[0].recoveryReason, /existing empty-input branch/);
});

test("closing completed work requires an explicit outcome and recorded task result", async (t) => {
  const f = fixture(t); await f.run("start", { input: f.input });
  await assert.rejects(f.run("close", { summary: "done" }), /explicit summary and declared outcome/);
  await assert.rejects(f.run("close", { summary: "done", outcome: "completed" }), /Record each task outcome/);
  assert.equal(f.state().status, "active");
});

test("fresh dossier requires explicit existing Controller binding and preserves its recommendation as non-authorizing", async (t) => {
  const f = fixture(t); await f.run("start", { input: f.input });
  const dossier = { schemaVersion: "snipara.evidence_dossier.v1", subject: { controllerId: "controller-fixture", candidateId: "candidate-fixture", repository: { path: f.cwd } },
    contract: { objective: f.input.goal, featureAcceptance: { criteria: f.input.criteria }, scope: [{ files: f.input.files, acceptance: f.input.criteria }] },
    after: { candidateCommitSha: "a".repeat(40), candidateTreeSha: "b".repeat(40) },
    commands: [{ command: "node known-check.js", status: "passed", passed: true, exitCode: 0,
      authority: "host_runner_observed", evidenceRef: "evaluation-fixture", cwdIdentity: { candidateCommitSha: "a".repeat(40), candidateTreeSha: "b".repeat(40) } }],
    gates: [{ id: "proof", required: true, status: "passed" }], recommendation: { action: "integrate" } };
  const bin = controller(f, { dossier });
  const card = await f.run("decide", { refreshDossier: true, controllerId: "controller-fixture", candidateId: "candidate-fixture", orchestratorBin: bin });
  assert.equal(card.status, "integration_possible"); assert.equal(card.recommendation.fresh, true);
  assert.equal(card.authority.integrationGranted, false); assert.equal(card.nextAction.kind, "show");
  assert.deepEqual(card.dossier, dossier);
});

test("an unrelated Controller dossier or an unknown mandatory gate cannot produce integration_possible", async (t) => {
  const f = fixture(t); await f.run("start", { input: f.input });
  let dossier = { schemaVersion: "snipara.evidence_dossier.v1", subject: { controllerId: "controller-fixture", candidateId: "candidate-fixture", repository: { path: f.cwd } },
    contract: { objective: "Other task", featureAcceptance: { criteria: f.input.criteria }, scope: [{ files: f.input.files, acceptance: f.input.criteria }] },
    recommendation: { action: "integrate" } };
  let bin = controller(f, { dossier });
  const options = { refreshDossier: true, controllerId: "controller-fixture", candidateId: "candidate-fixture", orchestratorBin: bin };
  await assert.rejects(f.run("decide", options), /objective is not bound/);
  dossier.contract.objective = f.input.goal; dossier.gates = [{ required: true, status: "unknown" }]; bin = controller(f, { dossier });
  await assert.rejects(f.run("decide", { ...options, orchestratorBin: bin }), /mandatory gate results/);
  dossier.gates[0].status = "passed"; dossier.contract.scope[0].files = ["other-file.txt"]; bin = controller(f, { dossier });
  await assert.rejects(f.run("decide", { ...options, orchestratorBin: bin }), /declared scope/);
});

test("long Unicode chunk bodies survive public task preparation and resume exactly", async (t) => {
  const f = fixture(t), body = "🙂é漢".repeat(6000);
  const preload = path.join(f.cwd, "hosted-context.cjs"), calls = path.join(f.cwd, ".snipara/hosted-calls.jsonl");
  fs.writeFileSync(preload, `globalThis.fetch=async(url,init)=>{const q=JSON.parse(init.body);require('node:fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(q.params.name)+'\\n');const data=q.params.name==='snipara_context_query'?{section_refs:[{chunk_id:'known-long'}]}:q.params.name==='snipara_get_chunk'?{found:true,chunk_id:'known-long',content:${JSON.stringify(body)},token_count:100}:{};return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{content:[{type:'text',text:JSON.stringify(data)}]}}))}`);
  f.git("add", "hosted-context.cjs"); f.git("commit", "-m", "context fixture");
  fs.mkdirSync(path.join(f.cwd, ".snipara/companion"), { recursive: true });
  fs.writeFileSync(path.join(f.cwd, ".snipara/companion/config.json"), JSON.stringify({ apiKey: "fixture-context-key", projectId: "fixture", apiUrl: "https://fixture.invalid" }));
  await environment({ NODE_OPTIONS: `--require=${preload}` }, async () => {
    await f.run("start", { input: f.input, contextRequest: { queries: ["known-long"], maxTokens: 16000 } });
    assert.equal(fs.existsSync(calls), false, "framing does not retrieve context");
    const work = await f.run("work");
    assert.equal(work.preparedContext.context.chunks[0].content, body);
    assert.equal(work.preparedContext.context.chunks[0].content.length, body.length);
    const before = fs.readFileSync(calls, "utf8");
    const resume = await f.run("resume"); assert.equal(resume.preparedContext.context.chunks[0].content, body);
    assert.equal(fs.readFileSync(calls, "utf8"), before, "resume does not refresh remotely");
    assert.equal(resume.runtimeDelivery.semanticUseVerified, false);
  });
});

test("oversized optional activity metadata does not fail local STANDARD task admission", async (t) => {
  const f = fixture(t); fs.mkdirSync(path.join(f.cwd, ".snipara/activity"), { recursive: true });
  fs.writeFileSync(path.join(f.cwd, ".snipara/activity/timeline.jsonl"), Buffer.alloc(5 * 1024 * 1024, 32));
  // The façade's STANDARD local route also leaves the optional observer unavailable.
  const card = await f.run("start", { input: f.input }); assert.equal(card.status, "ready");
  assert.equal(f.state().goal, f.input.goal);
});

test("FULL coordination preserves saved workflow when its optional session snapshot is oversized", (t) => {
  const f = fixture(t); fs.mkdirSync(path.join(f.cwd, ".snipara/activity"), { recursive: true });
  fs.writeFileSync(path.join(f.cwd, ".snipara/activity/timeline.jsonl"), Buffer.alloc(5 * 1024 * 1024, 32));
  fs.writeFileSync(path.join(f.cwd, ".snipara/full-plan.json"), JSON.stringify({ mode: "full", steps: [{ id: "work", query: f.input.goal, files: f.input.files }] }));
  const result = spawnSync(process.execPath, [require.resolve("../dist/index.js"), "workflow", "start", "--goal", f.input.goal,
    "--plan-file", ".snipara/full-plan.json", "--skip-agent-context", "--json"], { cwd: f.cwd, encoding: "utf8", timeout: 15000,
    env: { ...process.env, SNIPARA_LOCAL_ONLY: "1", SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK: "1" } });
  assert.equal(result.status, 0, result.stderr || result.stdout); assert.equal(f.state().coordination.mode, "full");
  assert.match(result.stderr, /Supplemental session snapshot unavailable/);
});

test("saved clean intake cannot silently adopt source changes made before task start", async (t) => {
  const f = fixture(t), intake = createTaskIntake({ workspaceRoot: f.cwd, ...f.input }).brief;
  fs.writeFileSync(path.join(f.cwd, "code.txt"), "changed after the saved brief\n");
  await assert.rejects(f.run("start", { intake }), /requires revalidation before admission/);
  assert.equal(fs.existsSync(path.join(f.cwd, ".snipara/workflow/current.json")), false);
  assert.equal(fs.existsSync(path.join(f.cwd, ".snipara/tasks/known-task/feature.json")), false);
});

test("only the exact newly exported brief artifact may be excluded from saved-intake admission", async (t) => {
  const f = fixture(t), intake = createTaskIntake({ workspaceRoot: f.cwd, ...f.input }).brief;
  writeTaskIntake(f.cwd, "selected-brief.json", intake);
  const card = await f.run("start", { intake, intakePath: "selected-brief.json" });
  assert.equal(card.status, "ready", JSON.stringify(card.blockers));
});

test("administrative brief exclusion does not hide other files or overwrite preexisting dirty artifacts", async (t) => {
  const f = fixture(t), intake = createTaskIntake({ workspaceRoot: f.cwd, ...f.input }).brief;
  writeTaskIntake(f.cwd, "selected-brief.json", intake); fs.writeFileSync(path.join(f.cwd, "unrelated.txt"), "new unexplained change");
  await assert.rejects(f.run("start", { intake, intakePath: "selected-brief.json" }), /requires revalidation/);
  fs.unlinkSync(path.join(f.cwd, "unrelated.txt")); fs.unlinkSync(path.join(f.cwd, "selected-brief.json"));
  fs.writeFileSync(path.join(f.cwd, "selected-brief.json"), "old dirty artifact");
  const later = createTaskIntake({ workspaceRoot: f.cwd, ...f.input }).brief;
  fs.writeFileSync(path.join(f.cwd, "selected-brief.json"), JSON.stringify(later));
  await assert.rejects(f.run("start", { intake: later, intakePath: "selected-brief.json" }), /requires revalidation/);
});

test("explicit outcome records real in-scope source changes while preserving unknown functional verification", async (t) => {
  const f = fixture(t); await f.run("start", { input: f.input }); await f.run("work");
  fs.writeFileSync(path.join(f.cwd, "code.txt"), "actual intended change\n");
  const recorded = await f.run("work", { summary: "Changed the agreed source file", outcome: "completed", evidence: ["unknown:external check not observed"] });
  assert.equal(recorded.status, "verification_required", JSON.stringify(recorded.blockers));
  assert.equal(f.state().phases[0].tasks[0].status, "completed");
  assert.equal(recorded.continuity.status, "exact_snapshot");
  assert.equal(recorded.steps.find((item) => item.id === "verify").status, "unverified");
  assert.equal(fs.readFileSync(path.join(f.cwd, "code.txt"), "utf8"), "actual intended change\n");
});

test("explicit outcome cannot absorb out-of-scope source changes or staged-index drift", async (t) => {
  const f = fixture(t); await f.run("start", { input: f.input }); await f.run("work");
  fs.writeFileSync(path.join(f.cwd, "other.txt"), "unagreed change\n");
  let card = await f.run("work", { summary: "Claim done", outcome: "completed" });
  assert.equal(card.status, "blocked"); assert.equal(f.state().phases[0].tasks[0].status, "in_progress");
  fs.unlinkSync(path.join(f.cwd, "other.txt")); fs.writeFileSync(path.join(f.cwd, "code.txt"), "staged change\n"); f.git("add", "code.txt");
  fs.writeFileSync(path.join(f.cwd, "code.txt"), "source\n");
  card = await f.run("work", { summary: "Claim done", outcome: "completed" });
  assert.equal(card.status, "blocked"); assert.ok(card.continuity.changes.includes("index"));
  assert.equal(f.state().phases[0].tasks[0].status, "in_progress");
});

test("saved task artifacts without a bound current workflow offer inspection rather than an impossible work action", async (t) => {
  const f = fixture(t); await f.run("start", { input: f.input });
  const pointer = path.join(f.cwd, ".snipara/workflow/current.json"), saved = fs.readFileSync(pointer, "utf8");
  fs.unlinkSync(pointer);
  let card = await f.run("show"); assert.equal(card.status, "blocked"); assert.equal(card.nextAction.kind, "show");
  assert.match(card.blockers.join("\n"), /no current workflow pointer/);
  const other = JSON.parse(saved); other.workflowId = "unrelated-workflow"; fs.writeFileSync(pointer, JSON.stringify(other));
  card = await f.run("show"); assert.equal(card.status, "blocked"); assert.equal(card.nextAction.kind, "show");
  assert.match(card.blockers.join("\n"), /another current workflow was preserved/);
  assert.equal(f.state().workflowId, "unrelated-workflow");
});

test("fresh dossier cannot replace selected verification with another green command or an unbound declaration", async (t) => {
  const f = fixture(t); await f.run("start", { input: f.input });
  const dossier = { schemaVersion: "snipara.evidence_dossier.v1", subject: { controllerId: "controller-fixture", candidateId: "candidate-fixture", repository: { path: f.cwd } },
    contract: { objective: f.input.goal, featureAcceptance: { criteria: f.input.criteria }, scope: [{ files: f.input.files, acceptance: f.input.criteria }] },
    after: { candidateCommitSha: "a".repeat(40), candidateTreeSha: "b".repeat(40) },
    gates: [{ id: "policy", required: true, status: "passed" }], recommendation: { action: "integrate" },
    commands: [{ command: "git diff --check", status: "passed", passed: true, exitCode: 0, authority: "host_runner_observed", evidenceRef: "evaluation-fixture",
      cwdIdentity: { candidateCommitSha: "a".repeat(40), candidateTreeSha: "b".repeat(40) } }] };
  const options = { refreshDossier: true, controllerId: "controller-fixture", candidateId: "candidate-fixture" };
  let bin = controller(f, { dossier });
  await assert.rejects(f.run("decide", { ...options, orchestratorBin: bin }), /Selected verification command/);
  dossier.commands[0].command = "node known-check.js"; dossier.commands[0].authority = "caller_declaration"; bin = controller(f, { dossier });
  await assert.rejects(f.run("decide", { ...options, orchestratorBin: bin }), /Selected verification command/);
  dossier.commands[0].authority = "host_runner_observed"; dossier.commands[0].cwdIdentity.candidateCommitSha = "c".repeat(40); bin = controller(f, { dossier });
  await assert.rejects(f.run("decide", { ...options, orchestratorBin: bin }), /Selected verification command/);
  dossier.commands[0].cwdIdentity.candidateCommitSha = "a".repeat(40); dossier.commands[0].status = "not_run"; dossier.commands[0].passed = false;
  bin = controller(f, { dossier }); await assert.rejects(f.run("decide", { ...options, orchestratorBin: bin }), /Selected verification command/);
});

for (const pattern of ["c[od]*.txt", "{code,other}*.txt"]) {
  test(`unsupported scope ${pattern} requires clarification and cannot record completion`, async (t) => {
    const f = fixture(t); f.input.files = [pattern];
    let card = await f.run("start", { input: f.input });
    assert.equal(card.status, "blocked"); assert.match(card.nextAction.expectedResult, /Clarify the scope/);
    assert.match(card.notices.join("\n"), /bracket\/brace patterns require explicit scope clarification/);
    card = await f.run("work"); assert.equal(card.status, "blocked"); assert.match(card.nextAction.expectedResult, /Clarify the scope/);
    assert.equal(f.state().phases[0].tasks[0].attempt, 0);
    fs.writeFileSync(path.join(f.cwd, "code.txt"), "change not admitted by unsupported matcher\n");
    card = await f.run("work", { summary: "Declared done", outcome: "completed" });
    assert.equal(card.status, "blocked"); assert.notEqual(f.state().phases[0].tasks[0].status, "completed");
  });
}
