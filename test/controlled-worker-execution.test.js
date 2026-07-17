const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");

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

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJsonValue(item)])
  );
}

function trustEventId(core) {
  const content = JSON.stringify(sortJsonValue(core), null, 2);
  return `worker-trust-${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
}

function prepareTrustedWorker(dir) {
  const git = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  const add = runCli(
    [
      "workers",
      "local",
      "add",
      "--id",
      "docs-worker",
      "--model",
      "qwen/test",
      "--role",
      "documentation",
      "--write-scope",
      "docs/**",
      "--json",
    ],
    { cwd: dir }
  );
  assert.equal(add.status, 0, add.stderr || add.stdout);
  const workerId = JSON.parse(add.stdout).worker.id;
  const profileReceipt = runCli(
    ["workers", "execute", "--task", "Read current profile", "--worker-id", workerId, "--json"],
    { cwd: dir }
  );
  assert.equal(profileReceipt.status, 0, profileReceipt.stderr || profileReceipt.stdout);
  const profileHash = JSON.parse(profileReceipt.stdout).receipt.trust.profileHash;
  assert.match(profileHash, /^sha256:[a-f0-9]{64}$/);
  const now = Date.now();
  const resolvedAt = new Date(now).toISOString();
  const requestId = "decision-trust-1";
  const eventId = trustEventId({
    workerId,
    workCategory: "docs_low_risk",
    profileHash,
    state: "delegated_earned",
    requestId,
    resolvedAt,
  });
  const resolutionDir = path.join(dir, ".snipara", "decisions", "resolved");
  fs.mkdirSync(resolutionDir, { recursive: true });
  fs.writeFileSync(
    path.join(resolutionDir, `${requestId}.json`),
    JSON.stringify({
      schemaVersion: "snipara.decision_resolution.v0",
      request: {
        requestId,
        producer: { kind: "worker_trust_promotion" },
      },
      response: {
        requestId,
        choice: "approve",
        reviewer: "alice",
        resolvedAt,
        appliedActions: ["worker_trust_event_written"],
      },
    })
  );
  return {
    workerId,
    profileHash,
    event: {
      schemaVersion: "snipara.worker_trust_event.v1",
      eventId,
      generatedAt: new Date(now).toISOString(),
      workerId,
      workCategory: "docs_low_risk",
      profileHash,
      previousState: "advisory_earned",
      state: "delegated_earned",
      hardGateReady: true,
      evidence: {
        reviewedSamples: 10,
        verifiedSamples: 8,
        blockedSamples: 0,
        incompleteReceiptSamples: 0,
        realWorkflowSamples: 3,
        distinctSessionsOrDays: 2,
        since: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
        receiptRefs: ["receipt-1"],
        safetyViolations: [],
      },
      decision: {
        requestId,
        responseChoice: "approve",
        reviewer: "alice",
        resolvedAt,
      },
      ceilings: {
        writeScope: ["docs/**"],
        riskCeiling: "low",
        expiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
        rollbackConditions: ["scope violation"],
      },
      reasonCodes: ["worker_trust_promotion_approved"],
    },
  };
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
  assert.equal(payload.executed, true, JSON.stringify(payload.receipt.reasonCodes));
  assert.equal(payload.blocked, false);
  assert.equal(payload.receipt.status, "verification_required");
  assert.equal(payload.receipt.contract.approvalReceiptId, "approval-123");
  assert.equal(payload.receipt.execution.exitCode, 0);
  assert.match(payload.receipt.execution.stdoutPreview, /proof ok/);
  assert.ok(fs.existsSync(outputPath));
});

test("workers execute fails closed when declared output fragments are incomplete", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-worker-output-contract-"));
  const result = runCli(
    [
      "workers",
      "execute",
      "--task",
      "Return a complete bounded diff",
      "--execute",
      "--approval-receipt",
      "approval-output-contract",
      "--command-arg",
      process.execPath,
      "--command-arg",
      "-e",
      "--command-arg",
      "console.log('return a + b')",
      "--proof",
      "review stdout",
      "--output-fragment",
      "return a - b",
      "--output-fragment",
      "return a + b",
      "--json",
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.executed, true);
  assert.equal(payload.blocked, true);
  assert.equal(payload.receipt.status, "failed");
  assert.deepEqual(payload.receipt.contract.outputFragments, ["return a - b", "return a + b"]);
  assert.deepEqual(payload.receipt.contract.missingOutputFragments, ["return a - b"]);
  assert.ok(
    payload.receipt.reasonCodes.includes("controlled_worker_execution_output_contract_failed")
  );
});

test("workers execute consumes reviewed delegated trust only through shell-free argv", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-worker-trusted-"));
  const eventPath = path.join(dir, "trust.json");
  const trusted = prepareTrustedWorker(dir);
  fs.writeFileSync(eventPath, JSON.stringify(trusted.event));
  const result = runCli(
    [
      "workers",
      "execute",
      "--task",
      "Render bounded docs output",
      "--worker-id",
      trusted.workerId,
      "--mode",
      "auto_low_risk",
      "--execute",
      "--work-category",
      "docs_low_risk",
      "--profile-hash",
      trusted.profileHash,
      "--trust-event",
      eventPath,
      "--write-scope",
      "docs/result.md",
      "--proof",
      "review stdout",
      "--command-arg",
      process.execPath,
      "--command-arg",
      "-e",
      "--command-arg",
      "console.log('delegated ok')",
      "--json",
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.executed, true, JSON.stringify(payload.receipt.reasonCodes));
  assert.equal(payload.blocked, false);
  assert.equal(payload.receipt.trust.hardGateReady, true);
  assert.equal(payload.receipt.trust.approvalReceiptRequired, false);
  assert.ok(!payload.receipt.reasonCodes.includes("controlled_worker_execution_missing_approval"));
  assert.match(payload.receipt.execution.stdoutPreview, /delegated ok/);
});

test("workers execute escalates sensitive scope and refuses delegated trust", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-worker-sensitive-"));
  const eventPath = path.join(dir, "trust.json");
  const trusted = prepareTrustedWorker(dir);
  fs.writeFileSync(eventPath, JSON.stringify(trusted.event));
  const result = runCli(
    [
      "workers",
      "execute",
      "--task",
      "Update authentication session",
      "--worker-id",
      trusted.workerId,
      "--mode",
      "auto_low_risk",
      "--execute",
      "--work-category",
      "docs_low_risk",
      "--profile-hash",
      trusted.profileHash,
      "--trust-event",
      eventPath,
      "--write-scope",
      "apps/web/src/auth/session.ts",
      "--proof",
      "review stdout",
      "--command-arg",
      process.execPath,
      "--command-arg",
      "-e",
      "--command-arg",
      "console.log('must not run')",
      "--json",
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.executed, false);
  assert.equal(payload.blocked, true);
  assert.ok(payload.receipt.reasonCodes.includes("controlled_worker_execution_category_escalated"));
  assert.ok(payload.receipt.reasonCodes.includes("worker_trust_sensitive_category_blocked"));
});

test("workers execute detects delegated writes outside the reviewed scope", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-worker-scope-proof-"));
  const eventPath = path.join(dir, "trust.json");
  const trusted = prepareTrustedWorker(dir);
  fs.writeFileSync(eventPath, JSON.stringify(trusted.event));
  const result = runCli(
    [
      "workers",
      "execute",
      "--task",
      "Render bounded docs output",
      "--worker-id",
      trusted.workerId,
      "--mode",
      "auto_low_risk",
      "--execute",
      "--work-category",
      "docs_low_risk",
      "--profile-hash",
      trusted.profileHash,
      "--trust-event",
      eventPath,
      "--write-scope",
      "docs/**",
      "--proof",
      "review git scope",
      "--command-arg",
      process.execPath,
      "--command-arg",
      "-e",
      "--command-arg",
      "require('fs').mkdirSync('src',{recursive:true}),require('fs').writeFileSync('src/escape.txt','x')",
      "--json",
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.executed, true);
  assert.equal(payload.blocked, true);
  assert.equal(payload.receipt.status, "failed");
  assert.deepEqual(payload.receipt.execution.scopeViolations, ["src/escape.txt"]);
  assert.ok(payload.receipt.reasonCodes.includes("worker_trust_demotion_required"));
});

test("workers execute rejects a forged delegated trust event", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-worker-forged-trust-"));
  const eventPath = path.join(dir, "trust.json");
  const trusted = prepareTrustedWorker(dir);
  fs.writeFileSync(
    eventPath,
    JSON.stringify({
      ...trusted.event,
      evidence: {},
      decision: {},
      ceilings: { writeScope: ["**"], riskCeiling: "low", expiresAt: "2099-01-01" },
    })
  );
  const result = runCli(
    [
      "workers",
      "execute",
      "--task",
      "Render docs",
      "--worker-id",
      trusted.workerId,
      "--mode",
      "auto_low_risk",
      "--execute",
      "--work-category",
      "docs_low_risk",
      "--profile-hash",
      trusted.profileHash,
      "--trust-event",
      eventPath,
      "--write-scope",
      "docs/**",
      "--proof",
      "review stdout",
      "--command-arg",
      process.execPath,
      "--command-arg",
      "-e",
      "--command-arg",
      "console.log('must not run')",
      "--json",
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.executed, false);
  assert.equal(payload.blocked, true);
  assert.ok(payload.receipt.reasonCodes.includes("worker_trust_event_missing"));
});
