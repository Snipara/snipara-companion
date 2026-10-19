const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync,spawnSync}=require('node:child_process');
const cliOverride=process.env.SNIPARA_COMPANION_TEST_CLI;
const cli=path.resolve(cliOverride===undefined?path.join(__dirname,'../dist/index.js'):cliOverride);
if(cliOverride!==undefined&&(!cliOverride||!fs.existsSync(cli)||!fs.statSync(cli).isFile())) {
  throw new Error(`SNIPARA_COMPANION_TEST_CLI must name an existing CLI file: ${cliOverride}`);
}
function fixture(t) {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'snipara-journey-public-'));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  execFileSync('git',['init','-q'],{cwd});
  fs.writeFileSync(path.join(cwd,'.gitignore'),'.snipara/\n');
  fs.writeFileSync(path.join(cwd,'service.js'),'module.exports = 1;\n');
  execFileSync('git',['add','.'],{cwd});
  execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],{cwd});
  const preload=path.join(cwd,'.snipara','deny-network.cjs');fs.mkdirSync(path.dirname(preload),{recursive:true});
  const networkLog=path.join(cwd,'.snipara','network.log');
  fs.writeFileSync(preload,`globalThis.fetch=()=>{require('node:fs').appendFileSync(${JSON.stringify(networkLog)},'unexpected\\n');throw new Error('UNEXPECTED NETWORK');};`);
  function run(args) {
    return spawnSync(process.execPath,['--require',preload,cli,'task',...args],{cwd,encoding:'utf8',timeout:30000,
      env:{...process.env,SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK:'1',SNIPARA_API_KEY:'fixture-only',SNIPARA_PROJECT_ID:'fixture-only',NODE_OPTIONS:`--require ${preload}`}});
  }
  function json(args) {const result=run([...args,'--json']);assert.equal(result.status,0,result.stderr+result.stdout);return JSON.parse(result.stdout);}
  return {cwd,run,json,networkLog};
}
test('public local journey requires neither account calls nor Orchestrator, and claims remain declarations',(t)=>{
  t.diagnostic(`Companion CLI under test: ${fs.realpathSync(cli)}`);
  const f=fixture(t);
  const start=f.json(['start','Preserve service behavior','--id','public-task','--accept','Preserves service output','--file','service.js','--check','git diff --check']);
  assert.equal(start.task.goal,'Preserve service behavior');
  assert.equal(start.authority.executionGranted,false);
  assert.equal(start.authority.integrationGranted,false);
  assert.equal(start.steps.length,5);
  const work=f.json(['work','public-task']); assert.equal(work.authority.declarationsAreFunctionalProof,false);
  const verify=f.json(['verify','public-task']); assert.ok(verify.verificationPlan);
  assert.notEqual(verify.recommendation.action,'integrate');
  const resume=f.json(['resume','public-task']); assert.equal(resume.task.workflowId,start.task.workflowId);
  const decide=f.json(['decide','public-task']);assert.notEqual(decide.status,'integration_possible');
  fs.writeFileSync(path.join(f.cwd,'service.js'),'module.exports = 2;\n');
  const declared=f.json(['work','public-task','--summary','Agent declares code ready','--outcome','completed']);
  assert.notEqual(declared.status,'integration_possible');
  assert.equal(declared.authority.integrationGranted,false);
  const closed=f.json(['close','public-task','--summary','Local work reviewed for handoff; functional acceptance remains unknown','--outcome','completed']);
  assert.notEqual(closed.recommendation.action,'integrate');
  assert.equal(closed.authority.integrationGranted,false);
  assert.equal(fs.existsSync(f.networkLog),false,'Local journey made an implicit network call');
});
test('explicit CLI override never falls back for a missing file or directory',(t)=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'snipara-invalid-cli-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  for(const file of ['task-journey-public.test.js','workflow-context-integration.test.js','workflow-continuity-integration.test.js']) {
    for(const invalid of [path.join(directory,'missing.js'),directory,'']) {
      const result=spawnSync(process.execPath,[path.join(__dirname,file)],{
        encoding:'utf8',timeout:10000,env:{...process.env,SNIPARA_COMPANION_TEST_CLI:invalid}
      });
      assert.notEqual(result.status,0,`${file} accepted invalid CLI override ${invalid}`);
      assert.match(result.stdout+result.stderr,/SNIPARA_COMPANION_TEST_CLI must name an existing CLI file/);
    }
  }
});
test('unknown or missing workflow versions refuse public read and start before any artifact write',(t)=>{
  function snapshot(directory) {
    const files={};
    function read(root) {
      for(const entry of fs.readdirSync(root,{withFileTypes:true})) {
        const target=path.join(root,entry.name);
        if(entry.isDirectory()) read(target);
        else files[path.relative(directory,target)]=fs.readFileSync(target).toString('base64');
      }
    }
    read(directory);return files;
  }
  for(const version of ['snipara.workflow.v999',undefined]) {
    const f=fixture(t);
    f.json(['start','Preserve service','--id','version-task','--accept','Keep behavior','--file','service.js']);
    const file=path.join(f.cwd,'.snipara/workflow/current.json');
    const state=JSON.parse(fs.readFileSync(file,'utf8'));
    if(version===undefined) delete state.schemaVersion;
    else state.schemaVersion=version;
    state.status='completed';fs.writeFileSync(file,JSON.stringify(state));
    const directory=path.join(f.cwd,'.snipara'),before=snapshot(directory);
    for(const args of [
      ['show','version-task'],['resume','version-task'],
      ['start','Another task','--id','future-task','--accept','Keep behavior','--file','service.js']
    ]) {
      const result=f.run([...args,'--json']);
      assert.notEqual(result.status,0,`${args[0]} accepted workflow version ${version}`);
      assert.match(result.stdout+result.stderr,/unsupported|schema|version|valid Snipara workflow state/i);
      assert.deepEqual(snapshot(directory),before,`${args[0]} wrote artifacts before refusing workflow version ${version}`);
    }
    assert.equal(fs.existsSync(f.networkLog),false);
  }
});
for(const version of ['snipara.workflow.v1','snipara.workflow.v2']) {
  test(`public journey keeps ${version} readable`,(t)=>{
    const f=fixture(t);
    f.json(['start','Preserve legacy service','--id','legacy-task','--accept','Keep behavior','--file','service.js']);
    const file=path.join(f.cwd,'.snipara/workflow/current.json');
    const state=JSON.parse(fs.readFileSync(file,'utf8'));state.schemaVersion=version;
    fs.writeFileSync(file,JSON.stringify(state));
    const before=fs.readFileSync(file,'utf8'),card=f.json(['show','legacy-task']);
    assert.equal(card.task.workflowId,state.workflowId);
    assert.equal(card.steps.length,5);
    assert.equal(card.authority.integrationGranted,false);
    assert.equal(fs.readFileSync(file,'utf8'),before);
    assert.equal(fs.existsSync(f.networkLog),false);
  });
}
test('public optional retrieval returns full chunks and resumes offline from the same receipt',(t)=>{
  const f=fixture(t),preload=path.join(f.cwd,'.snipara','deny-network.cjs');
  const body='Exact source é 🧭 '.repeat(1300);
  fs.writeFileSync(preload,`globalThis.fetch=async(_url,init)=>{const r=JSON.parse(init.body),{name,arguments:a}=r.params;let d={};if(name==='snipara_context_query')d={section_refs:[{chunk_id:'selected'}],total_tokens:10};if(name==='snipara_get_chunk')d={found:true,chunk_id:a.chunk_id,content:${JSON.stringify(body)},file:'source.md',token_count:10};return new Response(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{content:[{type:'text',text:JSON.stringify(d)}]}}),{headers:{'content-type':'application/json'}});};`);
  f.json(['start','Use selected source','--id','context-task','--accept','Preserves exact source','--file','service.js','--context-query','selected']);
  const work=f.json(['work','context-task']);
  assert.equal(work.preparedContext.context.chunks[0].content,body);
  fs.writeFileSync(preload,"globalThis.fetch=()=>{throw new Error('OFFLINE');};");
  const resume=f.json(['resume','context-task']);
  assert.equal(resume.preparedContext.context.chunks[0].content,body);
  assert.equal(resume.runtimeDelivery.semanticUseVerified,false);
});
test('public task export renders selected format and refuses writes outside workspace',(t)=>{
  const f=fixture(t);
  f.json(['start','Review service','--id','export-task','--accept','Review recorded','--file','service.js']);
  let result=f.run(['export','export-task','--format','markdown','--output','.snipara/card.md']);
  assert.equal(result.status,0,result.stderr);
  assert.equal(fs.readFileSync(path.join(f.cwd,'.snipara/card.md'),'utf8'),result.stdout.trimEnd());
  result=f.run(['export','export-task','--output','../outside.json']); assert.notEqual(result.status,0);
});
test('saved intake flags cannot silently override the operator contract',(t)=>{
  const f=fixture(t);
  const brief=f.run(['brief','Scoped change','--accept','Keep scope','--file','service.js','--output','.snipara/brief.json']);
  assert.equal(brief.status,0,brief.stderr);
  const result=f.run(['start','Different goal','--brief','.snipara/brief.json']);assert.notEqual(result.status,0);
  assert.match(result.stderr,/cannot be silently overridden/);
});
test('repeated public start cannot silently substitute or add task retrieval',(t)=>{
  const f=fixture(t);
  const args=['start','Use bound context','--id','context-binding','--accept','Bound source used','--file','service.js'];
  f.json([...args,'--context-query','alpha']);
  const file=path.join(f.cwd,'.snipara/workflow/current.json'),before=fs.readFileSync(file,'utf8');
  for (const changes of [['--context-query','beta'],['--chunk-id','other']]) {
    const result=f.run([...args,...changes]); assert.notEqual(result.status,0);
    assert.match(result.stderr,/context request differs/);assert.equal(fs.readFileSync(file,'utf8'),before);
  }
  assert.equal(f.json([...args,'--context-query','alpha']).task.workflowId,'feature-context-binding');
  assert.equal(f.json(args).task.workflowId,'feature-context-binding');
  assert.equal(fs.readFileSync(file,'utf8'),before);
  assert.equal(fs.existsSync(f.networkLog),false);
});
