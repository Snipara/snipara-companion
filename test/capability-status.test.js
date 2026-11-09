const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const ts = require('typescript');
const {spawnSync} = require('node:child_process');
function loadSource(name, overrides={}) {
  const filename=path.resolve(__dirname,'../src/runtime',name+'.ts');
  const loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=module.paths;
  const original=loaded.require.bind(loaded);
  loaded.require=name=>Object.hasOwn(overrides,name)?overrides[name]:original(name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,filename);
  return loaded.exports;
}
const capability = loadSource('capability-status');
function fixture() { return {runtime:{cliAvailable:true,mcpConfigured:true},orchestrator:{cliAvailable:true},docker:{available:true},providerKeys:{any:true}}; }

test('all discovered surfaces remain separately unqualified with no execution authority',()=>{
  const value=capability.summarizeRuntimeCapabilities(fixture());
  assert.equal(value.execution_authorized,false);
  assert.deepEqual(value.surfaces.map(surface=>surface.id),['restricted_python','deterministic_validation','provider_native','orchestrator']);
  for(const surface of value.surfaces) {
    assert.equal(surface.task_qualification,'unqualified');assert.equal(surface.execution_authorized,false);
    assert.equal(surface.endpoint,'not_checked');assert.equal(surface.permissions,'not_checked');
  }
  const validation=value.surfaces[1];
  assert.equal(validation.authentication,'not_required');assert.equal(validation.executable,'found');
  assert.equal(validation.docker_cli,'found');assert.equal(validation.prepared_image,'not_checked');
  assert.equal(validation.workspace_binding,'not_checked');assert.equal(validation.verified_test,'not_checked');
  assert.match(validation.next_action,/readiness is not a passing test/);
  assert.equal(value.surfaces[2].authentication,'not_checked');assert.equal(value.surfaces[3].authentication,'not_checked');
});

test('missing and legacy executables cannot advertise deterministic validation or native execution',()=>{
  const report=fixture();report.runtime.legacyCommand=true;report.orchestrator.cliAvailable=false;
  const surfaces=capability.summarizeRuntimeCapabilities(report).surfaces;
  assert.equal(surfaces[1].executable,'missing');assert.match(surfaces[1].next_action,/explicit choice/);
  assert.equal(surfaces[2].executable,'not_checked');assert.equal(surfaces[3].executable,'missing');
  report.runtime.legacyCommand=false;report.docker.available=false;
  assert.match(capability.summarizeRuntimeCapabilities(report).surfaces[1].next_action,/Docker CLI/);
});

test('provider credentials do not change deterministic validation requirements or qualification',()=>{
  const report=fixture();const before=capability.summarizeRuntimeCapabilities(report);
  report.providerKeys.any=false;
  assert.deepEqual(capability.summarizeRuntimeCapabilities(report),before);
});

test('discovery probes receive only non-secret environment settings including PATH fallback',()=>{
  const env={PATH:'/usr/bin',HOME:'/tmp/example',LANG:'C.UTF-8',OPENAI_API_KEY:'provider-secret',ANTHROPIC_API_KEY:'provider-secret',SNIPARA_API_KEY:'hosted-secret',AWS_SECRET_ACCESS_KEY:'cloud-secret',NODE_OPTIONS:'--require unsafe.js'};
  assert.deepEqual(capability.diagnosticProbeEnvironment(env),{PATH:'/usr/bin',HOME:'/tmp/example',LANG:'C.UTF-8'});
  const calls=[];
  const detection=loadSource('detection',{'./capability-status':capability,'../config/store':{},child_process:{execFileSync:(command,args,options)=>{calls.push({command,args,options});if(command!=='sh')throw new Error('version unsupported');return '/usr/bin/fake';}}});
  assert.equal(detection.commandExists('fake-client',env),true);
  assert.equal(calls.length,2);
  for(const call of calls)assert.deepEqual(call.options.env,{PATH:'/usr/bin',HOME:'/tmp/example',LANG:'C.UTF-8'});
});

test('deep doctor retains existing JSON fields and adds honest capability states without configured auth',t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'doctor-capability-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const result=spawnSync(process.execPath,[path.resolve(__dirname,'../dist/index.js'),'doctor','--deep','--json'],{cwd:folder,encoding:'utf8',env:{PATH:process.env.PATH,HOME:folder,SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK:'1'},timeout:30000});
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);
  for(const key of ['runtime','orchestrator','docker','companionVersion','auth','toolCatalog'])assert.ok(Object.hasOwn(report,key));
  assert.equal(report.auth.checked,false);assert.equal(report.capabilities.execution_authorized,false);
  assert.equal(report.capabilities.surfaces.length,4);
  assert.ok(!result.stdout.includes('provider-secret'));
});


test('deep doctor public npm version discovery also strips provider credentials and injected Node options',async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'doctor-npm-environment-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const report={...fixture(),cwd:folder,workspaceRoot:null,companion:{configured:false,configPath:path.join(folder,'config.json')}};
  const calls=[];
  const doctor=loadSource('../commands/doctor',{'chalk':{},'../runtime/capability-status':capability,'../runtime/detection':{detectRuntimeEnvironment:()=>report},'../runtime/managed-toolchain':{inspectManagedToolchain:()=>({status:'not_configured'})},'../api/client':{createClient:()=>{throw new Error('No auth probe expected')}},'node:child_process':{execFileSync:(command,args,options)=>{calls.push({command,args,options});return '3.10.0';}}});
  const previous={skip:process.env.SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK,key:process.env.OPENAI_API_KEY,nodeOptions:process.env.NODE_OPTIONS};
  const original=console.log;
  try {
    delete process.env.SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK;
    process.env.OPENAI_API_KEY='provider-secret';process.env.NODE_OPTIONS='--require unsafe.js';console.log=()=>{};
    await doctor.doctorCommand({json:true,deep:true});
  } finally {
    console.log=original;
    for(const [name,value] of [['SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK',previous.skip],['OPENAI_API_KEY',previous.key],['NODE_OPTIONS',previous.nodeOptions]]) {if(value===undefined)delete process.env[name];else process.env[name]=value;}
  }
  assert.equal(calls.length,1);assert.equal(calls[0].command,'npm');
  assert.equal(calls[0].options.env.OPENAI_API_KEY,undefined);assert.equal(calls[0].options.env.NODE_OPTIONS,undefined);
});
