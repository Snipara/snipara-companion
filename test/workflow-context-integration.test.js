const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const cliOverride = process.env.SNIPARA_COMPANION_TEST_CLI;
const cliPath = path.resolve(cliOverride === undefined ? path.join(__dirname, "../dist/index.js") : cliOverride);
if (cliOverride !== undefined && (!cliOverride || !fs.existsSync(cliPath) || !fs.statSync(cliPath).isFile())) {
  throw new Error(`SNIPARA_COMPANION_TEST_CLI must name an existing CLI file: ${cliOverride}`);
}
const { buildGeneratedWorkflowPlanDocument, normalizeWorkflowPlanInput } = require(cliPath);

// Exercise the public CLI, real client JSON-RPC serialization, persisted workflow
// and context-pack reads. Only the HTTPS boundary is replaced; no model is run.
function fixture(t, plan) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-task-context-it-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const preload = path.join(dir, "transport.cjs");
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    globalThis.fetch = async (url, init = {}) => {
      if (process.env.IT_FAILURE === 'offline') throw new Error('fixture offline');
      if (!String(url).includes('/mcp/')) return new Response('{}', {status: 404});
      const request = JSON.parse(init.body);
      const {name, arguments: args} = request.params;
      if (process.env.IT_FAILURE === 'deadline' && name === 'snipara_context_query')
        return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('fixture deadline aborted')), {once:true}));
      fs.appendFileSync(process.env.IT_CALLS, JSON.stringify({name, args}) + '\\n');
      let data = {};
      if (name === 'snipara_decompose') data = {sub_queries: [{query:'alpha'}, {query:'beta'}]};
      if (name === 'snipara_context_query') data = {
        section_refs: [{chunk_id: 'chunk_' + args.query}], sections: [], total_tokens: 10
      };
      if (name === 'snipara_get_chunk') data = {
        found: true, chunk_id: args.chunk_id, content: 'BODY ' + args.chunk_id,
        token_count: 10, file: args.chunk_id + '.md', lines: [1, 2], title: args.chunk_id
      };
      const mode = process.env.IT_FAILURE;
      if (name === 'snipara_get_chunk' && mode === 'missing') data.found = false;
      if (name === 'snipara_get_chunk' && mode === 'mismatch') data.chunk_id = 'other';
      if (name === 'snipara_get_chunk' && mode === 'truncated') data.truncated = true;
      if (name === 'snipara_get_chunk' && mode === 'budget') data.token_count = 100000;
      if (name === 'snipara_context_query' && mode === 'empty') data.section_refs = [];
      if (name === 'snipara_context_query' && mode === 'huge-metadata') data.unbounded = 'x'.repeat(50000);
      if (name === 'snipara_decompose' && mode === 'single') data.sub_queries = [{query:'alpha'}];
      if (name === 'snipara_context_query' && mode === 'too-many')
        data.section_refs = Array.from({length:17}, (_,i) => ({chunk_id:'chunk_' + i}));
      if (name === 'snipara_context_query' && mode === 'change-state') {
        const file = '.snipara/workflow/current.json';
        const state = JSON.parse(fs.readFileSync(file)); state.goal = 'Concurrent update';
        fs.writeFileSync(file, JSON.stringify(state));
      }
      if (name === 'snipara_session_memories') data = {critical_memories:[], session_context:[], total_tokens:0};
      return new Response(JSON.stringify({jsonrpc:'2.0', id:request.id,
        result:{isError:mode === 'mcp-error',content:[{type:'text',text:JSON.stringify(data)}]}}),
        {headers:{'content-type':'application/json'}});
    };
  `);
  const callsFile = path.join(dir, "calls.jsonl");
  const run = (args, mode) => {
    const env = {...process.env, SNIPARA_API_KEY: "fixture-key", SNIPARA_PROJECT_ID: "fixture",
      SNIPARA_API_URL: "https://fixture.invalid", SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK: "1",
      IT_CALLS: callsFile, IT_FAILURE: mode || ""};
    delete env.RLM_API_KEY;
    return spawnSync(process.execPath, ["--require", preload, cliPath, ...args],
      {cwd:dir, env, encoding:"utf8", timeout:15000});
  };
  const state = () => JSON.parse(fs.readFileSync(path.join(dir, ".snipara/workflow/current.json")));
  const calls = () => fs.existsSync(callsFile) ? fs.readFileSync(callsFile,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  fs.writeFileSync(path.join(dir,"plan.json"), JSON.stringify({...plan, mode:"standard"}));
  const start = run(["workflow", "start", "--goal", "Integration fixture", "--plan-file", "plan.json", "--json"]);
  assert.equal(start.status, 0, start.stderr || start.stdout);
  fs.writeFileSync(callsFile, "");
  return {dir, run, state, calls, start: (id, mode) => run(["workflow","task-start",id,"--skip-agent-context","--json"],mode)};
}
function simple(query = "alpha") {
  return {steps:[{id:"code",query:"Implement code",contextRequest:{queries:[query],maxTokens:1000}}]};
}

test("real planner shape retains dependencies and parameters through public task execution", (t) => {
  t.diagnostic(`Companion CLI under test: ${fs.realpathSync(cliPath)}`);
  const raw = {query:"Find project context",steps:[
    {step:1,action:"decompose",params:{query:"alpha and beta",max_depth:2},depends_on:[]},
    {step:2,action:"context_query",params:{query:"$step1.sub_queries[0].query",max_tokens:1000,search_mode:"keyword"},depends_on:[1]},
    {step:3,action:"multi_query",params:{queries:"$step1.sub_queries[1:]",max_tokens:1000},depends_on:[1]},
  ]};
  const generated = buildGeneratedWorkflowPlanDocument(raw, raw.query);
  assert.deepEqual(generated.steps[1].depends_on,["decompose"]);
  assert.equal(generated.steps[1].contextRequest.operation.params.query,"$step1.sub_queries[0].query");
  assert.deepEqual(normalizeWorkflowPlanInput(raw,raw.query)[1].dependsOn,["decompose"]);
  const f = fixture(t, generated);
  const first = f.start("decompose");
  assert.equal(first.status,0,first.stderr);
  assert.equal(JSON.parse(first.stdout).task_context.output.sub_queries[0].query,"alpha");
  // Completion remains a caller declaration. This test checks data wiring, not objective acceptance.
  const complete = f.run(["workflow","phase-commit","decompose","--summary","Decomposition observed","--json"]);
  assert.equal(complete.status,0,complete.stderr);
  const next = f.run(["workflow","task-next","context-query","--skip-agent-context","--json"]);
  assert.equal(next.status,0,next.stderr);
  assert.ok(JSON.parse(next.stdout).next_task);
  const second = f.start("context-query");
  assert.equal(second.status,0,second.stderr);
  const body = JSON.parse(second.stdout);
  assert.equal(body.task_context.chunks[0].content,"BODY chunk_alpha");
  assert.equal(body.context_envelope.materialization.authority,"local_client_observed");
  assert.equal(body.context_envelope.materialization.semanticUseVerified,false);
  assert.ok(f.calls().some(x=>x.name==="snipara_context_query" && x.args.query==="alpha" && x.args.search_mode==="keyword"));
  const third = f.start("multi-query");
  assert.equal(third.status,0,third.stderr);
  assert.equal(JSON.parse(third.stdout).task_context.chunks[0].id,"chunk_beta");
});

test("task contexts are loaded through get_chunk and never shared with a sibling task", (t) => {
  const f = fixture(t,{steps:[simple("alpha").steps[0],{...simple("beta").steps[0],id:"second"}]});
  for (const [id, own, other] of [["code","alpha","beta"],["second","beta","alpha"]]) {
    const result = f.start(id); assert.equal(result.status,0,result.stderr);
    const context = JSON.parse(result.stdout).task_context;
    assert.deepEqual(context.chunks.map(x=>x.id),["chunk_"+own]);
    assert.ok(!JSON.stringify(context).includes("BODY chunk_"+other));
  }
  assert.deepEqual(f.calls().filter(x=>x.name==="snipara_get_chunk").map(x=>x.args.chunk_id),["chunk_alpha","chunk_beta"]);
});

for (const mode of ["missing","mismatch","truncated","budget","empty","too-many","offline","mcp-error"]) {
  test(`context preparation ${mode} blocks before consuming an attempt`, (t) => {
    const f = fixture(t,simple()); const before = f.state();
    const result = f.start("code",mode);
    assert.notEqual(result.status,0);
    assert.deepEqual(f.state(),before);
    assert.equal(f.state().phases[0].tasks[0].attempt,0);
  });
}
test("concurrent workflow drift cannot be overwritten by context preparation", (t) => {
  const f=fixture(t,simple()); const result=f.start("code","change-state");
  assert.notEqual(result.status,0); assert.match(result.stderr,/Workflow changed/);
  assert.equal(f.state().goal,"Concurrent update");
  assert.equal(f.state().phases[0].tasks[0].status,"pending");
});
test("explicit task chunk references are deduplicated and loaded without a retrieval query", (t) => {
  const f=fixture(t,{steps:[{id:"code",contextRequest:{chunkIds:["chunk_exact","chunk_exact"]}}]});
  const result=f.start("code"); assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).task_context.chunks.length,1);
  assert.deepEqual(f.calls().map(x=>x.name),["snipara_get_chunk"]);
});
test("legacy tasks perform no mandatory retrieval calls", (t) => {
  const f=fixture(t,{steps:[{id:"code",query:"Old bounded task"}]});
  const result=f.start("code"); assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).task_context,undefined);
  assert.deepEqual(f.calls(),[]);
});
test("offline resume restores exact task-bound content without pretending it is fresh", (t) => {
  const f=fixture(t,simple()); assert.equal(f.start("code").status,0);
  const result=f.run(["workflow","resume","--json"],"offline");
  assert.equal(result.status,0,result.stderr);
  const body=JSON.parse(result.stdout);
  assert.equal(body.task_contexts[0].chunks[0].content,"BODY chunk_alpha");
  assert.match(body.session_bootstrap_error,/offline/);
});
test("resume rejects a modified context blob or changed task contract", (t) => {
  const f=fixture(t,simple()); assert.equal(f.start("code").status,0);
  const state=f.state(); const receipt=state.phases[0].tasks[0].contextReceipt;
  const manifest=JSON.parse(fs.readFileSync(path.join(f.dir,".snipara/context-pack/items",receipt.packId+".json")));
  const actual=path.join(f.dir,manifest.storage.blobRelativePath);
  const previous=fs.readFileSync(actual,"utf8"); fs.writeFileSync(actual,previous+"tampered");
  assert.notEqual(f.run(["workflow","resume","--json"]).status,0);
  fs.writeFileSync(actual,previous);
  state.phases[0].tasks[0].contextRequest.queries=["changed"];
  fs.writeFileSync(path.join(f.dir,".snipara/workflow/current.json"),JSON.stringify(state));
  assert.notEqual(f.run(["workflow","resume","--json"]).status,0);
});
test("planner mapping rejects unknown, ambiguous and cyclic dependencies", () => {
  for (const steps of [
    [{step:1,title:"A",depends_on:[9]}],
    [{step:1,title:"A"},{step:1,title:"B"}],
    [{id:"same",title:"A"},{id:"same",title:"B"}],
    [{step:1,title:"A",depends_on:[2]},{step:2,title:"B",depends_on:[1]}],
  ]) assert.throws(()=>buildGeneratedWorkflowPlanDocument({steps},"Fixture"));
});
test("repeated action labels get distinct stable IDs and retain numeric bindings", () => {
  const plan=buildGeneratedWorkflowPlanDocument({steps:[
    {step:7,action:"context_query",params:{query:"alpha",max_tokens:1000}},
    {step:9,action:"context_query",params:{query:"beta",max_tokens:1000},depends_on:[7]},
  ]},"Fixture");
  assert.notEqual(plan.steps[0].id,plan.steps[1].id);
  assert.deepEqual(plan.steps[1].depends_on,[plan.steps[0].id]);
});
test("symbolic bindings must name a declared predecessor and cannot evaluate arbitrary paths", () => {
  assert.throws(()=>buildGeneratedWorkflowPlanDocument({steps:[
    {step:1,action:"decompose",params:{query:"alpha"}},
    {step:2,action:"context_query",params:{query:"$step1.sub_queries[0].query"}},
  ]},"Fixture"),/declared dependency/);
});

test("explicit-ID public plans use the same graph compiler and retrieval preparation", (t) => {
  const f=fixture(t,{steps:[{id:"My Task",action:"context_query",params:{query:"alpha",max_tokens:1000}}]});
  const result=f.start("my-task"); assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).task_context.chunks[0].id,"chunk_alpha");
  assert.throws(()=>normalizeWorkflowPlanInput({steps:[
    {id:"a",depends_on:["b"]},{id:"b",depends_on:["a"]},
  ]},"Fixture"),/Cyclic/);
});
test("nested raw IDs resolve and phase completion deadlocks are rejected", () => {
  const plan=buildGeneratedWorkflowPlanDocument({steps:[
    {id:"first",tasks:[{id:"My Task",query:"First task"}]},
    {id:"next",depends_on:["My Task"]},
  ]},"Fixture");
  assert.deepEqual(plan.steps[1].depends_on,["my-task"]);
  assert.throws(()=>buildGeneratedWorkflowPlanDocument({steps:[
    {id:"first",tasks:[{id:"a",depends_on:["second"]}]},
    {id:"second",depends_on:["first"]},
  ]},"Fixture"),/Cyclic/);
});
test("phase task dependencies become eligible after the named member task completes", (t) => {
  const f=fixture(t,{steps:[{id:"first",tasks:[{id:"a"}]},{id:"second",depends_on:["a"]}]});
  const file=path.join(f.dir,".snipara/workflow/current.json");
  const state=f.state();state.phases[0].tasks[0].status="completed";
  fs.writeFileSync(file,JSON.stringify(state));
  const result=f.run(["workflow","task-next","second","--skip-agent-context","--json"]);
  assert.equal(result.status,0,result.stderr);assert.ok(JSON.parse(result.stdout).next_task);
});
test("phase lifecycle cannot bypass actual context preparation", (t) => {
  const f=fixture(t,simple());
  const bypass=f.run(["workflow","phase-commit","code","--summary","Pretend complete","--json"]);
  assert.notEqual(bypass.status,0);assert.match(bypass.stderr,/load its required context/);
  const result=f.run(["workflow","phase-start","code","--json"]);
  assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).task_context.chunks[0].id,"chunk_alpha");
  assert.equal(f.state().phases[0].tasks[0].attempt,1);
  const again=f.run(["workflow","phase-start","code","--json"]);
  assert.equal(again.status,0,again.stderr);assert.equal(f.state().phases[0].tasks[0].attempt,1);
});
test("the complete emitted payload including metadata obeys the byte budget", (t) => {
  const f=fixture(t,simple());const before=f.state();
  assert.notEqual(f.start("code","huge-metadata").status,0);
  assert.deepEqual(f.state(),before);
});
test("single-subquery plans accept an empty tail as observed zero retrieval work", (t) => {
  const f=fixture(t,{steps:[
    {step:1,action:"decompose",params:{query:"alpha"}},
    {step:2,action:"multi_query",params:{queries:"$step1.sub_queries[1:]",max_tokens:1000},depends_on:[1]},
  ]});
  assert.equal(f.start("decompose","single").status,0);
  assert.equal(f.run(["workflow","phase-commit","decompose","--summary","Observed single query","--json"]).status,0);
  const result=f.start("multi-query");assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).task_context.chunks,[]);
  assert.equal(JSON.parse(result.stdout).task_context.output.emptyTail,true);
});
test("advisory planner operations survive without executing recommended tools", (t) => {
  const params={recommended_tools:["snipara_forget"],memory_tools:["snipara_forget"]};
  const f=fixture(t,{steps:[{id:"advice",action:"tool_workflow",params}]});
  const result=f.start("advice");assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).context_envelope.scope.planStep.params,params);
  assert.deepEqual(f.calls(),[]);
});
test("context-bearing phases retain the existing Sandbox runtime binding", (t) => {
  const plan=simple();plan.steps[0].needs_runtime=true;
  const f=fixture(t,plan);
  const result=f.run(["workflow","phase-start","code","--json"]);
  assert.equal(result.status,0,result.stderr);
  assert.equal(f.state().runtime.sandbox.bindings[0].phaseId,"code");
});
test("total preparation deadline aborts the transport without consuming an attempt", (t) => {
  const plan=simple();plan.steps[0].contextRequest.timeoutMs=30;
  const f=fixture(t,plan);const before=f.state();
  const result=f.start("code","deadline");assert.notEqual(result.status,0);
  assert.match(result.stderr,/deadline aborted/);assert.deepEqual(f.state(),before);
});
test("explicit context operation bindings cannot import an undeclared task output", () => {
  assert.throws(()=>normalizeWorkflowPlanInput({steps:[{id:"first"},{id:"second",contextRequest:{
    operation:{action:"context_query",params:{query:"$step1.sub_queries[0].query"},bindings:{step1:"first"}}
  }}]},"Fixture"),/declared dependency/);
});
test("multiple task queries retain every response and its own source bodies", (t) => {
  const f=fixture(t,{steps:[{id:"code",contextRequest:{queries:["alpha","beta"],maxTokens:1000}}]});
  const result=f.start("code");assert.equal(result.status,0,result.stderr);
  const context=JSON.parse(result.stdout).task_context;
  assert.equal(context.output.results.length,2);
  assert.deepEqual(context.output.results.map(x=>x.section_refs[0].chunk_id),["chunk_alpha","chunk_beta"]);
  assert.deepEqual(context.chunks.map(x=>x.id),["chunk_alpha","chunk_beta"]);
});
test("both final closure commands enforce required context and completed phases", (t) => {
  const f=fixture(t,simple());
  const finish=(prefix)=>f.run([...prefix,"final-commit","--summary","Finish observed work","--json"]);
  const before=f.state();
  for(const prefix of [["workflow"],[]]) {
    const result=finish(prefix);assert.notEqual(result.status,0);
    assert.match(result.stderr,/before final completion/);assert.deepEqual(f.state(),before);
  }
  assert.deepEqual(f.calls(),[]);
  assert.equal(f.start("code").status,0);
  assert.notEqual(finish(["workflow"]).status,0);
  assert.equal(f.run(["workflow","phase-commit","code","--summary","Context observed","--json"]).status,0);
  assert.equal(finish(["workflow"]).status,0);
  const file=path.join(f.dir,".snipara/workflow/current.json");
  const state=f.state();delete state.phases[0].tasks[0].contextReceipt;
  fs.writeFileSync(file,JSON.stringify(state));
  const missing=finish([]);assert.notEqual(missing.status,0);
  assert.match(missing.stderr,/load its required context/);
});
