const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const cliPath = path.join(__dirname, "..", "dist", "index.js");

function runCli(args, options = {}) {
  const env = {
    ...process.env,
    ...(options.env ?? {}),
  };
  delete env.SNIPARA_API_KEY;
  delete env.SNIPARA_PROJECT_ID;
  delete env.SNIPARA_API_URL;

  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
    env,
  });
}

test("workers execute creates a dry-run Controlled Worker Execution receipt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-worker-dry-run-"));
  const result = runCli(
    [
      "workers",
      "execute",
      "--task",
      "Refresh public docs",
      "--worker-id",
      "docs-worker",
      "--worker-role",
      "documentation",
      "--write-scope",
      "docs/features/PROJECT_INTELLIGENCE.md",
      "--acceptance",
      "Docs mention hosted aggregation",
      "--proof",
      "pnpm --filter @snipara/web type-check",
      "--json",
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.executed, false);
  assert.equal(payload.blocked, false);
  assert.match(payload.receipt.receiptId, /^worker-exec-[a-f0-9]{16}$/);
  assert.equal(payload.receipt.status, "planned");
  assert.equal(payload.receipt.mode, "dry_run");
  assert.equal(payload.receipt.worker.id, "docs-worker");
  assert.deepEqual(payload.receipt.contract.writeScope, ["docs/features/PROJECT_INTELLIGENCE.md"]);
  assert.ok(fs.existsSync(payload.receiptPath));
});

test("workers execute can write a local unified receipt projection", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-worker-unified-"));
  const unifiedOutput = path.join(dir, "unified-receipt.json");
  const result = runCli(
    [
      "workers",
      "execute",
      "--task",
      "Refresh docs",
      "--worker-id",
      "docs-worker",
      "--project-id",
      "project_1",
      "--unified-output",
      unifiedOutput,
      "--json",
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.unifiedReceiptPath, unifiedOutput);
  assert.equal(payload.unifiedReceipt.family, "controlled_worker_execution");
  assert.equal(payload.unifiedReceipt.projectId, "project_1");
  assert.equal(payload.unifiedReceipt.workflow.workerId, "docs-worker");
  assert.ok(fs.existsSync(unifiedOutput));
  const saved = JSON.parse(fs.readFileSync(unifiedOutput, "utf8"));
  assert.equal(saved.receiptId, payload.receipt.receiptId);
});

test("workers execute blocks non-dry-run execution without an approval receipt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-worker-blocked-"));
  const result = runCli(
    [
      "workers",
      "execute",
      "--task",
      "Run tests",
      "--execute",
      "--command",
      "node -e \"console.log('should-not-run')\"",
      "--json",
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.executed, false);
  assert.equal(payload.blocked, true);
  assert.equal(payload.receipt.status, "blocked");
  assert.ok(payload.receipt.reasonCodes.includes("controlled_worker_execution_missing_approval"));
});

test("workers execute can run an approved low-risk command and requires verification", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-worker-exec-"));
  const outputPath = path.join(dir, "worker-receipt.json");
  const result = runCli(
    [
      "workers",
      "execute",
      "--task",
      "Run local proof",
      "--execute",
      "--approval-receipt",
      "approval-123",
      "--command",
      "node -e \"console.log('proof ok')\"",
      "--proof",
      "review stdout",
      "--output",
      outputPath,
      "--json",
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.executed, true);
  assert.equal(payload.blocked, false);
  assert.equal(payload.receipt.status, "verification_required");
  assert.equal(payload.receipt.contract.approvalReceiptId, "approval-123");
  assert.equal(payload.receipt.execution.exitCode, 0);
  assert.match(payload.receipt.execution.stdoutPreview, /proof ok/);
  assert.ok(fs.existsSync(outputPath));
});
