const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildProjectJudgmentCard,
  buildVerificationPlan,
  formatProjectJudgmentCard,
} = require("../dist/index.js");

test("buildProjectJudgmentCard returns ready when all production surfaces are clean", () => {
  const card = buildProjectJudgmentCard({
    task: "ship small docs update",
    branch: "dev",
    changedFiles: ["docs/features/project-intelligence.md"],
    memoryHealth: { health_score: 0.96 },
    codeImpact: {
      risk: { level: "low", score: 8 },
      index_freshness: { commit_match: true },
    },
    verificationPlan: {
      recommendedChecks: [{ title: "docs inspection", command: "pnpm lint" }],
      missingChecks: [],
    },
  });

  assert.equal(card.version, "project-intelligence.judgment-card.v1");
  assert.equal(card.state, "ready");
  assert.equal(card.canProceed, "yes");
  assert.ok(card.score >= 90);
  assert.ok(card.requiredActions.some((action) => action.command === "pnpm lint"));
  assert.ok(card.evidence.some((item) => item.source === "code_impact"));
});

test("buildProjectJudgmentCard requires proof for high-risk missing test coverage", () => {
  const card = buildProjectJudgmentCard({
    task: "ship auth hardening",
    changedFiles: ["apps/web/src/lib/auth.ts"],
    codeImpact: {
      risk: { level: "high", score: 82 },
      index_freshness: { is_stale: true },
    },
    verificationPlan: {
      recommendedChecks: [
        { title: "type-check", command: "pnpm --filter @snipara/web type-check" },
      ],
      missingChecks: [
        {
          code: "no_direct_tests",
          severity: "medium",
          message: "No direct tests were found.",
        },
      ],
    },
  });

  assert.equal(card.state, "proof_required");
  assert.equal(card.canProceed, "review");
  assert.ok(card.score < 75);
  assert.ok(card.reasons.some((reason) => reason.code === "code_impact_high_risk"));
  assert.ok(card.reasons.some((reason) => reason.code === "code_graph_stale"));
  assert.ok(card.requiredActions.some((action) => action.type === "inspect"));
});

test("buildProjectJudgmentCard blocks when collaboration guard blocks", () => {
  const card = buildProjectJudgmentCard({
    task: "deploy production",
    changedFiles: ["deploy/infomaniak/deploy-zero-downtime.sh"],
    guard: {
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
  });

  assert.equal(card.state, "blocked");
  assert.equal(card.band, "blocked");
  assert.equal(card.canProceed, "block");
  assert.equal(card.score, 0);
  assert.ok(card.requiredActions.some((action) => action.type === "resolve_blocker"));
});

test("buildProjectJudgmentCard treats skipped package review as advisory", () => {
  const card = buildProjectJudgmentCard({
    task: "smoke release runner",
    changedFiles: ["packages/cli/src/commands/run.ts"],
    packageReview: {
      command: "npm view snipara-companion version bin dist-tags --json",
      status: "skipped",
      packageName: "snipara-companion",
    },
  });

  assert.equal(card.canProceed, "yes");
  assert.equal(
    card.requiredActions.some((action) => action.type === "package_review"),
    false
  );
  assert.ok(
    card.advisories.some(
      (action) => action.type === "package_review" && action.title === "Package review skipped"
    )
  );
  assert.ok(card.evidence.some((item) => item.source === "package_review"));
});

test("buildProjectJudgmentCard does not require completed package review", () => {
  const card = buildProjectJudgmentCard({
    task: "smoke release runner",
    changedFiles: ["packages/cli/src/commands/run.ts"],
    packageReview: {
      command: "npm view snipara-companion version bin dist-tags --json",
      status: "ok",
      packageName: "snipara-companion",
    },
  });

  assert.equal(
    card.requiredActions.some((action) => action.type === "package_review"),
    false
  );
  assert.equal(
    card.advisories.some((action) => action.type === "package_review"),
    false
  );
});

test("buildProjectJudgmentCard lets advisor recommendations influence agent actions", () => {
  const card = buildProjectJudgmentCard({
    task: "publish package surface",
    changedFiles: ["packages/cli/src/commands/run.ts"],
    advisorRecommendations: [
      {
        id: "advisor:historical_impact:package-surface-risk",
        source: "historical_impact",
        severity: "risk",
        title: "Historical Impact suggests risk",
        rationale: "Package releases with skipped smoke tests were later refuted.",
        reasonCodes: ["package_surface", "low_outcome_sample"],
        historicalImpactSummary: "1 helpful / 3 unhelpful across 4 sample(s).",
        reasonCodeReliability: 0.84,
        recommendedVerification: ["Run pack smoke before publish."],
        expectedBehaviorChange:
          "Adapt by running package smoke before following the publish recommendation.",
      },
    ],
  });

  assert.equal(card.canProceed, "review");
  assert.equal(card.state, "proof_required");
  assert.ok(card.reasons.some((reason) => reason.code === "advisor_risk_historical_impact"));
  assert.ok(
    card.requiredActions.some((action) =>
      action.title.includes("Advisor verification: Run pack smoke before publish.")
    )
  );
  const lines = formatProjectJudgmentCard(card);
  assert.ok(lines.includes("Snipara says: Historical Impact suggests risk."));
  assert.ok(lines.includes("- Reason code reliability: 84%"));
});

test("buildVerificationPlan embeds a judgment card", () => {
  const plan = buildVerificationPlan({
    changedFiles: ["packages/cli/src/index.ts"],
    codeImpact: {
      risk: { level: "medium", score: 42 },
      coverage_gaps: [
        {
          code: "no_related_tests",
          severity: "medium",
          message: "No related tests linked by code impact.",
        },
      ],
    },
  });

  assert.equal(plan.judgmentCard.version, "project-intelligence.judgment-card.v1");
  assert.equal(plan.judgmentCard.canProceed, "review");
  assert.ok(plan.judgmentCard.requiredActions.length > 0);
});
