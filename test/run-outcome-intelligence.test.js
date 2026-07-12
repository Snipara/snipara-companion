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

test("run reads Outcome Intelligence receipts and emits calibration", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-run-outcome-"));
  const receiptPath = path.join(dir, "receipt.json");
  fs.writeFileSync(
    receiptPath,
    JSON.stringify({
      version: "snipara.outcome_intelligence.receipt.v0",
      receiptId: "outcome-test-1",
      generatedAt: "2026-07-04T22:00:00.000Z",
      sourceRef: "test:run-outcome",
      taskProfile: {
        kind: "feature",
        risk: "medium",
        surfaces: ["workflow"],
        changedFiles: ["packages/cli/src/commands/run.ts"],
      },
      decision: {
        summary: "Use Outcome Intelligence receipt calibration.",
        reasonCodes: ["outcome_receipt_present"],
      },
      verification: {
        evidence: [],
        passedCount: 1,
        failedCount: 0,
        warningCount: 0,
        skippedCount: 0,
      },
      outcome: {
        status: "success",
        summary: "Receipt was consumed.",
      },
      caveats: ["test fixture"],
    })
  );

  const result = runCli(
    [
      "run",
      "--task",
      "Validate local Outcome Intelligence calibration",
      "--skip-impact",
      "--skip-memory-health",
      "--skip-advisor-receipts",
      "--outcome-receipts",
      receiptPath,
      "--json",
    ],
    { cwd: dir }
  );

  assert.notEqual(result.status, 1, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.outcomeCalibration.version, "snipara.outcome_intelligence.calibration.v0");
  assert.equal(payload.outcomeCalibration.receiptCount, 1);
  assert.equal(payload.outcomeCalibration.buckets[0].reasonCode, "outcome_receipt_present");
  assert.equal(payload.outcomeCalibration.buckets[0].positiveRate, 1);
});
