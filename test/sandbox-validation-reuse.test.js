const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { loadRuntimeSource: loadSource } = require("./helpers/runtime-source.cjs");
const { invokeSandboxValidation } = loadSource(
  path.resolve(__dirname, "../src/runtime/sandbox-validation.ts")
);
const { expectedSandboxScope } = loadSource(
  path.resolve(__dirname, "../src/runtime/sandbox-identity.ts")
);

function fixture(t, { help = "Options: --no-reuse", run } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "companion reuse quotes' $-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const request = path.join(folder, 'request "quoted".json');
  const store = path.join(folder, "evidence $literal");
  const sandboxCommand = path.join(folder, 'sandbox "quoted"');
  const orchestratorCommand = path.join(folder, "orchestrator $literal");
  const callsFile = path.join(folder, "calls.jsonl");
  const sandboxCallsFile = path.join(folder, "sandbox-calls.jsonl");
  const savedFile = path.join(folder, "saved.json");
  fs.writeFileSync(request, "{}");
  const receipt = {
    schema_version: "snipara.sandbox.validation.v1",
    run_id: "a".repeat(32),
    status: "passed",
    cleanup_complete: true,
    exit_code: 0,
    backend: "docker",
  };
  fs.writeFileSync(
    sandboxCommand,
    `#!${process.execPath}
const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(sandboxCallsFile)},JSON.stringify({args:process.argv.slice(2),env:Object.keys(process.env)})+'\\n');
console.log(${JSON.stringify(JSON.stringify(receipt))});
`,
    { mode: 0o755 }
  );
  const defaultRun = `
const savedFile=${JSON.stringify(savedFile)};
if(fs.existsSync(savedFile)&&!args.includes('--no-reuse')) {
  console.log(JSON.stringify({...JSON.parse(fs.readFileSync(savedFile,'utf8')),work_reuse:{state:'reused'}}));
} else {
  const value=flag=>args[args.indexOf(flag)+1];
  const child=require('node:child_process').spawnSync(value('--sandbox-command'),['validation','run','--request',value('--request'),'--store',value('--store')],{encoding:'utf8',env:process.env,shell:false});
  const receipt=JSON.parse(child.stdout);
  fs.writeFileSync(savedFile,JSON.stringify(receipt));
  console.log(JSON.stringify({...receipt,work_reuse:{state:'executed'}}));
}`;
  fs.writeFileSync(
    orchestratorCommand,
    `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify({args,env:Object.keys(process.env)})+'\\n');
if(args.includes('--help')) {console.log(${JSON.stringify(help)});process.exit(0);}
${run ?? defaultRun}
`,
    { mode: 0o755 }
  );
  const readCalls = (file) =>
    fs.existsSync(file)
      ? fs
          .readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  return {
    request,
    store,
    sandboxCommand,
    orchestratorCommand,
    receipt,
    options: {
      request,
      store,
      sandboxCommand,
      orchestratorCommand,
      scope: 'lot "quoted" $literal',
    },
    calls: () => readCalls(callsFile),
    sandboxCalls: () => readCalls(sandboxCallsFile),
  };
}

test("scoped runs delegate safely and preserve shared reuse receipts with a clean environment", async (t) => {
  const f = fixture(t);
  const previous = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    RLM_API_KEY: process.env.RLM_API_KEY,
    SNIPARA_API_KEY: process.env.SNIPARA_API_KEY,
  };
  Object.assign(process.env, {
    OPENAI_API_KEY: "synthetic-provider",
    RLM_API_KEY: "synthetic-memory",
    SNIPARA_API_KEY: "synthetic-project",
  });
  try {
    const first = await invokeSandboxValidation("run", f.options);
    const second = await invokeSandboxValidation("run", f.options);
    assert.equal(first.exitCode, 0);
    assert.equal(second.exitCode, 0);
    assert.deepEqual(first.result, { ...f.receipt, work_reuse: { state: "executed" } });
    assert.deepEqual(second.result, { ...f.receipt, work_reuse: { state: "reused" } });
    const calls = f.calls();
    assert.equal(calls.filter((call) => call.args.includes("--help")).length, 2);
    const runs = calls.filter((call) => !call.args.includes("--help"));
    assert.equal(runs.length, 2);
    assert.deepEqual(runs[0].args, [
      "validation",
      "run",
      "--request",
      f.request,
      "--scope",
      f.options.scope,
      "--store",
      f.store,
      "--sandbox-command",
      f.sandboxCommand,
    ]);
    assert.equal(f.sandboxCalls().length, 1);
    assert.equal(f.sandboxCalls()[0].args.includes("--scope"), false);
    for (const call of [...calls, ...f.sandboxCalls()]) {
      for (const name of Object.keys(previous)) assert.equal(call.env.includes(name), false);
    }
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("no-reuse delegates a fresh request through the same coordinator", async (t) => {
  const f = fixture(t);
  await invokeSandboxValidation("run", f.options);
  const outcome = await invokeSandboxValidation("run", { ...f.options, noReuse: true });
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.work_reuse.state, "executed");
  assert.equal(f.sandboxCalls().length, 2);
  assert.equal(f.calls().filter((call) => call.args.includes("--no-reuse")).length, 1);
  const cli = path.resolve(__dirname, "../dist/index.js");
  const cliRun = spawnSync(
    process.execPath,
    [
      cli,
      "validation",
      "run",
      "--request",
      f.request,
      "--scope",
      f.options.scope,
      "--store",
      f.store,
      "--sandbox-command",
      f.sandboxCommand,
      "--orchestrator-command",
      f.orchestratorCommand,
      "--no-reuse",
    ],
    { encoding: "utf8", env: { ...process.env, SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK: "1" } }
  );
  assert.equal(cliRun.status, 0, cliRun.stderr);
  assert.equal(JSON.parse(cliRun.stdout).work_reuse.state, "executed");
  assert.equal(f.sandboxCalls().length, 3);
  assert.equal(f.calls().filter((call) => call.args.includes("--no-reuse")).length, 2);
});

test("busy and interrupted coordination remain nonpassing without a fabricated run identity", async (t) => {
  for (const [status, state] of [
    ["validation_in_progress", "in_progress"],
    ["validation_reuse_needs_review", "needs_review"],
  ]) {
    const response = { status, work_reuse: { state, key: "b".repeat(64) } };
    const f = fixture(t, {
      run: `console.log(${JSON.stringify(JSON.stringify(response))});process.exitCode=2;`,
    });
    const outcome = await invokeSandboxValidation("run", f.options);
    assert.equal(outcome.exitCode, 2);
    assert.deepEqual(outcome.result, response);
    assert.equal(outcome.result.run_id, undefined);
    assert.equal(f.sandboxCalls().length, 0);
  }
});

test("unavailable gates preserve a safe choice prompt while saved choices require exact scope binding", async (t) => {
  const vector = require("./fixtures/sandbox-scope-v2.json").cases[0];
  const unavailable = {
    status: "needs_user_choice",
    prompt: "Choose an environment token=synthetic-secret",
    choices: ["alternative", "install", "continue_without_sandbox"],
    execution_authorized_by_gate: false,
    reason: "Docker unavailable token=synthetic-secret",
    work_reuse: { state: "needs_review", key: null },
  };
  const choice = {
    schema_version: "snipara.validation.choice.v1",
    scope_sha256: vector.sha256,
    authority: "operator_asserted",
    choice: "alternative",
    environment: "reviewed environment",
    created_at: Date.now() / 1000,
    expires_at: Date.now() / 1000 + 600,
  };
  const recorded = {
    status: "user_choice_recorded",
    scope_sha256: vector.sha256,
    sandbox_used: false,
    execution_authorized_by_gate: false,
    proof_requirement_waived: false,
    choice,
    work_reuse: { state: "needs_review", key: null },
  };
  for (const [response, preserved] of [
    [unavailable, true],
    [{ ...unavailable, scope_sha256: vector.sha256, sandbox_used: false }, true],
    [recorded, true],
    [{ ...unavailable, choices: ["run_on_host"] }, false],
    [{ ...unavailable, scope_sha256: "b".repeat(64) }, false],
    [{ ...recorded, scope_sha256: undefined }, false],
    [{ ...recorded, choice: { ...choice, scope_sha256: "b".repeat(64) } }, false],
    [{ ...recorded, proof_requirement_waived: true }, false],
  ]) {
    const f = fixture(t, {
      run: `console.log(${JSON.stringify(JSON.stringify(response))});process.exitCode=2;`,
    });
    fs.writeFileSync(f.request, JSON.stringify(vector.request));
    const outcome = await invokeSandboxValidation("run", { ...f.options, scope: vector.scope });
    assert.equal(outcome.exitCode, 2);
    assert.equal(outcome.result.work_reuse.state, "needs_review");
    assert.equal(outcome.result.run_id, undefined);
    if (preserved) {
      assert.equal(outcome.result.status, response.status);
      assert.equal(outcome.result.execution_authorized_by_gate, false);
      if (response.status === "needs_user_choice") {
        assert.deepEqual(outcome.result.choices, unavailable.choices);
        assert.equal(outcome.result.prompt, "Choose an environment token=[REDACTED]");
        assert.equal(outcome.result.reason, "Docker unavailable token=[REDACTED]");
      } else assert.deepEqual(outcome.result.choice, choice);
    } else assert.equal(outcome.result.reason_code, "orchestrator_response_invalid");
    assert.equal(f.sandboxCalls().length, 0);
    assert.equal(f.calls().length, 2);
  }
});

test("missing or incompatible coordinator fails before execution without Sandbox fallback", async (t) => {
  const f = fixture(t, { help: "Old validation run options" });
  for (const orchestratorCommand of [
    f.orchestratorCommand,
    path.join(path.dirname(f.request), "missing"),
  ]) {
    const outcome = await invokeSandboxValidation("run", { ...f.options, orchestratorCommand });
    assert.equal(outcome.exitCode, 2);
    assert.equal(outcome.result.status, "orchestrator_update_required");
    assert.equal(outcome.result.execution_authorized_by_gate, false);
  }
  assert.equal(f.calls().length, 1);
  assert.equal(f.calls()[0].args.includes("--help"), true);
  assert.equal(f.sandboxCalls().length, 0);
});

test("malformed delegated responses never retry or fall back to direct Sandbox", async (t) => {
  for (const response of [
    "not-json",
    JSON.stringify({ status: "passed", work_reuse: { state: "reused" } }),
  ]) {
    const f = fixture(t, { run: `console.log(${JSON.stringify(response)});` });
    const outcome = await invokeSandboxValidation("run", f.options);
    assert.equal(outcome.exitCode, 2);
    assert.equal(outcome.result.reason_code, "orchestrator_response_invalid");
    assert.equal(outcome.result.work_reuse.state, "needs_review");
    assert.equal(f.calls().length, 2);
    assert.equal(f.sandboxCalls().length, 0);
  }
});

test("delegated failed receipts retain Sandbox evidence and cannot pass", async (t) => {
  const receipt = {
    schema_version: "snipara.sandbox.validation.v1",
    run_id: "a".repeat(32),
    status: "failed",
    cleanup_complete: true,
    exit_code: 1,
    reason: "assertion failed",
    work_reuse: { state: "executed" },
  };
  for (const response of [
    receipt,
    { ...receipt, status: "passed", exit_code: 0, work_reuse: { state: "needs_review" } },
  ]) {
    const f = fixture(t, { run: `console.log(${JSON.stringify(JSON.stringify(response))});` });
    const outcome = await invokeSandboxValidation("run", f.options);
    assert.equal(outcome.exitCode, 2);
    assert.deepEqual(outcome.result, response);
  }
});

test("delegated timeout leaves review evidence and never starts a replacement execution", async (t) => {
  const f = fixture(t, { run: "setInterval(()=>{},1000);" });
  const original = global.setTimeout;
  global.setTimeout = (callback, delay, ...args) =>
    original(callback, delay > 30_000 ? 500 : delay, ...args);
  let outcome;
  try {
    outcome = await invokeSandboxValidation("run", f.options);
  } finally {
    global.setTimeout = original;
  }
  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.result.reason_code, "orchestrator_process_timeout");
  assert.equal(outcome.result.work_reuse.state, "needs_review");
  assert.equal(f.calls().length, 2);
  assert.equal(f.sandboxCalls().length, 0);
});

test("legacy unscoped runs invoke standalone Sandbox without coordinator or scope flags", async (t) => {
  const f = fixture(t);
  const outcome = await invokeSandboxValidation("run", {
    request: f.request,
    store: f.store,
    sandboxCommand: f.sandboxCommand,
  });
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(outcome.result, f.receipt);
  assert.equal(f.calls().length, 0);
  assert.deepEqual(f.sandboxCalls()[0].args, [
    "validation",
    "run",
    "--request",
    f.request,
    "--store",
    f.store,
  ]);
});

test("direct SDK evidence stores are forwarded only to commands supporting --store", async (t) => {
  const f = fixture(t);
  const vector = require("./fixtures/sandbox-scope-v2.json").cases[0];
  fs.writeFileSync(f.request, JSON.stringify(vector.request));
  const argvFile = path.join(path.dirname(f.request), "direct-sdk-argv.json");
  const choice = {
    schema_version: "snipara.validation.choice.v1",
    scope_sha256: vector.sha256,
    authority: "operator_asserted",
    choice: "alternative",
    environment: "reviewed environment",
    created_at: Date.now() / 1000,
    expires_at: Date.now() / 1000 + 600,
  };
  const responses = {
    gate: {
      status: "sandbox_ready",
      scope_sha256: vector.sha256,
      sandbox_used: false,
      execution_authorized_by_gate: false,
      readiness: {
        schema_version: "snipara.sandbox.validation.v1",
        ready: true,
        backend: "docker",
        image_id: "sha256:synthetic",
      },
    },
    choose: choice,
    diagnose: { schema_version: "snipara.sandbox.validation.v1", ready: true, backend: "docker" },
    run: f.receipt,
    verify: {
      schema_version: "snipara.sandbox.validation.v1",
      valid: true,
      run_id: f.receipt.run_id,
      reasons: [],
      receipt: f.receipt,
    },
    status: f.receipt,
    cancel: { cancel_requested: true, run_id: f.receipt.run_id },
  };
  fs.writeFileSync(
    f.sandboxCommand,
    `#!${process.execPath}
const args=process.argv.slice(2);require('node:fs').writeFileSync(${JSON.stringify(argvFile)},JSON.stringify(args));
const allowed={gate:['request','scope'],choose:['request','scope','choice','environment','acknowledge-user-choice'],diagnose:['request'],run:['request','store'],verify:['request','run-id','store'],status:['run-id','store'],cancel:['run-id','store']};
for(const arg of args.slice(2).filter(x=>x.startsWith('--'))) if(!allowed[args[1]].includes(arg.slice(2))) {console.error('Unsupported option '+arg);process.exit(2);}
console.log(JSON.stringify(${JSON.stringify(responses)}[args[1]]));
`,
    { mode: 0o755 }
  );
  for (const action of Object.keys(responses)) {
    const options = { request: f.request, store: f.store, sandboxCommand: f.sandboxCommand };
    if (["status", "cancel"].includes(action)) delete options.request;
    if (action !== "run") options.scope = vector.scope;
    if (["verify", "status", "cancel"].includes(action)) options.runId = f.receipt.run_id;
    if (action === "choose")
      Object.assign(options, {
        choice: "alternative",
        environment: choice.environment,
        acknowledgeUserChoice: true,
      });
    const outcome = await invokeSandboxValidation(action, options);
    assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.result));
    const args = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.equal(
      args.includes("--store"),
      ["run", "verify", "status", "cancel"].includes(action),
      action
    );
    assert.equal(args.includes("--scope"), ["gate", "choose"].includes(action), action);
    assert.equal(args.includes("--request"), !["status", "cancel"].includes(action), action);
    if (args.includes("--store")) assert.equal(args[args.indexOf("--store") + 1], f.store);
  }
  assert.equal(f.calls().length, 0);
});

test("coordinated controls need explicit scope and appear only on run help", async (t) => {
  const f = fixture(t);
  for (const [action, options] of [
    ["run", { noReuse: true }],
    ["run", { orchestratorCommand: f.orchestratorCommand }],
    ["gate", { scope: "lot", noReuse: true }],
  ]) {
    const outcome = await invokeSandboxValidation(action, {
      request: f.request,
      sandboxCommand: f.sandboxCommand,
      ...options,
    });
    assert.equal(outcome.exitCode, 2);
    assert.equal(outcome.result.reason_code, "explicit_scope_required");
  }
  assert.equal(f.calls().length, 0);
  assert.equal(f.sandboxCalls().length, 0);
  const cli = path.resolve(__dirname, "../dist/index.js");
  for (const action of ["run", "gate", "choose", "diagnose", "verify", "status", "cancel"]) {
    const help = spawnSync(process.execPath, [cli, "validation", action, "--help"], {
      encoding: "utf8",
      env: { ...process.env, SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK: "1" },
    });
    assert.equal(help.status, 0, help.stderr);
    assert.equal(help.stdout.includes("--no-reuse"), action === "run");
    assert.equal(help.stdout.includes("--orchestrator-command"), action === "run");
  }
});

test("requirements scope matches published SDK 2.4.1 golden identity and preserves empty v2 identities", (t) => {
  const f = fixture(t);
  // Captured from the published SDK gate; the referenced workspace need not exist here.
  const reference = {
    workspace: "/private/tmp/snipara-scope-v3-reference-20261109",
    image: "sha256:18310de555d39353086ba48b7e12186ab899d0eb513b1c78d4fd19f42ef65721",
    profile: "mixed",
    argv: ["node", "input.js"],
    requirements: {
      python_modules: ["json", "json"],
      node_modules: [],
      commands: ["node", "git", "node"],
    },
  };
  fs.writeFileSync(f.request, JSON.stringify(reference));
  assert.equal(
    expectedSandboxScope(f.request, "work-reuse-reference"),
    "288fb7764372205a11212d2357057c49d70d448fbb22d872a9f090039fe508cb"
  );
  fs.writeFileSync(
    f.request,
    JSON.stringify({
      ...reference,
      requirements: { python_modules: ["json"], commands: ["node", "git"] },
    })
  );
  assert.equal(
    expectedSandboxScope(f.request, "work-reuse-reference"),
    "288fb7764372205a11212d2357057c49d70d448fbb22d872a9f090039fe508cb"
  );
  const vector = require("./fixtures/sandbox-scope-v2.json").cases[0];
  for (const requirements of [
    undefined,
    {},
    { python_modules: [], node_modules: [], commands: [] },
  ]) {
    fs.writeFileSync(f.request, JSON.stringify({ ...vector.request, requirements }));
    assert.equal(expectedSandboxScope(f.request, vector.scope), vector.sha256);
  }
});

test("requirements identity rejects invalid types, names, unknown fields and oversized raw lists", (t) => {
  const f = fixture(t);
  const request = require("./fixtures/sandbox-scope-v2.json").cases[0].request;
  const invalid = [
    null,
    false,
    [],
    "json",
    { extra: [] },
    { python_modules: "json" },
    { node_modules: {} },
    { commands: [1] },
    { python_modules: ["json\n"] },
    { python_modules: ["json/path"] },
    { python_modules: ["a".repeat(129)] },
    { node_modules: ["@scope/name/path"] },
    { node_modules: ["Uppercase"] },
    { commands: ["node --version"] },
    { commands: ["/bin/node"] },
    { commands: ["git\n"] },
    { python_modules: Array(33).fill("json") },
  ];
  for (const requirements of invalid) {
    fs.writeFileSync(f.request, JSON.stringify({ ...request, requirements }));
    assert.throws(() => expectedSandboxScope(f.request, "lot"));
  }
  fs.writeFileSync(
    f.request,
    JSON.stringify({
      ...request,
      requirements: {
        python_modules: ["pkg.sub_module"],
        node_modules: ["@scope/module-name"],
        commands: ["c++", "python3.12"],
      },
    })
  );
  assert.match(expectedSandboxScope(f.request, "lot"), /^[a-f0-9]{64}$/);
});
