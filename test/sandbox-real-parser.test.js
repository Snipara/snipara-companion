const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadRuntimeSource } = require("./helpers/runtime-source.cjs");

const sdk = process.env.SNIPARA_REAL_SANDBOX_COMMAND;
const { invokeSandboxValidation } = loadRuntimeSource(
  path.resolve(__dirname, "../src/runtime/sandbox-validation.ts")
);

test(
  "real Sandbox verify parser accepts Companion's scoped invocation",
  { skip: !sdk },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-real-parser-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const request = path.join(dir, "request.json");
    fs.writeFileSync(
      request,
      JSON.stringify({
        schema_version: "snipara.sandbox.validation.v1",
        workspace: dir,
        image: `sha256:${"a".repeat(64)}`,
        argv: ["true"],
        profile: "node",
      })
    );

    // The store does not exist: reaching verify_command is parser evidence only,
    // not a passing receipt or an end-to-end Docker run.
    const outcome = await invokeSandboxValidation("verify", {
      request,
      scope: "real-parser:test",
      runId: "a".repeat(32),
      store: path.join(dir, "missing-store"),
      sandboxCommand: sdk,
    });
    assert.equal(outcome.exitCode, 2);
    assert.equal(outcome.result.stage, "adapter_response");
    assert.match(outcome.result.reason, /verify_command/);
    assert.doesNotMatch(outcome.result.reason, /No such option.*--scope/i);
  }
);
