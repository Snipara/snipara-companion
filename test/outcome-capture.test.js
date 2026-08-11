const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const { buildWhyOutcomeCaptureReport, WHY_OUTCOME_CAPTURE_VERSION } = require("../dist/index.js");

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

test("buildWhyOutcomeCaptureReport emits review-pending candidates with redaction and dedupe", () => {
  const event = {
    kind: "phase_commit",
    summary: "Chose portable ADE adapter targets after contract review",
    reason: ["Cursor and Orca need handoff-only receipts before runtime control"],
    outcome: "completed",
    sourceRef: "phase-4-ade-adapter-pack-v1",
    files: ["packages/cli/src/commands/team-sync.ts"],
    evidence: ["pnpm test team-sync"],
    commands: ["pnpm --filter snipara-companion test"],
    observedAt: "2026-06-30T12:00:00.000Z",
  };

  const report = buildWhyOutcomeCaptureReport({
    now: new Date("2026-06-30T12:05:00.000Z"),
    events: [
      event,
      event,
      {
        kind: "test_result",
        summary: "Auth regression tests passed with API_KEY=abc1234567890", // gitleaks:allow
        status: "passed",
        sourceRef: "ci:auth",
        evidence: ["Authorization: Bearer secret-token-1234567890"], // gitleaks:allow
      },
    ],
  });

  assert.equal(report.version, WHY_OUTCOME_CAPTURE_VERSION);
  assert.equal(report.reviewStatus, "review_pending");
  assert.equal(report.eventCount, 3);
  assert.equal(report.candidateCount, 3);
  assert.equal(report.skippedDuplicateCount, 2);
  assert.ok(report.candidates.every((candidate) => candidate.reviewStatus === "review_pending"));
  assert.ok(report.candidates.every((candidate) => candidate.authorityStatus === "candidate"));
  assert.ok(report.candidates.some((candidate) => candidate.kind === "decision"));
  assert.ok(report.candidates.some((candidate) => candidate.kind === "outcome"));
  assert.ok(report.candidates.some((candidate) => candidate.redaction.redacted));
  assert.doesNotMatch(JSON.stringify(report), /abc1234567890|secret-token-1234567890/);
  assert.ok(
    report.candidates.some((candidate) =>
      candidate.provenance.reasonCodes.includes("review_pending_authority")
    )
  );
});

test("outcome-capture preview reads event files and prints JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-outcome-capture-"));
  const eventsPath = path.join(dir, "events.json");
  fs.writeFileSync(
    eventsPath,
    JSON.stringify({
      events: [
        {
          kind: "deploy_health",
          summary: "Production health check passed after release",
          status: "healthy",
          sourceRef: "deploy:2026-06-30",
          evidence: ["GET /health 200"],
        },
        {
          kind: "feedback",
          summary: "Reviewer accepted the proof report wording",
          feedback: "manual_review accepted",
          sourceRef: "review:proof-copy",
        },
      ],
    })
  );

  const result = runCli(["outcome-capture", "preview", "--from-file", eventsPath, "--json"], {
    cwd: dir,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.version, "snipara.why_outcome_capture.v1");
  assert.equal(payload.reviewStatus, "review_pending");
  assert.equal(payload.eventCount, 2);
  assert.ok(payload.candidateCount >= 2);
  assert.ok(
    payload.candidates.some(
      (candidate) => candidate.kind === "outcome" && candidate.source.kind === "deploy_health"
    )
  );
  assert.ok(
    payload.candidates.some(
      (candidate) => candidate.kind === "decision" && candidate.source.kind === "feedback"
    )
  );
});

test("outcome-capture preview can emit local decision requests", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-outcome-capture-decisions-"));
  const result = runCli(
    [
      "outcome-capture",
      "preview",
      "--event",
      "feedback",
      "--feedback",
      "Manual reviewer approved the durable why extraction",
      "--source-ref",
      "review:why-extraction",
      "--emit-decisions",
      "--json",
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.reviewStatus, "review_pending");
  assert.equal(payload.decisionRequests.written, payload.candidateCount);
  const pendingDir = path.join(dir, ".snipara", "decisions", "pending");
  const files = fs.readdirSync(pendingDir);
  assert.equal(files.length, payload.candidateCount);
  const request = JSON.parse(fs.readFileSync(path.join(pendingDir, files[0]), "utf8"));
  assert.equal(request.schemaVersion, "snipara.decision_request.v0");
  assert.equal(request.producer.kind, "outcome_capture");
  assert.equal(request.evidence.applyPath, "snipara_memory_resolve_queue_item");
});

test("outcome-capture preview can emit an Outcome Intelligence receipt", () => {
  const result = runCli([
    "outcome-capture",
    "preview",
    "--event",
    "test_result",
    "--summary",
    "Companion outcome tests passed",
    "--status",
    "passed",
    "--source-ref",
    "test:outcome-intelligence",
    "--files",
    "packages/cli/src/commands/outcome-capture.ts",
    "--evidence",
    "node --test packages/cli/test/outcome-capture.test.js",
    "--emit-outcome-receipt",
    "--task-kind",
    "feature",
    "--risk",
    "medium",
    "--surface",
    "workflow",
    "--json",
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.outcomeReceipt.version, "snipara.outcome_intelligence.receipt.v0");
  assert.match(payload.outcomeReceipt.receiptId, /^outcome-[a-f0-9]{16}$/);
  assert.equal(payload.outcomeReceipt.sourceRef, "test:outcome-intelligence");
  assert.equal(payload.outcomeReceipt.taskProfile.kind, "feature");
  assert.equal(payload.outcomeReceipt.taskProfile.risk, "medium");
  assert.deepEqual(payload.outcomeReceipt.taskProfile.surfaces, ["workflow"]);
  assert.equal(payload.outcomeReceipt.outcome.status, "success");
  assert.ok(payload.outcomeReceipt.decision.reasonCodes.includes("why_outcome_capture_v1"));
});

test("outcome-capture preview accepts direct feedback without a summary", () => {
  const result = runCli([
    "outcome-capture",
    "preview",
    "--event",
    "feedback",
    "--feedback",
    "Manual reviewer approved the outcome wording",
    "--source-ref",
    "review:direct-feedback",
    "--json",
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.reviewStatus, "review_pending");
  assert.equal(payload.eventCount, 1);
  assert.ok(
    payload.candidates.some(
      (candidate) => candidate.source.kind === "feedback" && candidate.kind === "decision"
    )
  );
});
