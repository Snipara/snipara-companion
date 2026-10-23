const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const sourcePath = path.resolve(__dirname, '../src/runtime/sandbox-validation.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}});
const adapter = new Module(sourcePath, module);
adapter.filename = sourcePath;
adapter.paths = module.paths;
const identityPath = path.resolve(__dirname, '../src/runtime/sandbox-identity.ts');
const identityModule = new Module(identityPath, module);
identityModule.filename=identityPath;
identityModule.paths=module.paths;
identityModule._compile(ts.transpileModule(fs.readFileSync(identityPath,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,identityPath);
const originalRequire=adapter.require.bind(adapter);
adapter.require=name=>name==='./sandbox-identity' ? identityModule.exports : originalRequire(name);
adapter._compile(compiled.outputText, sourcePath);
const {invokeSandboxValidation, executeBounded} = adapter.exports;
const vectors=require('./fixtures/sandbox-scope-v2.json');
function scopeRequest(folder){ const request=path.join(folder,'request.json');fs.writeFileSync(request,JSON.stringify(vectors.cases[0].request));return request; }

test('unknown runtime response is fail-closed without host fallback', async t => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-adapter-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const executable=path.join(folder,'old-runtime');
  fs.writeFileSync(executable,'#!/bin/sh\nprintf \'{}\\n\'\n',{mode:0o755});
  const result=await invokeSandboxValidation('gate',{sandboxCommand:executable,request:'request.json',scope:'lot'});
  assert.equal(result.exitCode,2);
  assert.equal(result.result.status,'needs_user_choice');
  assert.equal(result.result.execution_authorized_by_gate,false);
});

test('provider credentials are excluded from the runtime subprocess', async t => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-adapter-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const executable=path.join(folder,'runtime');
  fs.writeFileSync(executable,`#!${process.execPath}\nconsole.log(JSON.stringify({status:'sandbox_ready',scope_sha256:'${vectors.cases[0].sha256}',sandbox_used:false,execution_authorized_by_gate:false,readiness:{schema_version:'snipara.sandbox.validation.v1',ready:true,backend:'docker',image_id:'sha256:synthetic'},providerKeyPresent:!!process.env.OPENAI_API_KEY}));\n`,{mode:0o755});
  const previous=process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY='synthetic-never-forward';
  try {
    const result=await invokeSandboxValidation('gate',{sandboxCommand:executable,request:scopeRequest(folder),scope:'lot'});
    assert.equal(result.exitCode,0);
    assert.equal(result.result.providerKeyPresent,false);
  } finally {
    if(previous===undefined)delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY=previous;
  }
});

test('incomplete readiness and negative verification cannot succeed', async t => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-response-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  for (const [action,value] of [['gate',{status:'sandbox_ready'}],['verify',{schema_version:'snipara.sandbox.validation.v1',valid:false,run_id:'a'.repeat(32),reasons:[]}]]) {
    const executable=path.join(folder,'runtime');
    fs.writeFileSync(executable,`#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(value))});\n`,{mode:0o755});
    const result=await invokeSandboxValidation(action,{sandboxCommand:executable,request:'request.json',scope:'lot',runId:'a'.repeat(32)});
    assert.equal(result.exitCode,2);
  }
});

test('adapter forcibly terminates a runtime which ignores SIGTERM', async t => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-deadline-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const marker=path.join(folder,'alive');
  const script=`process.on('SIGTERM',()=>{}); setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'alive'),700); setInterval(()=>{},100);`;
  await assert.rejects(executeBounded(process.execPath,['-e',script],process.env,200),/deadline/);
  await new Promise(resolve=>setTimeout(resolve,800));
  assert.equal(fs.existsSync(marker),false);
});


test('status keeps running and failure evidence instead of an unavailable prompt', async t => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-status-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const executable=path.join(folder,'runtime');
  for (const status of ['running','failed','cancelled']) {
    const value={schema_version:'snipara.sandbox.validation.v1',run_id:'a'.repeat(32),status,cleanup_complete:status!=='running'};
    fs.writeFileSync(executable,`#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(value))});\n`,{mode:0o755});
    const result=await invokeSandboxValidation('status',{sandboxCommand:executable,runId:'a'.repeat(32)});
    assert.equal(result.exitCode,0);
    assert.deepEqual(result.result,value);
  }
});

test('contradictory gate cannot grant execution authority', async t => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-gate-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const executable=path.join(folder,'runtime');
  const value={status:'sandbox_ready',scope_sha256:'a'.repeat(64),sandbox_used:false,execution_authorized_by_gate:true,readiness:{schema_version:'snipara.sandbox.validation.v1',ready:true,backend:'docker',image_id:'sha256:test'}};
  fs.writeFileSync(executable,`#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(value))});\n`,{mode:0o755});
  assert.equal((await invokeSandboxValidation('gate',{sandboxCommand:executable,request:'request.json',scope:'lot'})).exitCode,2);
});

test('deadline settles even when an escaped descendant holds stdout', async t => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-escaped-'));
  const pidFile=path.join(folder,'pid');
  t.after(()=>{
    if(fs.existsSync(pidFile)) { try { process.kill(Number(fs.readFileSync(pidFile,'utf8')),'SIGKILL'); } catch {} }
    fs.rmSync(folder,{recursive:true,force:true});
  });
  const script=`const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,'ignore']}); require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid)); setInterval(()=>{},1000);`;
  const started=Date.now();
  await assert.rejects(executeBounded(process.execPath,['-e',script],process.env,300),/deadline/);
  assert.ok(Date.now()-started<2000);
});


test('verification requires explicit request and run ID before invoking a runtime', async () => {
  const result=await invokeSandboxValidation('verify',{sandboxCommand:'/never-invoke'});
  assert.equal(result.exitCode,2);
  assert.match(result.result.reason,/identity/);
});

test('parent SIGTERM stops its detached runtime', async t => {
  const {spawn}=require('node:child_process');
  const {once}=require('node:events');
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-interrupt-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const adapterPath=path.join(folder,'adapter.cjs');
  fs.writeFileSync(adapterPath,compiled.outputText);
  fs.writeFileSync(path.join(folder,'sandbox-identity.js'),ts.transpileModule(fs.readFileSync(identityPath,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText);
  const ready=path.join(folder,'ready');
  const alive=path.join(folder,'alive');
  const runtime=`process.on('SIGTERM',()=>{}); require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid)); setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(alive)},'alive'),700); setInterval(()=>{},100);`;
  const script=`require(${JSON.stringify(adapterPath)}).executeBounded(process.execPath,['-e',${JSON.stringify(runtime)}],process.env,30000).catch(()=>{process.exitCode=2});`;
  const parent=spawn(process.execPath,['-e',script],{stdio:'ignore'});
  t.after(()=>{try{parent.kill('SIGKILL')}catch{};if(fs.existsSync(ready)){try{process.kill(Number(fs.readFileSync(ready,'utf8')),'SIGKILL')}catch{}}});
  const deadline=Date.now()+3000;
  while(!fs.existsSync(ready)&&Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(fs.existsSync(ready));
  const closed=once(parent,'close');
  parent.kill('SIGTERM');
  await closed;
  await new Promise(resolve=>setTimeout(resolve,800));
  assert.equal(fs.existsSync(alive),false);
});

test('normal completion also stops remaining owned process-group members', async t => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-complete-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const marker=path.join(folder,'alive');
  const child=`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'alive'),700);`;
  const parent=`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'}).unref(); console.log('ok');`;
  const result=await executeBounded(process.execPath,['-e',parent],process.env,3000);
  assert.equal(result.status,0);
  await new Promise(resolve=>setTimeout(resolve,800));
  assert.equal(fs.existsSync(marker),false);
});

test('recording a choice requires an explicit human acknowledgement', async () => {
  const result=await invokeSandboxValidation('choose',{request:'request.json',scope:'lot',sandboxCommand:'/never-invoke'});
  assert.equal(result.exitCode,2);
  assert.match(result.result.reason,/acknowledged/);
});

test('arrays cannot substitute for exact runtime run identity', async t => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-identity-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const executable=path.join(folder,'runtime');
  const value={schema_version:'snipara.sandbox.validation.v1',run_id:['a'.repeat(32)],status:'passed',cleanup_complete:true};
  fs.writeFileSync(executable,`#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(value))});\n`,{mode:0o755});
  const result=await invokeSandboxValidation('run',{sandboxCommand:executable,request:'request.json'});
  assert.equal(result.exitCode,2);
});

test('alternative choice cannot silently select a different environment', async t => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-environment-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const executable=path.join(folder,'runtime');
  const value={schema_version:'snipara.validation.choice.v1',scope_sha256:'a'.repeat(64),authority:'operator_asserted',choice:'alternative',environment:'different',created_at:Date.now()/1000,expires_at:Date.now()/1000+600};
  fs.writeFileSync(executable,`#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(value))});\n`,{mode:0o755});
  const result=await invokeSandboxValidation('choose',{sandboxCommand:executable,request:'request.json',scope:'lot',choice:'alternative',environment:'requested',acknowledgeUserChoice:true});
  assert.equal(result.exitCode,2);
});

test('portable scope identity matches independent public vectors', t => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-vectors-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  for(const vector of vectors.cases){
    const request=path.join(folder,'request.json');fs.writeFileSync(request,JSON.stringify(vector.request));
    assert.equal(identityModule.exports.expectedSandboxScope(request,vector.scope),vector.sha256);
  }
});

test('saved choice is bound to supplied request, scope and environment', async t => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-scope-binding-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const executable=path.join(folder,'runtime');
  const request=scopeRequest(folder);
  const base={schema_version:'snipara.validation.choice.v1',scope_sha256:vectors.cases[0].sha256,authority:'operator_asserted',choice:'alternative',environment:'requested',created_at:Date.now()/1000,expires_at:Date.now()/1000+600};
  for(const [change,code] of [[{},0],[{environment:'other'},2],[{scope_sha256:vectors.cases[1].sha256},2],[{created_at:Date.now()/1000+120,expires_at:Date.now()/1000+720},2],[{expires_at:Date.now()/1000+90000},2],[{environment:'x'.repeat(257)},2]]){
    fs.writeFileSync(executable,`#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({...base,...change}))});\n`,{mode:0o755});
    const result=await invokeSandboxValidation('choose',{sandboxCommand:executable,request,scope:'lot',choice:'alternative',environment:'requested',acknowledgeUserChoice:true});
    assert.equal(result.exitCode,code);
  }
});
