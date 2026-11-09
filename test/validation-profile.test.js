const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const {loadRuntimeSource} = require('./helpers/runtime-source.cjs');

function subject(response, calls) {
  const file = path.resolve(__dirname, '../src/commands/validation-profile.ts');
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = module.paths;
  const original = loaded.require.bind(loaded);
  loaded.require = name => name === '../runtime/sandbox-validation' ? {
    executeBounded: async (...args) => {
      calls.push(args);
      if (response instanceof Error) throw response;
      return {status: 0, stdout: JSON.stringify(response), stderr: ''};
    },
  } : name === '../runtime/managed-toolchain'
    ? loadRuntimeSource(path.resolve(__dirname, '../src/runtime/managed-toolchain.ts'))
    : original(name);
  loaded._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true},
  }).outputText, file);
  return loaded.exports.validationMetadata;
}

test('profile discovery is metadata-only and does not forward provider credentials', async () => {
  const calls = [];
  const response = {schema_version: 'snipara.validation.profiles.v1', execution_authorized: false, requirements_qualified: false};
  const outcome = await subject(response, calls)('profiles', {sandboxCommand: '/reviewed sandbox'});
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(calls[0].slice(0, 2), ['/reviewed sandbox', ['validation', 'profiles']]);
  assert.deepEqual(Object.keys(calls[0][2]).filter(k => !['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].includes(k)), []);
  assert.equal(calls[0][3], 15000);
});

test('preparation preserves literal arguments, explicit output and image contract', async () => {
  const calls = [];
  const response = {schema_version: 'snipara.sandbox.validation.v1', workspace: '/work/project', argv: ['node', 'literal $(value).js']};
  const outcome = await subject(response, calls)('prepare', {profile: 'node-ci', workspace: '/work/project', image: 'sha256:' + 'a'.repeat(64), output: '/work/request.json', command: response.argv});
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(calls[0][1], ['validation', 'prepare', '--profile', 'node-ci', '--workspace', '/work/project', '--image', 'sha256:' + 'a'.repeat(64), '--output', '/work/request.json', '--', ...response.argv]);
});

test('inspection cannot be promoted into an execution authorization', async () => {
  for (const execution_authorized of [true, undefined]) {
    const outcome = await subject({schema_version: 'snipara.validation.inspection.v1', execution_authorized, requirements_qualified: false}, [])('inspect', {request: 'request.json'});
    assert.equal(outcome.exitCode, 2);
    assert.equal(outcome.result.execution_authorized, false);
  }
  const outcome = await subject({schema_version: 'snipara.validation.inspection.v1', execution_authorized: false, requirements_qualified: false}, [])('inspect', {request: 'request.json'});
  assert.equal(outcome.exitCode, 0);
});

test('unsupported or missing metadata tooling never triggers another executor', async () => {
  const calls = [];
  const outcome = await subject(new Error('synthetic missing executable'), calls)('profiles', {});
  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.result.status, 'validation_metadata_unavailable');
  assert.equal(calls.length, 1);
});

test('malformed preparation inputs stop before the engine', async () => {
  const calls = [];
  const invoke = subject({}, calls);
  await assert.rejects(invoke('prepare', {profile: 'python-ci'}), /required/);
  await assert.rejects(invoke('inspect', {request: 'bad\0path'}), /Invalid/);
  assert.equal(calls.length, 0);
});
