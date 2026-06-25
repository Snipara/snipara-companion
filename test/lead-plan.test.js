const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const ts = require("typescript");

const {
  ENGINEERING_LEAD_POSTURES,
  ENGINEERING_LEAD_ROUTING_MODES,
  ENGINEERING_LEAD_STATUSES,
  ENGINEERING_LEAD_WORKER_ROLES,
  buildCompanionEngineeringLeadPlanReport,
} = require("../dist/index.js");

const cliPath = path.join(__dirname, "..", "dist", "index.js");
const projectIntelligenceContractsPath = path.resolve(
  __dirname,
  "..",
  "src",
  "contracts",
  "project-intelligence.ts"
);

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

function exportedStringArray(filePath, exportName) {
  const source = ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );

  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    const isExported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    );
    if (!isExported) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === exportName &&
        declaration.initializer &&
        ts.isAsExpression(declaration.initializer) &&
        ts.isArrayLiteralExpression(declaration.initializer.expression)
      ) {
        return declaration.initializer.expression.elements.map((element) => {
          assert.ok(ts.isStringLiteral(element), `${exportName} must contain only string literals`);
          return element.text;
        });
      }
    }
  }

  assert.fail(`Could not find exported string array ${exportName} in ${filePath}`);
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
  assert.equal(
    report.engineeringLeadPlan.workerRecommendations[0].routingMode,
    "explicit_handoff_ready"
  );
  assert.ok(
    report.engineeringLeadPlan.caveats.some((caveat) => caveat.includes("does not launch"))
  );
});

if (fs.existsSync(projectIntelligenceContractsPath)) {
  test("lead-plan enum allowlists stay in parity with Project Intelligence contracts", () => {
    assert.deepEqual(
      ENGINEERING_LEAD_STATUSES,
      exportedStringArray(projectIntelligenceContractsPath, "PROJECT_HEALTH_COCKPIT_STATUSES")
    );
    assert.deepEqual(
      ENGINEERING_LEAD_POSTURES,
      exportedStringArray(
        projectIntelligenceContractsPath,
        "PROJECT_INTELLIGENCE_ENGINEERING_LEAD_POSTURES"
      )
    );
    assert.deepEqual(
      ENGINEERING_LEAD_WORKER_ROLES,
      exportedStringArray(
        projectIntelligenceContractsPath,
        "PROJECT_INTELLIGENCE_ENGINEERING_LEAD_WORKER_ROLES"
      )
    );
    assert.deepEqual(
      ENGINEERING_LEAD_ROUTING_MODES,
      exportedStringArray(
        projectIntelligenceContractsPath,
        "PROJECT_INTELLIGENCE_ENGINEERING_LEAD_ROUTING_MODES"
      )
    );
  });
} else {
  test("lead-plan enum allowlists stay in parity with Project Intelligence contracts", {
    skip: "Project Intelligence contract source is not present",
  });
}

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

test("lead-plan command round-trips a Project Health cockpit lead plan", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-lead-plan-cockpit-"));
  const cockpitPath = path.join(dir, "cockpit.json");
  const sourcePlan = {
    version: "project-intelligence-engineering-lead-plan-v0",
    posture: "lead_watch",
    status: "watch",
    score: 72,
    headline: "Imported cockpit headline",
    operatingMode: "advisory_fail_closed",
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
        workPackageId: "wp:docs",
        workPackageTitle: "Update docs",
        owner: "Docs",
        rationale: "Docs need proof",
        contract: {
          writeScope: ["docs/features/ADAPTIVE_WORK_ROUTING.md"],
          contextRefs: [
            {
              id: "ctx:docs",
              kind: "project_decision",
              label: "Adaptive Work Routing decision",
              sourceRef: "docs/features/ADAPTIVE_WORK_ROUTING.md",
              strength: 0.9,
              reviewStatus: "approved",
              authorityStatus: "approved",
              freshness: "fresh",
            },
          ],
          acceptanceCriteria: ["docs updated"],
          proofRequired: ["pnpm test docs"],
          approvalRequired: true,
          fallback: "main_agent",
        },
        proofGates: ["pnpm test docs"],
        brainUpdateCandidates: ["Record docs worker result"],
        evidence: [
          {
            id: "evidence:docs",
            kind: "workflow",
            label: "Docs workflow",
            sourceRef: ".snipara/workflow/current.json",
            strength: 0.8,
            reviewStatus: "approved",
            authorityStatus: "approved",
            freshness: "fresh",
          },
        ],
        reasonCodes: ["engineering_lead_role_documentation_worker"],
      },
    ],
    proofGates: ["pnpm test docs"],
    brainUpdateActions: ["Record docs result"],
    metrics: [
      { label: "Work packages", value: 1 },
      { label: "Ready packages", value: 0 },
    ],
    evidence: [
      {
        id: "evidence:summary",
        kind: "outcome_signal",
        label: "Summary evidence",
        sourceRef: "outcome:1",
        strength: 0.75,
        reviewStatus: "approved",
        authorityStatus: "approved",
        freshness: "fresh",
      },
    ],
    caveats: ["Imported from Project Health"],
    reasonCodes: ["project_intelligence_engineering_lead_plan_v0"],
  };
  fs.writeFileSync(
    cockpitPath,
    JSON.stringify({ engineeringLeadPlan: sourcePlan }, null, 2),
    "utf8"
  );

  const result = runCli(["lead-plan", "--from-cockpit", cockpitPath, "--json"], { cwd: dir });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.source, "project_health_cockpit");
  assert.deepEqual(payload.engineeringLeadPlan, {
    ...sourcePlan,
    caveats: [
      "Imported from Project Health",
      "Imported cockpit plans remain advisory and fail-closed inside Companion.",
    ],
    reasonCodes: [
      "companion_imported_project_health_lead_plan",
      "project_intelligence_engineering_lead_plan_v0",
    ],
  });
});

test("lead-plan cockpit import fails closed for unknown future enum values", () => {
  const report = buildCompanionEngineeringLeadPlanReport({
    now: new Date("2026-06-25T18:00:00.000Z"),
    cockpit: {
      engineeringLeadPlan: {
        posture: "lead_degraded",
        status: "degraded",
        score: 70,
        workerRecommendations: [
          {
            role: "security_worker",
            status: "degraded",
            routingMode: "parallel_auto_launch",
            contract: {},
          },
        ],
      },
    },
    localSignals: readySignals(),
  });

  assert.equal(report.engineeringLeadPlan.posture, "lead_cold_start");
  assert.equal(report.engineeringLeadPlan.status, "watch");
  assert.equal(report.engineeringLeadPlan.workerRecommendations[0].role, "main_agent");
  assert.equal(report.engineeringLeadPlan.workerRecommendations[0].status, "unknown");
  assert.equal(report.engineeringLeadPlan.workerRecommendations[0].routingMode, "hold");
  assert.equal(report.engineeringLeadPlan.workerRecommendations[0].contract.approvalRequired, true);
});
