const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const ts = require("typescript");

const {
  ENGINEERING_LEAD_EXECUTION_RECEIPT_STAGES,
  ENGINEERING_LEAD_EXECUTION_RECEIPT_STATUSES,
  ENGINEERING_LEAD_POSTURES,
  ENGINEERING_LEAD_ROUTING_MODES,
  ENGINEERING_LEAD_STATUSES,
  ENGINEERING_LEAD_SUPERVISION_STATUSES,
  ENGINEERING_LEAD_WORK_PACKAGE_STATUSES,
  ENGINEERING_LEAD_WORKER_ROLES,
  buildCompanionEngineeringLeadPlanReport,
  formatCompanionEngineeringLeadPlanReport,
} = require("../dist/index.js");

const cliPath = path.join(__dirname, "..", "dist", "index.js");
const sharedContractsPath = path.resolve(
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
  assert.equal(report.engineeringLeadPlan.contractVersion, "engineering-lead-contract-v1");
  assert.equal(report.engineeringLeadPlan.posture, "lead_ready");
  assert.equal(report.engineeringLeadPlan.workersSpawned, 0);
  assert.equal(report.engineeringLeadPlan.failClosedFallback, "main_agent");
  assert.equal(report.engineeringLeadPlan.workPackages.length, 1);
  assert.equal(report.engineeringLeadPlan.workPackages[0].status, "ready_for_handoff");
  assert.equal(report.engineeringLeadPlan.supervision.status, "on_track");
  assert.equal(report.engineeringLeadPlan.supervision.replanRequired, false);
  assert.equal(report.engineeringLeadPlan.executionReceipts.length, 1);
  assert.equal(report.engineeringLeadPlan.executionReceipts[0].status, "handoff_ready");
  assert.deepEqual(report.engineeringLeadPlan.executionReceipts[0].requiredStages, [
    "handoff",
    "claim",
    "proof",
    "outcome",
    "brain_update",
  ]);
  assert.deepEqual(report.engineeringLeadPlan.executionReceipts[0].missingRequirements, [
    "brain_update_receipt",
    "claim_id",
    "handoff_receipt",
    "outcome_receipt",
    "proof_receipt",
  ]);
  assert.equal(
    report.engineeringLeadPlan.workerRecommendations[0].routingMode,
    "explicit_handoff_ready"
  );
  assert.ok(
    report.engineeringLeadPlan.caveats.some((caveat) => caveat.includes("does not launch"))
  );
  const markdown = formatCompanionEngineeringLeadPlanReport(report);
  assert.match(markdown, /Execution Receipts/);
  assert.match(markdown, /handoff receipt: missing/);
  assert.match(markdown, /brain_update_receipt/);
});

if (fs.existsSync(sharedContractsPath)) {
  test("lead-plan enum allowlists stay in parity with shared Project Intelligence contracts", () => {
    assert.deepEqual(
      ENGINEERING_LEAD_STATUSES,
      exportedStringArray(sharedContractsPath, "PROJECT_HEALTH_COCKPIT_STATUSES")
    );
    assert.deepEqual(
      ENGINEERING_LEAD_POSTURES,
      exportedStringArray(sharedContractsPath, "PROJECT_INTELLIGENCE_ENGINEERING_LEAD_POSTURES")
    );
    assert.deepEqual(
      ENGINEERING_LEAD_WORKER_ROLES,
      exportedStringArray(sharedContractsPath, "PROJECT_INTELLIGENCE_ENGINEERING_LEAD_WORKER_ROLES")
    );
    assert.deepEqual(
      ENGINEERING_LEAD_ROUTING_MODES,
      exportedStringArray(
        sharedContractsPath,
        "PROJECT_INTELLIGENCE_ENGINEERING_LEAD_ROUTING_MODES"
      )
    );
    assert.deepEqual(
      ENGINEERING_LEAD_WORK_PACKAGE_STATUSES,
      exportedStringArray(
        sharedContractsPath,
        "PROJECT_INTELLIGENCE_ENGINEERING_LEAD_WORK_PACKAGE_STATUSES"
      )
    );
    assert.deepEqual(
      ENGINEERING_LEAD_SUPERVISION_STATUSES,
      exportedStringArray(
        sharedContractsPath,
        "PROJECT_INTELLIGENCE_ENGINEERING_LEAD_SUPERVISION_STATUSES"
      )
    );
    assert.deepEqual(
      ENGINEERING_LEAD_EXECUTION_RECEIPT_STATUSES,
      exportedStringArray(
        sharedContractsPath,
        "PROJECT_INTELLIGENCE_ENGINEERING_LEAD_EXECUTION_RECEIPT_STATUSES"
      )
    );
    assert.deepEqual(
      ENGINEERING_LEAD_EXECUTION_RECEIPT_STAGES,
      exportedStringArray(
        sharedContractsPath,
        "PROJECT_INTELLIGENCE_ENGINEERING_LEAD_EXECUTION_RECEIPT_STAGES"
      )
    );
  });
} else {
  test("lead-plan enum allowlists stay in parity with shared Project Intelligence contracts", {
    skip: "monorepo-only Project Intelligence contract source is not present",
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
  assert.equal(report.engineeringLeadPlan.workPackages[0].status, "blocked");
  assert.equal(report.engineeringLeadPlan.supervision.status, "blocked");
  assert.equal(report.engineeringLeadPlan.supervision.replanRequired, true);
  assert.equal(report.engineeringLeadPlan.workerRecommendations[0].routingMode, "needs_contract");
  assert.equal(report.engineeringLeadPlan.workerRecommendations[0].contract.approvalRequired, true);
  assert.equal(report.engineeringLeadPlan.executionReceipts[0].status, "blocked");
  assert.ok(
    report.engineeringLeadPlan.executionReceipts[0].missingRequirements.includes("proof_gate")
  );
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
  assert.equal(payload.engineeringLeadPlan.contractVersion, "engineering-lead-contract-v1");
  assert.equal(payload.engineeringLeadPlan.workPackages[0].status, "ready_for_handoff");
  assert.equal(payload.engineeringLeadPlan.executionReceipts[0].status, "handoff_ready");
  assert.ok(
    payload.engineeringLeadPlan.executionReceipts[0].missingRequirements.includes("proof_receipt")
  );
  assert.equal(payload.engineeringLeadPlan.supervision.status, "on_track");
  assert.equal(payload.engineeringLeadPlan.workerRecommendations[0].owner, "Orca");
  assert.equal(payload.engineeringLeadPlan.workersSpawned, 0);
});

test("lead-plan command round-trips a Project Health cockpit lead plan", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-lead-plan-cockpit-"));
  const cockpitPath = path.join(dir, "cockpit.json");
  const sourcePlan = {
    version: "project-intelligence-engineering-lead-plan-v0",
    contractVersion: "engineering-lead-contract-v1",
    posture: "lead_watch",
    status: "watch",
    score: 72,
    headline: "Imported cockpit headline",
    operatingMode: "advisory_fail_closed",
    nextAction: "Review worker contract",
    workersSpawned: 0,
    failClosedFallback: "main_agent",
    workPackages: [
      {
        id: "wp:docs",
        title: "Update docs",
        status: "contracting",
        health: "watch",
        owner: "Docs",
        dependencies: [],
        writeScope: ["docs/features/ADAPTIVE_WORK_ROUTING.md"],
        acceptanceCriteria: ["docs updated"],
        proofRequired: ["pnpm test docs"],
        resultExpectation: "Return docs proof",
        nextAction: "Finish docs proof",
        replanTriggers: ["Attach docs proof"],
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
        reasonCodes: ["engineering_lead_work_package_contracting"],
      },
    ],
    supervision: {
      status: "needs_review",
      summary: "Docs package needs proof review.",
      openWorkPackages: 1,
      blockedWorkPackages: 0,
      readyWorkPackages: 0,
      executingWorkPackages: 0,
      verifyingWorkPackages: 0,
      closedWorkPackages: 0,
      reviewRequired: true,
      replanRequired: false,
      nextCheck: "Review docs proof.",
      replanTriggers: ["Attach docs proof"],
      receiptsRequired: ["proof_receipt"],
      reasonCodes: ["engineering_lead_supervision_needs_review"],
    },
    executionReceipts: [
      {
        id: "engineering-lead-receipt:wp:docs",
        workPackageId: "wp:docs",
        workPackageTitle: "Update docs",
        status: "pending_handoff",
        requiredStages: ["handoff", "claim", "approval", "proof", "outcome", "brain_update"],
        completedStages: [],
        handoffReceiptId: null,
        claimId: null,
        htaskId: null,
        approvalReceiptId: null,
        proofReceiptIds: [],
        outcomeReceiptId: null,
        brainUpdateReceiptId: null,
        proofRequired: ["pnpm test docs"],
        proofExecuted: [],
        missingRequirements: [
          "approval_receipt",
          "brain_update_receipt",
          "claim_id",
          "handoff_receipt",
          "outcome_receipt",
          "proof_receipt",
        ],
        nextAction:
          "Create or attach the handoff receipt before treating this package as delegated.",
        replanTriggers: ["Attach docs proof"],
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
        reasonCodes: ["engineering_lead_execution_receipt_pending_handoff"],
      },
    ],
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
        workPackages: [
          {
            status: "auto_launching",
            health: "degraded",
          },
        ],
        supervision: {
          status: "unstable",
        },
        executionReceipts: [
          {
            status: "auto_closed",
            requiredStages: ["handoff", "telepathy"],
            completedStages: ["telepathy"],
          },
        ],
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
  assert.equal(report.engineeringLeadPlan.workPackages[0].status, "unknown");
  assert.equal(report.engineeringLeadPlan.workPackages[0].health, "unknown");
  assert.equal(report.engineeringLeadPlan.supervision.status, "needs_review");
  assert.equal(report.engineeringLeadPlan.executionReceipts[0].status, "pending_handoff");
  assert.deepEqual(
    report.engineeringLeadPlan.reasonCodes
      .filter((code) => code.startsWith("companion_dropped_unknown_"))
      .sort(),
    [
      "companion_dropped_unknown_posture",
      "companion_dropped_unknown_routing_mode",
      "companion_dropped_unknown_status",
      "companion_dropped_unknown_supervision_status",
      "companion_dropped_unknown_execution_receipt_stage",
      "companion_dropped_unknown_execution_receipt_status",
      "companion_dropped_unknown_work_package_health",
      "companion_dropped_unknown_work_package_status",
      "companion_dropped_unknown_worker_role",
      "companion_dropped_unknown_worker_status",
    ].sort()
  );
  assert.deepEqual(
    report.engineeringLeadPlan.workerRecommendations[0].reasonCodes
      .filter((code) => code.startsWith("companion_dropped_unknown_"))
      .sort(),
    [
      "companion_dropped_unknown_routing_mode",
      "companion_dropped_unknown_worker_role",
      "companion_dropped_unknown_worker_status",
    ].sort()
  );
  assert.deepEqual(
    report.engineeringLeadPlan.executionReceipts[0].reasonCodes
      .filter((code) => code.startsWith("companion_dropped_unknown_"))
      .sort(),
    [
      "companion_dropped_unknown_execution_receipt_stage",
      "companion_dropped_unknown_execution_receipt_status",
    ].sort()
  );
});

test("lead-plan reconcile makes stale imported scope observable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-lead-plan-reconcile-"));
  const planPath = path.join(dir, "lead-plan.json");
  fs.writeFileSync(
    planPath,
    JSON.stringify(
      {
        engineeringLeadPlan: {
          version: "project-intelligence-engineering-lead-plan-v0",
          contractVersion: "engineering-lead-contract-v1",
          posture: "lead_ready",
          status: "healthy",
          score: 86,
          headline: "Docs package ready",
          operatingMode: "advisory_fail_closed",
          nextAction: "Issue handoff",
          workersSpawned: 0,
          failClosedFallback: "main_agent",
          workPackages: [
            {
              id: "wp:docs",
              title: "Update docs",
              status: "ready_for_handoff",
              health: "healthy",
              owner: "Docs",
              dependencies: [],
              writeScope: ["docs/a.md"],
              acceptanceCriteria: ["docs updated"],
              proofRequired: ["pnpm test docs"],
              resultExpectation: "Return docs proof",
              nextAction: "Issue handoff",
              replanTriggers: [],
              evidence: [],
              reasonCodes: ["engineering_lead_work_package_ready_for_handoff"],
            },
          ],
          supervision: {
            status: "on_track",
            summary: "Ready",
            openWorkPackages: 1,
            blockedWorkPackages: 0,
            readyWorkPackages: 1,
            executingWorkPackages: 0,
            verifyingWorkPackages: 0,
            closedWorkPackages: 0,
            reviewRequired: false,
            replanRequired: false,
            nextCheck: "Collect proof",
            replanTriggers: [],
            receiptsRequired: ["proof_receipt"],
            reasonCodes: ["engineering_lead_supervision_on_track"],
          },
          workerRecommendations: [],
          proofGates: ["pnpm test docs"],
          brainUpdateActions: [],
          metrics: [],
          evidence: [],
          caveats: [],
          reasonCodes: ["project_intelligence_engineering_lead_plan_v0"],
        },
      },
      null,
      2
    ),
    "utf8"
  );

  const result = runCli(
    [
      "lead-plan",
      "--from-plan",
      planPath,
      "--reconcile",
      "--changed-files",
      "src/new.ts",
      "--json",
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.reconciliation.status, "needs_replan");
  assert.equal(payload.reconciliation.replanRequired, true);
  assert.equal(payload.engineeringLeadPlan.supervision.status, "needs_replan");
  assert.ok(payload.reconciliation.reasonCodes.includes("companion_reconcile_scope_changed"));
  assert.ok(payload.reconciliation.reasonCodes.includes("companion_reconcile_workflow_not_active"));
  assert.ok(
    payload.reconciliation.reasonCodes.includes(
      "companion_reconcile_execution_receipt_missing_requirements"
    )
  );
  assert.equal(payload.engineeringLeadPlan.executionReceipts[0].status, "handoff_ready");
});
