const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const {
  buildLocalImpactResult, buildLocalCodeOverlay, writeLocalCodeOverlayCache,
  mergeHybridCodeResults, buildProjectJudgmentCard, buildVerificationPlan,
  deriveManagedWorkflowJudgmentResolution,
} = require("../dist/index.js");

const cliPath = path.join(__dirname, "..", "dist", "index.js");

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
  if (!options.env || !Object.prototype.hasOwnProperty.call(options.env, "SNIPARA_SESSION_ID")) {
    delete env.SNIPARA_SESSION_ID;
  }

  return spawnSync(process.execPath, [...(options.nodeArgs ?? []), cliPath, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
    env,
  });
}

function writePackageJson(dir, pkg) {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function writeVerifyPreload(dir) {
  const preloadPath = path.join(dir, "verify-preload.js");
  fs.writeFileSync(
    preloadPath,
    [
      "globalThis.fetch = async (_url, init = {}) => {",
      "  const body = JSON.parse(init.body || '{}');",
      "  const toolName = body.params?.name;",
      "  const args = body.params?.arguments || {};",
      "  let result;",
      "  if (toolName === 'snipara_code_impact') {",
      "    result = {",
      "      changed_files: args.changed_files || [],",
      "      matched_targets: [{ file_path: 'src/auth.ts' }],",
      "      risk: { level: 'medium', score: 42 },",
      "      recommended_tests: [{ title: 'auth route regression', command: 'pnpm test auth' }],",
      "      recommended_actions: [{ action: 'run_type_check', priority: 'high', reason: 'Changed TypeScript surface' }],",
      "      coverage_gaps: [{ code: 'missing_browser_check', severity: 'low', message: 'UI smoke not proven' }],",
      "      index_freshness: { commit_match: true },",
      "      received: args",
      "    };",
      "  } else {",
      "    result = {};",
      "  }",
      "  return {",
      "    ok: true,",
      "    status: 200,",
      "    statusText: 'OK',",
      "    json: async () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } })",
      "  };",
      "};",
      "",
    ].join("\n"),
    "utf8"
  );
  return preloadPath;
}

test("missing local target stays unknown from the real producer through verification and judgment", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-verify-unknown-impact-"));
  try {
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "known.ts"), "export function known() { return 1; }\n");
    runGit(dir, ["init"]);
    runGit(dir, ["add", "src/known.ts"]);
    runGit(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const impact = buildLocalImpactResult({ cwd: dir, changedFiles: ["src/missing.ts"] });
    assert.equal(impact.risk.level, "unknown");
    assert.equal(impact.risk.score, null);
    assert.deepEqual(impact.missingTargetFiles, ["src/missing.ts"]);
    const direct = buildProjectJudgmentCard({ changedFiles: ["src/missing.ts"], codeImpact: impact });
    assert.equal(direct.state, "proof_required");
    assert.equal(direct.canProceed, "review");
    const plan = buildVerificationPlan({ cwd: dir, changedFiles: ["src/missing.ts"], codeImpact: impact });
    assert.equal(plan.risk.level, "unknown");
    assert.equal(plan.risk.score, undefined);
    const gap = plan.missingChecks.find((item) => item.code === "impact_applicability_incomplete");
    assert.ok(gap.reasons.includes("requested_targets_missing"));
    assert.deepEqual(gap.missingTargetFiles, ["src/missing.ts"]);
    assert.equal(plan.judgmentCard.state, "proof_required");
    assert.equal(plan.judgmentCard.canProceed, "review");
    assert.equal(plan.judgmentCard.reasons.filter((item) => item.code === gap.code).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("verification merges hosted gaps with local completeness reasons and missing paths", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-verify-composed-gaps-"));
  try {
    const plan = buildVerificationPlan({
      cwd: dir, changedFiles: ["src/known.ts"],
      codeImpact: {
        risk: { level: "low", score: 0 },
        coverage: { status: "incomplete", reasons: ["overlay_file_limit_reached"], missingTargetFiles: ["src/local.ts"] },
        coverage_gaps: [
          { code: "impact_applicability_incomplete", severity: "medium", message: "Hosted traversal is incomplete.", reasons: ["traversal_truncated"], missing_target_files: ["src/hosted.ts"] },
          { code: "impact_applicability_incomplete", severity: "medium", message: "Hosted traversal is incomplete.", reasons: ["traversal_truncated"] },
          { code: "existing_gap", severity: "low", message: "Keep this independent coverage gap." },
        ],
      },
    });
    const gaps = plan.missingChecks.filter((gap) => gap.code === "impact_applicability_incomplete");
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].severity, "high");
    assert.ok(gaps[0].reasons.includes("overlay_file_limit_reached"));
    assert.ok(gaps[0].reasons.includes("traversal_truncated"));
    assert.deepEqual(gaps[0].missingTargetFiles.sort(), ["src/hosted.ts", "src/local.ts"]);
    assert.equal(gaps[0].message.split("Hosted traversal is incomplete.").length - 1, 1);
    assert.ok(plan.missingChecks.some((gap) => gap.code === "existing_gap"));
    assert.equal(plan.risk.level, "unknown");
    assert.equal(plan.risk.score, undefined);
    assert.equal(plan.judgmentCard.canProceed, "review");
    const low = buildVerificationPlan({ cwd: dir, changedFiles: ["src/known.ts"], codeImpact: { risk: { level: "low", score: 0 }, coverage: { status: "complete" } } });
    assert.equal(low.risk.level, "low");
    assert.equal(low.risk.score, 0);
    assert.equal(low.missingChecks.some((gap) => gap.code === "impact_applicability_incomplete"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("present impact without a recognized assessed risk cannot become a ready verification card", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-verify-missing-risk-"));
  try {
    for (const codeImpact of [{}, { risk: {} }, { risk: { level: "custom", score: 0 } }]) {
      const plan = buildVerificationPlan({ cwd: dir, changedFiles: ["src/known.ts"], codeImpact });
      assert.equal(plan.risk.level, "unknown");
      assert.equal(plan.risk.score, undefined);
      assert.ok(plan.missingChecks.some((gap) => gap.code === "impact_applicability_incomplete" && gap.reasons.includes("risk_unknown")));
      assert.equal(plan.judgmentCard.state, "proof_required");
      assert.equal(plan.judgmentCard.canProceed, "review");
    }
    const absent = buildProjectJudgmentCard({ changedFiles: ["src/known.ts"] });
    assert.equal(absent.state, "ready");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildVerificationPlan combines code impact, coverage gaps, and local scripts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-verify-plan-"));
  fs.mkdirSync(path.join(dir, "packages", "cli", "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "packages", "cli", "test"), { recursive: true });
  writePackageJson(path.join(dir, "packages", "cli"), {
    name: "snipara-companion",
    scripts: {
      test: "node --test test/*.test.js",
      "type-check": "tsc --noEmit",
      lint: "eslint src --ext .ts",
      build: "tsup src/index.ts --format cjs --dts",
    },
  });

  const plan = buildVerificationPlan({
    cwd: dir,
    task: "ship verify command",
    changedFiles: ["packages/cli/src/index.ts"],
    codeImpact: {
      changed_files: ["packages/cli/src/index.ts"],
      matched_targets: [{ file_path: "packages/cli/src/commands/verify.ts" }],
      risk: { level: "medium", score: 45 },
      recommended_tests: [{ title: "verify unit test", file: "packages/cli/test/verify.test.js" }],
      recommended_actions: [{ action: "run_type_check", reason: "CLI TypeScript surface changed" }],
      coverage_gaps: [{ code: "no_browser_check", severity: "low", message: "No UI check needed" }],
      index_freshness: {
        commit_match: false,
        warnings: [{ message: "Hosted graph does not include uncommitted edits." }],
      },
    },
  });

  assert.equal(plan.version, "snipara.verification_plan.v1");
  assert.equal(plan.risk.level, "medium");
  assert.equal(plan.risk.score, 45);
  assert.deepEqual(plan.impactedFiles, [
    "packages/cli/src/index.ts",
    "packages/cli/src/commands/verify.ts",
  ]);
  assert.ok(
    plan.recommendedChecks.some((check) => check.file === "packages/cli/test/verify.test.js")
  );
  assert.ok(
    plan.recommendedChecks.some((check) => check.command === "pnpm --filter snipara-companion test")
  );
  assert.ok(plan.missingChecks.some((gap) => gap.code === "no_browser_check"));
  assert.ok(plan.caveats.some((caveat) => caveat.includes("does not run tests")));
  assert.ok(plan.caveats.some((caveat) => caveat.includes("uncommitted edits")));
});

test("buildVerificationPlan maps Python pyproject changes to Python checks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-verify-python-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "root-js",
        scripts: {
          test: "turbo test",
          lint: "turbo lint",
          build: "turbo build",
        },
      },
      null,
      2
    ),
    "utf8"
  );
  fs.mkdirSync(path.join(dir, "packages", "agentic-orchestrator", "src"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dir, "packages", "agentic-orchestrator", "pyproject.toml"),
    [
      "[build-system]",
      'requires = ["hatchling"]',
      "",
      "[project]",
      'name = "snipara-orchestrator"',
      "",
      "[tool.ruff]",
      'target-version = "py310"',
      "",
      "[tool.mypy]",
      'python_version = "3.10"',
      "",
      "[tool.pytest.ini_options]",
      'testpaths = ["tests"]',
      "",
    ].join("\n"),
    "utf8"
  );

  const plan = buildVerificationPlan({
    cwd: dir,
    skipImpact: true,
    changedFiles: ["packages/agentic-orchestrator/pyproject.toml"],
  });
  const commands = plan.recommendedChecks.flatMap((check) =>
    check.command ? [check.command] : []
  );

  assert.ok(commands.includes("cd 'packages/agentic-orchestrator' && python -m pytest"));
  assert.ok(commands.includes("cd 'packages/agentic-orchestrator' && python -m ruff check ."));
  assert.ok(commands.includes("cd 'packages/agentic-orchestrator' && python -m mypy ."));
  assert.ok(commands.includes("cd 'packages/agentic-orchestrator' && python -m build"));
  assert.equal(
    commands.some((command) => command.startsWith("pnpm ")),
    false
  );
});

test("verify command returns JSON from mocked code impact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-verify-cli-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "auth.ts"), "export const auth = true;\n", "utf8");
  writePackageJson(dir, {
    name: "sample-project",
    scripts: {
      test: "node --test",
      "type-check": "tsc --noEmit",
    },
  });
  const preloadPath = writeVerifyPreload(dir);

  const result = runCli(
    ["verify", "--task", "ship auth hardening", "--changed-files", "src/auth.ts", "--json"],
    {
      cwd: dir,
      env: {
        SNIPARA_API_KEY: "test-key",
        SNIPARA_PROJECT_ID: "snipara",
        SNIPARA_API_URL: "https://api.snipara.com",
      },
      nodeArgs: ["--require", preloadPath],
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.version, "snipara.verification_plan.v1");
  assert.equal(payload.task, "ship auth hardening");
  assert.equal(payload.codeImpactSourceSelection.selected, "hosted_graph");
  assert.equal(payload.codeImpactSourceSelection.reason, "auto_hosted_clean_checkout");
  assert.equal(payload.risk.level, "medium");
  assert.deepEqual(payload.impactedFiles, ["src/auth.ts"]);
  assert.ok(payload.recommendedChecks.some((check) => check.command === "pnpm test"));
  assert.ok(payload.recommendedChecks.some((check) => check.command === "pnpm type-check"));
});

test("verify command auto-selects hybrid graph for configured dirty worktrees", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-verify-dirty-local-"));
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.email", "agent@example.com"]);
  runGit(dir, ["config", "user.name", "Agent"]);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "auth.ts"), "export const auth = true;\n", "utf8");
  writePackageJson(dir, {
    name: "sample-project",
    scripts: {
      test: "node --test",
    },
  });
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-m", "initial"]);
  fs.appendFileSync(path.join(dir, "src", "auth.ts"), "export const dirty = true;\n", "utf8");
  const preloadPath = writeVerifyPreload(dir);

  const result = runCli(
    ["verify", "--task", "ship auth hardening", "--changed-files", "src/auth.ts", "--json"],
    {
      cwd: dir,
      env: {
        SNIPARA_API_KEY: "test-key",
        SNIPARA_PROJECT_ID: "snipara",
        SNIPARA_API_URL: "https://api.snipara.com",
      },
      nodeArgs: ["--require", preloadPath],
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.codeImpactSourceSelection.requested, "auto");
  assert.equal(payload.codeImpactSourceSelection.selected, "hybrid_graph");
  assert.equal(payload.codeImpactSourceSelection.reason, "working_tree_dirty");
  assert.ok(payload.codeImpactSourceSelection.dirtyFileCount >= 1);
  assert.ok(payload.codeImpactSourceSelection.dirtyFilesSample.includes("src/auth.ts"));
  assert.equal(payload.codeImpact.mode, "hybrid");
  assert.equal(payload.codeImpact.provenance.canonicalBase, "hosted_graph");
  assert.equal(payload.codeImpact.local.title, "Local impact");
  assert.ok(payload.codeImpact.hosted);
  assert.ok(payload.impactedFiles.includes("src/auth.ts"));
});

test("verify command can run in local fallback mode without hosted impact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-verify-skip-impact-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  writePackageJson(dir, {
    name: "sample-project",
    scripts: {
      lint: "eslint .",
    },
  });

  const result = runCli(["verify", "--skip-impact", "--changed-files", "src/index.ts", "--json"], {
    cwd: dir,
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.risk.level, "unknown");
  assert.ok(payload.recommendedChecks.some((check) => check.command === "pnpm lint"));
  assert.ok(payload.missingChecks.some((gap) => gap.code === "impact_skipped"));
});


function riskConsumerRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-risk-consumer-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/target.ts"), "export function target() { return 1; }\n");
  runGit(dir, ["init"]);
  runGit(dir, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", "."]);
  runGit(dir, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]);
  return dir;
}

function riskConsumerProjection(dir, impact, label = "code impact") {
  const plan = buildVerificationPlan({ cwd: dir, changedFiles: impact.changedFiles ?? [], codeImpact: impact });
  const card = buildProjectJudgmentCard({ task: "Inspect source applicability", codeImpact: impact });
  const judgment = { version: "snipara.workflow.judgment.v1", generatedAt: card.generatedAt,
    runEnvelope: {}, brief: {}, card, responses: [] };
  const resolution = deriveManagedWorkflowJudgmentResolution(judgment, {
    outcome: "completed", evidence: [{ source: "manual", label, status: "passed" }],
  });
  return { plan, card, resolution };
}

function assertIncompleteConsumers(dir, impact) {
  const { plan, card, resolution } = riskConsumerProjection(dir, impact);
  assert.equal(impact.risk.level, "unknown");
  assert.equal(impact.risk.score, null);
  assert.equal(impact.coverage.status, "incomplete");
  assert.equal(plan.risk.level, "unknown");
  assert.ok(plan.missingChecks.some((item) => item.code === "impact_applicability_incomplete"));
  assert.notEqual(card.canProceed, "yes");
  assert.notEqual(resolution.canProceed, "yes");
  assert.ok(resolution.evidence.unsatisfiedRequiredActions.includes("Resolve code impact applicability"));
}

test("risk consumers: free-text passed impact cannot clear an incomplete producer", () => {
  const dir = riskConsumerRepo();
  try {
    const impact = buildLocalImpactResult({ dir, changedFiles: ["src/missing.ts"] });
    for (const label of ["code impact", "code impact applicability inspection"]) {
      const { card, resolution } = riskConsumerProjection(dir, impact, label);
      const original = JSON.stringify(card);
      assert.notEqual(resolution.canProceed, "yes", label);
      assert.ok(resolution.evidence.unsatisfiedRequiredActions.includes("Resolve code impact applicability"));
      assert.ok(resolution.reasonCodes.includes("unresolved_review_signal"));
      assert.equal(JSON.stringify(card), original);
    }
    fs.writeFileSync(path.join(dir, "src/missing.ts"), "export const available = true;\n");
    const refreshed = buildLocalImpactResult({ dir, changedFiles: ["src/missing.ts"] });
    assert.equal(refreshed.coverage.status, "complete");
    assert.equal(riskConsumerProjection(dir, refreshed).resolution.canProceed, "yes");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("risk consumers: requested hybrid hosted failure is incomplete through closeout", () => {
  const dir = riskConsumerRepo();
  try {
    const local = buildLocalImpactResult({ dir, changedFiles: ["src/target.ts"] });
    assert.equal(local.coverage.status, "complete");
    assert.equal(local.risk.level, "low");
    const hybrid = mergeHybridCodeResults("impact", local, null, "HTTP 503: hosted graph unavailable");
    assert.equal(hybrid.mode, "hybrid_degraded_local");
    assertIncompleteConsumers(dir, hybrid);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const exclusion of ["too_large", "read_error"]) {
  test(`risk consumers: supported caller ${exclusion} cannot produce a complete low assessment`, (t) => {
    const dir = riskConsumerRepo();
    const caller = path.join(dir, "src/caller.ts");
    try {
      fs.writeFileSync(caller, "import { target } from './target';\nexport const value = target();\n" + "// retained caller context\n".repeat(10));
      const complete = buildLocalImpactResult({ dir, changedFiles: ["src/target.ts"] });
      assert.ok(complete.incoming.some((edge) => edge.from === "src/caller.ts"), "The omitted supported file is an actual caller");
      if (exclusion === "read_error") fs.chmodSync(caller, 0);
      const manifest = buildLocalCodeOverlay({ cwd: dir, maxFileBytes: exclusion === "too_large" ? 80 : 4096 });
      t.diagnostic(JSON.stringify({ exclusion, excluded: manifest.excluded, uid: process.getuid?.() }));
      assert.equal(manifest.excluded.byReason[exclusion], 1);
      writeLocalCodeOverlayCache(manifest);
      const impact = buildLocalImpactResult({ dir, cached: true, changedFiles: ["src/target.ts"] });
      assertIncompleteConsumers(dir, impact);
    } finally {
      if (fs.existsSync(caller)) fs.chmodSync(caller, 0o600);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("risk consumers: unsupported extension alone does not invalidate supported source coverage", () => {
  const dir = riskConsumerRepo();
  try {
    fs.writeFileSync(path.join(dir, "notes.unsupported"), "not supported code\n".repeat(20));
    const manifest = buildLocalCodeOverlay({ cwd: dir, maxFileBytes: 80 });
    assert.equal(manifest.excluded.byReason.unsupported_language, 1);
    assert.equal(manifest.excluded.byReason.too_large, 0);
    assert.equal(manifest.excluded.byReason.read_error, 0);
    writeLocalCodeOverlayCache(manifest);
    const impact = buildLocalImpactResult({ dir, cached: true, changedFiles: ["src/target.ts"] });
    assert.equal(impact.coverage.status, "complete");
    assert.equal(impact.risk.level, "low");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("risk consumers: fully applicable hybrid evidence retains the known low compatibility path", () => {
  const dir = riskConsumerRepo();
  try {
    const local = buildLocalImpactResult({ dir, changedFiles: ["src/target.ts"] });
    const hybrid = mergeHybridCodeResults("impact", local, { risk: { level: "low", score: 0, status: "assessed" }, coverage: { status: "complete" } });
    const { plan, card, resolution } = riskConsumerProjection(dir, hybrid);
    assert.equal(hybrid.risk.level, "low");
    assert.equal(hybrid.coverage.status, "combined");
    assert.equal(plan.missingChecks.some((item) => item.code === "impact_applicability_incomplete"), false);
    assert.equal(card.canProceed, "yes");
    assert.equal(resolution.canProceed, "yes");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test("risk consumers: retained legacy v1 degraded card needs refresh even without a modern applicability action", () => {
  const dir = riskConsumerRepo();
  try {
    const complete = buildLocalImpactResult({ dir, changedFiles: ["src/target.ts"] });
    const completeProjection = riskConsumerProjection(dir, complete);
    assert.equal(completeProjection.resolution.canProceed, "yes");
    // 29f6dc19's public producer emitted this reason and caveat without a new
    // applicability action. A stored card keeps that observed degradation.
    const card = { ...completeProjection.card, state: "proof_required", canProceed: "review",
      reasons: [{ code: "code_impact_degraded", severity: "high", message: "Code impact returned degraded results.", source: "code_impact" }],
      requiredActions: [], caveats: ["Code impact was degraded; local reads and broader checks should override confidence."] };
    const judgment = { version: "snipara.workflow.judgment.v1", generatedAt: card.generatedAt,
      runEnvelope: {}, brief: {}, card, responses: [] };
    for (const label of ["code impact", "local inspection", "code impact applicability inspection"]) {
      const resolution = deriveManagedWorkflowJudgmentResolution(judgment, {
        outcome: "completed", evidence: [{ source: "manual", label, status: "passed" }],
      });
      assert.equal(resolution.canProceed, "review");
      assert.ok(resolution.reasonCodes.includes("unresolved_review_signal"));
    }
    assert.equal(riskConsumerProjection(dir, complete).resolution.canProceed, "yes");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


for (const [source, fallbackHosted, expectedReason] of [
  ["hybrid", false, "hybrid_hosted_not_configured"],
  ["local", true, "fallback_hosted_not_configured"],
]) {
  test(`risk consumers: public ${source} fallback=${fallbackHosted} retains unavailable requested hosted coverage`, () => {
    const dir = riskConsumerRepo();
    try {
      for (const controlSource of ["auto", "local"]) {
        const local = runCli(["code", "impact", "--source", controlSource, "--changed-files", "src/target.ts", "--json"], { cwd: dir });
        assert.equal(local.status, 0, local.stderr || local.stdout);
        const complete = JSON.parse(local.stdout);
        assert.equal(complete.sourceSelection.selected, "local_overlay");
        assert.equal(complete.result.coverage.status, "complete");
        assert.equal(complete.result.risk.level, "low");
      }
      const args = ["code", "impact", "--source", source, "--changed-files", "src/target.ts", "--json"];
      if (fallbackHosted) args.push("--fallback-hosted");
      const requested = runCli(args, { cwd: dir });
      assert.equal(requested.status, 0, requested.stderr || requested.stdout);
      const payload = JSON.parse(requested.stdout);
      assert.equal(payload.sourceSelection.hosted.configured, false);
      assert.equal(payload.sourceSelection.reason, expectedReason);
      assertIncompleteConsumers(dir, payload.result);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test("risk consumers: merging retained legacy hybrid degradation cannot launder applicability in either order", () => {
  const dir = riskConsumerRepo();
  try {
    const complete = buildLocalImpactResult({ dir, changedFiles: ["src/target.ts"] });
    for (const mode of ["hybrid_degraded_local", "hybrid"]) {
      const legacy = { ...complete, mode, provenance: { canonicalBase: "unavailable" } };
      assert.notEqual(riskConsumerProjection(dir, legacy).card.canProceed, "yes");
      for (const inputs of [[legacy, complete], [complete, legacy]]) {
        const merged = mergeHybridCodeResults("impact", ...inputs);
        assertIncompleteConsumers(dir, merged);
        assert.equal(merged.provenance.canonicalBase, inputs[1] === legacy ? "unavailable" : "hosted_graph");
        assert.equal(merged.mode, inputs[1] === legacy ? "hybrid_degraded_local" : "hybrid");
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
