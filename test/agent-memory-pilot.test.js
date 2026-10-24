const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const manifest = require("./fixtures/memory-pilot-manifest.json");
const cli = process.env.SNIPARA_TEST_CLI_PATH || path.join(__dirname, "../dist/index.js");
const digest = (s) => `sha256:${createHash("sha256").update(s).digest("hex")}`;

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-memory-pilot-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, "docs"));
  fs.writeFileSync(path.join(cwd, "snipara.agent-context.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(cwd, "config.json"), '{"replicas":2}');
  const candidate = {
    id: "c1",
    sourceId: "config",
    sourceHash: digest('{"replicas":2}'),
    scope: "project",
    category: "project:fixture",
    assertion: { kind: "json_value", keys: ["replicas"], value: 2 },
  };
  const request = {
    schemaVersion: "snipara.agent_memory_pilot.v1",
    taskId: "task-1",
    producer: "code",
    candidates: [candidate],
  };
  const write = () => fs.writeFileSync(path.join(cwd, "request.json"), JSON.stringify(request));
  write();
  const run = (...extra) =>
    spawnSync(
      process.execPath,
      [
        cli,
        "agent-context",
        "memory-pilot",
        "--input",
        "request.json",
        "--consumer",
        "review",
        ...extra,
      ],
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env, SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK: "1" },
      }
    );
  return { cwd, candidate, request, write, run };
}

test("actual CLI automatically reviews, persists and resumes changed source observations", (t) => {
  const f = fixture(t);
  const first = f.run("--output", "review-1.json");
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).decisions[0].outcome, "auto_validated");
  fs.writeFileSync(path.join(f.cwd, "config.json"), '{"replicas":3}');
  const second = f.run("--previous", "review-1.json", "--output", "resume-2.json");
  assert.equal(second.status, 0, second.stderr);
  const receipt = JSON.parse(second.stdout);
  assert.equal(receipt.decisions[0].outcome, "auto_invalidated");
  assert.equal(receipt.delta[0].before, "auto_validated");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.cwd, "review-1.json"))).decisions[0].outcome,
    "auto_validated"
  );
});
test("receipts cannot overwrite previous evidence", (t) => {
  const f = fixture(t);
  assert.equal(f.run("--output", "receipt.json").status, 0);
  const before = fs.readFileSync(path.join(f.cwd, "receipt.json"));
  assert.notEqual(f.run("--output", "receipt.json").status, 0);
  assert.deepEqual(fs.readFileSync(path.join(f.cwd, "receipt.json")), before);
});
test("missing sources defer automatically without demanding human review", (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.cwd, "config.json"));
  const result = f.run();
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).decisions[0].outcome, "needs_evidence");
});
test("available bytes cannot approve an interpretation", (t) => {
  const f = fixture(t);
  f.candidate.assertion = {
    kind: "interpretation",
    text: "The system is safe to deploy",
  };
  f.write();
  const result = f.run();
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).decisions[0].outcome, "needs_human");
});
test("cross-profile source cannot be copied through a handoff", (t) => {
  const f = fixture(t);
  f.candidate.sourceId = "code-private";
  f.write();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decisions[0].reason, "source_outside_profile");
  assert.equal(JSON.parse(result.stdout).decisions[0].sourceHash, null);
});
test("symlink escape does not read outside trusted workspace", (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.cwd, "config.json"));
  fs.symlinkSync(cli, path.join(f.cwd, "config.json"));
  const result = f.run();
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).decisions[0].reason, "unsafe_path");
});
test("malformed and forged requests fail before output is persisted", (t) => {
  const f = fixture(t);
  f.request.candidates[0].confidence = 1;
  f.write();
  assert.notEqual(f.run("--output", "bad.json").status, 0);
  assert.equal(fs.existsSync(path.join(f.cwd, "bad.json")), false);
});
test("large input and changed receipt are rejected", (t) => {
  const f = fixture(t);
  f.run("--output", "receipt.json");
  const previous = JSON.parse(fs.readFileSync(path.join(f.cwd, "receipt.json")));
  previous.taskId = "other";
  fs.writeFileSync(path.join(f.cwd, "receipt.json"), JSON.stringify(previous));
  assert.notEqual(f.run("--previous", "receipt.json").status, 0);
  fs.writeFileSync(path.join(f.cwd, "request.json"), " ".repeat(1_048_577));
  assert.notEqual(f.run().status, 0);
});
