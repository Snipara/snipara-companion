const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildJournalCheckpointEntry,
  buildAgenticTimeline,
  buildAgenticWorkStatus,
  buildOrchestratorHandoff,
  buildWorkflowPlanScaffold,
  buildWorkflowPhaseCommitSummary,
  createClient,
  detectReleaseSurfacesFromFiles,
  formatOrchestratorRecommendationReason,
  getPlanStepDisplayTitle,
  getOrchestratorRecommendation,
  normalizeGuardTag,
  ORCHESTRATOR_HANDOFF_RELATIVE_PATH,
  normalizeWorkflowPlanInput,
  runMemoryGuardCheck,
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
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      statusText: 'OK',",
      "      json: async () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } }),",
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

  const current = JSON.parse(
    fs.readFileSync(path.join(dir, ".snipara", "workflow", "current.json"), "utf8")
  );
  assert.equal(current.status, "completed");
  assert.equal(current.phases[0].status, "completed");
  assert.equal(current.lastCommit.category, "workflow-phase");

  const logged = fs
    .readFileSync(journalLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(logged.length, 1);
  assert.match(logged[0].text, /Verified local fallback after hosted timeout/);
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
