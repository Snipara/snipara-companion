const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const cliOverride = process.env.SNIPARA_COMPANION_TEST_CLI;
const cli = path.resolve(cliOverride === undefined ? path.join(__dirname, "../dist/index.js") : cliOverride);
if (cliOverride !== undefined && (!cliOverride || !fs.existsSync(cli) || !fs.statSync(cli).isFile())) {
  throw new Error(`SNIPARA_COMPANION_TEST_CLI must name an existing CLI file: ${cliOverride}`);
}
const { retrieveContextPack } = require(cli);
// Assemble a synthetic canary so source scans distinguish it from credentials.
const redactionFixtureKey = ["snp", "fixturesecret12345678901234567890"].join("_");

// Each gesture runs in a fresh process. Only Hosted HTTP is replaced; repository,
// Companion state, context packs and CLI parsing are real, with no Orchestrator.
function fixture(t, { context = false } = {}) {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "continuity-public-"));
  const cwd = path.join(outer, "repo");
  fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git("init", "-b", "dev");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Continuity fixture");
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".snipara/\n");
  fs.writeFileSync(path.join(cwd, "work.txt"), "original\n");
  fs.writeFileSync(path.join(cwd, "plan.json"), JSON.stringify({ mode: "standard", steps: [{
    id: "code", title: "Repair the parser", query: "Preserve empty input", acceptance: "Empty input passes",
    files: ["work.txt"], tasks: [{ id: "edit", title: "Fix the generic parser", query: "Inspect and fix",
      acceptance: "Empty input passes without regressions", max_attempts: 3,
      verification: ["node parser.test.js"],
      ...(context ? { contextRequest: { queries: ["parser"], maxTokens: 1000 } } : {}),
    }] }]}));
  git("add", "."); git("commit", "-m", "Fixture base");
  // Preexisting changes are distinguishable from subsequent work.
  fs.writeFileSync(path.join(cwd, "work.txt"), "preexisting edit\n");
  const preload = path.join(outer, "transport.cjs");
  fs.writeFileSync(preload, `
  if (process.env.CONTINUITY_RENAME_FAIL === '1') {
    const fs = require('node:fs'); const rename = fs.renameSync;
    fs.renameSync = (...args) => { if (String(args[0]).includes('.current-')) throw new Error('Fixture interruption before pointer rename'); return rename(...args); };
  }
  globalThis.fetch = async (url, init = {}) => {
    if (process.env.CONTINUITY_SECRET_FAILURE === '1') throw new Error('api_key=snp_testsecret12345678901234567890');
    if (process.env.CONTINUITY_OFFLINE === '1') throw new Error('continuity fixture offline');
    const json = value => new Response(JSON.stringify(value), {headers:{'content-type':'application/json'}});
    if (!String(url).includes('/mcp/')) return json({success:true,data:{project:{},limit:10,
      whatChanged:{changes:[],decisions:[],staleAssumptions:[],failedJobs:[],recommendedActions:['Compare local files'],caveats:[],freshness:null},
      handoff:null, match:{score:0},recommendedActions:[],caveats:[],sessionContext:null}});
    const request = JSON.parse(init.body); const name=request.params.name; let data={};
    if (name==='snipara_context_query') data={section_refs:[{chunk_id:'chunk_parser'}]};
    if (name==='snipara_get_chunk') data={found:true,chunk_id:'chunk_parser',content:'Parser contract: preserve empty input',token_count:12};
    if (name==='snipara_session_memories') data={critical_memories:[],session_context:[],total_tokens:0};
    return json({jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text:JSON.stringify(data)}]}});
  };`);
  const run = (args, offline = false, overrides = {}) => {
    const env = { ...process.env, SNIPARA_API_KEY: "fixture-key", SNIPARA_PROJECT_ID: "fixture",
      SNIPARA_API_URL: "https://fixture.invalid", SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK: "1",
      CONTINUITY_OFFLINE: offline ? "1" : "0", ...overrides };
    delete env.RLM_API_KEY;
    return spawnSync(process.execPath, ["--require", preload, cli, ...args], { cwd, env, encoding: "utf8", timeout: 20000 });
  };
  const okay = (args, offline = false) => {
    const r = run(args, offline);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return JSON.parse(r.stdout);
  };
  const stateFile = path.join(cwd, ".snipara/workflow/current.json");
  const state = () => JSON.parse(fs.readFileSync(stateFile));
  okay(["workflow", "start", "--goal", "Repair generic parser", "--plan-file", "plan.json", "--skip-agent-context", "--json"]);
  const start = () => okay(["workflow", "task-start", "code", "edit", "--skip-agent-context", "--json"]);
  const commit = (outcome, summary) => okay(["workflow", "task-commit", "code", "edit", "--summary", summary,
    "--decision", "Preserve generic empty input behavior", "--why", "Existing callers depend on empty input",
    "--constraint", "No unrelated changes", "--outcome", outcome,
    "--evidence", outcome === "completed" ? "passed:parser regression" : "failed:empty input assertion", "--json"]);
  const resume = (offline = false) => okay(["workflow", "resume", "--json"], offline);
  return { cwd, git, run, okay, state, stateFile, start, commit, resume };
}

test("fresh CLI consumer can recover failed work and start repair without the original conversation", (t) => {
  t.diagnostic(`Companion CLI under test: ${fs.realpathSync(cli)}`);
  const f = fixture(t, { context: true }); f.start();
  f.commit("blocked", "Empty input assertion failed; caller behavior needs preserving");
  const before = fs.readFileSync(f.stateFile, "utf8");
  const result = f.resume(true), cp = result.continuity.checkpoint;
  assert.equal(result.continuity.status, "exact_snapshot", JSON.stringify(result.continuity));
  assert.equal(cp.goal, "Repair generic parser");
  assert.ok(cp.decisions.some(x => x.rationale === "Existing callers depend on empty input"));
  assert.ok(cp.attempts.some(x => x.attempt === 1 && x.outcome === "blocked" && /assertion failed/.test(x.summary)));
  assert.deepEqual(cp.attempts[0].constraints, ["No unrelated changes"]);
  assert.deepEqual(cp.attempts[0].evidence, ["failed:empty input assertion"]);
  assert.ok(cp.evidence.some(x => x.resultVerified === false || x.semanticUseVerified === false));
  assert.equal(cp.remaining[0].taskId, "edit");
  assert.ok(cp.missingChecks.some(x => x.command === "node parser.test.js"));
  assert.ok(cp.preexistingChanges.includes("work.txt"));
  assert.ok(cp.runtimeBoundary.some(x => /restore a live process/.test(x)));
  assert.equal(cp.budget.status, "unknown");
  assert.match(result.session_bootstrap_error, /offline/);
  assert.equal(result.what_changed_resume.receipt.status, "unavailable");
  assert.equal(fs.readFileSync(f.stateFile, "utf8"), before);
  assert.equal(fs.existsSync(path.join(f.cwd, ".snipara/controller")), false);
  const gesture = cp.nextAction.argv;
  assert.equal(gesture[0], "snipara-companion");
  assert.ok(["task-next", "task-status"].includes(gesture[2]));
  f.okay(gesture.slice(1));
  // Fresh consumer uses only the brief's phase/task and failure to request the
  // existing explicit retry; resume itself never runs this command.
  f.okay(["workflow", "task-retry", "code", cp.remaining[0].taskId, "--reason", "Preserve empty input and rerun the failed assertion", "--json"]);
  const repair = f.start();
  assert.equal(repair.current_task.attempt, 2);
  f.commit("completed", "Parser assertion now passes");
  const after = f.resume().continuity.checkpoint;
  assert.deepEqual(after.attempts.map(x => x.outcome), ["blocked", "completed"]);
  assert.equal(after.historyCompleteness, "complete");
  assert.ok(after.attempts[0].recoveryReason.includes("Preserve empty input"));
  assert.equal(after.decisions[0].rationale, cp.decisions[0].rationale);
});

test("public checkpoint freezes new files while preserving original dirty baseline and old immutable pack", (t) => {
  const f = fixture(t); f.start(); const before = f.state();
  const old = retrieveContextPack(before.continuity.packId, f.cwd).content;
  fs.writeFileSync(path.join(f.cwd, "work.txt"), "task modification\n");
  const drift = f.resume().continuity;
  assert.equal(drift.status, "drift_revalidation_required");
  assert.ok(drift.changes.includes("dirty file content"));
  const refreshed = f.okay(["workflow", "checkpoint", "--json"]).continuity;
  assert.equal(refreshed.status, "exact_snapshot", JSON.stringify(refreshed));
  assert.deepEqual(refreshed.checkpoint.preexistingChanges, ["work.txt"]);
  assert.deepEqual(refreshed.checkpoint.taskChanges, ["work.txt"]);
  assert.notEqual(f.state().continuity.packId, before.continuity.packId);
  assert.equal(retrieveContextPack(before.continuity.packId, f.cwd).content, old);
});

for (const kind of ["head", "branch", "index"]) test(`resume identifies ${kind} drift without changing refs`, (t) => {
  const f = fixture(t); f.start();
  if (kind === "head") { f.git("add", "work.txt"); f.git("commit", "-m", "Movement after checkpoint"); }
  if (kind === "branch") f.git("switch", "-c", "fixture-moved");
  if (kind === "index") f.git("add", "work.txt");
  const head = f.git("rev-parse", "HEAD");
  const result = f.resume().continuity;
  assert.equal(result.status, "drift_revalidation_required");
  assert.ok(result.changes.includes({head:"HEAD",branch:"branch",index:"index"}[kind]));
  assert.equal(result.nextAction.argv[2],"task-status");
  f.okay(result.nextAction.argv.slice(1));
  assert.equal(f.git("rev-parse", "HEAD"), head);
});

test("legacy checkpoint remains visibly incomplete until explicit checkpoint capture", (t) => {
  const f = fixture(t); const s = f.state(); delete s.continuity;
  fs.writeFileSync(f.stateFile, JSON.stringify(s));
  const result = f.resume().continuity;
  assert.equal(result.status, "drift_revalidation_required");
  assert.match(result.reasons.join(" "), /legacy|incomplete/i);
  assert.equal(result.checkpoint, null);
  assert.equal(f.okay(["workflow", "checkpoint", "--json"]).continuity.status, "exact_snapshot");
});

test("abandoned task is not retried and counters are preserved by resume", (t) => {
  const f = fixture(t); f.start(); f.commit("abandoned", "Caller chose to stop this repair");
  const before = f.state(); const result = f.resume();
  assert.equal(result.workflow.phases[0].tasks[0].attempt, 1);
  assert.deepEqual(f.state(), before);
  assert.ok(result.continuity.checkpoint.attempts.some(x => x.outcome === "abandoned"));
});

test("phase commits preserve their own rationale without duplicating failed task attempts", (t) => {
  const f = fixture(t); f.start(); f.commit("blocked", "First failed attempt");
  f.okay(["workflow","phase-commit","code","--summary","Phase remains blocked", "--outcome","blocked",
    "--decision","Preserve the original contract", "--why","Repair must address the same callers", "--json"]);
  const cp = f.resume().continuity.checkpoint;
  assert.equal(cp.attempts.filter(x => x.taskId === "edit" && x.attempt === 1).length,1);
  assert.ok(cp.decisions.some(x => x.rationale === "Repair must address the same callers"));
  assert.equal(cp.historyCompleteness,"complete");
});

test("a direct phase declaration does not invent an executed task attempt", (t) => {
  const f = fixture(t);
  f.okay(["workflow","phase-commit","code","--summary","Phase declaration only", "--json"]);
  const result = f.resume();
  assert.equal(result.workflow.phases[0].tasks[0].attempt,0);
  assert.equal(result.workflow.phases[0].tasks[0].attemptHistory,undefined);
  assert.equal(result.continuity.checkpoint.phases[0].commitHistory[0].summary,"Phase declaration only");
});

test("bound context cannot be loaded from a forged external blob path", (t) => {
  const f = fixture(t, { context: true }); f.start();
  const receipt = f.state().phases[0].tasks[0].contextReceipt;
  const file = path.join(f.cwd, ".snipara/context-pack/items", receipt.packId + ".json");
  const manifest = JSON.parse(fs.readFileSync(file));
  manifest.storage.blobRelativePath = "../../outside-secret.txt";
  fs.writeFileSync(file, JSON.stringify(manifest));
  assert.throws(() => retrieveContextPack(receipt.packId, f.cwd), /not found|invalid/i);
  const result = f.run(["workflow", "resume", "--json"]);
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stdout).continuity.status, "blocked");
  const action=JSON.parse(result.stdout).continuity.nextAction;
  assert.equal(action.argv[2],"task-status");
  f.okay(action.argv.slice(1));
  assert.match(JSON.parse(result.stdout).task_context_errors[0].error, /not found|invalid/i);
  assert.doesNotMatch(result.stdout + result.stderr, /outside content/);
});

test("empty hosted changes is separate from local drift and does not rewrite checkpoint", (t) => {
  const f = fixture(t); f.start(); fs.writeFileSync(path.join(f.cwd, "work.txt"), "different bytes\n");
  const before = fs.readFileSync(f.stateFile, "utf8");
  const result = f.resume();
  assert.equal(result.continuity.status, "drift_revalidation_required");
  assert.deepEqual(result.what_changed_resume.data.whatChanged.changes, []);
  assert.equal(result.what_changed_resume.receipt.historicalCheckpointRewritten, false);
  assert.match(result.what_changed_resume.receipt.sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(f.stateFile, "utf8"), before);
});

test("offline retrieval errors are redacted in JSON and human resume output", (t) => {
  const f=fixture(t); f.start();
  const state=f.state();
  state.runtime={sandbox:{provider:"snipara-sandbox",bindings:[{phaseId:"code",sessionId:"fixture-runtime",
    boundAt:new Date().toISOString(),bootstrapQuery:"Parser context"}]}};
  fs.writeFileSync(f.stateFile,JSON.stringify(state));
  f.okay(["workflow","checkpoint","--json"]);
  for (const args of [["workflow","resume","--json"],["workflow","resume"]]) {
    const r=f.run(args,false,{CONTINUITY_SECRET_FAILURE:"1"});
    assert.equal(r.status,0,r.stderr);
    assert.doesNotMatch(r.stdout+r.stderr,/snp_testsecret12345678901234567890/);
    assert.match(r.stdout,/REDACTED/);
  }
});

for (const kind of ["fifo", "symlink", "parent-symlink", "oversized"]) {
  test(`root workflow ${kind} is refused before reading state`, (t) => {
    const f = fixture(t); f.start();
    if (kind === "oversized") fs.writeFileSync(f.stateFile," ".repeat(2*1024*1024+1));
    if (kind === "fifo") { fs.unlinkSync(f.stateFile); assert.equal(spawnSync("mkfifo",[f.stateFile]).status,0); }
    if (kind === "symlink") { const outside=path.join(path.dirname(f.cwd),"external-state.json");
      fs.renameSync(f.stateFile,outside); fs.symlinkSync(outside,f.stateFile); }
    if (kind === "parent-symlink") { const old=path.dirname(f.stateFile), outside=path.join(path.dirname(f.cwd),"external-workflow");
      fs.renameSync(old,outside); fs.symlinkSync(outside,old); }
    const r=f.run(["workflow","resume","--json"]);
    assert.notEqual(r.status,0);
    assert.equal(r.error,undefined);
    assert.match(r.stderr,/bounded regular|byte|limit|symlink/i);
  });
}

test("interrupted pointer save preserves prior complete state and cleans its temporary file", (t) => {
  const f=fixture(t); f.start(); const before=fs.readFileSync(f.stateFile,"utf8");
  const r=f.run(["workflow","checkpoint","--json"],false,{CONTINUITY_RENAME_FAIL:"1"});
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/interruption before pointer rename/);
  assert.equal(fs.readFileSync(f.stateFile,"utf8"),before);
  assert.deepEqual(fs.readdirSync(path.dirname(f.stateFile)).filter(x=>x.startsWith(".current-")),[]);
  assert.equal(f.resume().continuity.status,"exact_snapshot");
});

for (const target of ["activity/timeline.jsonl", "decisions/pending/unsafe.json", "team-sync/session.json"]) {
  test(`unsafe supplemental ${target} cannot hang or discard the local continuity brief`, (t) => {
    const f=fixture(t); f.start();
    const file=path.join(f.cwd,".snipara",target);
    fs.mkdirSync(path.dirname(file),{recursive:true});
    if (fs.existsSync(file)) fs.unlinkSync(file);
    assert.equal(spawnSync("mkfifo",[file]).status,0);
    const r=f.run(["workflow","resume","--json"]);
    assert.equal(r.status,0,r.stderr);
    const body=JSON.parse(r.stdout);
    assert.ok(body.continuity.checkpoint);
    assert.equal(body.local_session_snapshot,null);
    assert.match(body.local_session_snapshot_error,/bounded|regular|unsafe/i);
    // Human output follows the same bounded supplemental path.
    const human=f.run(["workflow","resume"]);
    assert.equal(human.status,0,human.stderr);
    assert.match(human.stdout,/Supplemental session observation unavailable/);
  });
}

test("supplemental activity exposes a redacted summary and omits raw event payloads", (t) => {
  const f=fixture(t); f.start();
  const file=path.join(f.cwd,".snipara/activity/timeline.jsonl");
  fs.appendFileSync(file,JSON.stringify({schemaVersion:"snipara.activity_timeline.v0",eventId:"fixture-secret",
    timestamp:"2099-01-01T00:00:00Z",source:"tool",kind:"command",title:`api_key=${redactionFixtureKey}`,
    files:[],refs:[],metadata:{stdout:"fake raw private transcript"}})+"\n");
  const r=f.run(["workflow","resume","--json"]);
  assert.equal(r.status,0,r.stderr);
  assert.doesNotMatch(r.stdout,new RegExp(`${redactionFixtureKey}|fake raw private transcript`));
  const body=JSON.parse(r.stdout);
  assert.deepEqual(body.local_session_snapshot.activity.latestEvents,[]);
  assert.match(body.local_session_snapshot.summary.latestActivityTitle,/REDACTED/);
});

test("legacy task state and runtime metadata cannot bypass resume redaction", (t) => {
  const f=fixture(t); f.start();
  f.commit("blocked",`api_key=${redactionFixtureKey}`);
  const state=f.state();
  state.runtime={sandbox:{provider:"snipara-sandbox",bindings:[{phaseId:"code",sessionId:"fixture-runtime",
    boundAt:new Date().toISOString(),bootstrapQuery:"Parser context",lastCheckpoint:{summary:`api_key=${redactionFixtureKey}`,
      capturedAt:new Date().toISOString(),rehydratableState:{stdout:"fake raw transcript",password:"fake-password-value"}}}]}};
  fs.writeFileSync(f.stateFile,JSON.stringify(state));
  f.okay(["workflow","checkpoint","--json"]);
  for(const args of [["workflow","resume","--json"],["workflow","resume"]]) {
    const r=f.run(args,true);
    assert.equal(r.status,0,r.stderr);
    assert.doesNotMatch(r.stdout,new RegExp(`${redactionFixtureKey}|fake raw transcript|fake-password-value`));
  }
});

test("large optional history cannot turn a persisted task commit into a reported failure", (t) => {
  const f=fixture(t); f.start();
  fs.writeFileSync(path.join(f.cwd,".snipara/activity/timeline.jsonl")," ".repeat(4*1024*1024+1));
  const result=f.run(["workflow","task-commit","code","edit","--summary","Task outcome saved", "--outcome","completed","--json"]);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stderr,/Supplemental session snapshot unavailable; workflow state was saved/);
  assert.equal(JSON.parse(result.stdout).task.status,"completed");
  assert.equal(f.state().phases[0].tasks[0].status,"completed");
  const resumed=f.resume();
  assert.ok(resumed.continuity.checkpoint);
  assert.equal(resumed.local_session_snapshot,null);
});

test("exact historical files with blocked work emit only the current inspection gesture", (t) => {
  const f=fixture(t); f.start(); f.commit("blocked","Repair still required");
  const result=f.run(["workflow","resume"],true);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/Current next action: "snipara-companion" "workflow" "task-status"/);
  assert.doesNotMatch(result.stdout,/snipara-companion workflow phase-start code/);
});
