const test = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const cli = path.resolve(__dirname, '../dist/index.js');

test('missing Sandbox produces a structured user choice with no host test fallback', () => {
  const result = spawnSync(process.execPath,[cli,'validation','gate','--request','unavailable.json','--scope','lot','--sandbox-command','/nonexistent/snipara-sandbox'],{encoding:'utf8',env:{...process.env,SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK:'1'}});
  assert.equal(result.status,2);
  const value=JSON.parse(result.stdout);
  assert.equal(value.status,'needs_user_choice');
  assert.equal(value.execution_authorized_by_gate,false);
  assert.equal(value.choices.length,3);
});
