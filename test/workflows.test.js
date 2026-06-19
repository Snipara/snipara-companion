const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildJournalCheckpointEntry,
  buildAdaptiveWorkRoutingRecommendation,
  buildAgenticTimeline,
  buildAgenticWorkStatus,
  buildGeneratedWorkflowPlanDocument,
  buildSessionBootstrapQuality,
  buildTeamSyncStartWorkRecord,
  buildWorkflowImpactGate,
  buildOrchestratorHandoff,
  buildWorkflowPlanScaffold,
  buildWorkflowPhaseCommitSummary,
  createEmptyTeamSyncState,
  createClient,
  detectReleaseSurfacesFromFiles,
  formatOrchestratorRecommendationReason,
  getPlanStepDisplayTitle,
  getOrchestratorRecommendation,
  normalizeGuardTag,
  ORCHESTRATOR_HANDOFF_RELATIVE_PATH,
  normalizeWorkflowPlanInput,
  packContext,
  resolveFullWorkflowTokenBudget,
  validatePlanResult,
  runMemoryGuardCheck,
  saveTeamSyncState,
  WORKFLOW_PLANS_RELATIVE_DIR,
  WORKFLOW_STATE_RELATIVE_PATH,
  writeOrchestratorHandoff,
} = require("../dist/index.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function writeWorkflowPreload(dir) {
  const preloadPath = path.join(dir, "workflow-preload.js");
  fs.writeFileSync(
    preloadPath,
    [
      "const fs = require('node:fs');",
      "let endOfTaskCommitAttempts = 0;",
      "globalThis.fetch = async (url, init = {}) => {",
      "  const parsedUrl = new URL(String(url));",
      "  const pathname = parsedUrl.pathname;",
      "  if (pathname.includes('/mcp/')) {",
      "    const body = JSON.parse(init.body || '{}');",
      "    const toolName = body.params?.name;",
      "    if (toolName === 'snipara_journal_append') {",
      "      const logPath = process.env.SNIPARA_TEST_JOURNAL_LOG;",
      "      if (logPath) {",
      "        fs.appendFileSync(logPath, `${JSON.stringify(body.params?.arguments || {})}\\n`, 'utf8');",
      "      }",
      "      return {",
      "        ok: true,",
      "        status: 200,",
      "        statusText: 'OK',",
      "        json: async () => ({",
      "          jsonrpc: '2.0',",
      "          id: 1,",
      "          result: { content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'journal appended' }) }] },",
      "        }),",
      "      };",
      "    }",
      "    if (toolName === 'snipara_end_of_task_commit') {",
      "      const commitArgs = body.params?.arguments || {};",
      "      endOfTaskCommitAttempts += 1;",
      "      const commitLogPath = process.env.SNIPARA_TEST_COMMIT_LOG;",
      "      if (commitLogPath) {",
      "        fs.appendFileSync(commitLogPath, `${JSON.stringify(commitArgs)}\\n`, 'utf8');",
      "      }",
      "      const finalTimeoutMode = process.env.SNIPARA_TEST_FINAL_COMMIT_TIMEOUT;",
      "      const phaseTimeoutMode = process.env.SNIPARA_TEST_PHASE_COMMIT_TIMEOUT;",
      "      const shouldTimeout = (commitArgs.category === 'final-commit' && (finalTimeoutMode === 'always' || (finalTimeoutMode === 'first' && endOfTaskCommitAttempts === 1))) || (commitArgs.category === 'workflow-phase' && phaseTimeoutMode === 'always');",
      "      if (shouldTimeout) {",
      "        const error = new Error('This operation was aborted');",
      "        error.name = 'AbortError';",
      "        throw error;",
      "      }",
      "      const commitResult = { success: true, stored: true };",
      "      if (commitArgs.category === 'final-commit') {",
      "        commitResult.team_sync_handoff = { status: 'created', memory_id: 'mem_handoff' };",
      "      }",
      "      return {",
      "        ok: true,",
      "        status: 200,",
      "        statusText: 'OK',",
      "        json: async () => ({",
      "          jsonrpc: '2.0',",
      "          id: 1,",
      "          result: { content: [{ type: 'text', text: JSON.stringify(commitResult) }] },",
      "        }),",
      "      };",
      "    }",
      "    if (toolName === 'snipara_recall') {",
      "      return {",
      "        ok: true,",
      "        status: 200,",
      "        statusText: 'OK',",
      "        json: async () => ({",
      "          jsonrpc: '2.0',",
      "          id: 1,",
      "          result: { content: [{ type: 'text', text: JSON.stringify({ memories: [], warnings: [], total_searched: 0, query: '' }) }] },",
      "        }),",
      "      };",
      "    }",
      "    if (toolName === 'snipara_context_query') {",
      "      return {",
      "        ok: true,",
      "        status: 200,",
      "        statusText: 'OK',",
      "        json: async () => ({",
      "          jsonrpc: '2.0',",
      "          id: 1,",
      "          result: { content: [{ type: 'text', text: JSON.stringify({ sections: [], total_tokens: 0, max_tokens: 1600, query: '' }) }] },",
      "        }),",
      "      };",
      "    }",
      "    if (toolName === 'snipara_adaptive_routing_catalog') {",
      "      const catalogResponse = process.env.SNIPARA_TEST_ADAPTIVE_CATALOG_RESPONSE ? JSON.parse(process.env.SNIPARA_TEST_ADAPTIVE_CATALOG_RESPONSE) : { success: true, catalog: { version: 'test.catalog.v1', candidates: [{ candidateId: 'local-docs', workerClass: 'coding', endpointType: 'local', capabilities: ['docs'], isAvailable: true }] }, resolution: { status: 'candidate_catalog', candidate_count: 1, fallback: 'main_agent' }, fallback: 'main_agent', warnings: [] };",
      "      return {",
      "        ok: true,",
      "        status: 200,",
      "        statusText: 'OK',",
      "        json: async () => ({",
      "          jsonrpc: '2.0',",
      "          id: 1,",
      "          result: { content: [{ type: 'text', text: JSON.stringify(catalogResponse) }] },",
      "        }),",
      "      };",
      "    }",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      statusText: 'OK',",
      "      json: async () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } }),",
      "    };",
      "  }",
      "  if (pathname.endsWith('/automation')) {",
      "    const settings = process.env.SNIPARA_TEST_AUTOMATION_SETTINGS ? JSON.parse(process.env.SNIPARA_TEST_AUTOMATION_SETTINGS) : {};",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      statusText: 'OK',",
      "      json: async () => ({ success: true, data: { settings } }),",
      "    };",
      "  }",
      "  if (pathname.endsWith('/automation/events')) {",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      statusText: 'OK',",
      "      json: async () => ({ success: true, data: { count: 0, events: [], sessionIds: [] } }),",
      "    };",
      "  }",
      "  return {",
      "    ok: true,",
      "    status: 200,",
      "    statusText: 'OK',",
      "    json: async () => ({ success: true, data: {} }),",
      "  };",
      "};",
      "",
    ].join("\n"),
    "utf8"
  );
  return preloadPath;
}

function writeWorkflowState(dir) {
  const workflowDir = path.join(dir, ".snipara", "workflow");
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowDir, "current.json"),
    JSON.stringify(
      {
        schemaVersion: "snipara.workflow.v2",
        workflowId: "agentic-work",
        goal: "Ship companion continuity commands",
        status: "active",
        currentPhaseId: "verify",
        planSource: "inline",
        createdAt: "2026-05-31T10:00:00.000Z",
        updatedAt: "2026-05-31T10:30:00.000Z",
        phases: [
          {
            id: "build",
            title: "Build commands",
            query: "Build commands",
            status: "completed",
            startedAt: "2026-05-31T10:05:00.000Z",
            completedAt: "2026-05-31T10:20:00.000Z",
            summary: "Top-level status and timeline commands added",
            outcome: "completed",
            files: ["packages/cli/src/index.ts"],
          },
          {
            id: "verify",
            title: "Verify commands",
            query: "Verify commands",
            status: "in_progress",
            startedAt: "2026-05-31T10:25:00.000Z",
            files: ["packages/cli/test/workflows.test.js"],
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );
}

function writeTeamSyncState(dir) {
  const teamSyncDir = path.join(dir, ".snipara", "team-sync");
  fs.mkdirSync(teamSyncDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamSyncDir, "session.json"),
    JSON.stringify(
      {
        schemaVersion: "snipara.team-sync.v1",
        updatedAt: "2026-05-31T10:35:00.000Z",
        work: [
          {
            id: "work_1",
            type: "work",
            summary: "Start CLI command work",
            files: ["packages/cli/src/index.ts"],
            status: "active",
            createdAt: "2026-05-31T09:55:00.000Z",
            updatedAt: "2026-05-31T09:55:00.000Z",
          },
        ],
        handoffs: [
          {
            id: "handoff_1",
            type: "handoff",
            summary: "Status command ready",
            files: ["packages/cli/src/commands/workflows.ts"],
            next: "Run package tests",
            attention: "proof",
            createdAt: "2026-05-31T10:40:00.000Z",
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );
}

test("client exposes generic workflow helpers", () => {
  const client = createClient();

  assert.equal(typeof client.callTool, "function");
  assert.equal(typeof client.sharedContext, "function");
  assert.equal(typeof client.codeCallers, "function");
  assert.equal(typeof client.codeImports, "function");
  assert.equal(typeof client.codeNeighbors, "function");
  assert.equal(typeof client.codeShortestPath, "function");
  assert.equal(typeof client.codeSymbolCard, "function");
  assert.equal(typeof client.codeImpact, "function");
  assert.equal(typeof client.plan, "function");
  assert.equal(typeof client.uploadDocument, "function");
  assert.equal(typeof client.listBusinessCollections, "function");
  assert.equal(typeof client.ensureBusinessCollection, "function");
  assert.equal(typeof client.uploadBusinessDocument, "function");
  assert.equal(typeof client.listClientProjects, "function");
  assert.equal(typeof client.createClientProject, "function");
  assert.equal(typeof client.syncDocuments, "function");
  assert.equal(typeof client.reindex, "function");
  assert.equal(typeof client.indexHealth, "function");
  assert.equal(typeof client.getChunk, "function");
  assert.equal(typeof client.multiQuery, "function");
  assert.equal(typeof client.orchestrate, "function");
  assert.equal(typeof client.loadDocument, "function");
  assert.equal(typeof client.getAutomationEvents, "function");
  assert.equal(typeof client.evaluateStuckGuard, "function");
  assert.equal(typeof client.getStuckGuardStatus, "function");
  assert.equal(typeof client.getSessionMemories, "function");
  assert.equal(typeof client.endOfTaskCommit, "function");
  assert.equal(typeof client.journalAppend, "function");
});

test("agentic status summarizes workflow, git, and Team Sync state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-agentic-status-"));
  writeWorkflowState(dir);
  writeTeamSyncState(dir);

  const status = buildAgenticWorkStatus(dir);

  assert.equal(status.version, "snipara.agentic_status.v1");
  assert.equal(status.workflow.id, "agentic-work");
  assert.equal(status.workflow.currentPhase.id, "verify");
  assert.equal(status.workflow.lastPhaseCommit.phaseId, "build");
  assert.equal(status.teamSync.handoffCount, 1);
  assert.equal(status.teamSync.latestHandoff.summary, "Status command ready");
  assert.ok(status.risks.some((risk) => risk.includes("proof")));
  assert.match(status.suggestedNextAction, /verify/);
});

test("agentic timeline combines workflow phase events and Team Sync handoffs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-agentic-timeline-"));
  writeWorkflowState(dir);
  writeTeamSyncState(dir);

  const timeline = buildAgenticTimeline({ cwd: dir, limit: 4 });

  assert.equal(timeline.version, "snipara.agentic_timeline.v1");
  assert.equal(timeline.events.length, 4);
  assert.equal(timeline.events[0].kind, "team-sync-handoff");
  assert.equal(timeline.events[0].title, "Status command ready");
  assert.ok(timeline.events.some((event) => event.kind === "phase-start"));
  assert.ok(timeline.events.some((event) => event.kind === "phase-commit"));
});

test("top-level status works without a managed workflow", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-status-empty-"));
  const result = runCli(["status", "--json"], { cwd: dir });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.version, "snipara.agentic_status.v1");
  assert.equal(payload.workflow, null);
  assert.ok(payload.risks.some((risk) => risk.includes("No active managed workflow")));
});

test("top-level timeline reads local workflow and Team Sync state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-timeline-cli-"));
  writeWorkflowState(dir);
  writeTeamSyncState(dir);

  const result = runCli(["timeline", "--limit", "3", "--json"], { cwd: dir });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.version, "snipara.agentic_timeline.v1");
  assert.equal(payload.events.length, 3);
  assert.equal(payload.events[0].kind, "team-sync-handoff");
});

test("workflow impact gate audits unpushed committed phases without dirty files", () => {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-impact-remote-"));
  runGit(remote, ["init", "--bare"]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-impact-local-"));
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.email", "agent@example.com"]);
  runGit(dir, ["config", "user.name", "Agent"]);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitignore"), ".snipara/\n", "utf8");
  fs.writeFileSync(path.join(dir, "src", "base.ts"), "export const base = 1;\n", "utf8");
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-m", "initial"]);
  runGit(dir, ["branch", "-M", "dev"]);
  runGit(dir, ["remote", "add", "origin", remote]);
  runGit(dir, ["push", "-u", "origin", "dev"]);

  fs.writeFileSync(path.join(dir, "src", "base.ts"), "export const base = 2;\n", "utf8");
  fs.writeFileSync(
    path.join(dir, "src", "feature.ts"),
    "import { base } from './base';\nexport const feature = base;\n",
    "utf8"
  );
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs", "note.md"), "# Note\n", "utf8");
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-m", "phase code"]);
  const workflowDir = path.join(dir, ".snipara", "workflow");
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowDir, "current.json"),
    JSON.stringify(
      {
        schemaVersion: "snipara.workflow.v2",
        workflowId: "unpushed-impact",
        goal: "Ship unpushed local impact gate",
        status: "active",
        currentPhaseId: "verify",
        planSource: "inline",
        createdAt: "2026-06-12T09:00:00.000Z",
        updatedAt: "2026-06-12T09:30:00.000Z",
        phases: [
          {
            id: "build",
            title: "Build gate",
            query: "Build gate",
            status: "completed",
            startedAt: "2026-06-12T09:05:00.000Z",
            completedAt: "2026-06-12T09:20:00.000Z",
            summary: "Implemented local impact gate",
            outcome: "completed",
            files: ["src/base.ts", "src/feature.ts"],
          },
          {
            id: "verify",
            title: "Verify gate",
            query: "Verify gate",
            status: "pending",
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(path.join(dir, "scratch.tmp"), "dirty\n", "utf8");

  const result = buildWorkflowImpactGate({ cwd: dir });

  assert.equal(result.version, "snipara.workflow_impact_gate.v1");
  assert.equal(result.repo.upstream, "origin/dev");
  assert.equal(result.unpushed.commitCount, 1);
  assert.deepEqual(result.unpushed.codeChangedFiles.sort(), ["src/base.ts", "src/feature.ts"]);
  assert.deepEqual(result.unpushed.nonCodeChangedFiles, ["docs/note.md"]);
  assert.equal(result.dirtyWorkingTree.includedInLocalImpact, false);
  assert.deepEqual(result.dirtyWorkingTree.files, ["scratch.tmp"]);
  assert.ok(result.workflow.completedPhases.some((phase) => phase.id === "build"));
  assert.deepEqual(result.workflow.completedPhases[0].filesInUnpushedDiff.sort(), [
    "src/base.ts",
    "src/feature.ts",
  ]);
  assert.ok(result.workflow.changedFilesWithoutPhase.includes("docs/note.md"));
  assert.equal(result.gate.status, "attention");
  assert.ok(result.localImpact);

  const cli = runCli(["workflow", "impact-gate", "--json"], { cwd: dir });
  assert.equal(cli.status, 0, cli.stderr);
  const payload = JSON.parse(cli.stdout);
  assert.equal(payload.unpushed.commitCount, 1);
  assert.equal(payload.dirtyWorkingTree.includedInLocalImpact, false);
});

test("journal checkpoint helper formats workflow context without durable-memory fields", () => {
  const entry = buildJournalCheckpointEntry({
    action: "workflow:phase-commit",
    summary: "Added journal writes to workflow checkpoints",
    outcome: "completed",
    workflowId: "companion-journal",
    phaseId: "companion-journal-checkpoints",
    phaseTitle: "Companion Journal Checkpoints",
    files: ["packages/cli/src/commands/workflows.ts"],
  });

  assert.match(entry.text, /Checkpoint: workflow:phase-commit/);
  assert.match(entry.text, /Workflow: companion-journal/);
  assert.match(
    entry.text,
    /Phase: companion-journal-checkpoints \(Companion Journal Checkpoints\)/
  );
  assert.match(entry.text, /Outcome: completed/);
  assert.deepEqual(entry.tags, [
    "companion",
    "checkpoint",
    "workflow:phase-commit",
    "workflow",
    "phase",
    "outcome:completed",
  ]);
});

test("plan step display prefers action over numeric step id", () => {
  assert.equal(
    getPlanStepDisplayTitle({ step: 1, action: "decompose", expected_output: "sub_queries" }, 0),
    "decompose"
  );
  assert.equal(
    getPlanStepDisplayTitle({ step: 2, title: "Inspect auth flow" }, 1),
    "Inspect auth flow"
  );
});

test("managed workflow plan normalization accepts hosted plan shapes", () => {
  const phases = normalizeWorkflowPlanInput(
    {
      steps: [
        {
          id: "context",
          action: "Load context",
          query: "Load auth context",
          expected_output: "Relevant auth notes",
          files: ["src/auth.ts"],
        },
        {
          action: "Implement and verify",
          needs_runtime: true,
        },
      ],
    },
    "Harden auth"
  );

  assert.equal(phases.length, 2);
  assert.equal(phases[0].id, "context");
  assert.equal(phases[0].title, "Load context");
  assert.equal(phases[0].acceptance, "Relevant auth notes");
  assert.deepEqual(phases[0].files, ["src/auth.ts"]);
  assert.equal(phases[1].needsRuntime, true);
});

test("plan validation rejects placeholder and empty hosted plans", () => {
  const empty = validatePlanResult({ plan_id: "plan_empty", steps: [] });
  assert.equal(empty.valid, false);
  assert.match(empty.issues.join("\n"), /no executable steps/);

  const placeholder = validatePlanResult({
    plan_id: "plan_placeholder",
    steps: [
      { step: 1 },
      {
        step: 2,
        action: "2",
        expected_output: "sections",
        params: { max_tokens: -334 },
      },
    ],
  });

  assert.equal(placeholder.valid, false);
  assert.match(placeholder.issues.join("\n"), /missing a useful title or action/);
  assert.match(placeholder.issues.join("\n"), /placeholder action/);
  assert.match(placeholder.issues.join("\n"), /invalid max_tokens budget/);
});

test("plan validation keeps structural validity while warning on weak file hints", () => {
  const quality = validatePlanResult(
    {
      plan_id: "plan_weak_files",
      query: "Harden companion workflow token budget",
      steps: [
        {
          action: "implementation_map",
          title: "Map htask implementation",
          expected_output: "files",
          params: {
            likely_files: ["apps/mcp-server/src/engine/handlers/htask.py"],
            max_tokens: 500,
          },
        },
      ],
    },
    { query: "Harden companion workflow token budget" }
  );

  assert.equal(quality.valid, true);
  assert.match(quality.warnings.join("\n"), /no obvious lexical overlap|weakly related/);
});

test("full workflow token budget allocates compact FULL surfaces", () => {
  const budget = resolveFullWorkflowTokenBudget({
    maxTokens: 1200,
    includeSessionContext: false,
  });

  assert.equal(budget.requested_max_tokens, 1200);
  assert.equal(budget.allocations.session_context_tokens, 0);
  assert.ok(budget.allocations.critical_memory_tokens < 1200);
  assert.ok(budget.allocations.context_query_tokens < 1200);
  assert.ok(budget.allocations.plan_tokens < 1200);
  assert.equal(budget.estimated_max_tokens, 1200);
});

test("session bootstrap quality warns on stale low-confidence test memories", () => {
  const quality = buildSessionBootstrapQuality(
    {
      critical: {
        memories: [
          {
            id: "mem_test",
            content: "Test memory should not steer production work",
            confidence: 0.2,
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        count: 1,
        tokens: 120,
      },
      daily: { memories: [], count: 0, tokens: 0 },
      total_tokens: 120,
    },
    { expectedMaxTokens: 80, now: new Date("2026-06-18T00:00:00.000Z") }
  );

  assert.equal(quality.counts.low_confidence_memories, 1);
  assert.equal(quality.counts.stale_memories, 1);
  assert.equal(quality.counts.test_memories, 1);
  assert.match(quality.warnings.join("\n"), /above requested bootstrap budget/);
  assert.match(quality.warnings.join("\n"), /confidence below 0\.5/);
  assert.match(quality.warnings.join("\n"), /older than 90 days/);
  assert.match(quality.warnings.join("\n"), /test fixtures/);
});

test("generated workflow plan document converts hosted plan steps", () => {
  const document = buildGeneratedWorkflowPlanDocument(
    {
      plan_id: "plan_test",
      query: "Harden auth",
      steps: [
        {
          action: "context_query",
          params: { query: "auth middleware", max_tokens: 2000 },
          expected_output: "sections",
        },
        {
          action: "implementation_map",
          params: { likely_files: ["src/auth.ts"] },
          expected_output: "implementation_targets",
        },
      ],
    },
    "Fallback goal"
  );

  assert.equal(document.mode, "full");
  assert.equal(document.goal, "Harden auth");
  assert.equal(document.source, "snipara_plan");
  assert.equal(document.steps[0].title, "context_query");
  assert.equal(document.steps[0].query, "auth middleware");
  assert.equal(document.steps[0].acceptance, "sections");
  assert.deepEqual(document.steps[1].files, ["src/auth.ts"]);
});

test("managed workflow plan normalization keeps markdown sub-bullets inside their parent phase", () => {
  const phases = normalizeWorkflowPlanInput(
    `# Public Drift Cleanup

Goal: Align snipara.com homepage, public pricing, and public docs with the current persistent-workflows positioning and Context + Memory packaging.

Phases:

1. Homepage metadata and SEO
   - Align root and marketing metadata with the current homepage messaging.
   - Remove preview-only \`noindex\` behavior from the shipped homepage.
   - Update shared JSON-LD copy so structured data matches the live positioning.

2. Public pricing and packaging docs
   - Make the public docs stop advertising a separate \`$15/month\` Agents subscription.
   - Remove obsolete \`Starter\` plan tables from public Agent/Team Memory pages.
   - Align public MCP Tools and Agents docs with the current pricing page language.

3. Verification
   - Re-scan the affected source files for old pricing/plan strings.
   - Run targeted checks or build validation for the web app.
   - Re-check the key public pages and summarize any residual drift.
`,
    "Align public site and docs messaging with current homepage and pricing"
  );

  assert.equal(phases.length, 3);
  assert.deepEqual(
    phases.map((phase) => phase.id),
    ["homepage-metadata-and-seo", "public-pricing-and-packaging-docs", "verification"]
  );
  assert.ok(!phases.some((phase) => phase.title === "Phases:"));
  assert.match(
    phases[0].query,
    /Align root and marketing metadata with the current homepage messaging\./
  );
  assert.match(
    phases[1].acceptance,
    /Remove obsolete `Starter` plan tables from public Agent\/Team Memory pages\./
  );
});

test("workflow scaffold builds a four-phase memory backend unification plan", () => {
  const scaffold = buildWorkflowPlanScaffold("memory-backend-unification", {
    cwd: "/tmp/workspace",
  });

  assert.equal(scaffold.plan.mode, "full");
  assert.equal(scaffold.plan.steps.length, 4);
  assert.equal(
    scaffold.outputPath,
    path.join("/tmp/workspace", WORKFLOW_PLANS_RELATIVE_DIR, "memory-backend-unification-plan.json")
  );
  assert.deepEqual(
    scaffold.plan.steps.filter((step) => step.needs_runtime).map((step) => step.id),
    ["v2-limits-compaction-and-hygiene", "multi-scope-recall-and-proof-gated-validation"]
  );
  assert.match(scaffold.plan.steps[0].acceptance, /legacy memory surfaces are inventoried/i);
});

test("workflow scaffold builds the Project Intelligence continuity layer plan", () => {
  const scaffold = buildWorkflowPlanScaffold("project-intelligence-continuity-layer", {
    cwd: "/tmp/workspace",
  });

  assert.equal(scaffold.plan.mode, "full");
  assert.equal(scaffold.plan.steps.length, 4);
  assert.match(scaffold.goal, /Project Intelligence and Continuity Layer/i);
  assert.equal(
    scaffold.outputPath,
    path.join(
      "/tmp/workspace",
      WORKFLOW_PLANS_RELATIVE_DIR,
      "project-intelligence-continuity-layer-plan.json"
    )
  );
  assert.deepEqual(
    scaffold.plan.steps.map((step) => step.id),
    [
      "memory-authority-and-health",
      "code-impact-and-verification",
      "continuity-brief-and-graph-summary",
      "release-docs-and-companion-surface",
    ]
  );
  assert.match(scaffold.plan.steps[1].query, /symbol cards, multi-hop impact graph/i);
  assert.ok(scaffold.plan.steps[3].gates.includes("release surface verification"));
});

test("managed workflow exposes compaction-safe commit summaries", () => {
  assert.equal(WORKFLOW_STATE_RELATIVE_PATH, ".snipara/workflow/current.json");
  assert.equal(
    buildWorkflowPhaseCommitSummary({
      workflowId: "auth-hardening",
      phase: { id: "context", title: "Load context" },
      summary: "Loaded Snipara context and verified impacted files.",
    }),
    [
      "Workflow auth-hardening",
      "Phase context: Load context",
      "Loaded Snipara context and verified impacted files.",
    ].join("\n")
  );
});

test("workflow phase-commit appends a journal checkpoint alongside durable memory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-workflow-phase-commit-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  fs.mkdirSync(path.join(dir, ".snipara", "workflow"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".snipara", "workflow", "current.json"),
    JSON.stringify(
      {
        schemaVersion: "snipara.workflow.v2",
        workflowId: "companion-journal",
        goal: "Write journal checkpoints",
        status: "active",
        currentPhaseId: "companion-journal-checkpoints",
        planSource: "inline",
        createdAt: "2026-05-29T08:00:00.000Z",
        updatedAt: "2026-05-29T08:00:00.000Z",
        phases: [
          {
            id: "companion-journal-checkpoints",
            title: "Companion Journal Checkpoints",
            query: "Add journal writes",
            status: "in_progress",
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );
  const preloadPath = writeWorkflowPreload(dir);
  const journalLog = path.join(dir, "workflow-journal.jsonl");

  const result = runCli(
    [
      "workflow",
      "phase-commit",
      "companion-journal-checkpoints",
      "--summary",
      "Added journal writes to workflow checkpoints",
      "--json",
    ],
    {
      cwd: dir,
      env: {
        SNIPARA_API_KEY: "snp-test",
        SNIPARA_PROJECT_ID: "project_1",
        SNIPARA_API_URL: "https://api.snipara.com",
        SNIPARA_SESSION_ID: "session_1",
        SNIPARA_AUTOMATION_CLIENT: "codex",
        SNIPARA_TEST_JOURNAL_LOG: journalLog,
      },
      nodeArgs: ["-r", preloadPath],
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.journal.status, "ok");
  const current = JSON.parse(
    fs.readFileSync(path.join(dir, ".snipara", "workflow", "current.json"), "utf8")
  );
  assert.equal(current.phases[0].status, "completed");
  const logged = fs
    .readFileSync(journalLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(logged.length, 1);
  assert.match(logged[0].text, /Checkpoint: workflow:phase-commit/);
  assert.match(logged[0].text, /Workflow: companion-journal/);
  assert.match(logged[0].text, /Outcome: completed/);
  assert.deepEqual(logged[0].tags, [
    "companion",
    "checkpoint",
    "workflow:phase-commit",
    "workflow",
    "phase",
    "outcome:completed",
  ]);
});

test("workflow phase-commit advances local state when hosted commit times out", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-workflow-phase-fallback-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  fs.mkdirSync(path.join(dir, ".snipara", "workflow"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".snipara", "workflow", "current.json"),
    JSON.stringify(
      {
        schemaVersion: "snipara.workflow.v2",
        workflowId: "companion-phase-fallback",
        goal: "Keep local workflow moving",
        status: "active",
        currentPhaseId: "verify",
        planSource: "inline",
        createdAt: "2026-05-29T08:00:00.000Z",
        updatedAt: "2026-05-29T08:00:00.000Z",
        phases: [
          {
            id: "verify",
            title: "Verify fallback",
            query: "Verify fallback",
            status: "in_progress",
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );
  const preloadPath = writeWorkflowPreload(dir);
  const journalLog = path.join(dir, "workflow-journal.jsonl");
  const teamSyncState = createEmptyTeamSyncState(new Date("2026-05-29T08:00:00.000Z"));
  teamSyncState.work.push(
    buildTeamSyncStartWorkRecord({
      summary: "Keep local workflow moving",
      files: ["packages/cli/src/commands/workflows.ts"],
      now: new Date("2026-05-29T08:05:00.000Z"),
    })
  );
  saveTeamSyncState(teamSyncState, dir);

  const result = runCli(
    [
      "workflow",
      "phase-commit",
      "verify",
      "--summary",
      "Verified local fallback after hosted timeout",
      "--json",
    ],
    {
      cwd: dir,
      env: {
        SNIPARA_API_KEY: "snp-test",
        SNIPARA_PROJECT_ID: "project_1",
        SNIPARA_API_URL: "https://api.snipara.com",
        SNIPARA_SESSION_ID: "session_1",
        SNIPARA_AUTOMATION_CLIENT: "codex",
        SNIPARA_TEST_JOURNAL_LOG: journalLog,
        SNIPARA_TEST_PHASE_COMMIT_TIMEOUT: "always",
      },
      nodeArgs: ["-r", preloadPath],
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.commit.hosted_phase_commit.status, "error");
  assert.equal(payload.commit.local_phase_commit.status, "local_fallback");
  assert.equal(payload.teamSyncCompletedWork.length, 1);
  assert.equal(payload.teamSyncCompletedWork[0].summary, "Keep local workflow moving");

  const current = JSON.parse(
    fs.readFileSync(path.join(dir, ".snipara", "workflow", "current.json"), "utf8")
  );
  assert.equal(current.status, "completed");
  assert.equal(current.phases[0].status, "completed");
  assert.equal(current.lastCommit.category, "workflow-phase");
  const teamSyncStateAfter = JSON.parse(
    fs.readFileSync(path.join(dir, ".snipara", "team-sync", "session.json"), "utf8")
  );
  assert.equal(teamSyncStateAfter.work[0].status, "completed");
  assert.match(
    teamSyncStateAfter.work[0].completionReason,
    /Workflow companion-phase-fallback completed after phase verify phase-commit/
  );

  const logged = fs
    .readFileSync(journalLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(logged.length, 1);
  assert.match(logged[0].text, /Verified local fallback after hosted timeout/);
});

test("workflow runtime-checkpoint records local context pack receipts without hosted auth", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-workflow-context-pack-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  writeWorkflowState(dir);
  const packed = packContext({
    cwd: dir,
    content: "runtime log output\nline 2\n",
    kind: "log",
    label: "runtime log",
    source: "sandbox validation",
    now: new Date("2026-06-19T08:45:00.000Z"),
  });

  const result = runCli(
    [
      "workflow",
      "runtime-checkpoint",
      "verify",
      "--summary",
      "Captured runtime log",
      "--context-pack",
      packed.record.id,
      "--json",
    ],
    { cwd: dir, env: { HOME: fs.mkdtempSync(path.join(os.tmpdir(), "snipara-workflow-home-")) } }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.runtime_checkpoint.contextPackReceipts.length, 1);
  assert.equal(payload.runtime_checkpoint.contextPackReceipts[0].pack_id, packed.record.id);
  assert.deepEqual(payload.runtime_checkpoint.artifacts, [`context-pack:${packed.record.id}`]);
  assert.equal(payload.hosted_event, null);

  const current = JSON.parse(
    fs.readFileSync(path.join(dir, ".snipara", "workflow", "current.json"), "utf8")
  );
  const checkpoint = current.runtime.sandbox.bindings[0].lastCheckpoint;
  assert.equal(checkpoint.contextPackReceipts[0].content_uploaded, false);
  assert.equal(
    JSON.stringify(checkpoint.contextPackReceipts).includes("runtime log output"),
    false
  );
});

test("final-commit surfaces the backend Team Sync handoff invariant", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-workflow-final-commit-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  writeWorkflowState(dir);
  const preloadPath = writeWorkflowPreload(dir);
  const commitLog = path.join(dir, "workflow-commit.jsonl");

  const result = runCli(
    [
      "final-commit",
      "--summary",
      "Closed the managed workflow",
      "--files",
      "packages/cli/src/commands/workflows.ts",
      "--json",
    ],
    {
      cwd: dir,
      env: {
        SNIPARA_API_KEY: "snp-test",
        SNIPARA_PROJECT_ID: "project_1",
        SNIPARA_API_URL: "https://api.snipara.com",
        SNIPARA_SESSION_ID: "session_1",
        SNIPARA_AUTOMATION_CLIENT: "codex",
        SNIPARA_TEST_COMMIT_LOG: commitLog,
      },
      nodeArgs: ["-r", preloadPath],
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.commit.team_sync_handoff.status, "created");
  assert.equal(payload.commit.team_sync_handoff.memory_id, "mem_handoff");

  const current = JSON.parse(
    fs.readFileSync(path.join(dir, ".snipara", "workflow", "current.json"), "utf8")
  );
  assert.equal(current.status, "completed");
  assert.equal(current.lastCommit.category, "final-commit");

  const logged = fs
    .readFileSync(commitLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(logged.length, 1);
  assert.equal(logged[0].category, "final-commit");
  assert.equal(logged[0].handoff_only, true);
  assert.deepEqual(logged[0].persist_types, []);
  assert.ok(logged[0].summary.length <= 1200);
  assert.deepEqual(logged[0].files_touched, ["packages/cli/src/commands/workflows.ts"]);
});

test("final-commit completes the matching local Team Sync work item", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-workflow-final-team-sync-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  writeWorkflowState(dir);
  const teamSyncState = createEmptyTeamSyncState(new Date("2026-05-31T10:00:00.000Z"));
  teamSyncState.work.push(
    buildTeamSyncStartWorkRecord({
      summary: "Ship companion continuity commands",
      files: ["packages/cli/src/commands/workflows.ts"],
      now: new Date("2026-05-31T10:05:00.000Z"),
    }),
    buildTeamSyncStartWorkRecord({
      summary: "Promote unrelated frontend release",
      files: ["apps/web/src/app/page.tsx"],
      now: new Date("2026-05-31T10:06:00.000Z"),
    })
  );
  saveTeamSyncState(teamSyncState, dir);
  const preloadPath = writeWorkflowPreload(dir);

  const result = runCli(
    [
      "final-commit",
      "--summary",
      "Closed the managed workflow",
      "--files",
      "packages/cli/src/commands/workflows.ts",
      "--json",
    ],
    {
      cwd: dir,
      env: {
        SNIPARA_API_KEY: "snp-test",
        SNIPARA_PROJECT_ID: "project_1",
        SNIPARA_API_URL: "https://api.snipara.com",
      },
      nodeArgs: ["-r", preloadPath],
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.teamSyncCompletedWork.length, 1);
  assert.equal(payload.teamSyncCompletedWork[0].summary, "Ship companion continuity commands");

  const loaded = JSON.parse(
    fs.readFileSync(path.join(dir, ".snipara", "team-sync", "session.json"), "utf8")
  );
  assert.equal(loaded.work[0].status, "completed");
  assert.match(loaded.work[0].completionReason, /Workflow agentic-work completed by final-commit/);
  assert.equal(loaded.work[1].status, "active");
});

test("final-commit keeps custom categories on the final handoff-only path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-workflow-final-category-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  writeWorkflowState(dir);
  const preloadPath = writeWorkflowPreload(dir);
  const commitLog = path.join(dir, "workflow-commit.jsonl");

  const result = runCli(
    [
      "final-commit",
      "--summary",
      "Closed the managed workflow for release handoff validation",
      "--category",
      "release",
      "--json",
    ],
    {
      cwd: dir,
      env: {
        SNIPARA_API_KEY: "snp-test",
        SNIPARA_PROJECT_ID: "project_1",
        SNIPARA_API_URL: "https://api.snipara.com",
        SNIPARA_SESSION_ID: "session_1",
        SNIPARA_AUTOMATION_CLIENT: "codex",
        SNIPARA_TEST_COMMIT_LOG: commitLog,
      },
      nodeArgs: ["-r", preloadPath],
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const current = JSON.parse(
    fs.readFileSync(path.join(dir, ".snipara", "workflow", "current.json"), "utf8")
  );
  assert.equal(current.lastCommit.category, "final-commit:release");

  const logged = fs
    .readFileSync(commitLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(logged.length, 1);
  assert.equal(logged[0].category, "final-commit:release");
  assert.equal(logged[0].handoff_only, true);
  assert.deepEqual(logged[0].persist_types, []);
});

test("final-commit writes local workflow and handoff fallback when hosted commit times out", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-workflow-final-fallback-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  writeWorkflowState(dir);
  const preloadPath = writeWorkflowPreload(dir);
  const commitLog = path.join(dir, "workflow-commit.jsonl");

  const result = runCli(
    [
      "final-commit",
      "--summary",
      "Closed the managed workflow after completing companion final commit timeout hardening.",
      "--files",
      "packages/cli/src/commands/workflows.ts",
      "--json",
    ],
    {
      cwd: dir,
      env: {
        SNIPARA_API_KEY: "snp-test",
        SNIPARA_PROJECT_ID: "project_1",
        SNIPARA_API_URL: "https://api.snipara.com",
        SNIPARA_SESSION_ID: "session_1",
        SNIPARA_AUTOMATION_CLIENT: "codex",
        SNIPARA_TEST_COMMIT_LOG: commitLog,
        SNIPARA_TEST_FINAL_COMMIT_TIMEOUT: "always",
      },
      nodeArgs: ["-r", preloadPath],
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.commit.team_sync_handoff.status, "local_fallback");
  assert.equal(payload.commit.hosted_final_commit.status, "error");
  assert.equal(payload.commit.hosted_final_commit.attempts.length, 2);

  const current = JSON.parse(
    fs.readFileSync(path.join(dir, ".snipara", "workflow", "current.json"), "utf8")
  );
  assert.equal(current.status, "completed");
  assert.equal(current.lastCommit.category, "final-commit");

  const teamSyncState = JSON.parse(
    fs.readFileSync(path.join(dir, ".snipara", "team-sync", "session.json"), "utf8")
  );
  assert.equal(teamSyncState.handoffs.length, 1);
  assert.equal(teamSyncState.handoffs[0].attention, "watch");
  assert.match(teamSyncState.handoffs[0].summary, /Closed the managed workflow/);

  const logged = fs
    .readFileSync(commitLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(logged.length, 2);
  assert.equal(logged[0].category, "final-commit");
  assert.equal(logged[0].handoff_only, true);
  assert.deepEqual(logged[0].persist_types, []);
  assert.ok(logged[0].summary.length <= 1200);
  assert.ok(logged[1].summary.length <= 600);
});

test("orchestrator recommendation escalates explicit proof and multi-agent intent", () => {
  const recommendation = getOrchestratorRecommendation(
    "Coordinate multi-agent rollout with proof gates and live validation",
    "full",
    { changedFilesCount: 6 }
  );

  assert.equal(recommendation.level, "confirm");
  assert.equal(recommendation.orchestratorRequired, true);
  assert.ok(recommendation.reasons.includes("multi_agent_intent"));
  assert.ok(recommendation.reasons.includes("proof_gate_intent"));
  assert.ok(recommendation.reasons.includes("changed_files_threshold"));
  assert.equal(
    formatOrchestratorRecommendationReason("team_sync_collision"),
    "Team Sync overlap or collision signals"
  );
});

test("orchestrator recommendation can be auto-routed by policy", () => {
  const recommendation = getOrchestratorRecommendation("Release validation", "full", {
    policyAutoRoute: true,
    policySource: "enterprise-proof-gates",
  });

  assert.equal(recommendation.level, "auto");
  assert.equal(recommendation.policySource, "enterprise-proof-gates");
  assert.equal(recommendation.orchestratorRequired, true);
});

test("orchestrator handoff artifact captures workflow and routing metadata", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-orchestrator-handoff-"));
  try {
    fs.mkdirSync(path.join(dir, ".snipara", "workflow"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".snipara", "workflow", "current.json"),
      JSON.stringify(
        {
          schemaVersion: "snipara.workflow.v2",
          workflowId: "companion-routing",
          goal: "Prepare orchestrator handoff",
          status: "active",
          currentPhaseId: "phase-3",
          planSource: "inline",
          createdAt: "2026-05-28T08:00:00.000Z",
          updatedAt: "2026-05-28T08:00:00.000Z",
          phases: [
            {
              id: "inventory-and-cutover-contract",
              title: "Inventory and cutover contract",
              query: "Map the remaining legacy memory surfaces",
              status: "completed",
              files: ["apps/web/src/lib/db/queries/agent-memory.ts"],
            },
            {
              id: "phase-3",
              title: "Companion handoff artifact",
              query: "Prepare the handoff artifact",
              status: "in_progress",
              files: ["packages/cli/src/commands/team-sync.ts"],
              acceptance: "Handoff metadata is complete",
              gates: ["proof-gate"],
              needsRuntime: true,
            },
          ],
          runtime: {
            sandbox: {
              provider: "snipara-sandbox",
              bindings: [
                {
                  phaseId: "phase-3",
                  sessionId: "sandbox_session_123",
                  boundAt: "2026-05-28T08:05:00.000Z",
                  bootstrapQuery: "Resume sandbox validation for handoff phase",
                  environment: "docker",
                  profile: "analysis",
                  artifacts: ["artifacts/memory-health.json"],
                  lastCheckpoint: {
                    summary: "Captured repeatable sandbox validation state",
                    capturedAt: "2026-05-28T08:20:00.000Z",
                    artifacts: ["artifacts/memory-health.json"],
                    contextPackReceipts: [
                      {
                        version: "snipara.context_pack.receipt.v1",
                        receipt_id: "cpack_0123456789abcdef:reference:2026-05-28T08:20:00.000Z",
                        pack_id: "cpack_0123456789abcdef",
                        operation: "reference",
                        content_uploaded: false,
                        policy_decision: "local_only",
                        privacy_level: "standard",
                        kind: "tool_output",
                        tags: [],
                        bytes: 42,
                        line_count: 2,
                        sensitive: false,
                        created_at: "2026-05-28T08:19:00.000Z",
                        local_ref: {
                          base_relative_path: ".snipara/context-pack",
                          manifest_relative_path:
                            ".snipara/context-pack/items/cpack_0123456789abcdef.json",
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const recommendation = getOrchestratorRecommendation(
      "Coordinate proof gate validation across multiple files",
      "full",
      { changedFilesCount: 6, hasActiveCollisions: true }
    );
    const artifact = buildOrchestratorHandoff({
      sourceCommand: "workflow run",
      recommendation,
      query: "Coordinate proof gate validation across multiple files",
      summary: "Prepare orchestrator handoff",
      rootDir: dir,
      changedFiles: ["packages/cli/src/commands/team-sync.ts"],
      workstreams: ["team-sync:resume"],
    });

    assert.equal(artifact.workflow.workflowId, "companion-routing");
    assert.equal(artifact.workflow.currentPhaseId, "phase-3");
    assert.equal(artifact.workflow.phases.length, 2);
    assert.equal(artifact.workflow.phases[1].needsRuntime, true);
    assert.equal(artifact.routing.level, "confirm");
    assert.equal(artifact.validation.requiresProofGate, true);
    assert.equal(artifact.validation.requiredEvidence[0].type, "proof");
    assert.deepEqual(artifact.repo.changedFiles, ["packages/cli/src/commands/team-sync.ts"]);
    assert.equal(artifact.runtime.sandbox.provider, "snipara-sandbox");
    assert.deepEqual(
      artifact.runtime.sandbox.phases.map((phase) => phase.phaseId),
      ["phase-3"]
    );
    assert.equal(artifact.runtime.sandbox.phases[0].hasCheckpoint, true);
    assert.equal(artifact.runtime.sandbox.phases[0].sessionId, "sandbox_session_123");
    assert.deepEqual(artifact.runtime.sandbox.phases[0].contextPacks, ["cpack_0123456789abcdef"]);

    const written = writeOrchestratorHandoff({
      sourceCommand: "workflow run",
      recommendation,
      query: "Coordinate proof gate validation across multiple files",
      summary: "Prepare orchestrator handoff",
      rootDir: dir,
      changedFiles: ["packages/cli/src/commands/team-sync.ts"],
    });

    assert.equal(written.relativePath, ORCHESTRATOR_HANDOFF_RELATIVE_PATH);
    assert.match(written.command, /^snipara-orchestrator agents coordinate --plan /);
    assert.equal(fs.existsSync(path.join(dir, ORCHESTRATOR_HANDOFF_RELATIVE_PATH)), true);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(dir, ORCHESTRATOR_HANDOFF_RELATIVE_PATH), "utf8")
    );
    assert.equal(persisted.schemaVersion, "snipara.orchestrator.handoff.v1");
    assert.deepEqual(persisted.memory.decisionIds, ["DEC-002"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("adaptive work routing handoff remains recommendation-only and local-capable", () => {
  const recommendation = getOrchestratorRecommendation("Coordinate local worker coding", "full", {
    changedFilesCount: 1,
  });
  const adaptiveRouting = buildAdaptiveWorkRoutingRecommendation({
    query: "Reason with the main agent, then let a local worker code the docs update",
    mode: "full",
    changedFiles: ["docs/roadmap.md"],
    preferredEndpointTypes: ["local"],
    workerRole: "coding",
  });

  const artifact = buildOrchestratorHandoff({
    sourceCommand: "workflow run",
    recommendation,
    query: "Coordinate local worker coding",
    summary: "Prepare local worker handoff",
    changedFiles: ["docs/roadmap.md"],
    adaptiveRouting,
  });

  assert.equal(artifact.routing.workProfile.taskType, "documentation");
  assert.equal(artifact.routing.requirements.workerRole, "coding");
  assert.equal(artifact.routing.requirements.plannerRetainsReasoning, true);
  assert.deepEqual(artifact.routing.requirements.preferredEndpointTypes, ["local"]);
  assert.deepEqual(artifact.routing.requirements.writeScope, ["docs/roadmap.md"]);
  assert.equal(artifact.routing.routingCard.mode, "dry_run");
  assert.equal(artifact.routing.routingCard.humanApprovalRequired, true);
  assert.equal(artifact.routing.routingCard.fallback, "main_agent");
  assert.match(
    artifact.routing.routingCard.reasons.join(" "),
    /runtime catalog resolution remains delegated to snipara-orchestrator/
  );
  assert.doesNotMatch(JSON.stringify(artifact.routing), /api[_-]?key|secret value/i);
});

test("workflow run emits adaptive routing dry-run metadata into orchestrator handoff", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-adaptive-routing-run-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
    fs.mkdirSync(path.join(dir, ".snipara", "workflow"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".snipara", "workflow", "current.json"),
      JSON.stringify(
        {
          schemaVersion: "snipara.workflow.v2",
          workflowId: "adaptive-routing-cli",
          goal: "Prepare adaptive routing handoff",
          status: "active",
          currentPhaseId: "docs-worker",
          planSource: "inline",
          createdAt: "2026-06-18T21:30:00.000Z",
          updatedAt: "2026-06-18T21:30:00.000Z",
          phases: [
            {
              id: "docs-worker",
              title: "Docs worker",
              query: "Update docs through a scoped worker",
              status: "in_progress",
              files: ["docs/roadmap.md"],
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    );

    const preloadPath = writeWorkflowPreload(dir);
    const result = runCli(
      [
        "workflow",
        "run",
        "--mode",
        "standard",
        "--query",
        "Reason with the main planner then use a local worker for a docs update",
        "--adaptive-routing-dry-run",
        "--route-local-workers",
        "--routing-worker-role",
        "coding",
        "--emit-orchestrator-handoff",
        "--json",
      ],
      {
        cwd: dir,
        env: {
          SNIPARA_API_KEY: "snp-test",
          SNIPARA_PROJECT_ID: "project_1",
          SNIPARA_API_URL: "https://api.snipara.com",
        },
        nodeArgs: ["-r", preloadPath],
      }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.adaptive_routing.requirements.workerRole, "coding");
    assert.equal(payload.adaptive_routing.requirements.plannerRetainsReasoning, true);
    assert.deepEqual(payload.adaptive_routing.requirements.preferredEndpointTypes, ["local"]);
    assert.deepEqual(payload.adaptive_routing.requirements.writeScope, ["docs/roadmap.md"]);
    assert.equal(payload.adaptive_routing.gateway.source, "hosted_mcp");
    assert.equal(payload.adaptive_routing.gateway.success, true);
    assert.equal(payload.adaptive_routing.gateway.candidateCount, 1);
    assert.equal(payload.adaptive_routing.runtimeCatalog.candidates[0].candidateId, "local-docs");
    assert.equal(payload.orchestrator_handoff.relativePath, ORCHESTRATOR_HANDOFF_RELATIVE_PATH);
    assert.equal(
      payload.orchestrator_handoff.handoff.routing.routingCard.recommendedWorkerClass,
      "coding"
    );

    const persisted = JSON.parse(
      fs.readFileSync(path.join(dir, ORCHESTRATOR_HANDOFF_RELATIVE_PATH), "utf8")
    );
    assert.equal(persisted.routing.workProfile.taskType, "documentation");
    assert.equal(persisted.routing.routingCard.humanApprovalRequired, true);
    assert.equal(persisted.routing.gateway.candidateCount, 1);
    assert.equal(persisted.routing.runtimeCatalog.candidates[0].endpointType, "local");
    assert.match(
      persisted.routing.routingCard.warnings.join(" "),
      /companion does not launch or claim workers/
    );
    assert.doesNotMatch(JSON.stringify(persisted.routing), /api[_-]?key|secret value/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workflow run applies project adaptive routing catalog policy", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-adaptive-routing-policy-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
    fs.mkdirSync(path.join(dir, ".snipara", "workflow"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".snipara", "workflow", "current.json"),
      JSON.stringify(
        {
          schemaVersion: "snipara.workflow.v2",
          workflowId: "adaptive-routing-policy",
          goal: "Prepare adaptive routing handoff",
          status: "active",
          currentPhaseId: "docs-worker",
          planSource: "inline",
          createdAt: "2026-06-18T21:30:00.000Z",
          updatedAt: "2026-06-18T21:30:00.000Z",
          phases: [
            {
              id: "docs-worker",
              title: "Docs worker",
              query: "Update docs through a scoped worker",
              status: "in_progress",
              files: ["docs/roadmap.md"],
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    );

    const preloadPath = writeWorkflowPreload(dir);
    const result = runCli(
      [
        "workflow",
        "run",
        "--mode",
        "standard",
        "--query",
        "Reason with the main planner then use a local worker for a docs update",
        "--emit-orchestrator-handoff",
        "--json",
      ],
      {
        cwd: dir,
        env: {
          SNIPARA_API_KEY: "snp-test",
          SNIPARA_PROJECT_ID: "project_1",
          SNIPARA_API_URL: "https://api.snipara.com",
          SNIPARA_TEST_AUTOMATION_SETTINGS: JSON.stringify({
            adaptiveRoutingMode: "catalog",
            adaptiveRoutingRequireApproval: true,
            adaptiveRoutingPlannerRetainsReasoning: true,
            adaptiveRoutingPreferLocalWorkers: true,
            adaptiveRoutingAllowedEndpointTypes: ["cloud", "local"],
            adaptiveRoutingPreferredEndpointTypes: ["local"],
            adaptiveRoutingAllowedWorkerClasses: ["documentation", "tests", "review"],
            adaptiveRoutingFallback: "main_agent",
            adaptiveRoutingDailyBudgetCents: 500,
            adaptiveRoutingMonthlyBudgetCents: 2000,
          }),
        },
        nodeArgs: ["-r", preloadPath],
      }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.adaptive_routing.requirements.workerRole, "documentation");
    assert.equal(payload.adaptive_routing.requirements.plannerRetainsReasoning, true);
    assert.deepEqual(payload.adaptive_routing.requirements.allowedEndpointTypes, [
      "cloud",
      "local",
    ]);
    assert.deepEqual(payload.adaptive_routing.requirements.preferredEndpointTypes, ["local"]);
    assert.equal(payload.adaptive_routing.requirements.catalogLimit, 20);
    assert.equal(payload.adaptive_routing.requirements.dailyBudgetCents, 500);
    assert.equal(payload.adaptive_routing.requirements.monthlyBudgetCents, 2000);
    assert.equal(payload.adaptive_routing.gateway.success, true);
    assert.equal(payload.adaptive_routing.gateway.candidateCount, 1);
    assert.match(
      payload.adaptive_routing.routingCard.reasons.join(" "),
      /project adaptive routing policy mode is catalog/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workflow run uses local adaptive routing policy without hosted configuration", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-adaptive-routing-local-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
    fs.mkdirSync(path.join(dir, ".snipara", "workflow"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".snipara", "workflow", "current.json"),
      JSON.stringify(
        {
          schemaVersion: "snipara.workflow.v2",
          workflowId: "adaptive-routing-local",
          goal: "Prepare local adaptive routing handoff",
          status: "active",
          currentPhaseId: "docs-worker",
          planSource: "inline",
          createdAt: "2026-06-18T21:30:00.000Z",
          updatedAt: "2026-06-18T21:30:00.000Z",
          phases: [
            {
              id: "docs-worker",
              title: "Docs worker",
              query: "Update docs through a scoped worker",
              status: "in_progress",
              files: ["docs/roadmap.md"],
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    );
    fs.writeFileSync(
      path.join(dir, ".snipara", "adaptive-routing.json"),
      JSON.stringify(
        {
          mode: "catalog",
          plannerRetainsReasoning: true,
          preferLocalWorkers: true,
          allowedEndpointTypes: ["local", "cloud"],
          preferredEndpointTypes: ["local"],
          allowedWorkerClasses: ["documentation", "tests", "review"],
          catalogLimit: 8,
        },
        null,
        2
      ),
      "utf8"
    );

    const result = runCli(
      [
        "workflow",
        "run",
        "--mode",
        "standard",
        "--query",
        "Reason with the main planner then use a local worker for a docs update",
        "--emit-orchestrator-handoff",
        "--json",
      ],
      { cwd: dir }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.local_only, true);
    assert.equal(payload.context, undefined);
    assert.equal(payload.adaptive_routing.gateway, undefined);
    assert.equal(payload.adaptive_routing.requirements.workerRole, "documentation");
    assert.equal(payload.adaptive_routing.requirements.catalogLimit, 8);
    assert.deepEqual(payload.adaptive_routing.requirements.preferredEndpointTypes, ["local"]);
    assert.match(
      payload.adaptive_routing.routingCard.warnings.join(" "),
      /hosted catalog lookup is skipped without Snipara configuration/
    );
    assert.equal(payload.orchestrator_handoff.relativePath, ORCHESTRATOR_HANDOFF_RELATIVE_PATH);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workflow run treats missing adaptive catalog success as fail-closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-adaptive-routing-strict-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
    fs.mkdirSync(path.join(dir, ".snipara", "workflow"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".snipara", "workflow", "current.json"),
      JSON.stringify(
        {
          schemaVersion: "snipara.workflow.v2",
          workflowId: "adaptive-routing-strict",
          goal: "Prepare adaptive routing handoff",
          status: "active",
          currentPhaseId: "docs-worker",
          planSource: "inline",
          createdAt: "2026-06-18T21:30:00.000Z",
          updatedAt: "2026-06-18T21:30:00.000Z",
          phases: [
            {
              id: "docs-worker",
              title: "Docs worker",
              query: "Update docs through a scoped worker",
              status: "in_progress",
              files: ["docs/roadmap.md"],
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    );

    const preloadPath = writeWorkflowPreload(dir);
    const result = runCli(
      [
        "workflow",
        "run",
        "--mode",
        "standard",
        "--query",
        "Use adaptive routing for documentation",
        "--adaptive-routing-dry-run",
        "--emit-orchestrator-handoff",
        "--json",
      ],
      {
        cwd: dir,
        env: {
          SNIPARA_API_KEY: "snp-test",
          SNIPARA_PROJECT_ID: "project_1",
          SNIPARA_API_URL: "https://api.snipara.com",
          SNIPARA_TEST_ADAPTIVE_CATALOG_RESPONSE: JSON.stringify({
            catalog: {
              version: "test.catalog.v1",
              candidates: [
                {
                  candidateId: "local-docs",
                  workerClass: "documentation",
                  endpointType: "local",
                  capabilities: ["docs"],
                  isAvailable: true,
                },
              ],
            },
            resolution: {
              status: "candidate_catalog",
              candidate_count: 1,
              fallback: "main_agent",
            },
          }),
        },
        nodeArgs: ["-r", preloadPath],
      }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.adaptive_routing.gateway.success, false);
    assert.equal(payload.adaptive_routing.gateway.candidateCount, 1);
    assert.match(
      payload.adaptive_routing.routingCard.warnings.join(" "),
      /did not return success=true/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("orchestrator handoff preserves policy source when auto-routed", () => {
  const recommendation = getOrchestratorRecommendation("Release validation", "full", {
    policyAutoRoute: true,
    policySource: "enterprise-proof-gates",
  });

  const artifact = buildOrchestratorHandoff({
    sourceCommand: "workflow run",
    recommendation,
    query: "Release validation",
    summary: "Policy auto-route",
  });

  assert.equal(artifact.routing.level, "auto");
  assert.equal(artifact.routing.policySource, "enterprise-proof-gates");
});

test("memory guard detects publishable npm and PyPI release surfaces generically", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-memory-guard-"));
  try {
    fs.mkdirSync(path.join(dir, "packages", "cli", "src"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "packages", "cli", "package.json"),
      JSON.stringify({ name: "example-cli", version: "1.2.3" }),
      "utf8"
    );
    fs.writeFileSync(path.join(dir, "packages", "cli", "src", "index.ts"), "", "utf8");

    fs.mkdirSync(path.join(dir, "python", "lib", "src"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "python", "lib", "pyproject.toml"),
      ["[project]", 'name = "example-py"', 'version = "0.4.0"', ""].join("\n"),
      "utf8"
    );
    fs.writeFileSync(path.join(dir, "python", "lib", "src", "module.py"), "", "utf8");

    fs.mkdirSync(path.join(dir, "apps", "web"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "apps", "web", "package.json"),
      JSON.stringify({ name: "private-web", version: "1.0.0", private: true }),
      "utf8"
    );

    const surfaces = detectReleaseSurfacesFromFiles(dir, [
      "packages/cli/src/index.ts",
      "python/lib/src/module.py",
      "apps/web/package.json",
    ]);

    assert.deepEqual(
      surfaces.map((surface) => `${surface.ecosystem}:${surface.name}@${surface.version}`),
      ["npm:example-cli@1.2.3", "pypi:example-py@0.4.0"]
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("memory guard normalizes guard tags into memory categories", () => {
  assert.equal(normalizeGuardTag("guard:pre-commit"), "pre-commit");
  assert.equal(normalizeGuardTag(" commit "), "commit");
});

test("memory guard treats explicit failure triggers and npm E-codes as failures", async () => {
  const result = await runMemoryGuardCheck({
    trigger: "failure",
    command: "npm publish --auth-type=web",
    result: "npm E404 on web auth challenge",
    strict: true,
    includeContext: false,
    recentFailures: false,
  });

  assert.equal(result.triggered, true);
  assert.equal(result.shouldBlock, true);
  assert.equal(result.findings[0].code, "recent_failure");
});

test("memory guard always recalls workflow policy for commit-like gates", async () => {
  const result = await runMemoryGuardCheck({
    trigger: "commit",
    includeContext: false,
    recentFailures: false,
  });

  assert.equal(result.triggered, false);
  assert.ok(result.categories.includes("workflow-policy"));
});
