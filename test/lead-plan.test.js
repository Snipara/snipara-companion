const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const { buildCompanionEngineeringLeadPlanReport } = require("../dist/index.js");

const cliPath = path.join(__dirname, "..", "dist", "index.js");

function readySignals() {
  return {
    workflow: {
      present: true,
      path: ".snipara/workflow/current.json",
      status: "active",
      workflowId: "engineering-lead",
      currentPhaseId: "implementation",
      completedPhases: 1,
      pendingPhases: 0,
    },
    teamSync: {
      present: true,
      path: ".snipara/team-sync/session.json",
      activeWorkCount: 1,
      handoffCount: 1,
      latestActiveSummary: "Ship lead plan",
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

test("buildCompanionEngineeringLeadPlanReport creates a ready fail-closed handoff plan", () => {
  const report = buildCompanionEngineeringLeadPlanReport({
    now: new Date("2026-06-25T18:00:00.000Z"),
    target: "codex",
    task: "Ship engineering lead plan",
    changedFiles: ["packages/cli/src/commands/lead-plan.ts"],
    context: ["docs/features/ADAPTIVE_WORK_ROUTING.md"],
    proof: ["pnpm --filter snipara-companion test"],
    acceptance: ["lead-plan command prints JSON and Markdown"],
    localSignals: readySignals(),
  });

  assert.equal(report.version, "snipara.companion_engineering_lead_plan.v1");
  assert.equal(report.engineeringLeadPlan.version, "project-intelligence-engineering-lead-plan-v0");
  assert.equal(report.engineeringLeadPlan.posture, "lead_ready");
  assert.equal(report.engineeringLeadPlan.workersSpawned, 0);
  assert.equal(report.engineeringLeadPlan.failClosedFallback, "main_agent");
  assert.equal(report.engineeringLeadPlan.workerRecommendations[0].routingMode, "explicit_handoff_ready");
  assert.ok(
    report.engineeringLeadPlan.caveats.some((caveat) => caveat.includes("does not launch"))
  );
});

test("buildCompanionEngineeringLeadPlanReport blocks delegation without proof gates", () => {
  const report = buildCompanionEngineeringLeadPlanReport({
    now: new Date("2026-06-25T18:00:00.000Z"),
    target: "cursor",
    task: "Refactor billing",
    changedFiles: ["apps/web/src/app/api/billing/route.ts"],
    localSignals: readySignals(),
  });

  assert.equal(report.engineeringLeadPlan.posture, "lead_blocked");
  assert.equal(report.engineeringLeadPlan.workerRecommendations[0].routingMode, "needs_contract");
  assert.equal(report.engineeringLeadPlan.workerRecommendations[0].contract.approvalRequired, true);
});

test("lead-plan command reads local workflow state and prints JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-lead-plan-"));
  fs.mkdirSync(path.join(dir, ".snipara", "workflow"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".snipara", "team-sync"), { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Agent instructions\n", "utf8");
  fs.writeFileSync(
    path.join(dir, ".snipara", "workflow", "current.json"),
    JSON.stringify(
      {
        schemaVersion: "snipara.workflow.v2",
        workflowId: "lead-plan",
        status: "active",
        currentPhaseId: "implementation",
        phases: [{ id: "implementation", status: "in_progress" }],
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
        work: [{ id: "work_1", type: "work", status: "active", summary: "Ship lead plan" }],
        handoffs: [{ id: "handoff_1", type: "handoff", summary: "Run proof gates" }],
      },
      null,
      2
    ),
    "utf8"
  );

  const result = runCli(
    [
      "lead-plan",
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
  assert.equal(payload.source, "local_companion_inputs");
  assert.equal(payload.engineeringLeadPlan.posture, "lead_ready");
  assert.equal(payload.engineeringLeadPlan.workerRecommendations[0].owner, "Orca");
  assert.equal(payload.engineeringLeadPlan.workersSpawned, 0);
});

test("lead-plan command imports a Project Health cockpit lead plan", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-lead-plan-cockpit-"));
  const cockpitPath = path.join(dir, "cockpit.json");
  fs.writeFileSync(
    cockpitPath,
    JSON.stringify(
      {
        engineeringLeadPlan: {
          version: "project-intelligence-engineering-lead-plan-v0",
          posture: "lead_watch",
          status: "watch",
          score: 72,
          headline: "Imported cockpit headline",
          nextAction: "Review worker contract",
          workersSpawned: 0,
          failClosedFallback: "main_agent",
          workerRecommendations: [
            {
              id: "worker:docs",
              role: "documentation_worker",
              label: "Documentation worker",
              status: "watch",
              routingMode: "needs_contract",
              rationale: "Docs need proof",
              contract: {
                writeScope: ["docs/features/ADAPTIVE_WORK_ROUTING.md"],
                acceptanceCriteria: ["docs updated"],
                proofRequired: ["pnpm test docs"],
                approvalRequired: true,
                fallback: "main_agent",
              },
              proofGates: ["pnpm test docs"],
            },
          ],
          proofGates: ["pnpm test docs"],
          brainUpdateActions: ["Record docs result"],
          caveats: ["Imported from Project Health"],
        },
      },
      null,
      2
    ),
    "utf8"
  );

  const result = runCli(["lead-plan", "--from-cockpit", cockpitPath, "--json"], { cwd: dir });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.source, "project_health_cockpit");
  assert.equal(payload.engineeringLeadPlan.headline, "Imported cockpit headline");
  assert.equal(payload.engineeringLeadPlan.workersSpawned, 0);
  assert.equal(
    payload.engineeringLeadPlan.workerRecommendations[0].contract.fallback,
    "main_agent"
  );
});
