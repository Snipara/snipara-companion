const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const { buildAgentReadinessAuditReport } = require("../dist/index.js");

const cliPath = path.join(__dirname, "..", "dist", "index.js");

function readySignals() {
  return {
    workflow: {
      present: true,
      path: ".snipara/workflow/current.json",
      status: "active",
      workflowId: "agent-readiness",
      currentPhaseId: "implementation",
      completedPhases: 1,
      pendingPhases: 0,
    },
    teamSync: {
      present: true,
      path: ".snipara/team-sync/session.json",
      activeWorkCount: 1,
      handoffCount: 1,
      latestActiveSummary: "Ship adapter",
      latestHandoffSummary: "Run proof gates",
    },
    projectInstructions: {
      present: true,
      path: "AGENTS.md",
    },
  };
}

function runCli(args, options = {}) {
  const env = {
    ...process.env,
    ...(options.env ?? {}),
  };
  if (!options.env || !Object.prototype.hasOwnProperty.call(options.env, "SNIPARA_API_KEY")) {
    delete env.SNIPARA_API_KEY;
  }
  if (!options.env || !Object.prototype.hasOwnProperty.call(options.env, "SNIPARA_PROJECT_ID")) {
    delete env.SNIPARA_PROJECT_ID;
  }
  if (!options.env || !Object.prototype.hasOwnProperty.call(options.env, "SNIPARA_API_URL")) {
    delete env.SNIPARA_API_URL;
  }

  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
    env,
  });
}

test("buildAgentReadinessAuditReport marks a bounded delegated task ready", () => {
  const report = buildAgentReadinessAuditReport({
    now: new Date("2026-06-25T12:00:00.000Z"),
    target: "codex",
    task: "Ship ADE adapter pack",
    changedFiles: ["packages/cli/src/commands/team-sync.ts"],
    context: ["AGENTS.md", "docs/features/ADAPTIVE_WORK_ROUTING.md"],
    proof: ["pnpm --filter snipara-companion test"],
    acceptance: ["handoff artifact includes proof gates"],
    localSignals: readySignals(),
  });

  assert.equal(report.version, "snipara.agent_readiness_audit.v1");
  assert.equal(report.target.id, "codex");
  assert.equal(report.score.total, 100);
  assert.equal(report.score.band, "ready");
  assert.equal(report.recommendedServicePack.id, "launch_review");
  assert.equal(report.gaps.length, 0);
});

test("buildAgentReadinessAuditReport blocks delegation when proof gates are absent", () => {
  const report = buildAgentReadinessAuditReport({
    now: new Date("2026-06-25T12:00:00.000Z"),
    target: "cursor",
    task: "Refactor billing route",
    changedFiles: ["apps/web/src/app/api/billing/route.ts"],
    context: ["AGENTS.md"],
    localSignals: readySignals(),
  });

  assert.equal(report.score.band, "blocked");
  assert.equal(report.recommendedServicePack.id, "hardening_sprint");
  assert.ok(report.gaps.some((gap) => gap.checkId === "proof_gates"));
  assert.ok(report.gaps.some((gap) => gap.severity === "blocker"));
  assert.ok(
    report.suggestedCommands.some((command) => command.includes("snipara-companion handoff"))
  );
});

test("agent-readiness audit command reads local workflow state and prints JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-agent-readiness-"));
  fs.mkdirSync(path.join(dir, ".snipara", "workflow"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".snipara", "team-sync"), { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Agent instructions\n", "utf8");
  fs.writeFileSync(
    path.join(dir, ".snipara", "workflow", "current.json"),
    JSON.stringify(
      {
        schemaVersion: "snipara.workflow.v2",
        workflowId: "agent-readiness",
        status: "active",
        currentPhaseId: "audit",
        phases: [{ id: "audit", status: "in_progress" }],
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, ".snipara", "team-sync", "session.json"),
    JSON.stringify(
      {
        schemaVersion: "snipara.team-sync.v1",
        work: [{ id: "work_1", type: "work", status: "active", summary: "Ship adapter" }],
        handoffs: [{ id: "handoff_1", type: "handoff", summary: "Run proof gates" }],
      },
      null,
      2
    ),
    "utf8"
  );

  const result = runCli(
    [
      "agent-readiness",
      "audit",
      "--target",
      "orca",
      "--task",
      "Ship adapter handoff",
      "--changed-files",
      "src/adapter.ts",
      "--context",
      "AGENTS.md",
      "--proof",
      "pnpm test adapter",
      "--acceptance",
      "adapter artifact generated",
      "--json",
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.target.id, "orca");
  assert.equal(payload.score.band, "ready");
  assert.equal(payload.localSignals.workflow.currentPhaseId, "audit");
  assert.equal(payload.localSignals.teamSync.activeWorkCount, 1);
});
