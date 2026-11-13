const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sourcePath = path.resolve(__dirname, '../src/runtime/sandbox-validation.ts');
const {loadRuntimeSource} = require('./helpers/runtime-source.cjs');
const {invokeSandboxValidation, executeBounded} = loadRuntimeSource(sourcePath);
const {expectedSandboxScope} = loadRuntimeSource(path.resolve(__dirname, '../src/runtime/sandbox-identity.ts'));
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
  const ready=path.join(folder,'ready');
  const alive=path.join(folder,'alive');
  const runtime=`process.on('SIGTERM',()=>{}); require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid)); setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(alive)},'alive'),700); setInterval(()=>{},100);`;
  const script=`require(${JSON.stringify(require.resolve('./helpers/runtime-source.cjs'))}).loadRuntimeSource(${JSON.stringify(sourcePath)}).executeBounded(process.execPath,['-e',${JSON.stringify(runtime)}],process.env,30000).catch(()=>{process.exitCode=2});`;
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
    assert.equal(expectedSandboxScope(request,vector.scope),vector.sha256);
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

test('diagnostic adapters preserve negative stage, reason and timings with bounded redaction', async t => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-diagnostic-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const executable=path.join(folder,'runtime');
  const readiness={schema_version:'snipara.sandbox.validation.v1',backend:'docker',ready:false,stage:'capability_probe',reason_code:'capability_probe_timeout',reason:'token=synthetic-secret',timings_ms:{capability_probe:30001},duration_ms:30002,probe_timeout_seconds:30};
  for(const action of ['diagnose','gate']) {
    const value=action==='diagnose'?readiness:{status:'needs_user_choice',sandbox_used:false,execution_authorized_by_gate:false,scope_sha256:vectors.cases[0].sha256,choices:['alternative'],readiness};
    fs.writeFileSync(executable,`#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(value))})`,{mode:0o755});
    const outcome=await invokeSandboxValidation(action,{sandboxCommand:executable,request:scopeRequest(folder),scope:'lot'});
    const report=action==='diagnose'?outcome.result:outcome.result.readiness;
    assert.equal(outcome.exitCode,2);
    assert.equal(report.stage,'capability_probe');assert.equal(report.reason_code,'capability_probe_timeout');
    assert.deepEqual(report.timings_ms,{capability_probe:30001});assert.equal(report.duration_ms,30002);
    assert.equal(report.reason,'token=[REDACTED]');
  }
});

test('diagnostic budgets cover internal control deadline plus startup and preserve older CLI compatibility', async t => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-diagnostic-budget-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const executable=path.join(folder,'runtime');
  fs.writeFileSync(executable,`#!${process.execPath}\nconsole.log(JSON.stringify({schema_version:'snipara.sandbox.validation.v1',backend:'docker',ready:true,args:process.argv.slice(2)}))`,{mode:0o755});
  for (const probeTimeoutSeconds of [undefined,1,60]) {
    const delays=[];const original=global.setTimeout;
    global.setTimeout=(callback,delay,...args)=>{delays.push(delay);return original(callback,delay,...args)};
    let outcome;
    try {outcome=await invokeSandboxValidation('diagnose',{sandboxCommand:executable,request:'request.json',probeTimeoutSeconds});}
    finally {global.setTimeout=original;}
    assert.equal(outcome.exitCode,0);assert.ok(delays.includes(((probeTimeoutSeconds??30)+40)*1000));
    assert.equal(outcome.result.args.includes('--probe-timeout-seconds'),probeTimeoutSeconds!==undefined);
    if(probeTimeoutSeconds!==undefined)assert.deepEqual(outcome.result.args.slice(-2),['--probe-timeout-seconds',String(probeTimeoutSeconds)]);
  }
});

test('invalid and misplaced probe options never start the runtime', async () => {
  for(const probeTimeoutSeconds of [0,61,1.5,NaN,true,'30',null]) {
    const outcome=await invokeSandboxValidation('diagnose',{request:'request.json',sandboxCommand:'/nonexistent',probeTimeoutSeconds});
    assert.equal(outcome.result.reason_code,'invalid_probe_timeout');assert.equal(outcome.result.stage,'adapter_input');
  }
  const outcome=await invokeSandboxValidation('run',{request:'request.json',probeTimeoutSeconds:30});
  assert.equal(outcome.result.reason_code,'invalid_probe_timeout');
});

test('unsupported CLI stderr is preserved with bounded redaction and no proof authorization', async t => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-diagnostic-stderr-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const executable=path.join(folder,'runtime');
  fs.writeFileSync(executable,`#!${process.execPath}\nconsole.error('No such option: --probe-timeout-seconds token=synthetic-secret '+ 'x'.repeat(3000));process.exitCode=2`,{mode:0o755});
  const outcome=await invokeSandboxValidation('diagnose',{request:'request.json',sandboxCommand:executable,probeTimeoutSeconds:30});
  assert.equal(outcome.exitCode,2);assert.equal(outcome.result.reason_code,'sandbox_option_rejected');
  assert.equal(outcome.result.status,'sandbox_incompatible');assert.doesNotMatch(outcome.result.prompt,/n'est pas disponible/);
  assert.match(outcome.result.reason,/No such option/);assert.ok(!outcome.result.reason.includes('synthetic-secret'));assert.ok(outcome.result.reason.length<=2000);
  assert.equal(outcome.result.execution_authorized_by_gate,false);
});

test('adapter removes every NUL and redacts bounded top-level, nested and stderr diagnostics', async t => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-diagnostic-controls-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const executable=path.join(folder,'runtime');
  const raw='pre\0fi\0x token=token-value api_key=key-value password=password-value secret=secret-value Authorization: Bearer bearer-value sk-'+'A'.repeat(20)+' '+'x'.repeat(2500)+'\0tail';
  const prefix='prefix token=[REDACTED] api_key=[REDACTED] password=[REDACTED] secret=[REDACTED] Authorization: Bearer [REDACTED] [REDACTED] ';
  const expected=prefix+'x'.repeat(2000-prefix.length);
  const readiness={schema_version:'snipara.sandbox.validation.v1',backend:'docker',ready:false,reason:raw,error:raw,stderr:raw};
  for(const action of ['diagnose','gate']) {
    const value=action==='diagnose'?readiness:{status:'needs_user_choice',sandbox_used:false,execution_authorized_by_gate:false,scope_sha256:vectors.cases[0].sha256,choices:['alternative'],reason:raw,error:raw,stderr:raw,readiness};
    fs.writeFileSync(executable,`#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(value))});\n`,{mode:0o755});
    const outcome=await invokeSandboxValidation(action,{sandboxCommand:executable,request:scopeRequest(folder),scope:'lot'});
    assert.equal(outcome.exitCode,2);
    for(const report of action==='gate'?[outcome.result,outcome.result.readiness]:[outcome.result]) {
      for(const key of ['reason','error','stderr']) {
        assert.equal(report[key],expected,`${action} ${key}`);
        assert.equal(report[key].includes('\0'),false);
      }
    }
    assert.notEqual(outcome.result.execution_authorized_by_gate,true);
  }
  fs.writeFileSync(executable,`#!${process.execPath}\nconsole.error(${JSON.stringify(raw)});console.log('{}');process.exitCode=2;\n`,{mode:0o755});
  const outcome=await invokeSandboxValidation('diagnose',{sandboxCommand:executable,request:scopeRequest(folder)});
  assert.equal(outcome.exitCode,2);assert.equal(outcome.result.reason_code,'sandbox_response_invalid');
  assert.equal(outcome.result.reason,expected);assert.equal(outcome.result.reason.includes('\0'),false);
  assert.equal(outcome.result.execution_authorized_by_gate,false);
});

test('run identity is refused before Sandbox on actions that do not take it', async t => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-run-id-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const marker=path.join(folder,'called');const executable=path.join(folder,'runtime');
  fs.writeFileSync(executable,`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'1');console.log('{}')`,{mode:0o755});
  for(const action of ['gate','choose','diagnose','run']){
    const outcome=await invokeSandboxValidation(action,{request:'request.json',scope:action==='run'?undefined:'lot:a',runId:'a'.repeat(32),sandboxCommand:executable});
    assert.equal(outcome.exitCode,2);assert.equal(outcome.result.reason_code,'run_id_not_supported');
    assert.equal(outcome.result.status,'invalid_request');assert.equal(outcome.result.prompt,undefined);
    assert.equal(outcome.result.execution_authorized_by_gate,false);
  }
  assert.equal(fs.existsSync(marker),false);
});

test('a Sandbox that runs and fails is not reported as unavailable', async t => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-command-failed-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const executable=path.join(folder,'runtime');
  fs.writeFileSync(executable,`#!${process.execPath}\nconsole.error('Traceback: invalid request');process.exitCode=1`,{mode:0o755});
  const outcome=await invokeSandboxValidation('gate',{request:'request.json',scope:'lot:a',sandboxCommand:executable});
  assert.equal(outcome.exitCode,2);assert.equal(outcome.result.status,'sandbox_command_failed');
  assert.equal(outcome.result.reason_code,'sandbox_response_invalid');assert.match(outcome.result.reason,/invalid request/);
  assert.doesNotMatch(outcome.result.prompt,/n'est pas disponible/);assert.equal(outcome.result.execution_authorized_by_gate,false);
});
