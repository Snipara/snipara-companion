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
    SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK: "1",
    ...(options.env ?? {}),
  };
  if (!options.env || !Object.prototype.hasOwnProperty.call(options.env, "OPENAI_API_KEY")) {
    delete env.OPENAI_API_KEY;
  }
  if (!options.env || !Object.prototype.hasOwnProperty.call(options.env, "ANTHROPIC_API_KEY")) {
    delete env.ANTHROPIC_API_KEY;
  }
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
  if (
    !options.env ||
    !Object.prototype.hasOwnProperty.call(options.env, "SNIPARA_AUTOMATION_CLIENT")
  ) {
    delete env.SNIPARA_AUTOMATION_CLIENT;
  }

  return spawnSync(process.execPath, [...(options.nodeArgs ?? []), cliPath, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
    env,
  });
}

function writeProjectListPreload(dir, projects) {
  const preloadPath = path.join(dir, "preload.js");
  fs.writeFileSync(
    preloadPath,
    [
      `const projects = ${JSON.stringify(projects)};`,
      "globalThis.fetch = async (url) => {",
      "  if (String(url).includes('/api/cli/projects')) {",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      statusText: 'OK',",
      "      json: async () => ({ success: true, data: projects }),",
      "    };",
      "  }",
      "  return {",
      "    ok: true,",
      "    status: 200,",
      "    statusText: 'OK',",
      "    json: async () => ({",
      "      jsonrpc: '2.0',",
      "      id: 1,",
      "      result: { content: [{ type: 'text', text: '{}' }] },",
      "    }),",
      "  };",
      "};",
      "",
    ].join("\n"),
    "utf8"
  );
  return preloadPath;
}

function writeIntelligencePreload(dir) {
  const preloadPath = path.join(dir, "intelligence-preload.js");
  fs.writeFileSync(
    preloadPath,
    [
      "globalThis.fetch = async (_url, init = {}) => {",
      "  const body = JSON.parse(init.body || '{}');",
      "  const toolName = body.params?.name;",
      "  const args = body.params?.arguments || {};",
      "  let result;",
      "  if (toolName === 'snipara_resume_context') {",
      "    result = {",
      "      project: { slug: 'snipara' },",
      "      resumeContext: {",
      "        scope: { branch: args.branch },",
      "        focus: { summary: 'Resume intelligence surface', activeDecisionCount: 2, overlapCount: 0 },",
      "        recommendedActions: ['Run verification plan'],",
      "        caveats: []",
      "      },",
      "      received: args",
      "    };",
      "  } else if (toolName === 'snipara_memory_health') {",
      "    result = { health_score: 0.92, metrics: { stale_memories: 1, conflicting_memories: 0, verified_memories: 12 } };",
      "  } else if (toolName === 'snipara_code_impact') {",
      "    result = {",
      "      risk: { level: 'medium', score: 42 },",
      "      evidence_summary: { matched_target_count: 3 },",
      "      recommended_actions: [{ action: 'run_tests', priority: 'high', reason: 'Changed auth surface' }],",
      "      coverage_gaps: []",
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

function writeAdvisorReceiptPreload(dir) {
  const preloadPath = path.join(dir, "advisor-receipt-preload.js");
  const callsPath = path.join(dir, "advisor-receipt-calls.jsonl");
  fs.writeFileSync(
    preloadPath,
    [
      "const fs = require('node:fs');",
      `const callsPath = ${JSON.stringify(callsPath)};`,
      "globalThis.fetch = async (url, init = {}) => {",
      "  const body = JSON.parse(init.body || '{}');",
      "  if (String(url).includes('/project-intelligence/advisor-influence')) {",
      "    fs.appendFileSync(callsPath, JSON.stringify({ url: String(url), body }) + '\\n');",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      statusText: 'OK',",
      "      json: async () => ({",
      "        success: true,",
      "        data: {",
      "          project: { id: 'project_1', name: 'Snipara', slug: 'snipara' },",
      "          receipt: { id: 'advisor-receipt:served-123:advisor-risk', advisorRecommendationId: body.recommendation.id, outcomeLinkStatus: 'pending' },",
      "          advisorInfluence: { version: 'advisor-influence-outcome-loop-v0', receiptCount: 1 }",
      "        }",
      "      })",
      "    };",
      "  }",
      "  const toolName = body.params?.name;",
      "  const args = body.params?.arguments || {};",
      "  let result;",
      "  if (toolName === 'snipara_resume_context') {",
      "    result = {",
      "      project: { slug: 'snipara' },",
      "      projectIntelligence: {",
      "        judgment: {",
      "          advisorRecommendations: [{",
      "            id: 'advisor:historical_impact:package-surface-risk',",
      "            source: 'historical_impact',",
      "            severity: 'risk',",
      "            title: 'Historical Impact suggests risk',",
      "            rationale: 'Package releases need smoke proof.',",
      "            reasonCodes: ['package_surface'],",
      "            historicalImpactSummary: '1 helpful / 3 unhelpful.',",
      "            reasonCodeReliability: 0.84,",
      "            recommendedVerification: ['Run pack smoke before publish.'],",
      "            expectedBehaviorChange: 'Add pack smoke before publishing.'",
      "          }]",
      "        }",
      "      },",
      "      resumeContext: {",
      "        scope: { branch: args.branch },",
      "        focus: { summary: 'Resume intelligence surface', activeDecisionCount: 2, overlapCount: 0 },",
      "        recommendedActions: ['Run verification plan'],",
      "        caveats: []",
      "      },",
      "      received: args",
      "    };",
      "  } else if (toolName === 'snipara_memory_health') {",
      "    result = { health_score: 0.92, metrics: { stale_memories: 1, conflicting_memories: 0, verified_memories: 12 } };",
      "  } else if (toolName === 'snipara_code_impact') {",
      "    result = {",
      "      risk: { level: 'medium', score: 42 },",
      "      evidence_summary: { matched_target_count: 3 },",
      "      recommended_actions: [{ action: 'run_tests', priority: 'high', reason: 'Changed CLI receipt surface' }],",
      "      coverage_gaps: []",
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
  return { preloadPath, callsPath };
}

function writeMemoryPreload(dir) {
  const preloadPath = path.join(dir, "memory-preload.js");
  fs.writeFileSync(
    preloadPath,
    [
      "globalThis.fetch = async (_url, init = {}) => {",
      "  const body = JSON.parse(init.body || '{}');",
      "  const toolName = body.params?.name;",
      "  const args = body.params?.arguments || {};",
      "  let result;",
      "  if (toolName === 'snipara_memory_health') {",
      "    result = { total_scanned: 12, scope: args.scope, counts: { by_status: { active: 11 }, top_categories: [] }, received: args };",
      "  } else if (toolName === 'snipara_memory_clean_candidates') {",
      "    result = { total_scanned: 12, counts: { noise: 1, possibly_stale: 2, duplicates: 0 }, candidates: { noise: [{ memory_id: 'mem_noise', reason: 'receipt', preview: 'low signal' }] }, received: args };",
      "  } else if (toolName === 'snipara_memory_compact') {",
      "    result = { dry_run: args.dry_run, mutated: false, planned_actions: 3, received: args };",
      "  } else if (toolName === 'snipara_memory_invalidate') {",
      "    result = { memory_id: args.memory_id, invalidated: true, invalidated_at: args.invalidated_at || '2026-06-14T21:00:00.000Z', reason: args.reason, message: 'invalidated', received: args };",
      "  } else if (toolName === 'snipara_memory_supersede') {",
      "    result = { old_memory_id: args.old_memory_id, new_memory_id: args.new_memory_id, superseded: true, superseded_at: '2026-06-14T21:00:00.000Z', reason: args.reason, message: 'superseded', received: args };",
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

function writeMemoryGuardPreload(dir) {
  const preloadPath = path.join(dir, "memory-guard-preload.js");
  fs.writeFileSync(
    preloadPath,
    [
      "globalThis.fetch = async (_url, init = {}) => {",
      "  const body = JSON.parse(init.body || '{}');",
      "  const toolName = body.params?.name;",
      "  let result;",
      "  if (toolName === 'snipara_recall') {",
      "    result = {",
      "      memories: [{",
      "        memory_id: 'mem_no_publish',",
      "        content: 'Do not publish npm packages before hosted API is deployed and verified.',",
      "        type: 'decision',",
      "        scope: 'project',",
      "        category: 'release',",
      "        status: 'ACTIVE',",
      "        relevance: 0.96,",
      "        confidence: 1,",
      "        created_at: '2026-06-05T00:00:00.000Z',",
      "        access_count: 0",
      "      }],",
      "      warnings: [],",
      "      total_searched: 1,",
      "      query: body.params?.arguments?.query || '',",
      "      timing_ms: 1",
      "    };",
      "  } else if (toolName === 'snipara_context_query') {",
      "    result = { sections: [], total_tokens: 0, query: body.params?.arguments?.query || '' };",
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

test("root help exposes workflow, intelligence, and code commands", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: snipara-companion/);
  assert.match(result.stdout, /\bworkflow\b/);
  assert.match(result.stdout, /\bintelligence\b/);
  assert.match(result.stdout, /\bstatus\b/);
  assert.match(result.stdout, /\bbrief\b/);
  assert.match(result.stdout, /\brun\b/);
  assert.match(result.stdout, /\btimeline\b/);
  assert.match(result.stdout, /\bhandoff\b/);
  assert.match(result.stdout, /\bverify\b/);
  assert.match(result.stdout, /team-sync/);
  assert.match(result.stdout, /collaboration/);
  assert.match(result.stdout, /\beval\b/);
  assert.match(result.stdout, /\bcode\b/);
  assert.match(result.stdout, /sync-documents/);
  assert.match(result.stdout, /onboard-folder/);
  assert.match(result.stdout, /business-health/);
  assert.match(result.stdout, /business-collections/);
  assert.match(result.stdout, /client-projects/);
  assert.match(result.stdout, /\breindex\b/);
  assert.match(result.stdout, /shared-context/);
  assert.match(result.stdout, /stuck-guard/);
  assert.match(result.stdout, /memory-guard/);
  assert.match(result.stdout, /\bmemory\b/);
  assert.match(result.stdout, /\bdoctor\b/);
  assert.match(result.stdout, /\bautomations\b/);
  assert.match(result.stdout, /\bswarm\b/);
  assert.match(result.stdout, /\bhtask\b/);
});

test("memory help exposes audit, dry-run, and lifecycle commands", () => {
  const result = runCli(["memory", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\baudit\b/);
  assert.match(result.stdout, /\bhealth\b/);
  assert.match(result.stdout, /clean-candidates/);
  assert.match(result.stdout, /\bcompact\b/);
  assert.match(result.stdout, /\binvalidate\b/);
  assert.match(result.stdout, /\bsupersede\b/);
});

test("intelligence help exposes the brief command", () => {
  const result = runCli(["intelligence", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\bbrief\b/);
});

test("top-level brief help exposes Project Intelligence options", () => {
  const result = runCli(["brief", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Project Intelligence continuity brief/);
  assert.match(result.stdout, /--changed-files/);
  assert.match(result.stdout, /--skip-memory-health/);
});

test("top-level handoff help exposes artifact options", () => {
  const result = runCli(["handoff", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /agent-ready handoff artifact/);
  assert.match(result.stdout, /--summary/);
  assert.match(result.stdout, /--output/);
});

test("top-level verify help exposes verification plan options", () => {
  const result = runCli(["verify", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /transparent verification plan/);
  assert.match(result.stdout, /--changed-files/);
  assert.match(result.stdout, /--skip-impact/);
});

test("top-level run help exposes production judgment options", () => {
  const result = runCli(["run", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /production Project Intelligence judgment flow/);
  assert.match(result.stdout, /--release/);
  assert.match(result.stdout, /--skip-guard/);
  assert.match(result.stdout, /--skip-package-review/);
  assert.match(result.stdout, /--served-judgment-id/);
  assert.match(result.stdout, /--skip-advisor-receipts/);
});

test("intelligence brief combines resume context, memory health, and code impact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-intelligence-"));
  const preloadPath = writeIntelligencePreload(dir);

  const result = runCli(
    [
      "intelligence",
      "brief",
      "--task",
      "ship project intelligence",
      "--branch",
      "dev",
      "--changed-files",
      "src/auth.ts",
      "--diff-summary",
      "auth change",
      "--json",
    ],
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
  assert.equal(payload.version, "project-intelligence-brief-v1");
  assert.equal(payload.branch, "dev");
  assert.deepEqual(payload.changedFiles, ["src/auth.ts"]);
  assert.equal(payload.resumeContext.resumeContext.focus.summary, "Resume intelligence surface");
  assert.equal(payload.memoryHealth.health_score, 0.92);
  assert.equal(payload.codeImpactSourceSelection.selected, "hosted_graph");
  assert.equal(payload.codeImpact.risk.level, "medium");
  assert.equal(payload.judgmentCard.version, "project-intelligence.judgment-card.v1");
  assert.ok(
    payload.suggestedCommands.some((command) =>
      command.includes("snipara-companion code impact --changed-files src/auth.ts")
    )
  );
});

test("run command composes production judgment JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-run-"));
  const preloadPath = writeIntelligencePreload(dir);

  const result = runCli(
    [
      "run",
      "--task",
      "ship project intelligence",
      "--branch",
      "dev",
      "--changed-files",
      "packages/cli/src/commands/run.ts",
      "--diff-summary",
      "companion run change",
      "--release",
      "--skip-guard",
      "--skip-package-review",
      "--json",
    ],
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
  assert.equal(payload.version, "project-intelligence.production-run.v1");
  assert.equal(payload.release, true);
  assert.equal(payload.brief.version, "project-intelligence-brief-v1");
  assert.equal(payload.packageReview.status, "skipped");
  assert.equal(payload.guard, undefined);
  assert.equal(payload.policyGates.version, "project-intelligence.policy-gates.v1");
  assert.equal(payload.policyGates.summary.strongestSeverity, "required_action");
  assert.ok(
    payload.policyGates.gates.some(
      (gate) => gate.surface === "package_surface" && gate.severity === "required_action"
    )
  );
  assert.equal(payload.judgmentCard.version, "project-intelligence.judgment-card.v1");
  assert.equal(
    payload.judgmentCard.requiredActions.some((action) => action.type === "package_review"),
    false
  );
  assert.ok(
    payload.judgmentCard.advisories.some(
      (action) => action.type === "package_review" && action.title === "Package review skipped"
    )
  );
  assert.equal(
    payload.suggestedCommands.includes("npm view snipara-companion version bin dist-tags --json"),
    true
  );
  assert.equal(
    payload.suggestedCommands.includes("pnpm --filter snipara-companion pack:smoke"),
    true
  );
});

test("run command records first-party advisor influence receipts when served judgment is known", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-advisor-receipt-"));
  const { preloadPath, callsPath } = writeAdvisorReceiptPreload(dir);

  const result = runCli(
    [
      "run",
      "--task",
      "publish package surface",
      "--branch",
      "dev",
      "--changed-files",
      "packages/cli/src/commands/run.ts",
      "--diff-summary",
      "companion run change",
      "--served-judgment-id",
      "served_123",
      "--skip-package-review",
      "--json",
    ],
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
  assert.equal(payload.advisorReceiptCapture.status, "recorded");
  assert.equal(payload.advisorReceiptCapture.servedJudgmentId, "served_123");
  assert.equal(payload.advisorReceiptCapture.attemptedCount, 1);
  assert.equal(payload.advisorReceiptCapture.recordedCount, 1);
  assert.equal(payload.judgmentCard.advisorRecommendations[0].source, "historical_impact");

  const calls = fs.readFileSync(callsPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/projects\/snipara\/project-intelligence\/advisor-influence$/);
  assert.equal(calls[0].body.servedJudgmentId, "served_123");
  assert.equal(calls[0].body.agentDecision, "modified");
  assert.deepEqual(calls[0].body.verificationExecuted, []);
  assert.equal(calls[0].body.outcomeLinkStatus, "pending");
  assert.equal(calls[0].body.metadata.source, "snipara-companion:run");
  assert.equal(calls[0].body.metadata.firstParty, true);
  assert.equal(calls[0].body.recommendation.source, "historical_impact");
  assert.deepEqual(calls[0].body.recommendation.caveats, [
    "First-party companion receipt records plan adaptation, not outcome proof.",
  ]);
});

test("memory audit combines health, candidates, and compact dry-run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-memory-"));
  const preloadPath = writeMemoryPreload(dir);

  const result = runCli(
    [
      "memory",
      "audit",
      "--scope",
      "project",
      "--include-inactive",
      "--limit-per-bucket",
      "3",
      "--json",
    ],
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
  assert.equal(payload.version, "snipara.memory_audit.v1");
  assert.equal(payload.scope, "project");
  assert.equal(payload.health.total_scanned, 12);
  assert.equal(payload.cleanCandidates.counts.noise, 1);
  assert.equal(payload.cleanCandidates.received.limit_per_bucket, 3);
  assert.equal(payload.compactDryRun.dry_run, true);
  assert.equal(payload.compactDryRun.mutated, false);
  assert.equal(payload.compactDryRun.received.dry_run, true);
  assert.deepEqual(payload.errors, []);
});

test("memory lifecycle commands call hosted invalidate and supersede tools", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-memory-lifecycle-"));
  const preloadPath = writeMemoryPreload(dir);

  const invalidate = runCli(
    [
      "memory",
      "invalidate",
      "mem_old",
      "--reason",
      "superseded by corrected decision",
      "--invalidated-at",
      "2026-06-14T21:00:00.000Z",
      "--json",
    ],
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

  assert.equal(invalidate.status, 0, invalidate.stderr);
  const invalidatePayload = JSON.parse(invalidate.stdout);
  assert.equal(invalidatePayload.memory_id, "mem_old");
  assert.equal(invalidatePayload.received.memory_id, "mem_old");
  assert.equal(invalidatePayload.received.reason, "superseded by corrected decision");
  assert.equal(invalidatePayload.received.invalidated_at, "2026-06-14T21:00:00.000Z");

  const supersede = runCli(
    [
      "memory",
      "supersede",
      "mem_old",
      "mem_new",
      "--reason",
      "corrected source-selection rule",
      "--json",
    ],
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

  assert.equal(supersede.status, 0, supersede.stderr);
  const supersedePayload = JSON.parse(supersede.stdout);
  assert.equal(supersedePayload.old_memory_id, "mem_old");
  assert.equal(supersedePayload.new_memory_id, "mem_new");
  assert.equal(supersedePayload.received.old_memory_id, "mem_old");
  assert.equal(supersedePayload.received.new_memory_id, "mem_new");
  assert.equal(supersedePayload.received.reason, "corrected source-selection rule");
  assert.equal(supersedePayload.received.text, undefined);
});

test("top-level brief is an alias for intelligence brief", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-brief-alias-"));
  const preloadPath = writeIntelligencePreload(dir);

  const result = runCli(
    [
      "brief",
      "--task",
      "ship project intelligence",
      "--branch",
      "dev",
      "--changed-files",
      "src/auth.ts",
      "--diff-summary",
      "auth change",
      "--json",
    ],
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
  assert.equal(payload.version, "project-intelligence-brief-v1");
  assert.equal(payload.branch, "dev");
  assert.deepEqual(payload.changedFiles, ["src/auth.ts"]);
  assert.equal(payload.resumeContext.resumeContext.focus.summary, "Resume intelligence surface");
});

test("swarm help exposes the hosted fallback subcommands", () => {
  const result = runCli(["swarm", "--help"]);
  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /prefer\s+snipara-orchestrator\s+for\s+shared\s+multi-agent\s+task\s+routing/i
  );
  assert.match(result.stdout, /\bcreate\b/);
  assert.match(result.stdout, /\bjoin\b/);
});

test("swarm create help stays an explicit legacy passthrough", () => {
  const result = runCli(["swarm", "create", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--name/);
  assert.doesNotMatch(result.stdout, /reuse-existing/);
});

test("htask help exposes the hosted fallback subcommands", () => {
  const result = runCli(["htask", "--help"]);
  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /prefer\s+snipara-orchestrator\s+for\s+shared\s+multi-agent\s+queues/i
  );
  assert.match(result.stdout, /\bcreate\b/);
  assert.doesNotMatch(result.stdout, /\bbootstrap\b/);
  assert.match(result.stdout, /create-feature/);
  assert.match(result.stdout, /\bnext\b/);
  assert.match(result.stdout, /\btree\b/);
  assert.match(result.stdout, /\bcomplete\b/);
});

test("htask create-feature help stays an explicit legacy passthrough", () => {
  const result = runCli(["htask", "create-feature", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /swarm-id/);
  assert.match(result.stdout, /workstream-owner/);
  assert.doesNotMatch(result.stdout, /swarm-name/);
  assert.doesNotMatch(result.stdout, /create-initiative/);
  assert.doesNotMatch(result.stdout, /custom-workstream/);
  assert.doesNotMatch(result.stdout, /no-actionable-tasks/);
});

test("htask next help stays read-only unless orchestrator claims work", () => {
  const result = runCli(["htask", "next", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /swarm-id/);
  assert.doesNotMatch(result.stdout, /swarm-name/);
  assert.doesNotMatch(result.stdout, /claim-for-agent/);
});

test("query help exposes follow recommendation flag", () => {
  const result = runCli(["query", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /follow-recommendation/);
});

test("init help lists extended client presets", () => {
  const result = runCli(["init", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--project <project>/);
  assert.match(result.stdout, /--project-id <id>/);
  assert.match(
    result.stdout,
    /claude-code\|cursor\|windsurf\|codex\|gemini\|mistral\|chatgpt\|vscode\|continue\|custom/
  );
});

test("init starts browser project authorization instead of dashboard key copy-paste when no key is provided", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "commands", "init.ts"), "utf8");
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "src", "index.ts"), "utf8");

  assert.match(source, /Starting browser project authorization/);
  assert.match(source, /runProjectDeviceAuthorization/);
  assert.match(source, /Select the project\/repo this workspace should use/);
  assert.match(source, /writeProjectBinding\(projectDir, selectedProject\.slug\)/);
  assert.doesNotMatch(source, /await loginCommand/);
  assert.doesNotMatch(source, /Get your API key from: https:\/\/snipara\.com\/dashboard/);
  assert.doesNotMatch(indexSource, /projectId: options\.project/);
});

test("init --force refreshes an existing workspace through browser project authorization", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-force-browser-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-force-home-"));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-browser-bin-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  fs.mkdirSync(path.join(dir, ".snipara", "companion"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".snipara", "companion", "config.json"),
    JSON.stringify(
      {
        apiKey: "snp-old-key",
        apiUrl: "https://api.snipara.com",
        projectId: "proj_old_001",
        client: "claude-code",
        sessionId: "sess_old",
      },
      null,
      2
    ),
    "utf8"
  );

  for (const command of ["open", "xdg-open", "cmd"]) {
    const commandPath = path.join(binDir, command);
    fs.writeFileSync(commandPath, "#!/usr/bin/env sh\nexit 0\n", "utf8");
    fs.chmodSync(commandPath, 0o755);
  }

  const preloadPath = path.join(dir, "preload.js");
  fs.writeFileSync(
    preloadPath,
    [
      "globalThis.fetch = async (url) => {",
      "  const value = String(url);",
      "  if (value.includes('/api/oauth/device/code')) {",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      json: async () => ({",
      "        device_code: 'device-test',",
      "        user_code: 'TEST-CODE',",
      "        verification_uri_complete: 'https://www.snipara.com/device?code=TEST-CODE',",
      "        expires_in: 600,",
      "        interval: 0,",
      "      }),",
      "    };",
      "  }",
      "  if (value.includes('/api/oauth/device/token')) {",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      json: async () => ({",
      "        api_key: 'snp-fresh-key',",
      "        project_id: 'proj_fresh_001',",
      "        project_slug: 'fresh-project',",
      "        project_name: 'Fresh Project',",
      "        server_url: 'https://api.snipara.com',",
      "      }),",
      "    };",
      "  }",
      "  if (value.includes('/api/cli/projects')) {",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      statusText: 'OK',",
      "      json: async () => ({",
      "        success: true,",
      "        data: [{ id: 'proj_fresh_001', slug: 'fresh-project', name: 'Fresh Project', githubRepo: null, ownerType: 'user' }],",
      "      }),",
      "    };",
      "  }",
      "  return {",
      "    ok: true,",
      "    status: 200,",
      "    statusText: 'OK',",
      "    json: async () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } }),",
      "  };",
      "};",
      "",
    ].join("\n"),
    "utf8"
  );

  const result = runCli(["init", "--force", "--client", "claude-code"], {
    cwd: dir,
    env: { HOME: home, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
    nodeArgs: ["-r", preloadPath],
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Starting browser project authorization/);
  assert.match(result.stdout, /Select the project\/repo this workspace should use/);
  assert.match(result.stdout, /Authorized project: Fresh Project/);
  assert.match(result.stdout, /Selected browser-authorized project: Fresh Project/);

  const workspaceConfig = JSON.parse(
    fs.readFileSync(path.join(dir, ".snipara", "companion", "config.json"), "utf8")
  );
  assert.equal(workspaceConfig.apiKey, "snp-fresh-key");
  assert.equal(workspaceConfig.projectId, "proj_fresh_001");
  assert.equal(workspaceConfig.client, "claude-code");
  assert.equal(fs.readFileSync(path.join(dir, ".snipara", "project"), "utf8"), "fresh-project\n");
});

test("init writes workspace project binding and one companion config for codex", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-init-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-init-home-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });

  const preloadPath = path.join(dir, "preload.js");
  fs.writeFileSync(
    preloadPath,
    [
      "globalThis.fetch = async (url) => {",
      "  if (String(url).includes('/api/cli/projects')) {",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      statusText: 'OK',",
      "      json: async () => ({",
      "        success: true,",
      "        data: [{ id: 'proj_snipara_001', slug: 'snipara', name: 'Snipara', githubRepo: 'alopez3006/snipara-webapp', ownerType: 'user' }],",
      "      }),",
      "    };",
      "  }",
      "  return {",
      "    ok: true,",
      "    status: 200,",
      "    statusText: 'OK',",
      "    json: async () => ({",
      "      jsonrpc: '2.0',",
      "      id: 1,",
      "      result: { content: [{ type: 'text', text: '{}' }] },",
      "    }),",
      "  };",
      "};",
      "",
    ].join("\n"),
    "utf8"
  );

  const result = runCli(
    ["init", "--api-key", "snp-test-key", "--project", "snipara", "--client", "codex", "--force"],
    { cwd: dir, env: { HOME: home }, nodeArgs: ["-r", preloadPath] }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const workspaceConfig = JSON.parse(
    fs.readFileSync(path.join(dir, ".snipara", "companion", "config.json"), "utf8")
  );
  assert.deepEqual(Object.keys(workspaceConfig).sort(), [
    "apiKey",
    "apiUrl",
    "client",
    "projectId",
    "sessionId",
  ]);
  assert.equal(workspaceConfig.apiKey, "snp-test-key");
  assert.equal(workspaceConfig.apiUrl, "https://api.snipara.com");
  assert.equal(workspaceConfig.projectId, "proj_snipara_001");
  assert.equal(workspaceConfig.client, "codex");
  assert.match(workspaceConfig.sessionId, /^sess_/);

  assert.equal(fs.readFileSync(path.join(dir, ".snipara", "project"), "utf8"), "snipara\n");
  assert.match(result.stdout, /Selected project: Snipara/);
});

test("init prefers local create-snipara project binding before project list defaults", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-local-project-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-local-home-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  fs.mkdirSync(path.join(dir, ".snipara"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".snipara", "project"), "inmosuiza\n", "utf8");
  fs.writeFileSync(
    path.join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        inmosuiza: {
          type: "http",
          url: "https://api.snipara.com/mcp/inmosuiza",
          headers: { "X-API-Key": "${SNIPARA_API_KEY}" },
        },
      },
    }),
    "utf8"
  );

  const preloadPath = writeProjectListPreload(dir, [
    {
      id: "proj_default_001",
      slug: "default-project",
      name: "Default Project",
      githubRepo: null,
      ownerType: "user",
    },
    {
      id: "proj_inmosuiza_001",
      slug: "inmosuiza",
      name: "InmoSuiza",
      githubRepo: null,
      ownerType: "user",
      automationClient: "claude-code",
    },
  ]);

  const result = runCli(
    ["init", "--api-key", "snp-test-key", "--client", "claude-code", "--force"],
    { cwd: dir, env: { HOME: home }, nodeArgs: ["-r", preloadPath] }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const workspaceConfig = JSON.parse(
    fs.readFileSync(path.join(dir, ".snipara", "companion", "config.json"), "utf8")
  );
  assert.equal(workspaceConfig.projectId, "proj_inmosuiza_001");
  assert.equal(workspaceConfig.client, "claude-code");
  assert.equal(fs.readFileSync(path.join(dir, ".snipara", "project"), "utf8"), "inmosuiza\n");
  assert.match(result.stdout, /Matched local \.snipara\/project \(inmosuiza\)/);
});

test("init without api key uses browser auth with project selection", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-project-auth-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-project-auth-home-"));
  const callsPath = path.join(dir, "calls.jsonl");
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  fs.mkdirSync(path.join(dir, ".snipara"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".snipara", "project"), "inmosuiza\n", "utf8");

  const preloadPath = path.join(dir, "preload.js");
  fs.writeFileSync(
    preloadPath,
    [
      "const fs = require('node:fs');",
      "const childProcess = require('node:child_process');",
      `const callsPath = ${JSON.stringify(callsPath)};`,
      "const originalExecFileSync = childProcess.execFileSync;",
      "childProcess.execFileSync = (command, args, options) => {",
      "  if (command === 'open' || command === 'xdg-open' || command === 'cmd') {",
      "    fs.appendFileSync(callsPath, JSON.stringify({ kind: 'open', command, args }) + '\\n');",
      "    return Buffer.from('');",
      "  }",
      "  return originalExecFileSync(command, args, options);",
      "};",
      "globalThis.fetch = async (url, init = {}) => {",
      "  const body = init.body ? JSON.parse(init.body) : null;",
      "  fs.appendFileSync(callsPath, JSON.stringify({ kind: 'fetch', url: String(url), body }) + '\\n');",
      "  if (String(url).includes('/api/oauth/device/code')) {",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      statusText: 'OK',",
      "      json: async () => ({",
      "        device_code: 'device-code-12345678901234567890123456789012',",
      "        user_code: 'TEST-CODE',",
      "        verification_uri_complete: 'https://www.snipara.com/device?code=TEST-CODE',",
      "        expires_in: 1800,",
      "        interval: 1,",
      "      }),",
      "    };",
      "  }",
      "  if (String(url).includes('/api/oauth/device/token')) {",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      statusText: 'OK',",
      "      json: async () => ({",
      "        api_key: 'snp-project-key',",
      "        project_id: 'proj_inmosuiza_001',",
      "        project_slug: 'inmosuiza',",
      "        project_name: 'InmoSuiza',",
      "      }),",
      "    };",
      "  }",
      "  if (String(url).includes('/api/cli/projects')) {",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      statusText: 'OK',",
      "      json: async () => ({",
      "        success: true,",
      "        data: [{ id: 'proj_inmosuiza_001', slug: 'inmosuiza', name: 'InmoSuiza', githubRepo: 'sarucca1977/inmosuiza', ownerType: 'user', automationClient: 'claude-code' }],",
      "      }),",
      "    };",
      "  }",
      "  return {",
      "    ok: true,",
      "    status: 200,",
      "    statusText: 'OK',",
      "    json: async () => ({",
      "      jsonrpc: '2.0',",
      "      id: 1,",
      "      result: { content: [{ type: 'text', text: '{}' }] },",
      "    }),",
      "  };",
      "};",
      "",
    ].join("\n"),
    "utf8"
  );

  const result = runCli(["init", "--client", "claude-code", "--force"], {
    cwd: dir,
    env: { HOME: home },
    nodeArgs: ["-r", preloadPath],
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Select the project\/repo this workspace should use/);
  assert.match(result.stdout, /project_hint=inmosuiza/);
  assert.match(result.stdout, /Authorized project: InmoSuiza/);

  const workspaceConfig = JSON.parse(
    fs.readFileSync(path.join(dir, ".snipara", "companion", "config.json"), "utf8")
  );
  assert.equal(workspaceConfig.apiKey, "snp-project-key");
  assert.equal(workspaceConfig.projectId, "proj_inmosuiza_001");
  assert.equal(workspaceConfig.client, "claude-code");
  const tokens = JSON.parse(fs.readFileSync(path.join(home, ".snipara", "tokens.json"), "utf8"));
  assert.equal(tokens.proj_inmosuiza_001.api_key, "snp-project-key");
  assert.equal(tokens.proj_inmosuiza_001.project_slug, "inmosuiza");

  const calls = fs
    .readFileSync(callsPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const codeRequest = calls.find((call) => call.url?.includes("/api/oauth/device/code"));
  const tokenRequest = calls.find((call) => call.url?.includes("/api/oauth/device/token"));
  assert.equal(codeRequest.body.client_id, "claude-code");
  assert.equal(codeRequest.body.auto_provision, true);
  assert.equal(tokenRequest.body.client_id, "claude-code");
});

test("login uses browser project authorization by default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-login-project-auth-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-login-home-"));
  const callsPath = path.join(dir, "calls.jsonl");
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");

  const preloadPath = path.join(dir, "preload.js");
  fs.writeFileSync(
    preloadPath,
    [
      "const fs = require('node:fs');",
      "const childProcess = require('node:child_process');",
      `const callsPath = ${JSON.stringify(callsPath)};`,
      "const originalExecFileSync = childProcess.execFileSync;",
      "childProcess.execFileSync = (command, args, options) => {",
      "  if (command === 'open' || command === 'xdg-open' || command === 'cmd') {",
      "    fs.appendFileSync(callsPath, JSON.stringify({ kind: 'open', command, args }) + '\\n');",
      "    return Buffer.from('');",
      "  }",
      "  return originalExecFileSync(command, args, options);",
      "};",
      "globalThis.fetch = async (url, init = {}) => {",
      "  const body = init.body ? JSON.parse(init.body) : null;",
      "  fs.appendFileSync(callsPath, JSON.stringify({ kind: 'fetch', url: String(url), body }) + '\\n');",
      "  if (String(url).includes('/api/oauth/device/code')) {",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      statusText: 'OK',",
      "      json: async () => ({",
      "        device_code: 'device-code-login-123456789012345678901234',",
      "        user_code: 'LOGIN-CODE',",
      "        verification_uri_complete: 'https://www.snipara.com/device?code=LOGIN-CODE',",
      "        expires_in: 1800,",
      "        interval: 1,",
      "      }),",
      "    };",
      "  }",
      "  if (String(url).includes('/api/oauth/device/token')) {",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      statusText: 'OK',",
      "      json: async () => ({",
      "        api_key: 'snp-project-key',",
      "        project_id: 'proj_inmosuiza_001',",
      "        project_slug: 'inmosuiza',",
      "        project_name: 'InmoSuiza',",
      "        server_url: 'https://api.snipara.com',",
      "      }),",
      "    };",
      "  }",
      "  throw new Error('unexpected fetch ' + url);",
      "};",
      "",
    ].join("\n"),
    "utf8"
  );

  const result = runCli(["login", "--client", "claude-code", "--project", "inmosuiza"], {
    cwd: dir,
    env: { HOME: home },
    nodeArgs: ["-r", preloadPath],
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Snipara project login/);
  assert.match(result.stdout, /Select the project\/repo this workspace should use/);
  assert.match(result.stdout, /project_hint=inmosuiza/);
  assert.match(result.stdout, /Authorized project: InmoSuiza/);

  const workspaceConfig = JSON.parse(
    fs.readFileSync(path.join(dir, ".snipara", "companion", "config.json"), "utf8")
  );
  assert.equal(workspaceConfig.apiKey, "snp-project-key");
  assert.equal(workspaceConfig.projectId, "proj_inmosuiza_001");
  assert.equal(workspaceConfig.client, "claude-code");
  assert.equal(fs.readFileSync(path.join(dir, ".snipara", "project"), "utf8"), "inmosuiza\n");
  const tokens = JSON.parse(fs.readFileSync(path.join(home, ".snipara", "tokens.json"), "utf8"));
  assert.equal(tokens.proj_inmosuiza_001.api_key, "snp-project-key");
  assert.equal(tokens.proj_inmosuiza_001.project_slug, "inmosuiza");

  const calls = fs
    .readFileSync(callsPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const codeRequest = calls.find((call) => call.url?.includes("/api/oauth/device/code"));
  const tokenRequest = calls.find((call) => call.url?.includes("/api/oauth/device/token"));
  assert.equal(codeRequest.body.client_id, "claude-code");
  assert.equal(tokenRequest.body.client_id, "claude-code");
});

test("init uses git remote repo slug when the project has no GitHub repo attached yet", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-git-project-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-git-home-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  assert.equal(spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" }).status, 0);
  assert.equal(
    spawnSync("git", ["remote", "add", "origin", "git@github.com:sarucca1977/inmosuiza.git"], {
      cwd: dir,
      encoding: "utf8",
    }).status,
    0
  );

  const preloadPath = writeProjectListPreload(dir, [
    {
      id: "proj_default_001",
      slug: "default-project",
      name: "Default Project",
      githubRepo: null,
      ownerType: "user",
    },
    {
      id: "proj_inmosuiza_001",
      slug: "inmosuiza",
      name: "InmoSuiza",
      githubRepo: null,
      ownerType: "user",
    },
  ]);

  const result = runCli(
    ["init", "--api-key", "snp-test-key", "--client", "claude-code", "--force"],
    { cwd: dir, env: { HOME: home }, nodeArgs: ["-r", preloadPath] }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const workspaceConfig = JSON.parse(
    fs.readFileSync(path.join(dir, ".snipara", "companion", "config.json"), "utf8")
  );
  assert.equal(workspaceConfig.projectId, "proj_inmosuiza_001");
  assert.equal(fs.readFileSync(path.join(dir, ".snipara", "project"), "utf8"), "inmosuiza\n");
  assert.match(result.stdout, /Matched local git remote repo slug \(inmosuiza\)/);
});

test("init lists explicit project choices instead of silently rebinding a mismatched local repo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-project-mismatch-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-mismatch-home-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  fs.mkdirSync(path.join(dir, ".snipara"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".snipara", "project"), "inmosuiza\n", "utf8");

  const preloadPath = writeProjectListPreload(dir, [
    {
      id: "proj_default_001",
      slug: "default-project",
      name: "Default Project",
      githubRepo: null,
      ownerType: "user",
    },
    {
      id: "proj_other_001",
      slug: "other-repo",
      name: "Other Repo",
      githubRepo: "acme/other-repo",
      ownerType: "user",
    },
  ]);

  const result = runCli(["init", "--api-key", "snp-test-key", "--client", "claude-code"], {
    cwd: dir,
    env: { HOME: home },
    nodeArgs: ["-r", preloadPath],
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Local workspace points at \.snipara\/project: inmosuiza/);
  assert.match(result.stdout, /1\. Default Project \(default-project\)/);
  assert.match(result.stdout, /2\. Other Repo \(other-repo .* acme\/other-repo\)/);
  assert.match(result.stdout, /npx -y snipara-companion@latest init --project default-project/);
  assert.match(result.stdout, /npx -y snipara-companion@latest init --project other-repo/);
  assert.match(result.stderr, /Project selection requires an interactive terminal/);
});

test("init --client cursor shows hook reference and writes only instruction files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-cursor-init-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-cursor-home-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });

  const preloadPath = path.join(dir, "preload.js");
  fs.writeFileSync(
    preloadPath,
    [
      "globalThis.fetch = async (url) => {",
      "  if (String(url).includes('/api/cli/projects')) {",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      statusText: 'OK',",
      "      json: async () => ({",
      "        success: true,",
      "        data: [{ id: 'proj_snipara_001', slug: 'snipara', name: 'Snipara', githubRepo: 'alopez3006/snipara-webapp', ownerType: 'user' }],",
      "      }),",
      "    };",
      "  }",
      "  return {",
      "    ok: true,",
      "    status: 200,",
      "    statusText: 'OK',",
      "    json: async () => ({",
      "      jsonrpc: '2.0',",
      "      id: 1,",
      "      result: { content: [{ type: 'text', text: '{}' }] },",
      "    }),",
      "  };",
      "};",
      "",
    ].join("\n"),
    "utf8"
  );

  const result = runCli(
    ["init", "--api-key", "snp-test-key", "--project", "snipara", "--client", "cursor", "--force"],
    { cwd: dir, env: { HOME: home }, nodeArgs: ["-r", preloadPath] }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Cursor Hook Configuration/);
  assert.match(result.stdout, /\.cursor\/hooks\.json/);
  assert.doesNotMatch(result.stdout, /hook files stay disabled/);
  assert.equal(fs.existsSync(path.join(dir, "AGENTS.md")), true);
  assert.equal(fs.existsSync(path.join(dir, ".cursor", "rules", "snipara.mdc")), true);
  assert.equal(fs.existsSync(path.join(dir, ".cursor", "hooks.json")), false);
  assert.equal(fs.existsSync(path.join(dir, ".cursor", "hooks")), false);
});

test("init uses project automation client when --client is omitted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-init-project-client-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-project-client-home-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });

  const preloadPath = path.join(dir, "preload.js");
  fs.writeFileSync(
    preloadPath,
    [
      "globalThis.fetch = async (url) => {",
      "  if (String(url).includes('/api/cli/projects')) {",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      statusText: 'OK',",
      "      json: async () => ({",
      "        success: true,",
      "        data: [{ id: 'proj_snipara_001', slug: 'snipara', name: 'Snipara', githubRepo: 'alopez3006/snipara-webapp', automationClient: 'codex' }],",
      "      }),",
      "    };",
      "  }",
      "  return {",
      "    ok: true,",
      "    status: 200,",
      "    statusText: 'OK',",
      "    json: async () => ({",
      "      jsonrpc: '2.0',",
      "      id: 1,",
      "      result: { content: [{ type: 'text', text: '{}' }] },",
      "    }),",
      "  };",
      "};",
      "",
    ].join("\n"),
    "utf8"
  );

  const result = runCli(["init", "--api-key", "snp-test-key", "--project", "snipara", "--force"], {
    cwd: dir,
    env: { HOME: home },
    nodeArgs: ["-r", preloadPath],
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const workspaceConfig = JSON.parse(
    fs.readFileSync(path.join(dir, ".snipara", "companion", "config.json"), "utf8")
  );
  assert.equal(workspaceConfig.client, "codex");
  assert.match(result.stdout, /Selected client:\s+OpenAI Codex/);
});

test("init writes one workspace companion config when reconfiguring codex", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-init-legacy-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-init-legacy-home-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".snipara", "companion"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".snipara", "companion", "config.json"),
    JSON.stringify(
      {
        apiKey: "legacy-local-key",
        apiUrl: "https://api.snipara.com",
        projectId: "legacy-project",
        sessionId: "sess_existing",
      },
      null,
      2
    ),
    "utf8"
  );

  const preloadPath = path.join(dir, "preload.js");
  fs.writeFileSync(
    preloadPath,
    [
      "globalThis.fetch = async (url) => {",
      "  if (String(url).includes('/api/cli/projects')) {",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      statusText: 'OK',",
      "      json: async () => ({",
      "        success: true,",
      "        data: [{ id: 'proj_snipara_001', slug: 'snipara', name: 'Snipara', githubRepo: 'alopez3006/snipara-webapp', ownerType: 'user' }],",
      "      }),",
      "    };",
      "  }",
      "  return {",
      "    ok: true,",
      "    status: 200,",
      "    statusText: 'OK',",
      "    json: async () => ({",
      "      jsonrpc: '2.0',",
      "      id: 1,",
      "      result: { content: [{ type: 'text', text: '{}' }] },",
      "    }),",
      "  };",
      "};",
      "",
    ].join("\n"),
    "utf8"
  );

  const result = runCli(
    [
      "init",
      "--api-key",
      "snp-test-key",
      "--project-id",
      "snipara",
      "--client",
      "codex",
      "--force",
    ],
    { cwd: dir, env: { HOME: home }, nodeArgs: ["-r", preloadPath] }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const workspaceConfig = JSON.parse(
    fs.readFileSync(path.join(dir, ".snipara", "companion", "config.json"), "utf8")
  );
  assert.deepEqual(Object.keys(workspaceConfig).sort(), [
    "apiKey",
    "apiUrl",
    "client",
    "projectId",
    "sessionId",
  ]);
  assert.equal(workspaceConfig.apiKey, "snp-test-key");
  assert.equal(workspaceConfig.apiUrl, "https://api.snipara.com");
  assert.equal(workspaceConfig.projectId, "proj_snipara_001");
  assert.equal(workspaceConfig.client, "codex");
  assert.match(workspaceConfig.sessionId, /^sess_/);
});

test("code help frames symbol-card and impact as agent-ready gates", () => {
  const result = runCli(["code", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /agent-ready symbol card/);
  assert.match(result.stdout, /agent-ready code impact gate/);
  assert.match(result.stdout, /routes\/services\/jobs/);
});

test("shared-context help exposes category filter", () => {
  const result = runCli(["shared-context", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /BEST_PRACTICES/);
  assert.match(result.stdout, /--no-content/);
});

test("upload help exposes reindex flag", () => {
  const result = runCli(["upload", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--reindex/);
  assert.match(result.stdout, /--metadata/);
  assert.match(result.stdout, /--asset-class/);
});

test("references help exposes scan and ingest", () => {
  const result = runCli(["references", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\bscan\b/);
  assert.match(result.stdout, /\bingest\b/);
});

test("business collection help exposes preset commands", () => {
  const result = runCli(["business-collections", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\blist\b/);
  assert.match(result.stdout, /\bensure\b/);
  assert.match(result.stdout, /\bupload\b/);
});

test("client projects help exposes create command", () => {
  const result = runCli(["client-projects", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\blist\b/);
  assert.match(result.stdout, /\bcreate\b/);
});

test("sync-documents help exposes bulk sync options", () => {
  const result = runCli(["sync-documents", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--delete-missing/);
  assert.match(result.stdout, /--dry-run/);
  assert.match(result.stdout, /--reindex/);
});

test("onboard-folder help exposes preview and provenance options", () => {
  const result = runCli(["onboard-folder", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--apply/);
  assert.match(result.stdout, /--write-manifest/);
  assert.match(result.stdout, /--source-provider/);
  assert.match(result.stdout, /business_context/);
});

test("business-health help exposes stale threshold", () => {
  const result = runCli(["business-health", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /stale-threshold-days/);
});

test("workflow run help exposes runtime hint toggle", () => {
  const result = runCli(["workflow", "run", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /runtime-hint/);
  assert.match(result.stdout, /write-plan-file/);
  assert.match(result.stdout, /start-workflow-from-plan/);
  assert.match(result.stdout, /adaptive-routing-dry-run/);
  assert.match(result.stdout, /route-local-workers/);
  assert.match(result.stdout, /routing-preferred-endpoint/);
  assert.match(result.stdout, /lite\|standard\|auto\|full\|orchestrate/);
});

test("plan help exposes managed workflow bridge options", () => {
  const result = runCli(["plan", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /write-plan-file/);
  assert.match(result.stdout, /start-workflow/);
  assert.match(result.stdout, /workflow-id/);
});

test("team-sync help exposes continuity commands and hosted context wording", () => {
  const result = runCli(["team-sync", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /hosted Team Sync continuity context/);
  assert.match(result.stdout, /start-work/);
  assert.match(result.stdout, /complete-work/);
  assert.match(result.stdout, /handoff/);
  assert.match(result.stdout, /what-changed/);
  assert.match(result.stdout, /resume/);
});

test("team-sync handoff help exposes evidence-first attention wording", () => {
  const result = runCli(["team-sync", "handoff", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /attention/);
  assert.match(result.stdout, /note\|watch\|review\|proof/);
});

test("collaboration help exposes safe parallel coding commands", () => {
  const result = runCli(["collaboration", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /presence, claims, locks, and guard checks/);
  assert.match(result.stdout, /\bstart\b/);
  assert.match(result.stdout, /\bwatch\b/);
  assert.match(result.stdout, /\bclaim\b/);
  assert.match(result.stdout, /\bguard\b/);
  assert.match(result.stdout, /\bhooks\b/);
  assert.match(result.stdout, /\brelease\b/);
  assert.match(result.stdout, /\bstatus\b/);
  assert.match(result.stdout, /ide-status/);
});

test("local Mini Snipara bridge help exposes memory local and eval commands", () => {
  const memory = runCli(["memory", "--help"]);
  assert.equal(memory.status, 0);
  assert.match(memory.stdout, /\blocal\b/);
  assert.match(memory.stdout, /snipara-memory/);

  const evalHelp = runCli(["eval", "--help"]);
  assert.equal(evalHelp.status, 0);
  assert.match(evalHelp.stdout, /\bexport\b/);
  assert.match(evalHelp.stdout, /\brun\b/);
  assert.match(evalHelp.stdout, /snipara-evals/);
});

test("stuck-guard help exposes status, check, and simulate commands", () => {
  const result = runCli(["stuck-guard", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\bstatus\b/);
  assert.match(result.stdout, /\bcheck\b/);
  assert.match(result.stdout, /\bsimulate\b/);
});

test("memory-guard help exposes check and remember commands", () => {
  const result = runCli(["memory-guard", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\bcheck\b/);
  assert.match(result.stdout, /\bremember\b/);
  const checkResult = runCli(["memory-guard", "check", "--help"]);
  assert.equal(checkResult.status, 0);
  assert.match(checkResult.stdout, /--intent/);
  assert.match(checkResult.stdout, /--destructive/);
  assert.match(checkResult.stdout, /--confirmed-by-user/);
});

test("memory-guard detects contradictory memory before destructive intent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-memory-guard-"));
  const preloadPath = writeMemoryGuardPreload(dir);

  const result = runCli(
    [
      "memory-guard",
      "check",
      "--intent",
      "npm publish snipara-companion",
      "--destructive",
      "--strict",
      "--json",
    ],
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

  assert.equal(result.status, 20, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.destructive, true);
  assert.equal(payload.requiresConfirmation, true);
  assert.equal(payload.confirmation.required, true);
  assert.equal(payload.confirmation.confirmed, false);
  assert.equal(payload.shouldBlock, true);
  assert.equal(payload.blockReason, "confirmation_required");
  assert.equal(payload.exitCode, 20);
  assert.equal(payload.contradictions.length, 1);
  assert.equal(payload.contradictions[0].memoryId, "mem_no_publish");
  assert.match(payload.confirmationPrompt, /explicitly confirm/);
});

test("memory-guard explicit user confirmation overrides strict destructive contradiction", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-memory-guard-"));
  const preloadPath = writeMemoryGuardPreload(dir);

  const result = runCli(
    [
      "memory-guard",
      "check",
      "--intent",
      "npm publish snipara-companion",
      "--destructive",
      "--strict",
      "--confirmed-by-user",
      "User confirmed override after reviewing contradiction mem_no_publish.",
      "--json",
    ],
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
  assert.equal(payload.destructive, true);
  assert.equal(payload.requiresConfirmation, true);
  assert.equal(payload.confirmation.required, true);
  assert.equal(payload.confirmation.confirmed, true);
  assert.equal(payload.confirmation.overridesDestructive, true);
  assert.equal(payload.confirmation.overridesContradictions, true);
  assert.match(payload.confirmation.note, /User confirmed override/);
  assert.equal(payload.shouldBlock, false);
  assert.equal(payload.exitCode, 0);
  assert.equal(payload.contradictions.length, 1);
});

test("memory-guard validation rejects destructive checks without auditable intent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-memory-guard-"));

  const result = runCli(["memory-guard", "check", "--destructive", "--strict", "--json"], {
    cwd: dir,
    env: {
      HOME: fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-home-")),
    },
  });

  assert.equal(result.status, 22, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.version, "snipara.memory_guard_validation.v1");
  assert.equal(payload.valid, false);
  assert.equal(payload.exitCode, 22);
  assert.equal(payload.errors[0].field, "destructive");
});

test("memory-guard strict mode uses a distinct exit code when guidance is unavailable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-memory-guard-"));

  const result = runCli(
    [
      "memory-guard",
      "check",
      "--intent",
      "finalize release notes",
      "--strict",
      "--no-context",
      "--json",
    ],
    {
      cwd: dir,
      env: {
        HOME: fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-home-")),
      },
    }
  );

  assert.equal(result.status, 21, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.shouldBlock, true);
  assert.equal(payload.blockReason, "guidance_unavailable");
  assert.equal(payload.exitCode, 21);
  assert.equal(payload.requiresConfirmation, false);
});

test("automations help exposes install, update, diff, and status commands", () => {
  const result = runCli(["automations", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\binstall\b/);
  assert.match(result.stdout, /\bupdate\b/);
  assert.match(result.stdout, /\bdiff\b/);
  assert.match(result.stdout, /\bstatus\b/);
});

test("workflow start suggests Snipara Sandbox installation for runtime-marked phases", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-workflow-runtime-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-home-"));
  const planPath = path.join(dir, "plan.json");
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      steps: [
        {
          id: "verify",
          title: "Verify generated artifacts",
          query: "Run sandboxed validation",
          needs_runtime: true,
        },
      ],
    }),
    "utf8"
  );

  const result = runCli(
    ["workflow", "start", "--goal", "Validate artifacts", "--plan-file", planPath, "--force"],
    {
      cwd: dir,
      env: {
        HOME: home,
        PATH: path.dirname(process.execPath),
      },
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /npx create-snipara repair --with-runtime/);
});

test("workflow phase-start prints code impact and symbol-card gates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-workflow-code-gate-"));
  fs.mkdirSync(path.join(dir, ".snipara", "workflow"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".snipara", "workflow", "current.json"),
    JSON.stringify(
      {
        schemaVersion: "snipara.workflow.v1",
        workflowId: "auth-hardening",
        goal: "Harden auth",
        status: "active",
        currentPhaseId: "implement-auth",
        planSource: "inline",
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
        phases: [
          {
            id: "implement-auth",
            title: "Implement auth",
            query: "Implement auth hardening",
            status: "pending",
            files: ["src/auth.ts", "tests/auth.test.ts"],
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );

  const result = runCli(["workflow", "phase-start", "implement-auth"], { cwd: dir });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /snipara-companion code impact --changed-files/);
  assert.match(result.stdout, /src\/auth\.ts/);
  assert.match(result.stdout, /--diff-summary 'Implement auth'/);
  assert.match(result.stdout, /snipara-companion code symbol-card --qualified-name '<symbol>'/);
  assert.match(result.stdout, /Coding workflow mode/);
  assert.match(result.stdout, /STANDARD/);
  assert.match(result.stdout, /FULL \+ ORCHESTRATED/);
  assert.match(result.stdout, /routes\/services\/jobs/);
  assert.match(result.stdout, /execution\/test\/debug\/finalization/);
});

test("doctor json reports runtime readiness", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-doctor-ok-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  fs.mkdirSync(path.join(dir, ".snipara", "companion"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".snipara", "companion", "config.json"),
    JSON.stringify(
      {
        apiKey: "test-api-key",
        projectId: "test-project",
      },
      null,
      2
    ),
    "utf8"
  );

  const preloadPath = path.join(dir, "preload.js");
  fs.writeFileSync(
    preloadPath,
    [
      "globalThis.fetch = async (_url, init) => {",
      "  const payload = init && init.body ? JSON.parse(init.body) : null;",
      "  const toolName = payload && payload.params ? payload.params.name : null;",
      "  const text =",
      "    toolName === 'snipara_help'",
      "      ? JSON.stringify({ tools: [], count: 0, mode: 'catalog' })",
      "      : '{}';",
      "  return ({",
      "  ok: true,",
      "  status: 200,",
      "  statusText: 'OK',",
      "  json: async () => ({",
      "    jsonrpc: '2.0',",
      "    id: 1,",
      "    result: { content: [{ type: 'text', text }] },",
      "  }),",
      "});",
      "};",
      "",
    ].join("\n"),
    "utf8"
  );

  const result = runCli(["doctor", "--json"], { cwd: dir, nodeArgs: ["-r", preloadPath] });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(typeof report.companion.configured, "boolean");
  assert.equal(typeof report.runtime.cliAvailable, "boolean");
  assert.equal(typeof report.runtime.mcpConfigured, "boolean");
  assert.equal(typeof report.orchestrator.cliAvailable, "boolean");
  assert.equal(typeof report.providerKeys.any, "boolean");
  assert.equal(typeof report.providerKeys.sources, "object");
  assert.ok(Array.isArray(report.providerKeys.envFilesLoaded));
  assert.equal(typeof report.docker.available, "boolean");
  assert.equal(report.companionVersion.checked, true);
  assert.equal(typeof report.companionVersion.currentVersion, "string");
  assert.equal(report.companionVersion.npmLatestChecked, false);
  assert.equal(report.auth.checked, true);
  assert.equal(report.auth.valid, true);
  assert.equal(report.auth.detail, "project access confirmed via snipara_settings");
  assert.equal(report.auth.tool, "snipara_settings");
  assert.equal(report.toolCatalog.checked, true);
  assert.equal(report.toolCatalog.available, true);
  assert.equal(report.toolCatalog.toolCount, 0);
  assert.match(report.toolCatalog.detail, /snipara_help\(list_all=true\) returned 0 tools/);
});

test("doctor json detects workspace companion version newer than running CLI", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-doctor-version-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  fs.mkdirSync(path.join(dir, "packages", "cli"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "packages", "cli", "package.json"),
    JSON.stringify({ name: "snipara-companion", version: "99.0.0" }, null, 2),
    "utf8"
  );

  const result = runCli(["doctor", "--json"], { cwd: dir });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.companionVersion.workspacePackageVersion, "99.0.0");
  assert.equal(report.companionVersion.workspaceMismatch, true);
  assert.ok(
    report.companionVersion.warnings.some((warning) =>
      warning.includes("workspace packages/cli is 99.0.0")
    )
  );
});

test("doctor json detects provider keys from workspace dotenv files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-doctor-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  fs.writeFileSync(path.join(dir, ".env"), "OPENAI_API_KEY=sk-test-dotenv\n", "utf8");

  const result = runCli(["doctor", "--json"], { cwd: dir });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.providerKeys.openai, true);
  assert.equal(report.providerKeys.any, true);
  assert.equal(report.providerKeys.sources.openai, "env-file");
  assert.ok(report.providerKeys.envFilesLoaded.some((file) => file.endsWith(".env")));
  assert.doesNotMatch(result.stdout, /sk-test-dotenv/);
});

test("doctor json detects Snipara Sandbox MCP in Codex TOML config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-codex-runtime-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-home-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".codex", "config.toml"),
    [
      '[mcp_servers."snipara-sandbox"]',
      'command = "snipara-sandbox"',
      'args = ["mcp-serve"]',
      "",
    ].join("\n"),
    "utf8"
  );

  const result = runCli(["doctor", "--json"], {
    cwd: dir,
    env: {
      HOME: home,
    },
  });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.runtime.mcpConfigured, true);
  assert.ok(
    report.runtime.mcpConfigPaths.some((configPath) =>
      configPath.endsWith(path.join(".codex", "config.toml"))
    )
  );
});

test("doctor json keeps legacy rlm-runtime MCP detection", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-legacy-runtime-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-home-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".codex", "config.toml"),
    ['[mcp_servers."rlm-runtime"]', 'command = "rlm"', 'args = ["mcp-serve"]', ""].join("\n"),
    "utf8"
  );

  const result = runCli(["doctor", "--json"], {
    cwd: dir,
    env: {
      HOME: home,
    },
  });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.runtime.mcpConfigured, true);
});

test("doctor json flags unauthorized snipara auth explicitly", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-doctor-401-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  fs.mkdirSync(path.join(dir, ".snipara", "companion"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".snipara", "companion", "config.json"),
    JSON.stringify(
      {
        apiKey: "stale-api-key",
        projectId: "test-project",
      },
      null,
      2
    ),
    "utf8"
  );

  const preloadPath = path.join(dir, "preload.js");
  fs.writeFileSync(
    preloadPath,
    [
      "globalThis.fetch = async () => ({",
      "  ok: false,",
      "  status: 401,",
      "  statusText: 'Unauthorized',",
      "  json: async () => ({})",
      "});",
      "",
    ].join("\n"),
    "utf8"
  );

  const result = runCli(["doctor", "--json"], { cwd: dir, nodeArgs: ["-r", preloadPath] });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.auth.checked, true);
  assert.equal(report.auth.valid, false);
  assert.equal(report.auth.statusCode, 401);
  assert.match(report.auth.detail, /invalid credentials or stale project mapping/);
});

test("query surfaces a friendly timeout when fetch aborts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-abort-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");

  const preloadPath = path.join(dir, "preload.js");
  fs.writeFileSync(
    preloadPath,
    [
      "globalThis.fetch = async () => {",
      "  const error = new Error('This operation was aborted');",
      "  error.name = 'AbortError';",
      "  throw error;",
      "};",
      "",
    ].join("\n"),
    "utf8"
  );

  const result = spawnSync(
    process.execPath,
    ["-r", preloadPath, cliPath, "query", "--query", "timeout"],
    {
      encoding: "utf8",
      cwd: dir,
      env: {
        ...process.env,
        SNIPARA_API_KEY: "test-api-key",
        SNIPARA_PROJECT_ID: "test-project",
        SNIPARA_API_URL: "https://api.snipara.com",
      },
    }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Request timed out while contacting Snipara/);
  assert.doesNotMatch(result.stderr, /triggerUncaughtException/);
  assert.doesNotMatch(result.stderr, /AbortError/);
});

test("query surfaces a friendly auth hint on HTTP 401", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-companion-401-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");

  const preloadPath = path.join(dir, "preload.js");
  fs.writeFileSync(
    preloadPath,
    [
      "globalThis.fetch = async () => ({",
      "  ok: false,",
      "  status: 401,",
      "  statusText: 'Unauthorized',",
      "  json: async () => ({})",
      "});",
      "",
    ].join("\n"),
    "utf8"
  );

  const result = spawnSync(
    process.execPath,
    ["-r", preloadPath, cliPath, "query", "--query", "ping"],
    {
      encoding: "utf8",
      cwd: dir,
      env: {
        ...process.env,
        SNIPARA_API_KEY: "test-api-key",
        SNIPARA_PROJECT_ID: "test-project",
        SNIPARA_API_URL: "https://api.snipara.com",
      },
    }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Snipara rejected the API key/);
  assert.match(result.stderr, /npx -y snipara-companion@latest init --force/);
});
