const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { validateRuntimeSourceContext } = require('../dist/index.js');
const hash = value => createHash('sha256').update(value).digest('hex');
function source() {
  const receipt = {version:'snipara.workflow.task-context-receipt.v1',workflowId:'flow',phaseId:'phase',taskId:'task',attempt:1,requestHash:'a'.repeat(64),packId:'pack',loadedAt:'2026-10-19T00:00:00Z',chunkIds:['one'],authority:'local_client_observed',semanticUseVerified:false};
  const content = JSON.stringify({version:'snipara.workflow.loaded-context.v1',workflowId:'flow',phaseId:'phase',taskId:'task',attempt:1,requestHash:receipt.requestHash,output:{},inputs:[],calls:[],chunks:[{id:'one',content:'é 🧭',sha256:hash('é 🧭'),source:{file:'source.md'}}]});
  receipt.sha256 = hash(content);
  return {schemaVersion:'snipara.runtime.source-context.v1',receipt,content};
}
test('exact runtime body keeps source identity and explicit consumer mapping', () => {
  const value = {...source(),targetTaskId:'mapped'};
  assert.equal(validateRuntimeSourceContext(value,'mapped').receipt.taskId,'task');
  assert.throws(()=>validateRuntimeSourceContext(value,'other'),/consumer/);
});
test('runtime envelope refuses changed body, unknown receipt fields and false authority', () => {
  for (const mutate of [v=>v.content+=' ',v=>v.receipt.semanticUseVerified=true,v=>v.receipt.authority='verified',v=>v.receipt.unknown=true,v=>v.targetAttempt=0]) {
    const value=source(); mutate(value); assert.throws(()=>validateRuntimeSourceContext(value));
  }
});
test('chunk identity and raw bytes are checked independently of outer body hash', () => {
  for (const mutate of [body=>body.chunks[0].content='changed',body=>body.chunks[0].id='other',body=>body.taskId='other',body=>body.chunks.push(body.chunks[0])]) {
    const value=source(),body=JSON.parse(value.content); mutate(body); value.content=JSON.stringify(body);value.receipt.sha256=hash(value.content);
    assert.throws(()=>validateRuntimeSourceContext(value));
  }
});
test('ambiguous JSON keys and non-finite observations are rejected before export', () => {
  for (const fragment of ['"extra":1,"extra":2,','"extra":1e999,']) {
    const value=source(); value.content='{'+fragment+value.content.slice(1);value.receipt.sha256=hash(value.content);
    assert.throws(()=>validateRuntimeSourceContext(value));
  }
});
