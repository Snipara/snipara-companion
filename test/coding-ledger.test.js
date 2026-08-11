const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const {
  buildCodingIntelligenceLedger,
  CODING_INTELLIGENCE_LEDGER_VERSION,
} = require("../dist/index.js");

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

test("buildCodingIntelligenceLedger emits structured redacted portable JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-coding-ledger-"));
  const ledger = buildCodingIntelligenceLedger({
    dir,
    now: new Date("2026-06-30T16:30:00.000Z"),
    input: {
      prompt: {
        task: "Ship Coding Intelligence Ledger Export V0",
        prompt: "Export a ledger without leaking API_KEY=abc1234567890", // gitleaks:allow
        sourceRef: "phase-8-coding-intelligence-ledger-export",
      },
      repoState: {
        branch: "dev",
        commit: "abc1234",
        changedFiles: [path.join(dir, "packages/cli/src/commands/coding-ledger.ts")],
        diffSummary: `Added export code under ${dir}`,
      },
      servedContext: [
        {
          title: "Roadmap phase",
          summary: `Use ${path.join(dir, "AGENTS.md")} and Authorization: Bearer secret-token-1234567890`,
          sourceRef: "workflow:phase-8",
          confidence: 0.82,
          reasonCodes: ["workflow_phase"],
        },
      ],
      plans: ["Keep the export structured, not a raw transcript."],
      tests: [{ command: "pnpm --filter snipara-companion test", status: "passed" }],
      influenceReceipts: [
        {
          id: "advisor:1",
          summary: "Advisor recommendation changed verification plan",
          status: "pending",
          reasonCodes: ["advisor_influence"],
        },
      ],
      reasonCodes: ["phase_8"],
      confidence: { score: 0.72, rationale: "Fixture has source refs and verification evidence." },
      calibrationMetadata: {
        sampleSize: 8,
        reliability: 0.61,
        notes: ["Observed association only."],
        caveats: ["Low sample size."],
      },
    },
  });

  const serialized = JSON.stringify(ledger);
  assert.equal(ledger.version, CODING_INTELLIGENCE_LEDGER_VERSION);
  assert.equal(ledger.portability.contentModel, "structured_redacted_ledger");
  assert.equal(ledger.prompt.task, "Ship Coding Intelligence Ledger Export V0");
  assert.equal(
    ledger.repoState.changedFiles[0],
    "<repo>/packages/cli/src/commands/coding-ledger.ts"
  );
  assert.equal(ledger.servedContext[0].kind, "served_context");
  assert.equal(ledger.servedContext[0].reasonCodes.includes("workflow_phase"), true);
  assert.equal(ledger.tests[0].commands[0], "pnpm --filter snipara-companion test");
  assert.equal(ledger.confidence.band, "medium");
  assert.equal(ledger.calibrationMetadata.reliability, 0.61);
  assert.equal(ledger.redaction.redacted, true);
  assert.ok(ledger.redaction.patterns.includes("secret_assignment"));
  assert.ok(ledger.redaction.patterns.includes("bearer_token"));
  assert.ok(ledger.redaction.patterns.includes("local_repo_path"));
  assert.doesNotMatch(serialized, /abc1234567890|secret-token-1234567890/);
  assert.doesNotMatch(serialized, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(serialized, /not approved memory/);
});

test("intelligence ledger-export reads fixtures, merges CLI signals, and prints JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-coding-ledger-cli-"));
  const inputPath = path.join(dir, "ledger-input.json");
  fs.writeFileSync(
    inputPath,
    JSON.stringify(
      {
        prompt: {
          task: "Replay coding intelligence",
          prompt: "Summarize plan and tests",
        },
        repoState: {
          branch: "dev",
          changedFiles: ["packages/cli/src/commands/coding-ledger.ts"],
        },
        reviews: [{ summary: "Reviewer accepted the structured export boundary." }],
        outcomes: [{ summary: "Phase accepted for local replay.", status: "completed" }],
        confidence: { score: 88 },
      },
      null,
      2
    ),
    "utf8"
  );

  const result = runCli(
    [
      "intelligence",
      "ledger-export",
      "--from-file",
      inputPath,
      "--test",
      "pnpm --filter snipara-companion test",
      "--reason-code",
      "phase_8_fixture",
      "--json",
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.version, "snipara.coding_intelligence_ledger.v0");
  assert.equal(payload.prompt.task, "Replay coding intelligence");
  assert.equal(payload.repoState.branch, "dev");
  assert.equal(payload.tests[0].summary, "pnpm --filter snipara-companion test");
  assert.equal(payload.reasonCodes.includes("phase_8_fixture"), true);
  assert.equal(payload.confidence.score, 0.88);
  assert.equal(payload.confidence.band, "high");
  assert.equal(
    payload.caveats.some((caveat) => caveat.includes("not approved memory")),
    true
  );
});
