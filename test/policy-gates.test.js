const assert = require("node:assert/strict");
const test = require("node:test");

const { evaluateProjectPolicyGates, formatPolicyGateDecision } = require("../dist/index.js");

test("evaluateProjectPolicyGates classifies release-critical surfaces", () => {
  const result = evaluateProjectPolicyGates({
    task: "Release schema, auth, billing, deploy, and package hardening",
    release: true,
    changedFiles: [
      "packages/database/prisma/schema.prisma",
      "apps/web/src/lib/auth/session.ts",
      "apps/web/src/lib/billing/checkout.ts",
      "deploy/infomaniak/deploy-zero-downtime.sh",
      "packages/cli/src/commands/run.ts",
    ],
    diffSummary: "Touches migration, auth, billing, deploy, and npm package surface",
    skipGuard: true,
    skipPackageReview: true,
    packageReview: {
      status: "skipped",
      command: "npm view snipara-companion version bin dist-tags --json",
    },
  });

  assert.equal(result.version, "project-intelligence.policy-gates.v1");
  assert.equal(result.release, true);
  assert.equal(result.summary.block, 0);
  assert.ok(result.summary.advisory >= 1);
  assert.ok(result.summary.requiredAction >= 6);
  assert.equal(result.summary.strongestSeverity, "required_action");
  assert.deepEqual([...result.summary.affectedSurfaces].sort(), [
    "auth",
    "billing",
    "deploy",
    "package_surface",
    "release",
    "schema",
  ]);

  const schemaGate = result.gates.find((gate) => gate.surface === "schema");
  assert.equal(schemaGate.severity, "required_action");
  assert.equal(schemaGate.sampleGate.mode, "structural");
  assert.equal(schemaGate.sampleGate.satisfied, true);
  assert.equal(schemaGate.audit.humanOverrideRequiresReason, true);
  assert.ok(
    schemaGate.suggestedCommands.includes("deploy/infomaniak/migrate-vaultbrix.sh <migration.sql>")
  );

  const packageGate = result.gates.find((gate) => gate.surface === "package_surface");
  assert.equal(packageGate.severity, "required_action");
  assert.ok(packageGate.audit.reasonCodes.includes("package_surface"));
  assert.ok(result.suggestedCommands.includes("pnpm --filter snipara-companion pack:smoke"));
});

test("evaluateProjectPolicyGates blocks explicit guard contradictions", () => {
  const result = evaluateProjectPolicyGates({
    task: "Deploy production",
    release: true,
    changedFiles: ["deploy/infomaniak/deploy-zero-downtime.sh"],
    guard: {
      status: 2,
      payload: {
        hosted: {
          data: {
            evaluation: {
              decision: "BLOCKED",
              severity: "critical",
              summary: "Exclusive deploy lease exists.",
            },
          },
        },
      },
    },
    judgmentCard: {
      version: "project-intelligence.judgment-card.v1",
      generatedAt: "2026-06-20T00:00:00.000Z",
      target: { changedFiles: ["deploy/infomaniak/deploy-zero-downtime.sh"] },
      score: 0,
      band: "blocked",
      state: "blocked",
      canProceed: "block",
      summary: "Blocked",
      reasons: [],
      requiredActions: [
        {
          type: "resolve_blocker",
          title: "Resolve collaboration guard blocker",
          severity: "critical",
        },
      ],
      advisories: [],
      advisorRecommendations: [],
      evidence: [],
      caveats: [],
    },
  });

  assert.equal(result.summary.block, 2);
  assert.equal(result.summary.strongestSeverity, "block");
  const guardGate = result.gates.find((gate) => gate.id === "policy:release:guard-block");
  assert.equal(guardGate.audit.humanOverrideAllowed, false);
  assert.equal(guardGate.sampleGate.mode, "explicit_contract");
  assert.ok(formatPolicyGateDecision(guardGate).some((line) => /not allowed/.test(line)));
});

test("evaluateProjectPolicyGates emits Project Policy decision consistency gates", () => {
  const result = evaluateProjectPolicyGates({
    task: "Bypass pre-deploy guard and deploy production",
    changedFiles: ["deploy/infomaniak/deploy-zero-downtime.sh"],
    projectPolicy: {
      rules: [
        {
          id: "policy-deploy-guard",
          title: "Do not bypass deploy guard",
          scope: "deploy",
          strength: "blocking",
          confidence: 0.99,
          source: {
            kind: "project_policy",
            ref: "policy:deploy-guard",
            reviewStatus: "approved",
          },
          anchors: ["deploy", "pre-deploy guard"],
          requirement: "Run the pre-deploy guard before production deploy.",
          forbiddenActions: ["bypass", "skip guard"],
        },
      ],
    },
  });

  assert.equal(result.projectPolicyDecision.verdict, "block");
  assert.equal(result.summary.block, 1);
  const policyGate = result.gates.find((gate) => gate.id === "policy:project:decision-consistency");
  assert.equal(policyGate.surface, "deploy");
  assert.equal(policyGate.severity, "block");
  assert.equal(policyGate.audit.humanOverrideAllowed, false);
  assert.ok(policyGate.evidence.some((line) => /project-policy-/.test(line)));
});
