const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const cp=require('node:child_process');
const crypto=require('node:crypto');
const path=require('node:path');
const Module=require('node:module');
const ts=require('typescript');
const {resolveCanonicalDocumentation}=require('./support/source-fixtures.js');
function loadSource(filename, overrides={}) {
  const loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=module.paths;
  const original=loaded.require.bind(loaded);
  loaded.require=name=>Object.hasOwn(overrides,name)?overrides[name]:original(name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,filename);
  return loaded.exports;
}
const checkpoint=loadSource(path.resolve(__dirname,'../src/session/checkpoint.ts'));
const {projectSandboxEvidenceCard,previewSandboxValidationRequest}=loadSource(
  path.resolve(__dirname,'../src/commands/sandbox-evidence-card.ts'),{'../session/checkpoint':checkpoint}
);
const run='a'.repeat(32),request='b'.repeat(64),snapshot='c'.repeat(64),image='sha256:'+'d'.repeat(64);
function verifier(valid=true,reasons=[]) { return {schema_version:'snipara.sandbox.validation.v1',run_id:run,valid,reasons,continuity:'historical_proof_only',receipt:{schema_version:'snipara.sandbox.validation.v1',run_id:run,status:'passed',exit_code:0,cleanup_complete:true,backend:'docker',request_sha256:request,snapshot:{sha256:snapshot},image_id:image,command_sha256:'e'.repeat(64)}}; }
function options(){return {expectedRunId:run,requestPath:'.snipara/reviewed/request.json',storePath:'.snipara/validation',current:{requestSha256:request,snapshotSha256:snapshot,imageId:image}};}

test('editable saved successful verifier claim never becomes fresh reusable proof',()=>{
  const card=projectSandboxEvidenceCard(verifier(),options());
  assert.equal(card.status,'saved_observation');assert.equal(card.savedVerifierClaim,'valid');
  assert.equal(card.authority,'editable_saved_observation');assert.equal(card.verificationFresh,false);
  assert.equal(card.executionAuthorized,false);assert.equal(card.reuse.eligible,false);
  assert.deepEqual(card.reuse.denialReasons,['fresh_verification_required']);
  assert.equal(card.receipt.requestSha256,request);assert.equal(card.receipt.snapshotSha256,snapshot);assert.equal(card.receipt.imageId,image);
  assert.deepEqual(card.nextAction.argv,['snipara-companion','validation','verify','--request','.snipara/reviewed/request.json','--run-id',run,'--store','.snipara/validation']);
  assert.equal(card.nextAction.automaticExecution,false);assert.equal(card.nextAction.dispatchesTests,false);
});

test('request source and image drift are independently displayed beside exact verifier reasons',()=>{
  const reasons=['request_changed','snapshot_changed','image_changed','artifact_path_invalid','artifact_changed','log_changed','artifacts_incomplete','run_not_accepted'];
  const current=options();current.current={requestSha256:'f'.repeat(64),snapshotSha256:'0'.repeat(64),imageId:'sha256:'+'1'.repeat(64)};
  const card=projectSandboxEvidenceCard(verifier(false,reasons),current);
  assert.deepEqual(card.verifierReasons,reasons);
  for(const reason of reasons)assert.ok(card.reuse.denialReasons.includes(reason));
  assert.equal(card.savedVerifierClaim,'invalid');assert.equal(card.reuse.eligible,false);
});

test('gate readiness, malformed success and mismatched run cannot supply evidence authority',()=>{
  for(const saved of [{ready:true,status:'ready'}, {...verifier(),receipt:{}}, {...verifier(),reasons:['request_changed']}]) {
    const card=projectSandboxEvidenceCard(saved,options());assert.equal(card.status,'malformed');assert.equal(card.reuse.eligible,false);
  }
  const opts=options();opts.expectedRunId='2'.repeat(32);
  const card=projectSandboxEvidenceCard(verifier(),opts);
  assert.ok(card.reuse.denialReasons.includes('run_identity_mismatch'));assert.equal(card.nextAction,undefined);
  assert.equal(projectSandboxEvidenceCard(null).status,'not_observed');
});

test('unknown identities and unsafe or credential-bearing paths produce bounded denial, no argv',()=>{
  const card=projectSandboxEvidenceCard(verifier());
  for(const reason of ['task_run_binding_not_observed','current_request_not_observed','current_snapshot_not_observed','current_image_not_observed','request_reference_required'])assert.ok(card.reuse.denialReasons.includes(reason));
  for(const requestPath of ['../outside.json','/absolute/request.json','--help','token=synthetic-secret.json','a\0b']) {
    const card=projectSandboxEvidenceCard(verifier(),{requestPath});assert.equal(card.nextAction,undefined);
    assert.ok(!JSON.stringify(card).includes('synthetic-secret'));
  }
});

test('every ASCII control and DEL is rejected in both request and store references',()=>{
  for(const code of [...Array.from({length:32},(_,index)=>index),127]) {
    for(const field of ['requestPath','storePath']) {
      const current=options();current[field]=`reviewed/a${String.fromCodePoint(code)}b.json`;
      const card=projectSandboxEvidenceCard(verifier(),current);
      const label=`${field} U+${code.toString(16).padStart(4,'0')}`;
      assert.equal(card.nextAction,undefined,label);
      assert.ok(card.reuse.denialReasons.includes('unsafe_request_or_store_reference'),label);
      assert.equal(card.executionAuthorized,false,label);
    }
  }
});

test('neutral Unicode, C1 and bounded references preserve exact argv without authority',()=>{
  for(const value of ['reviewed/my request.json','révision/日本語/🤖.json','a\u0080\u009fb/request.json','x'.repeat(512)]) {
    for(const [field,flag] of [['requestPath','--request'],['storePath','--store']]) {
      const current=options();current[field]=value;
      const card=projectSandboxEvidenceCard(verifier(),current);
      assert.ok(card.nextAction,`${field}: ${JSON.stringify(value)}`);
      assert.equal(card.nextAction.argv[card.nextAction.argv.indexOf(flag)+1],value);
      assert.equal(card.executionAuthorized,false);assert.equal(card.reuse.eligible,false);
    }
  }
  for(const value of ['x'.repeat(513),'reviewed\\request.json','reviewed:request.json','reviewed/../outside.json','reviewed//request.json']) {
    for(const field of ['requestPath','storePath']) {
      const current=options();current[field]=value;
      const card=projectSandboxEvidenceCard(verifier(),current);
      assert.equal(card.nextAction,undefined);
      assert.ok(card.reuse.denialReasons.includes('unsafe_request_or_store_reference'));
    }
  }
});

test('bounded reasons are redacted and raw logs/source contents are excluded',()=>{
  const saved=verifier(false,['future_reason','token=synthetic-secret']);saved.rawLogs='private-raw-log';saved.receipt.argv=['api_key=synthetic-secret'];
  const card=projectSandboxEvidenceCard(saved,options());
  assert.equal(card.verifierReasons[0],'future_reason');assert.match(card.verifierReasons[1],/REDACTED/);
  assert.ok(!JSON.stringify(card).includes('synthetic-secret'));assert.ok(!JSON.stringify(card).includes('private-raw-log'));
  assert.equal(projectSandboxEvidenceCard(verifier(false,Array(33).fill('reason'))).status,'malformed');
  assert.equal(projectSandboxEvidenceCard(verifier(false,['x'.repeat(513)])).status,'malformed');
  const huge=verifier();huge.unused='x'.repeat(1024*1024);assert.ok(JSON.stringify(projectSandboxEvidenceCard(huge)).length<10000);
});

test('request preview binds file bytes and shows limits without canonical proof or execution',()=>{
  const request={workspace:'/reviewed/project',image,profile:'python',argv:['python','-m','pytest','token=synthetic-secret'],timeout_seconds:120,cpus:2,memory_mb:1024,pids:128,disk_mb:512,requirements:{python_modules:['pytest'],commands:['git']}};
  const text=JSON.stringify(request,null,2),preview=previewSandboxValidationRequest(text);
  assert.equal(preview.requestFileSha256,crypto.createHash('sha256').update(text).digest('hex'));
  assert.equal(preview.summary.immutableImageReference,true);assert.equal(preview.summary.limits.timeout_seconds,120);
  assert.equal(preview.canonicalRequestIdentity,false);assert.equal(preview.validatedBySandbox,false);assert.equal(preview.executionAuthorized,false);
  assert.ok(!JSON.stringify(preview).includes('synthetic-secret'));
  assert.notEqual(preview.requestFileSha256,previewSandboxValidationRequest(JSON.stringify(request)).requestFileSha256);
  assert.throws(()=>previewSandboxValidationRequest(' '.repeat(65537)),/64KiB/);
  assert.throws(()=>previewSandboxValidationRequest('{"argv":[]}'),/structure/);
});

test('card and request projections perform zero filesystem, network or process operations',()=>{
  const originals=[];const deny=()=>{throw new Error('I/O forbidden in projection')};
  try {
    for(const [object,key] of [[fs,'readFileSync'],[fs,'writeFileSync'],[fs,'openSync'],[cp,'spawnSync'],[cp,'execFileSync'],[global,'fetch']]) {originals.push([object,key,object[key]]);object[key]=deny;}
    projectSandboxEvidenceCard(verifier(),options());
    previewSandboxValidationRequest(JSON.stringify({workspace:'/reviewed',image,argv:['true']}));
  } finally {for(const [object,key,value] of originals)object[key]=value;}
});

test('documented example remains an explicit unqualified request template',()=>{
  const text=fs.readFileSync(resolveCanonicalDocumentation('docs/guides/sandbox-validation-preparation/request.example.json'),'utf8');
  const preview=previewSandboxValidationRequest(text);
  assert.equal(preview.summary.immutableImageReference,false);
  assert.equal(preview.summary.requirements.python_modules[0],'pytest');
  assert.equal(preview.executionAuthorized,false);assert.ok(text.includes('REPLACE_WITH_REVIEWED'));
});
