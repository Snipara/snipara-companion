const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Module = require('node:module');
const ts = require('typescript');

function load(file) {
  const m = new Module(file, module); m.filename = file; m.paths = module.paths;
  const original = m.require.bind(m);
  m.require = name => {
    if (name === '../contracts/project-intelligence') return load(path.resolve(__dirname, '../src/contracts/project-intelligence/managed-toolchain.ts'));
    if (name.startsWith('.')) {
      const target = path.resolve(path.dirname(file), name + '.ts');
      if (fs.existsSync(target)) return load(target);
    }
    return original(name);
  };
  m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  }}).outputText, file);
  return m.exports;
}
const subject = load(path.resolve(__dirname, '../src/runtime/managed-toolchain.ts'));
const {managedValidationScope, parseManagedToolchainManifest} = load(path.resolve(__dirname, '../src/contracts/project-intelligence/managed-toolchain.ts'));
const {invokeSandboxValidation} = load(path.resolve(__dirname, '../src/runtime/sandbox-validation.ts'));
const {prepareManagedMcpLaunch} = load(path.resolve(__dirname, '../src/runtime/managed-mcp.ts'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t, suffix = '') {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snipara-managed-')));
  fs.chmodSync(base, 0o700); t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const root = path.join(base, 'bundle' + suffix); fs.mkdirSync(root, {mode: 0o700});
  const marker = path.join(base, 'should-not-run');
  const components = {};
  for (const name of ['companion', 'orchestrator', 'sandbox']) {
    const command = path.join(root, name);
    const bytes = `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)},'ran');\n`;
    fs.writeFileSync(command, bytes, {mode: 0o700});
    components[name] = {command, version: name === 'sandbox' ? '3.0.0' : name === 'orchestrator' ? '1.16.0' : '4.2.0', sha256: hash(bytes)};
  }
  const manifest = {schemaVersion: 'snipara.toolchain.v1', bundleId: 'test-local-work', root,
    components, contracts: {taskReference: 1, validation: 1}, capabilities: ['validation', 'coordination']};
  const manifestPath = path.join(root, 'manifest.json');
  const write = () => fs.writeFileSync(manifestPath, JSON.stringify(manifest), {mode: 0o600}); write();
  const active = path.join(base, 'active.json'); fs.symlinkSync(manifestPath, active);
  return {base, root, marker, manifest, manifestPath, active, write};
}

test('owned active selection pins immutable paths and only observes installed bytes', t => {
  const f = fixture(t);
  const value = subject.resolveManagedToolchain({manifestPath: f.active});
  assert.equal(value.manifestPath, f.manifestPath);
  assert.equal(value.manifestSha256, hash(fs.readFileSync(f.manifestPath)));
  assert.deepEqual(value.components, f.manifest.components);
  const report = subject.inspectManagedToolchain({manifestPath: f.active});
  assert.equal(report.status, 'available'); assert.equal(report.installed, true);
  assert.equal(report.callable, null); assert.equal(report.verified, null);
  assert.equal(report.executionAuthorized, false); assert.equal(fs.existsSync(f.marker), false);
});

test('absent default stays legacy but explicit missing or dangling selection never falls back', t => {
  const f = fixture(t);
  assert.equal(subject.resolveManagedToolchain({home: f.base, env: {}}), null);
  assert.throws(() => subject.resolveManagedToolchain({manifestPath: path.join(f.base, 'missing')}), /unavailable/);
  fs.unlinkSync(f.active); fs.symlinkSync(path.join(f.base, 'missing'), f.active);
  assert.throws(() => subject.resolveManagedToolchain({manifestPath: f.active}), /invalid or changed/);
});

test('an activated successor cannot change an already resolved peer environment', t => {
  const f = fixture(t);
  const selected = subject.resolveManagedToolchain({manifestPath: f.active});
  const next = path.join(f.base, 'successor.json');
  fs.writeFileSync(next, '{}', {mode: 0o600}); fs.unlinkSync(f.active); fs.symlinkSync(next, f.active);
  const env = subject.managedToolchainEnvironment(selected, {PATH: '/approved', OPENAI_API_KEY: 'synthetic', RLM_API_KEY: 'synthetic'});
  assert.equal(env.SNIPARA_TOOLCHAIN_MANIFEST, f.manifestPath);
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.RLM_API_KEY, undefined);
  assert.throws(() => subject.resolveManagedToolchain({manifestPath: f.active}));
});

test('native launch preparation pins a stable generation and operator root without executing or forwarding secrets', t => {
  const f = fixture(t);
  const launch = prepareManagedMcpLaunch({workspaceRoot: f.base, manifestPath: f.active});
  assert.equal(launch.command, f.manifest.components.sandbox.command);
  assert.deepEqual(launch.args, ['mcp-serve']);
  assert.equal(launch.cwd, f.base);
  assert.equal(launch.env.SNIPARA_TOOLCHAIN_MANIFEST, f.manifestPath);
  assert.equal(launch.env.SNIPARA_SANDBOX_VALIDATION_WORKSPACE, f.base);
  assert.equal(launch.env.SNIPARA_SANDBOX_VALIDATION_ENABLED, '1');
  assert.equal(launch.env.OPENAI_API_KEY, undefined);
  assert.equal(fs.existsSync(f.marker), false);
  assert.throws(() => prepareManagedMcpLaunch({workspaceRoot: f.base + '/.', manifestPath: f.active}), /canonical/);
  f.manifest.components.sandbox.version = '2.5.0'; f.write();
  assert.throws(() => prepareManagedMcpLaunch({workspaceRoot: f.base, manifestPath: f.active}), error => error.code === 'toolchain_version_incompatible');
});

function runNativeHarness(f, input) {
  const helper = path.resolve(__dirname, 'helpers/runtime-source.cjs');
  const source = path.resolve(__dirname, '../src/runtime/managed-mcp.ts');
  const harness = `require(${JSON.stringify(helper)}).loadRuntimeSource(${JSON.stringify(source)}).launchManagedMcp(${JSON.stringify({workspaceRoot:f.base,manifestPath:f.active})}).then(code=>{process.exitCode=code}).catch(()=>{process.exitCode=2});`;
  return require('node:child_process').spawnSync(process.execPath, ['-e', harness], {input, encoding:'utf8', timeout:12000});
}

test('native bootstrap forwards only the stdio protocol and exits on disconnect', t => {
  const f = fixture(t), command = f.manifest.components.sandbox.command;
  fs.writeFileSync(command, `#!${process.execPath}\nprocess.stdin.on('data',b=>process.stdout.write(b));process.stdin.on('end',()=>{});`, {mode:0o700});
  f.manifest.components.sandbox.sha256 = hash(fs.readFileSync(command)); f.write();
  const protocol = '{"jsonrpc":"2.0","id":1,"method":"synthetic"}\n';
  const result = runNativeHarness(f, protocol);
  assert.ifError(result.error); assert.equal(result.status, 0); assert.equal(result.stdout, protocol);
});

test('a native server ignoring disconnect is terminated within the owned shutdown budget', t => {
  const f = fixture(t), command = f.manifest.components.sandbox.command;
  fs.writeFileSync(command, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},100);`, {mode:0o700});
  f.manifest.components.sandbox.sha256 = hash(fs.readFileSync(command)); f.write();
  const started = Date.now(), result = runNativeHarness(f, '');
  assert.ifError(result.error); assert.equal(result.status, 2); assert.equal(result.stdout, '');
  assert(Date.now() - started < 10000);
});

test('changed command bytes and group-writable manifest fail before any call', t => {
  const f = fixture(t);
  fs.appendFileSync(f.manifest.components.sandbox.command, '// changed\n');
  assert.throws(() => subject.resolveManagedToolchain({manifestPath: f.active}), error => error.code === 'toolchain_component_changed');
  f.manifest.components.sandbox.sha256 = hash(fs.readFileSync(f.manifest.components.sandbox.command)); f.write();
  fs.chmodSync(f.manifestPath, 0o660);
  assert.throws(() => subject.resolveManagedToolchain({manifestPath: f.active}), /permissions/);
  assert.equal(fs.existsSync(f.marker), false);
});

test('declared paths cannot escape through traversal, another root or a symlink', t => {
  const f = fixture(t);
  for (const command of ['/elsewhere/sdk', f.root + '/../sdk', f.root + '//sdk']) {
    assert.throws(() => parseManagedToolchainManifest({...f.manifest, components: {...f.manifest.components,
      sandbox: {...f.manifest.components.sandbox, command}}}));
  }
  const command = f.manifest.components.sandbox.command;
  const outside = path.join(f.base, 'outside'); fs.renameSync(command, outside); fs.symlinkSync(outside, command);
  assert.throws(() => subject.resolveManagedToolchain({manifestPath: f.active}), /invalid or changed/);
});

test('coordination roots come from the operator/current workspace and cannot widen from a request', t => {
  const f = fixture(t), repo = path.join(f.base, 'repo'), sub = path.join(repo, 'sub');
  fs.mkdirSync(repo); fs.mkdirSync(path.join(repo, '.git')); fs.mkdirSync(sub);
  assert.equal(subject.managedCoordinationRoot(sub, undefined, {}, sub), repo);
  assert.equal(subject.managedCoordinationRoot(sub, sub, {}, sub), sub);
  assert.throws(() => subject.managedCoordinationRoot(f.root, undefined, {}, sub), /outside/);
  assert.equal(subject.managedCoordinationRoot(sub, undefined, {SNIPARA_SANDBOX_VALIDATION_WORKSPACE: repo}, sub), repo);
  assert.throws(() => subject.managedCoordinationRoot(sub, undefined, {SNIPARA_SANDBOX_VALIDATION_WORKSPACE: repo}, f.root), /within the approved/);
});

test('automatic lots bind canonical SDK identity, not JSON bytes or an observed task revision', () => {
  assert.equal(managedValidationScope('a'.repeat(64)), 'snipara-validation:' + 'a'.repeat(64));
  for (const digest of ['', 'x'.repeat(64), '../other', 'a'.repeat(65)]) assert.throws(() => managedValidationScope(digest));
});

function runnableFixture(t) {
  const f = fixture(t), request = path.join(f.base, 'request.json'), calls = path.join(f.base, 'calls.jsonl');
  fs.writeFileSync(request, JSON.stringify({workspace: f.base, argv: ['python', '-V']}));
  const receipt = {schema_version:'snipara.sandbox.validation.v1',run_id:'a'.repeat(32),status:'passed',cleanup_complete:true,exit_code:0,backend:'docker'};
  const record = `const fs=require('fs'),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({command:__filename,args:a,env:Object.keys(process.env)})+'\\n');`;
  fs.writeFileSync(f.manifest.components.sandbox.command, `#!${process.execPath}\n${record}
console.log(JSON.stringify({schema_version:'snipara.validation.inspection.v1',execution_authorized:false,requirements_qualified:false,request_sha256:'${'b'.repeat(64)}',canonical_request:{workspace:${JSON.stringify(f.base)}}}));`, {mode:0o700});
  fs.writeFileSync(f.manifest.components.orchestrator.command, `#!${process.execPath}\n${record}
if(a.includes('--help'))console.log('Options: --no-reuse');else console.log(${JSON.stringify(JSON.stringify({...receipt,work_reuse:{state:'executed'}}))});`, {mode:0o700});
  for (const name of ['sandbox','orchestrator']) f.manifest.components[name].sha256=hash(fs.readFileSync(f.manifest.components[name].command)); f.write();
  return {...f,request,calls};
}

test('managed scope omission reaches only the pinned coordinator with a canonical lot and private environment', async t => {
  const f = runnableFixture(t);
  const previousCwd = process.cwd();
  const previous = {OPENAI_API_KEY:process.env.OPENAI_API_KEY,RLM_API_KEY:process.env.RLM_API_KEY};
  process.chdir(f.base);
  Object.assign(process.env,{OPENAI_API_KEY:'synthetic',RLM_API_KEY:'synthetic'});
  try {
    const outcome = await invokeSandboxValidation('run',{toolchainManifest:f.active,request:f.request,coordinationRoot:f.base});
    assert.equal(outcome.exitCode,0); assert.equal(outcome.result.work_reuse.state,'executed');
    const calls=fs.readFileSync(f.calls,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter(c=>c.command===f.manifest.components.sandbox.command).length,1);
    const run=calls.find(c=>c.command===f.manifest.components.orchestrator.command&&!c.args.includes('--help'));
    const flag=name=>run.args[run.args.indexOf(name)+1];
    assert.equal(flag('--scope'),'snipara-validation:'+'b'.repeat(64));
    assert.equal(flag('--sandbox-command'),f.manifest.components.sandbox.command);
    assert.equal(flag('--store'),path.join(f.base,'.snipara','validation'));
    assert.equal(flag('--coordination-root'),f.base);
    for(const c of calls){assert(!c.env.includes('OPENAI_API_KEY'));assert(!c.env.includes('RLM_API_KEY'));assert(c.env.includes('SNIPARA_TOOLCHAIN_MANIFEST'));}
  } finally {
    process.chdir(previousCwd);
    for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
});

test('a broken managed selection cannot invoke explicit legacy executables', async t => {
  const f = runnableFixture(t);fs.appendFileSync(f.manifest.components.sandbox.command,'\n// changed');
  const result=await invokeSandboxValidation('run',{toolchainManifest:f.active,request:f.request,sandboxCommand:'/untrusted/fallback'});
  assert.equal(result.exitCode,2);assert.equal(result.result.status,'managed_toolchain_needs_attention');
  assert.equal(fs.existsSync(f.calls),false);assert.equal(result.result.execution_authorized_by_gate,false);
});
