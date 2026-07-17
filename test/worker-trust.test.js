const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const cliPath = path.join(__dirname, "..", "dist", "index.js");

function runCli(args, cwd) {
  const env = { ...process.env };
  delete env.SNIPARA_API_KEY;
  delete env.SNIPARA_PROJECT_ID;
  delete env.SNIPARA_API_URL;
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
}

test("workers trust candidate stays empty without reviewed worker evidence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-worker-trust-candidate-"));
  const result = runCli(["workers", "trust", "candidate", "--json"], dir);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.version, "snipara.worker_trust_candidates.v1");
  assert.deepEqual(payload.candidates, []);
  assert.deepEqual(payload.decisions, []);
});

test("workers trust status exposes no synthetic reviewed events", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-worker-trust-status-"));
  const result = runCli(["workers", "trust", "status", "--json"], dir);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.version, "snipara.worker_trust_status.v1");
  assert.deepEqual(payload.events, []);
});

test("workers trust review refuses an unknown decision request", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-worker-trust-review-"));
  const result = runCli(
    [
      "workers",
      "trust",
      "review",
      "--request-id",
      "decision-missing",
      "--choice",
      "approve",
      "--reviewer",
      "alice",
    ],
    dir
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No pending worker trust decision matched/);
});
