const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

function subject(report, probes, stubs = {}) {
  const file = path.resolve(__dirname, "../src/commands/doctor.ts");
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = module.paths;
  const original = loaded.require.bind(loaded);
  const unexpected = () => {
    probes.push("probe");
    throw new Error("explicit deep probe");
  };
  loaded.require = (name) => {
    if (name === "../runtime/managed-toolchain") return { inspectManagedToolchain: () => report };
    if (name === "../runtime/detection")
      return { detectRuntimeEnvironment: stubs.detect ?? unexpected };
    if (name === "../runtime/capability-status")
      return {
        diagnosticProbeEnvironment: () => process.env,
        summarizeRuntimeCapabilities: unexpected,
      };
    if (name === "../api/client") return { createClient: stubs.createClient ?? unexpected };
    if (name === "node:child_process") return { execFileSync: stubs.exec ?? unexpected };
    if (name === "chalk") return {};
    return original(name);
  };
  loaded._compile(
    ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText,
    file
  );
  return loaded.exports.doctorCommand;
}

const detected =
  (over = {}) =>
  () => ({
    cwd: "/work",
    workspaceRoot: null,
    companion: { configured: true, configPath: "/work/.snipara/config.json" },
    runtime: {
      cliAvailable: true,
      command: "snipara-sandbox",
      cliVersion: "3.2.1",
      version: "snipara-sandbox 3.2.1",
    },
    docker: { available: true },
    ...over,
  });
const capture = async (run) => {
  const output = [],
    original = console.log;
  console.log = (value) => output.push(value);
  try {
    await run();
  } finally {
    console.log = original;
  }
  return output;
};

test("default doctor keeps the toolchain status and adds checks without deep probes", async () => {
  const probes = [];
  const report = {
    schemaVersion: "snipara.toolchain_status.v1",
    status: "not_configured",
    installed: false,
    callable: null,
    verified: null,
    executionAuthorized: false,
  };
  const exec = (command, args) => {
    if (command === "docker") return "27.1.0\n";
    assert.deepEqual(args, ["validation", "run", "--help"]);
    return "Options: --scope --no-reuse";
  };
  const createClient = () => ({
    probeConnection: async () => ({
      connected: true,
      detail: "project access confirmed via snipara_stats",
    }),
  });
  const output = await capture(() =>
    subject(report, probes, { detect: detected(), exec, createClient })({ json: true })
  );
  assert.deepEqual(probes, []);
  const parsed = JSON.parse(output[0]);
  for (const [key, value] of Object.entries(report)) assert.deepEqual(parsed[key], value);
  assert.equal(typeof parsed.companionVersion, "string");
  const byName = Object.fromEntries(parsed.checks.map((check) => [check.name, check]));
  assert.deepEqual(Object.keys(byName), [
    "companion_version",
    "project_configuration",
    "hosted_endpoint",
    "snipara_sandbox",
    "docker",
  ]);
  for (const check of parsed.checks) assert.ok(["pass", "warn", "fail"].includes(check.status));
  assert.equal(byName.project_configuration.status, "pass");
  assert.match(byName.project_configuration.detail, /\/work\/\.snipara\/config\.json/);
  assert.equal(byName.hosted_endpoint.status, "pass");
  assert.equal(byName.snipara_sandbox.status, "pass");
  assert.match(byName.snipara_sandbox.detail, /3\.2\.1.*--scope/);
  assert.equal(byName.docker.status, "pass");
});

test("doctor reports failures as findings and never throws", async () => {
  const report = { status: "not_configured" };
  const exec = (command) => {
    throw Object.assign(new Error("failed"), {
      stdout: command === "docker" ? "" : "Options: --no-reuse",
      stderr: "",
    });
  };
  const createClient = () => ({
    probeConnection: async () => {
      throw new Error("socket hang up");
    },
  });
  const output = await capture(() =>
    subject(report, [], { detect: detected(), exec, createClient })({ json: true })
  );
  const byName = Object.fromEntries(
    JSON.parse(output[0]).checks.map((check) => [check.name, check])
  );
  assert.equal(byName.hosted_endpoint.status, "fail");
  assert.match(byName.hosted_endpoint.detail, /socket hang up/);
  assert.equal(byName.snipara_sandbox.status, "warn");
  assert.match(byName.snipara_sandbox.detail, /does not expose --scope/);
  assert.equal(byName.docker.status, "warn");
});

test("doctor without configuration, sandbox or docker warns for each and skips the hosted probe", async () => {
  const detect = detected({
    companion: { configured: false, configPath: "/work/.snipara/config.json" },
    runtime: { cliAvailable: false },
    docker: { available: false },
  });
  const output = await capture(() => subject({ status: "not_configured" }, [], { detect })({}));
  const text = output.join("\n");
  assert.match(text, /\[warn\] project_configuration/);
  assert.match(text, /\[warn\] hosted_endpoint: skipped/);
  assert.match(text, /\[warn\] snipara_sandbox: snipara-sandbox not found on PATH/);
  assert.match(text, /\[warn\] docker: docker CLI not found/);
});

test("legacy environment probes require explicit deep diagnostics", async () => {
  const probes = [];
  await assert.rejects(
    subject({ status: "not_configured" }, probes)({ deep: true }),
    /explicit deep probe/
  );
  assert.deepEqual(probes, ["probe"]);
});
