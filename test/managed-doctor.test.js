const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function subject(report, probes) {
  const file = path.resolve(__dirname, '../src/commands/doctor.ts');
  const loaded = new Module(file, module); loaded.filename = file; loaded.paths = module.paths;
  const original = loaded.require.bind(loaded);
  const unexpected = () => { probes.push('probe'); throw new Error('explicit deep probe'); };
  loaded.require = name => {
    if (name === '../runtime/managed-toolchain') return {inspectManagedToolchain: () => report};
    if (name === '../runtime/detection') return {detectRuntimeEnvironment: unexpected};
    if (name === '../runtime/capability-status') return {diagnosticProbeEnvironment: unexpected, summarizeRuntimeCapabilities: unexpected};
    if (name === '../api/client') return {createClient: unexpected};
    if (name === 'node:child_process') return {execFileSync: unexpected};
    if (name === 'chalk') return {};
    return original(name);
  };
  loaded._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  }}).outputText, file);
  return loaded.exports.doctorCommand;
}

test('default doctor only returns metadata even when no managed installation exists', async () => {
  const probes = [], output = [], original = console.log;
  const report = {schemaVersion:'snipara.toolchain_status.v1',status:'not_configured',installed:false,callable:null,verified:null,executionAuthorized:false};
  console.log = value => output.push(value);
  try { await subject(report, probes)({json:true}); } finally { console.log = original; }
  assert.deepEqual(probes, []); assert.deepEqual(JSON.parse(output[0]), report);
});

test('legacy environment probes require explicit deep diagnostics', async () => {
  const probes = [];
  await assert.rejects(subject({status:'not_configured'}, probes)({deep:true}), /explicit deep probe/);
  assert.deepEqual(probes, ['probe']);
});
