const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildJournalCheckpointEntry,
  appendActivityEvent,
  buildAdaptiveWorkRoutingRecommendation,
  buildAgenticTimeline,
  buildAgenticWorkStatus,
  buildSessionSnapshot,
  buildGeneratedWorkflowPlanDocument,
  buildFinalCommitReport,
  buildSessionBootstrapQuality,
  buildTeamSyncStartWorkRecord,
  buildWorkflowImpactGate,
  buildOrchestratorHandoff,
  buildWorkflowPlanScaffold,
  buildWorkflowPhaseCommitSummary,
  buildSessionBootstrapBrief,
  createEmptyTeamSyncState,
  createClient,
  detectReleaseSurfacesFromFiles,
  formatOrchestratorRecommendationReason,
  formatFinalCommitReport,
  getPlanStepDisplayTitle,
  getOrchestratorRecommendation,
  MEMORY_GUARD_CONTEXT_TIMEOUT_MS,
  MEMORY_GUARD_RECALL_TIMEOUT_MS,
  normalizeGuardTag,
  ORCHESTRATOR_HANDOFF_RELATIVE_PATH,
  normalizeWorkflowPlanInput,
  packContext,
  PRODUCER_LOOP_ARTIFACT_VERSION,
  PRODUCER_LOOP_REPORT_VERSION,
  PRODUCER_LOOP_RELATIVE_DIR,
  FINAL_COMMIT_REPORT_RELATIVE_PATH,
  FINAL_COMMIT_REPORT_VERSION,
  resolveAutoWorkflowMode,
  resolveFullWorkflowTokenBudget,
  validatePlanResult,
  runMemoryGuardCheck,
  readActivityTimeline,
  saveTeamSyncState,
  WORKFLOW_PLANS_RELATIVE_DIR,
  WORKFLOW_STATE_RELATIVE_PATH,
  writeOrchestratorHandoff,
  writeSessionSnapshot,
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

  const isLocalWorkerCommand = args.includes("workers") && args.includes("local");
  if (isLocalWorkerCommand && !Object.prototype.hasOwnProperty.call(env, "SNIPARA_WORKSPACE_DIR")) {
    const workspaceDir = options.cwd
      ? path.resolve(options.cwd)
      : fs.mkdtempSync(path.join(os.tmpdir(), "snipara-cli-test-"));
    env.SNIPARA_WORKSPACE_DIR = workspaceDir;
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

function stableTestJson(value) {
  if (Array.isArray(value)) {
    return value.map(stableTestJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableTestJson(child)])
    );
  }
  return value;
}

function stableTestJsonStringify(value) {
  return JSON.stringify(stableTestJson(value), null, 2);
}

function writeWorkflowPreload(dir) {
  const preloadPath = path.join(dir, "workflow-preload.js");
  fs.writeFileSync(
    preloadPath,
    [
      "const fs = require('node:fs');",
      "const childProcess = require('node:child_process');",
      "const originalExecFileSync = childProcess.execFileSync;",
      "childProcess.execFileSync = (command, args, options) => {",
      "  if (command === 'snipara-orchestrator') {",
      "    const argsLogPath = process.env.SNIPARA_TEST_ORCHESTRATOR_ARGS_LOG;",
      "    if (argsLogPath) {",
      "      fs.appendFileSync(argsLogPath, `${JSON.stringify({ command, args })}\\n`, 'utf8');",
      "    }",
      "    const subcommand = Array.isArray(args) ? args[0] : undefined;",
      "    if (subcommand === 'local-model-catalog' && process.env.SNIPARA_TEST_LOCAL_ORCHESTRATOR_CATALOG_RESPONSE) {",
      "      return process.env.SNIPARA_TEST_LOCAL_ORCHESTRATOR_CATALOG_RESPONSE;",
      "    }",
      "    if (subcommand === 'route' && process.env.SNIPARA_TEST_LOCAL_ORCHESTRATOR_ROUTE_RESPONSE) {",
      "      return process.env.SNIPARA_TEST_LOCAL_ORCHESTRATOR_ROUTE_RESPONSE;",
      "    }",
      "  }",
      "  return originalExecFileSync(command, args, options);",
      "};",
      "let endOfTaskCommitAttempts = 0;",
      "globalThis.fetch = async (url, init = {}) => {",
      "  const parsedUrl = new URL(String(url));",
      "  const pathname = parsedUrl.pathname;",
      "  if (pathname.includes('/mcp/')) {",
      "    const body = JSON.parse(init.body || '{}');",
      "    const toolName = body.params?.name;",
      "    const toolLogPath = process.env.SNIPARA_TEST_TOOL_LOG;",
      "    if (toolLogPath && toolName) {",
      "      fs.appendFileSync(toolLogPath, `${toolName}\\n`, 'utf8');",
      "    }",
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
      "      const commitResult = { success: true, stored: true, stored_candidates: [], skipped_candidates: [] };",
      "      if (commitArgs.category === 'final-commit') {",
      "        commitResult.team_sync_handoff = { status: 'created', memory_id: 'mem_handoff' };",
      "      } else {",
      "        commitResult.stored_candidates = [{ text: 'Keep phase decisions attributable to their workflow receipts', memory_type: 'decision', category: commitArgs.category, stored: true, memory_id: 'mem_phase_decision', reason: 'stored' }];",
      "        commitResult.skipped_candidates = [{ text: 'Ran a transient local inspection', memory_type: 'context', reason: 'operational_receipt' }];",
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
      "    if (toolName === 'snipara_session_memories') {",
      "      const sessionMemories = process.env.SNIPARA_TEST_SESSION_MEMORIES ? JSON.parse(process.env.SNIPARA_TEST_SESSION_MEMORIES) : { critical: { memories: [], count: 0, tokens: 0 }, daily: { memories: [], count: 0, tokens: 0 }, total_tokens: 0 };",
      "      return {",
      "        ok: true,",
      "        status: 200,",
      "        statusText: 'OK',",
      "        json: async () => ({",
      "          jsonrpc: '2.0',",
      "          id: 1,",
      "          result: { content: [{ type: 'text', text: JSON.stringify(sessionMemories) }] },",
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
      "  const body = init.body ? JSON.parse(init.body) : {};",
      "  const collaborationLogPath = process.env.SNIPARA_TEST_COLLAB_LOG;",
      "  if (collaborationLogPath && pathname.includes('/collaboration/')) {",
      "    fs.appendFileSync(collaborationLogPath, `${JSON.stringify({ pathname, method: init.method, body })}\\n`, 'utf8');",
      "  }",
      "  const teamSyncLogPath = process.env.SNIPARA_TEST_TEAM_SYNC_LOG;",
      "  if (teamSyncLogPath && pathname.includes('/team-sync/')) {",
      "    fs.appendFileSync(teamSyncLogPath, `${JSON.stringify({ pathname, method: init.method, body })}\\n`, 'utf8');",
      "  }",
      "  if (pathname.endsWith('/agents/memory/why-capture') && init.method === 'POST') {",
      "    const whyCaptureLogPath = process.env.SNIPARA_TEST_WHY_CAPTURE_LOG;",
      "    if (whyCaptureLogPath) {",
      "      fs.appendFileSync(whyCaptureLogPath, `${JSON.stringify(body)}\\n`, 'utf8');",
      "    }",
      "    const candidate = { content: 'Decision: Preserve review-first final commit reporting. Why: Pending rationale must never be shown as approved memory.', type: 'DECISION', category: 'why-capture', whyFields: { decision: 'Preserve review-first final commit reporting', why: 'Pending rationale must never be shown as approved memory' } };",
      "    const memory = { id: 'mem_pending_why', content: candidate.content, type: 'DECISION', category: 'why-capture', reviewStatus: 'PENDING' };",
      "    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ success: true, data: { previewOnly: body.previewOnly === true, confirmed: body.confirmed === true, candidateCount: 1, candidates: [candidate], ...(body.confirmed ? { capturedCount: 1, memories: [memory], decisionCapture: { createdCount: 1, duplicateCount: 0, failedCount: 0, created: [{ id: 'decision_pending_1' }], duplicates: [], failed: [] } } : {}) } }) };",
      "  }",
      "  const project = { id: 'project_1', name: 'App', slug: 'app' };",
      "  if (pathname.endsWith('/collaboration/sessions') && init.method === 'POST') {",
      "    const resources = [...(body.resources || []), ...(body.files || []).map((file) => ({ kind: 'FILE', id: file, sourcePath: file }))];",
      "    return { ok: true, status: 201, statusText: 'Created', json: async () => ({ success: true, data: { project, session: { id: body.workSessionId || 'workflow:test', actorId: body.actorId || 'agent_1', actorType: body.actorType || 'AGENT', actorLabel: body.actorLabel || 'Codex', sessionId: body.sessionId || 'session_1', client: body.client || 'snipara-companion', repository: body.repository || 'acme/app', branch: body.branch || 'dev', task: body.task || null, status: 'ACTIVE', dirtyFiles: body.files || [], startedAt: '2026-06-09T12:00:00.000Z', lastHeartbeatAt: '2026-06-09T12:00:00.000Z' }, resources } }) };",
      "  }",
      "  if (pathname.endsWith('/collaboration/leases') && init.method === 'POST') {",
      "    const resources = [...(body.resources || []), ...(body.files || []).map((file) => ({ kind: 'FILE', id: file, sourcePath: file }))];",
      "    return { ok: true, status: 201, statusText: 'Created', json: async () => ({ success: true, data: { project, resources, leases: resources.map((resource, index) => ({ id: `lease_${index + 1}`, workSessionId: body.workSessionId || 'workflow:test', resourceKind: resource.kind, resourceId: resource.id, resourceLabel: resource.label || null, mode: body.mode || 'ADVISORY', status: 'ACTIVE', claimedByActorId: body.actorId || 'agent_1', claimedByActorType: body.actorType || 'AGENT', claimedByLabel: body.actorLabel || 'Codex', reason: body.reason || null, claimedAt: '2026-06-09T12:01:00.000Z', heartbeatAt: '2026-06-09T12:01:00.000Z', expiresAt: body.ttlSeconds ? '2099-06-09T16:01:00.000Z' : null })) } }) };",
      "  }",
      "  if (pathname.includes('/collaboration/leases/') && init.method === 'PATCH') {",
      "    const leaseId = pathname.split('/').pop();",
      "    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ success: true, data: { project, lease: { id: leaseId, resourceKind: 'FILE', resourceId: 'packages/cli/src/index.ts', mode: 'ADVISORY', status: 'RELEASED', claimedByActorId: 'agent_1', claimedByActorType: 'AGENT' } } }) };",
      "  }",
      "  if (pathname.endsWith('/team-sync/work-briefs') && init.method === 'POST') {",
      "    return { ok: true, status: 201, statusText: 'Created', json: async () => ({ success: true, data: { project, brief: { id: 'brief_1', task: body.task || 'workflow', generatedAt: '2026-06-09T12:00:00.000Z', evidenceLevel: 'hosted', activeCollisions: [], staleAssumptions: [], failedJobs: [], recommendedActions: ['Continue workflow'] }, whatChanged: { generatedAt: '2026-06-09T12:00:00.000Z', changes: [], decisions: [], nextActions: [], recommendedActions: ['Continue workflow'], summary: { changeCount: 0, decisionChanges: 0, staleAssumptions: 0, failedJobs: 0, overlapClusters: 0 } } } }) };",
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
        phaseCommitReceipts: [
          {
            phaseId: "build",
            capturedAt: "2026-05-31T10:20:00.000Z",
            category: "workflow-phase",
            outcome: "completed",
            hostedStatus: "processed",
            stored: [
              {
                memoryId: "mem_kept_decision",
                text: "Keep final commit handoff-only",
                type: "decision",
                category: "workflow-phase",
                source: "phase_commit",
                phaseId: "build",
              },
            ],
            skipped: [
              {
                text: "Ran one transient command",
                type: "context",
                reason: "operational_receipt",
                source: "phase_commit",
                phaseId: "build",
              },
            ],
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

function writePendingDecisionRequest(dir, requestId = "decision-operational-loop") {
  const pendingDir = path.join(dir, ".snipara", "decisions", "pending");
  fs.mkdirSync(pendingDir, { recursive: true });
  const request = {
    schemaVersion: "snipara.decision_request.v0",
    requestId,
    fingerprint: `${requestId}-fingerprint`,
    createdAt: "2026-05-31T10:45:00.000Z",
    producer: {
      kind: "project_policy_review",
      command: "run --emit-policy-decisions",
      sourceRef: "policy:operational-loop",
    },
    decision: "review_policy_findings",
    question: "Review policy findings before closing the workflow phase?",
    blocking: false,
    expiresAt: null,
    evidence: {
      summary: "Policy review should be resolved before closure.",
      refs: ["policy:operational-loop"],
      items: [
        {
          ref: "policy:operational-loop",
          title: "Policy review",
          summary: "Review policy findings before phase closure.",
          kind: "project_policy_review",
        },
      ],
      reasonCodes: ["project_policy_review"],
      applyPath: "manual_project_policy_review",
      applyCommand: "Resolve with snipara-companion workflow decide.",
    },
    options: ["accept", "reject", "keep_pending"],
    recommendation: "keep_pending",
    rationale: "Policy administration stays review-only.",
  };
  fs.writeFileSync(
    path.join(pendingDir, `${request.requestId}.json`),
    `${stableTestJsonStringify(request)}\n`,
    "utf8"
  );
  return request;
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

test("final-commit help exposes structured closeout inputs", () => {
  for (const args of [
    ["final-commit", "--help"],
    ["workflow", "final-commit", "--help"],
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /--why/);
    assert.match(result.stdout, /--evidence/);
    assert.match(result.stdout, /--risk/);
    assert.match(result.stdout, /--next-step/);
  }
});

test("agentic status summarizes workflow, git, and Team Sync state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-agentic-status-"));
  writeWorkflowState(dir);
  writeTeamSyncState(dir);
  writePendingDecisionRequest(dir);

  const status = buildAgenticWorkStatus(dir);

  assert.equal(status.version, "snipara.agentic_status.v1");
  assert.equal(status.workflow.id, "agentic-work");
  assert.equal(status.workflow.currentPhase.id, "verify");
  assert.equal(status.workflow.lastPhaseCommit.phaseId, "build");
  assert.equal(status.teamSync.handoffCount, 1);
  assert.equal(status.teamSync.latestHandoff.summary, "Status command ready");
  assert.ok(status.risks.some((risk) => risk.includes("proof")));
  assert.equal(status.openDecisions.count, 1);
  assert.equal(status.operationalLoop.status, "attention");
  assert.equal(status.operationalLoop.decisionRequestCount, 1);
  assert.ok(status.operationalLoop.receiptGapCount >= 1);
  assert.ok(
    status.operationalLoop.nextActions.some((action) => action.includes("Decision Request"))
  );
  assert.ok(
    status.operationalLoop.receiptActions.some((action) =>
      action.includes("outcome-capture preview --emit-outcome-receipt")
    )
  );
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

test("workflow timeline exports redacted markdown", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-timeline-md-"));
  writeWorkflowState(dir);
  appendActivityEvent({
    cwd: dir,
    source: "workflow",
    kind: "phase-commit",
    title: `Verified ${dir}/packages/cli/src/index.ts`,
    summary: "token=secret-value should be redacted",
    files: [path.join(dir, "packages/cli/src/index.ts"), ".snipara/activity/session.json"],
    timestamp: "2026-07-02T21:30:00.000Z",
  });

  const result = runCli(["workflow", "timeline", "--export", "md", "--limit", "3"], { cwd: dir });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# Workflow Timeline/);
  assert.match(result.stdout, /\[workspace\]/);
  assert.match(result.stdout, /\[local-state\]/);
  assert.match(result.stdout, /token=\[redacted\]/);
  assert.doesNotMatch(result.stdout, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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

test("session bootstrap brief prioritizes recent high-signal carryover over stale critical trivia", () => {
  const brief = buildSessionBootstrapBrief(
    {
      critical: {
        memories: [
          {
            id: "old_env",
            type: "FACT",
            category: "configuration",
            content:
              "Symlinked .env files structure: /Users/alopez/Devs/Snipara/.env is the source of truth.",
            confidence: 0.23,
            created_at: "2026-02-06T11:55:45.516Z",
          },
          {
            id: "old_tooltip",
            type: "DECISION",
            category: "ui",
            content:
              "InfoTooltip component created at apps/web/src/components/ui/info-tooltip.tsx.",
            confidence: 0.2,
            created_at: "2026-01-26T08:49:04.656Z",
          },
        ],
        count: 2,
        tokens: 300,
      },
      daily: {
        memories: [
          {
            id: "today_final",
            type: "CONTEXT",
            category: "journal:2026-07-03",
            content:
              "Checkpoint: workflow:final-commit. Implemented and released true Control Plane Lite lifecycle. Companion now routes --mode auto by intent, LITE has zero mandatory Snipara calls, and snipara-companion@3.2.7 is published.",
            confidence: 1,
            created_at: "2026-07-03T20:11:10.540Z",
          },
        ],
        count: 1,
        tokens: 120,
      },
      total_tokens: 420,
    },
    {
      includeSessionContext: true,
      maxTokens: 120,
      now: new Date("2026-07-03T20:30:00.000Z"),
    }
  );

  assert.equal(brief.entries[0]?.id, "today_final");
  assert.notEqual(brief.entries[0]?.id, "old_env");
  assert.ok(brief.estimatedTokens <= brief.budgetTokens);
});

test("session bootstrap brief reserves old project and owner profiles and drops generic stale memory", () => {
  const projectProfile = {
    id: "project_profile",
    type: "FACT",
    category: "tenant_profile",
    content: "Project constitution: ship verified context optimization without owning inference.",
    confidence: 1,
    created_at: "2025-01-01T00:00:00.000Z",
  };
  const ownerProfile = {
    id: "owner_profile",
    type: "PREFERENCE",
    category: "owner_operating_profile",
    content:
      "Owner operating profile: prefers concise evidence-first updates and end-to-end release proof.",
    confidence: 1,
    created_at: "2025-01-01T00:00:00.000Z",
  };
  const additionalProjectProfile = {
    id: "additional_project_profile",
    type: "FACT",
    category: "tenant_profile",
    content: "Second client profile: preserve EU residency and accessibility constraints.",
    confidence: 1,
    created_at: "2025-01-02T00:00:00.000Z",
  };
  const brief = buildSessionBootstrapBrief(
    {
      critical: {
        memories: [
          projectProfile,
          ownerProfile,
          additionalProjectProfile,
          {
            id: "generic_stale_fact",
            type: "FACT",
            category: "configuration",
            content: "Generic configuration note from a long-finished migration.",
            confidence: 1,
            created_at: "2025-01-02T00:00:00.000Z",
          },
        ],
        count: 4,
        tokens: 100,
      },
      daily: { memories: [], count: 0, tokens: 0 },
      profiles: {
        owner_memory_id: "owner_profile",
        project_memory_id: "project_profile",
        tokens: 48,
        precedence: ["project", "owner"],
      },
      total_tokens: 100,
    },
    {
      includeSessionContext: false,
      maxEntries: 4,
      maxTokens: 160,
      now: new Date("2026-07-12T00:00:00.000Z"),
    }
  );

  assert.deepEqual(
    brief.entries.map((entry) => entry.id),
    ["project_profile", "owner_profile", "additional_project_profile"]
  );
  assert.equal(
    brief.entries.filter((entry) => entry.category === "owner_operating_profile").length,
    1
  );
  assert.equal(brief.entries.filter((entry) => entry.category === "tenant_profile").length, 2);
  assert.ok(brief.estimatedTokens <= brief.budgetTokens);
});

test("session bootstrap brief deduplicates carryover and reserves room for recent decisions", () => {
  const brief = buildSessionBootstrapBrief(
    {
      critical: {
        memories: [
          {
            id: "control_plane_decision",
            type: "DECISION",
            category: "roadmap",
            content:
              "Roadmap framing decision: Project Control Plane = architecture component of Project Intelligence, not the product and not a marketing slogan.",
            confidence: 1,
            created_at: "2026-07-03T15:16:43.491Z",
          },
          {
            id: "workflow_phase",
            type: "CONTEXT",
            category: "workflow-phase",
            content:
              "Workflow control-plane-lite-context-routing Final commit Implemented and released true Control Plane Lite lifecycle. Companion now routes --mode auto by intent, LITE has zero mandatory Snipara calls.",
            confidence: 1,
            created_at: "2026-07-03T20:10:00.000Z",
          },
        ],
        count: 2,
        tokens: 240,
      },
      daily: {
        memories: [
          {
            id: "checkpoint_final",
            type: "CONTEXT",
            category: "journal:2026-07-03",
            content:
              "Checkpoint: workflow:final-commit Summary: Implemented and released true Control Plane Lite lifecycle. Companion now routes --mode auto by intent, LITE has zero mandatory Snipara calls.",
            confidence: 1,
            created_at: "2026-07-03T20:11:10.540Z",
          },
          {
            id: "published_handoff",
            type: "CONTEXT",
            category: "team_sync_handoff",
            content:
              "Released snipara-companion 3.2.8 to make session-bootstrap text briefs tiny/high-signal: recent handoff/session carryover ranks ahead of stale durable memory.",
            confidence: 1,
            created_at: "2026-07-03T20:37:31.215Z",
          },
          {
            id: "phase_docs",
            type: "CONTEXT",
            category: "journal:2026-07-03",
            content:
              "Checkpoint: workflow:phase-commit Summary: Replaced mandatory recall/context startup rules with routed brief-first guidance and documented true lite mode.",
            confidence: 1,
            created_at: "2026-07-03T19:50:00.000Z",
          },
        ],
        count: 3,
        tokens: 360,
      },
      total_tokens: 600,
    },
    {
      includeSessionContext: true,
      maxTokens: 260,
      now: new Date("2026-07-03T20:45:00.000Z"),
    }
  );

  const ids = brief.entries.map((entry) => entry.id);
  assert.equal(ids.filter((id) => id === "workflow_phase" || id === "checkpoint_final").length, 1);
  assert.ok(ids.includes("control_plane_decision"));
  assert.ok(brief.entries.filter((entry) => entry.type === "CONTEXT").length <= 3);
  assert.ok(brief.estimatedTokens <= brief.budgetTokens);
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

test("workflow start auto-publishes standard collaboration presence without claims", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-workflow-standard-presence-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "app" }), "utf8");
  const preloadPath = writeWorkflowPreload(dir);
  const collaborationLog = path.join(dir, "collaboration.log");

  const result = runCli(["workflow", "start", "--goal", "Fix copy", "--json"], {
    cwd: dir,
    nodeArgs: ["--require", preloadPath],
    env: {
      SNIPARA_API_KEY: "test-key",
      SNIPARA_PROJECT_ID: "project_1",
      SNIPARA_API_URL: "https://api.example.test",
      SNIPARA_TEST_COLLAB_LOG: collaborationLog,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.coordination.mode, "standard");
  assert.equal(payload.coordination.startReceipt.hostedSessionStatus, "ok");
  assert.equal(payload.coordination.startReceipt.hostedClaimStatus, "skipped");
  const calls = fs.readFileSync(collaborationLog, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter((call) => call.pathname.endsWith("/collaboration/sessions")).length, 1);
  assert.equal(calls.filter((call) => call.pathname.endsWith("/collaboration/leases")).length, 0);
});

test("workflow start auto-publishes full Team Sync and claims planned files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-workflow-full-claims-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "app" }), "utf8");
  const planFile = path.join(dir, "workflow-plan.json");
  fs.writeFileSync(
    planFile,
    JSON.stringify({
      mode: "full",
      steps: [
        {
          id: "edit-cli",
          title: "Edit CLI",
          query: "Edit the CLI",
          files: ["packages/cli/src/index.ts"],
        },
      ],
    }),
    "utf8"
  );
  const preloadPath = writeWorkflowPreload(dir);
  const collaborationLog = path.join(dir, "collaboration.log");
  const teamSyncLog = path.join(dir, "team-sync.log");

  const result = runCli(
    [
      "workflow",
      "start",
      "--goal",
      "Ship workflow coordination",
      "--plan-file",
      planFile,
      "--json",
    ],
    {
      cwd: dir,
      nodeArgs: ["--require", preloadPath],
      env: {
        SNIPARA_API_KEY: "test-key",
        SNIPARA_PROJECT_ID: "project_1",
        SNIPARA_API_URL: "https://api.example.test",
        SNIPARA_TEST_COLLAB_LOG: collaborationLog,
        SNIPARA_TEST_TEAM_SYNC_LOG: teamSyncLog,
      },
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.coordination.mode, "full");
  assert.equal(payload.coordination.startReceipt.hostedSessionStatus, "ok");
  assert.equal(payload.coordination.startReceipt.hostedClaimStatus, "ok");
  assert.equal(payload.coordination.teamSyncReceipt.hostedStatus, "ok");
  const calls = fs.readFileSync(collaborationLog, "utf8").trim().split("\n").map(JSON.parse);
  const leaseCall = calls.find((call) => call.pathname.endsWith("/collaboration/leases"));
  assert.ok(leaseCall);
  assert.ok(
    leaseCall.body.resources.some((resource) => resource.id === "packages/cli/src/index.ts")
  );
  const teamSyncCalls = fs.readFileSync(teamSyncLog, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(teamSyncCalls.length, 1);
  assert.equal(teamSyncCalls[0].body.task, "Ship workflow coordination");
});

test("workflow phase-commit releases workflow coordination leases", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-workflow-release-"));
  const planFile = path.join(dir, "workflow-plan.json");
  fs.writeFileSync(
    planFile,
    JSON.stringify({
      mode: "full",
      steps: [
        {
          id: "edit-cli",
          title: "Edit CLI",
          query: "Edit the CLI",
          files: ["packages/cli/src/index.ts"],
        },
      ],
    }),
    "utf8"
  );
  const preloadPath = writeWorkflowPreload(dir);
  const collaborationLog = path.join(dir, "collaboration.log");
  const env = {
    SNIPARA_API_KEY: "test-key",
    SNIPARA_PROJECT_ID: "project_1",
    SNIPARA_API_URL: "https://api.example.test",
    SNIPARA_TEST_COLLAB_LOG: collaborationLog,
  };

  const start = runCli(
    ["workflow", "start", "--goal", "Ship release hygiene", "--plan-file", planFile, "--json"],
    { cwd: dir, nodeArgs: ["--require", preloadPath], env }
  );
  assert.equal(start.status, 0, start.stderr || start.stdout);

  const phaseCommit = runCli(
    [
      "workflow",
      "phase-commit",
      "edit-cli",
      "--summary",
      "Implemented edit",
      "--outcome",
      "completed",
      "--files",
      "packages/cli/src/index.ts",
      "--json",
    ],
    { cwd: dir, nodeArgs: ["--require", preloadPath], env }
  );
  assert.equal(phaseCommit.status, 0, phaseCommit.stderr || phaseCommit.stdout);
  const payload = JSON.parse(phaseCommit.stdout);
  assert.equal(payload.coordinationRelease.hostedReleaseStatus, "ok");
  assert.ok(payload.workflow.coordination.releaseReceipt);
  const calls = fs.readFileSync(collaborationLog, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(
    calls.some(
      (call) => call.pathname.includes("/collaboration/leases/") && call.method === "PATCH"
    )
  );
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

test("final report fails closed for legacy receipts and unverified evidence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-final-report-builder-"));
  const report = buildFinalCommitReport({
    cwd: dir,
    summary: "Closed the workflow with api_key=secret-value",
    why: "Protect Bearer abcdefghijklmnopqrstuvwxyz from closeout output",
    outcome: "completed",
    evidence: ["Ran a command without a result receipt"],
    state: {
      workflowId: "legacy-workflow",
      goal: "Close legacy workflow",
      status: "completed",
      createdAt: "2026-05-01T08:00:00.000Z",
      phases: [
        {
          id: "legacy",
          title: "Legacy phase",
          status: "completed",
          summary: "Completed before phase receipts existed",
          files: ["src/legacy.ts"],
        },
      ],
    },
    whyCapture: {
      status: "skipped",
      sourceKind: "final_commit",
      previewCandidateCount: 0,
      capturedCount: 0,
      previewCandidates: [],
      pendingMemories: [],
      duplicates: [],
      failed: [],
    },
    finalCommitResult: {
      hosted_final_commit: { status: "error" },
    },
  });

  assert.equal(report.changed.summary, "Closed the workflow with api_key=<redacted>");
  assert.equal(report.rationale.text, "Protect Bearer <redacted> from closeout output");
  assert.equal(report.evidence.items[0].status, "unknown");
  assert.equal(report.retainedDecisions.status, "unavailable");
  assert.equal(report.pendingDecisions.status, "unavailable");
  assert.ok(report.closeout.risks.some((risk) => /local fallback/i.test(risk)));
  assert.match(formatFinalCommitReport(report), /7\. Risks and next step/);
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
  const whyCaptureLog = path.join(dir, "workflow-why-capture.jsonl");

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
        SNIPARA_TEST_WHY_CAPTURE_LOG: whyCaptureLog,
      },
      nodeArgs: ["-r", preloadPath],
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.journal.status, "ok");
  assert.deepEqual(payload.whyCapture, {
    status: "captured",
    sourceKind: "phase_commit",
    previewCandidateCount: 1,
    capturedCount: 1,
    previewCandidates: [
      {
        text: "Decision: Preserve review-first final commit reporting. Why: Pending rationale must never be shown as approved memory.",
        type: "DECISION",
        category: "why-capture",
        decision: "Preserve review-first final commit reporting",
        rationale: "Pending rationale must never be shown as approved memory",
      },
    ],
    pendingMemories: [
      {
        memoryId: "mem_pending_why",
        text: "Decision: Preserve review-first final commit reporting. Why: Pending rationale must never be shown as approved memory.",
        type: "DECISION",
        category: "why-capture",
        reviewStatus: "PENDING",
      },
    ],
    duplicates: [],
    failed: [],
  });
  const phaseWhyCapture = fs
    .readFileSync(whyCaptureLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(phaseWhyCapture.length, 2);
  assert.equal(phaseWhyCapture[0].previewOnly, true);
  assert.equal(phaseWhyCapture[0].confirmed, false);
  assert.equal(phaseWhyCapture[1].previewOnly, false);
  assert.equal(phaseWhyCapture[1].confirmed, true);
  assert.equal(phaseWhyCapture[1].sourceKind, "phase_commit");
  assert.equal(phaseWhyCapture[1].sourceSessionId, "companion-journal");
  assert.equal(payload.producerLoopArtifact.status, "written");
  assert.equal(payload.producerLoopArtifact.schemaVersion, PRODUCER_LOOP_ARTIFACT_VERSION);
  assert.match(payload.producerLoopArtifact.relativePath, /^\.snipara\/producer-loop\//);
  assert.match(payload.producerLoopArtifact.ledgerHash, /^sha256:/);
  const phaseProducerArtifact = JSON.parse(
    fs.readFileSync(payload.producerLoopArtifact.path, "utf8")
  );
  assert.equal(phaseProducerArtifact.schemaVersion, PRODUCER_LOOP_ARTIFACT_VERSION);
  assert.equal(phaseProducerArtifact.producer.kind, "workflow_phase_commit");
  assert.equal(phaseProducerArtifact.producer.workflowId, "companion-journal");
  assert.equal(phaseProducerArtifact.producer.phaseId, "companion-journal-checkpoints");
  assert.equal(phaseProducerArtifact.ledger.version, "snipara.coding_intelligence_ledger.v0");
  assert.equal(phaseProducerArtifact.calibration.hardGateReady, false);
  assert.match(phaseProducerArtifact.caveats.join("\n"), /Local review evidence only/);
  assert.ok(
    fs.existsSync(path.join(dir, PRODUCER_LOOP_RELATIVE_DIR)),
    "producer loop artifact directory should exist"
  );
  const current = JSON.parse(
    fs.readFileSync(path.join(dir, ".snipara", "workflow", "current.json"), "utf8")
  );
  assert.equal(current.phases[0].status, "completed");
  assert.equal(current.phaseCommitReceipts.length, 1);
  assert.equal(current.phaseCommitReceipts[0].stored[0].memoryId, "mem_phase_decision");
  assert.equal(current.phaseCommitReceipts[0].skipped[0].reason, "operational_receipt");
  assert.equal(
    current.phaseCommitReceipts[0].whyCapture.pendingMemories[0].reviewStatus,
    "PENDING"
  );
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

test("workflow producer-report summarizes local workflow producer artifacts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-workflow-producer-report-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  fs.mkdirSync(path.join(dir, ".snipara", "workflow"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".snipara", "workflow", "current.json"),
    JSON.stringify(
      {
        schemaVersion: "snipara.workflow.v2",
        workflowId: "producer-report-workflow",
        goal: "Report local producer samples",
        status: "active",
        currentPhaseId: "report",
        planSource: "inline",
        createdAt: "2026-05-29T08:00:00.000Z",
        updatedAt: "2026-05-29T08:00:00.000Z",
        phases: [
          {
            id: "report",
            title: "Report samples",
            query: "Create a local producer sample",
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

  const commitResult = runCli(
    [
      "workflow",
      "phase-commit",
      "report",
      "--summary",
      "Created one producer sample for report coverage",
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
      },
      nodeArgs: ["-r", preloadPath],
    }
  );
  assert.equal(commitResult.status, 0, commitResult.stderr || commitResult.stdout);
  const producerDir = path.join(dir, PRODUCER_LOOP_RELATIVE_DIR);
  fs.mkdirSync(producerDir, { recursive: true });
  fs.writeFileSync(
    path.join(producerDir, "2026-05-29T08-05-00-000Z-producer-pr-answer-pack.json"),
    JSON.stringify(
      {
        schemaVersion: PRODUCER_LOOP_ARTIFACT_VERSION,
        artifactId: "producer-pr-answer-pack",
        generatedAt: "2026-05-29T08:05:00.000Z",
        producer: {
          kind: "pr_answer_pack_decision_capture",
          command: "github-pr-answer-pack decision-capture",
          category: "github-pr-answer-pack",
          repository: "acme/app",
          pullNumber: 42,
          sourceRef: "github:acme/app#42:abc123",
          files: ["src/auth.ts"],
          candidateCount: 1,
          createdDecisionCount: 1,
          duplicateDecisionCount: 0,
          failedDecisionCount: 0,
        },
        source: {
          summary: "Captured PR decision candidates",
          sourceRef: "github:acme/app#42:abc123",
        },
        ledger: {
          version: "snipara.coding_intelligence_ledger.v0",
          reasonCodes: ["producer_loop_v0", "pr_answer_pack_decision_capture"],
        },
        ledgerHash: "sha256:pr-pack-ledger",
        localEvidence: {
          durableMemoryAttempted: true,
          decisionCaptureAttempted: true,
          serverSide: true,
        },
        calibration: {
          status: "sample_unreviewed",
          sampleSize: 1,
          hardGateReady: false,
          notes: ["PR Answer Pack sample is review-pending."],
        },
        caveats: ["PR Answer Pack producer evidence remains review-pending."],
      },
      null,
      2
    ),
    "utf8"
  );

  const result = runCli(["workflow", "producer-report", "--min-review-samples", "2", "--json"], {
    cwd: dir,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.version, PRODUCER_LOOP_REPORT_VERSION);
  assert.equal(report.source.directory, PRODUCER_LOOP_RELATIVE_DIR);
  assert.equal(report.source.localOnly, true);
  assert.equal(report.adoption.status, "active");
  assert.equal(report.adoption.artifactCount, 2);
  assert.deepEqual([...report.adoption.producerKinds].sort(), [
    "pr_answer_pack_decision_capture",
    "workflow_phase_commit",
  ]);
  assert.deepEqual(report.adoption.workflowIds, ["producer-report-workflow"]);
  assert.equal(report.calibration.status, "insufficient_samples");
  assert.equal(report.calibration.sampleSize, 2);
  assert.equal(report.calibration.reviewedSampleSize, 0);
  assert.equal(report.calibration.rejectedSampleSize, 0);
  assert.equal(report.calibration.unreviewedSampleSize, 2);
  assert.equal(report.calibration.minReviewSampleSize, 2);
  assert.equal(report.calibration.hardGateReady, false);
  assert.equal(report.reasonCodes.counts.producer_loop_v0, 2);
  assert.equal(report.reasonCodes.counts.pr_answer_pack_decision_capture, 1);
  assert.match(report.latestArtifact.relativePath, /^\.snipara\/producer-loop\//);
  assert.equal(report.invalidArtifacts.length, 0);

  const reviewResult = runCli(
    [
      "workflow",
      "producer-review",
      "--artifact",
      "producer-pr-answer-pack",
      "--outcome",
      "useful",
      "--reviewer",
      "alice",
      "--note",
      "Evidence matched the PR Answer Pack",
      "--json",
    ],
    {
      cwd: dir,
    }
  );

  assert.equal(reviewResult.status, 0, reviewResult.stderr || reviewResult.stdout);
  const review = JSON.parse(reviewResult.stdout);
  assert.equal(review.artifactId, "producer-pr-answer-pack");
  assert.equal(review.review.status, "sample_reviewed");
  assert.equal(review.review.outcome, "useful");
  assert.equal(review.review.reviewer, "alice");
  assert.equal(review.calibration.hardGateReady, false);

  const reviewedArtifact = JSON.parse(fs.readFileSync(review.path, "utf8"));
  assert.equal(reviewedArtifact.calibration.status, "sample_reviewed");
  assert.equal(reviewedArtifact.review.outcome, "useful");

  const reviewedReportResult = runCli(
    ["workflow", "producer-report", "--min-review-samples", "1", "--json"],
    {
      cwd: dir,
    }
  );

  assert.equal(
    reviewedReportResult.status,
    0,
    reviewedReportResult.stderr || reviewedReportResult.stdout
  );
  const reviewedReport = JSON.parse(reviewedReportResult.stdout);
  assert.equal(reviewedReport.calibration.status, "reviewable_sample_set");
  assert.equal(reviewedReport.calibration.sampleSize, 2);
  assert.equal(reviewedReport.calibration.reviewedSampleSize, 1);
  assert.equal(reviewedReport.calibration.rejectedSampleSize, 0);
  assert.equal(reviewedReport.calibration.unreviewedSampleSize, 1);
  assert.equal(reviewedReport.calibration.reviewOutcomes.useful, 1);
  assert.equal(reviewedReport.calibration.hardGateReady, false);
});

test("workflow producer-report groups attributed receipts by worker and category", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-worker-trust-report-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  const executionDir = path.join(dir, ".snipara", "orchestrator", "executions");
  const reviewDir = path.join(dir, ".snipara", "orchestrator", "reviews");
  fs.mkdirSync(executionDir, { recursive: true });
  fs.mkdirSync(reviewDir, { recursive: true });
  const receiptRefs = {
    handoffReceiptId: "handoff-docs",
    claimId: "claim-docs",
    proofReceiptIds: ["proof-docs"],
    outcomeReceiptId: "outcome-docs",
    brainUpdateReceiptId: "brain-docs",
  };
  fs.writeFileSync(
    path.join(executionDir, "receipt-docs.json"),
    JSON.stringify({
      schemaVersion: "snipara.gated_worker_execution_receipt.v1",
      receiptId: "receipt-docs",
      recordedAt: "2026-07-13T10:00:00.000Z",
      status: "completed_review_pending",
      reviewStatus: "review_pending",
      workerId: "local-docs-v0",
      workCategory: "docs_low_risk",
      routingCardRef: "routing-card-sha256:docs",
      workflowFingerprint: "workflow-shape-sha256:docs",
      executionActor: "worker",
      workersSpawned: 1,
      receiptRefs,
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(executionDir, "receipt-code.json"),
    JSON.stringify({
      schemaVersion: "snipara.gated_worker_execution_receipt.v1",
      receiptId: "receipt-code",
      recordedAt: "2026-07-13T10:01:00.000Z",
      status: "completed_review_pending",
      reviewStatus: "review_pending",
      workerId: "local-docs-v0",
      workCategory: "code_shared",
      routingCardRef: "routing-card-sha256:code",
      workflowFingerprint: "workflow-shape-sha256:code",
      executionActor: "worker",
      workersSpawned: 1,
      receiptRefs: { proofReceiptIds: [] },
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(reviewDir, "review-docs.json"),
    JSON.stringify({
      schemaVersion: "snipara.gated_worker_execution_review.v0",
      receiptId: "receipt-docs",
      passed: true,
      reviewStatus: "accepted",
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(reviewDir, "review-code.json"),
    JSON.stringify({
      schemaVersion: "snipara.gated_worker_execution_review.v0",
      receiptId: "receipt-code",
      passed: false,
      reviewStatus: "blocked",
    }),
    "utf8"
  );

  const result = runCli(["workflow", "producer-report", "--min-review-samples", "2", "--json"], {
    cwd: dir,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.workerReceipts.sampleSize, 2);
  assert.equal(report.workerReceipts.invalidArtifacts.length, 0);
  assert.equal(report.workerTrust.length, 2);
  const docs = report.workerTrust.find((row) => row.workCategory === "docs_low_risk");
  const code = report.workerTrust.find((row) => row.workCategory === "code_shared");
  assert.equal(docs.workerId, "local-docs-v0");
  assert.equal(docs.state, "probation_supervised");
  assert.equal(docs.reviewedSampleSize, 1);
  assert.equal(docs.verifiedSampleSize, 1);
  assert.equal(docs.incompleteReceiptSampleSize, 0);
  assert.equal(docs.hardGateReady, false);
  assert.deepEqual(docs.workflowFingerprints, ["workflow-shape-sha256:docs"]);
  assert.equal(code.blockedSampleSize, 1);
  assert.equal(code.incompleteReceiptSampleSize, 1);
  assert.match(code.nextRequired.join(" "), /complete receipt families/);
  assert.equal(code.hardGateReady, false);
});

test("workflow producer-triage emits decision requests and decide applies producer review", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-workflow-decisions-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  fs.mkdirSync(path.join(dir, ".snipara", "workflow"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".snipara", "workflow", "current.json"),
    JSON.stringify(
      {
        schemaVersion: "snipara.workflow.v2",
        workflowId: "decision-request-workflow",
        goal: "Create decision request sample",
        status: "active",
        currentPhaseId: "request",
        planSource: "inline",
        createdAt: "2026-05-29T08:00:00.000Z",
        updatedAt: "2026-05-29T08:00:00.000Z",
        phases: [
          {
            id: "request",
            title: "Request review",
            query: "Create a local producer sample",
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
  const commitResult = runCli(
    [
      "workflow",
      "phase-commit",
      "request",
      "--summary",
      "Created one producer sample for decision triage",
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
      },
      nodeArgs: ["-r", preloadPath],
    }
  );
  assert.equal(commitResult.status, 0, commitResult.stderr || commitResult.stdout);

  const triageResult = runCli(["workflow", "producer-triage", "--json"], { cwd: dir });
  assert.equal(triageResult.status, 0, triageResult.stderr || triageResult.stdout);
  const triage = JSON.parse(triageResult.stdout);
  assert.equal(triage.write.status, "written");
  assert.equal(triage.request.schemaVersion, "snipara.decision_request.v0");
  assert.equal(triage.request.decision, "accept_triage_batch");
  assert.equal(triage.request.evidence.applyPath, "workflow producer-review");
  assert.equal(triage.request.evidence.items.length, 1);
  assert.equal(triage.request.evidence.items[0].ref, triage.request.evidence.refs[0]);
  assert.match(triage.request.evidence.items[0].title, /decision-request-workflow/);
  assert.match(
    triage.request.evidence.items[0].summary,
    /Created one producer sample for decision triage/
  );

  const decisionsResult = runCli(["workflow", "decisions", "--json"], { cwd: dir });
  assert.equal(decisionsResult.status, 0, decisionsResult.stderr || decisionsResult.stdout);
  const decisions = JSON.parse(decisionsResult.stdout);
  assert.equal(decisions.pendingCount, 1);
  assert.equal(decisions.requests[0].requestId, triage.request.requestId);
  assert.equal(decisions.requests[0].evidence.items[0].ref, triage.request.evidence.refs[0]);

  const decideResult = runCli(
    [
      "workflow",
      "decide",
      triage.request.requestId,
      "--choose",
      "accept_all",
      "--reviewer",
      "alice",
      "--note",
      "spot checked",
      "--json",
    ],
    { cwd: dir }
  );
  assert.equal(decideResult.status, 0, decideResult.stderr || decideResult.stdout);
  const resolved = JSON.parse(decideResult.stdout);
  assert.equal(resolved.response.choice, "accept_all");
  assert.match(resolved.response.appliedActions[0], /workflow producer-review/);
  assert.equal(fs.readdirSync(path.join(dir, ".snipara", "decisions", "pending")).length, 0);
  assert.equal(fs.readdirSync(path.join(dir, ".snipara", "decisions", "resolved")).length, 1);

  const reportResult = runCli(["workflow", "producer-report", "--json"], { cwd: dir });
  assert.equal(reportResult.status, 0, reportResult.stderr || reportResult.stdout);
  const report = JSON.parse(reportResult.stdout);
  assert.equal(report.calibration.reviewedSampleSize, 1);
  assert.equal(report.artifacts[0].reviewer, "alice");
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
  const whyCaptureLog = path.join(dir, "workflow-final-why-capture.jsonl");

  const result = runCli(
    [
      "final-commit",
      "--summary",
      "Closed the managed workflow",
      "--why",
      "Make closeout memory status explicit without auto-approving rationale",
      "--evidence",
      "passed:pnpm --filter snipara-companion test",
      "--evidence",
      "not-run:production smoke",
      "--risk",
      "Published package still needs registry verification",
      "--next-step",
      "Publish and verify the package",
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
        SNIPARA_TEST_WHY_CAPTURE_LOG: whyCaptureLog,
      },
      nodeArgs: ["-r", preloadPath],
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.commit.team_sync_handoff.status, "created");
  assert.equal(payload.commit.team_sync_handoff.memory_id, "mem_handoff");
  assert.equal(payload.whyCapture.status, "captured");
  assert.equal(payload.whyCapture.sourceKind, "final_commit");
  assert.equal(payload.report.version, FINAL_COMMIT_REPORT_VERSION);
  assert.equal(payload.report.rationale.status, "provided");
  assert.equal(payload.report.evidence.counts.passed, 1);
  assert.equal(payload.report.evidence.counts.not_run, 1);
  assert.equal(payload.report.retainedDecisions.status, "confirmed");
  assert.equal(payload.report.retainedDecisions.items[0].memoryId, "mem_kept_decision");
  assert.equal(payload.report.pendingDecisions.status, "pending_review");
  assert.equal(payload.report.pendingDecisions.items[0].memoryId, "mem_pending_why");
  assert.ok(
    payload.report.notPersisted.items.some((item) => item.reason === "handoff_only_by_design")
  );
  assert.deepEqual(payload.report.closeout.risks, [
    "Published package still needs registry verification",
    "Phase 'verify' is in_progress.",
    "1 verification item(s) were not run.",
  ]);
  assert.equal(payload.report.closeout.nextStep, "Publish and verify the package");
  assert.equal(payload.reportArtifact.status, "written");
  assert.equal(payload.reportArtifact.relativePath, FINAL_COMMIT_REPORT_RELATIVE_PATH);
  assert.match(payload.reportArtifact.hash, /^sha256:/);
  const finalWhyCapture = fs
    .readFileSync(whyCaptureLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(finalWhyCapture.length, 2);
  assert.equal(finalWhyCapture[0].previewOnly, true);
  assert.equal(finalWhyCapture[1].confirmed, true);
  assert.equal(finalWhyCapture[1].sourceSessionId, "agentic-work");
  assert.equal(payload.producerLoopArtifact.status, "written");
  assert.equal(payload.producerLoopArtifact.schemaVersion, PRODUCER_LOOP_ARTIFACT_VERSION);
  assert.match(payload.producerLoopArtifact.relativePath, /^\.snipara\/producer-loop\//);
  const finalProducerArtifact = JSON.parse(
    fs.readFileSync(payload.producerLoopArtifact.path, "utf8")
  );
  assert.equal(finalProducerArtifact.schemaVersion, PRODUCER_LOOP_ARTIFACT_VERSION);
  assert.equal(finalProducerArtifact.producer.kind, "workflow_final_commit");
  assert.equal(finalProducerArtifact.producer.workflowId, "agentic-work");
  assert.deepEqual(finalProducerArtifact.producer.files, [
    "packages/cli/src/commands/workflows.ts",
  ]);
  assert.equal(finalProducerArtifact.ledger.version, "snipara.coding_intelligence_ledger.v0");
  assert.equal(finalProducerArtifact.calibration.hardGateReady, false);

  const current = JSON.parse(
    fs.readFileSync(path.join(dir, ".snipara", "workflow", "current.json"), "utf8")
  );
  assert.equal(current.status, "completed");
  assert.equal(current.lastCommit.category, "final-commit");
  assert.equal(current.finalReport.version, FINAL_COMMIT_REPORT_VERSION);
  const savedReport = JSON.parse(
    fs.readFileSync(path.join(dir, FINAL_COMMIT_REPORT_RELATIVE_PATH), "utf8")
  );
  assert.equal(savedReport.version, FINAL_COMMIT_REPORT_VERSION);
  assert.equal(savedReport.pendingDecisions.items[0].reviewStatus, "PENDING");

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

test("final-commit prints the seven closeout sections in stable order", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-workflow-final-report-text-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  writeWorkflowState(dir);
  const preloadPath = writeWorkflowPreload(dir);

  const result = runCli(
    [
      "final-commit",
      "--summary",
      "Closed the workflow with a transparent report",
      "--why",
      "Operators need attributable closeout evidence",
      "--evidence",
      "passed:focused tests",
      "--next-step",
      "Verify the published package",
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
  const headings = [
    "1. What changed",
    "2. Why",
    "3. Evidence",
    "4. Decisions kept",
    "5. Decisions proposed for review",
    "6. Not persisted",
    "7. Risks and next step",
  ];
  let previousIndex = -1;
  for (const heading of headings) {
    const index = result.stdout.indexOf(heading);
    assert.ok(index > previousIndex, `Expected '${heading}' after the previous section`);
    previousIndex = index;
  }
  assert.match(result.stdout, /\[passed\] focused tests/);
  assert.match(result.stdout, /\[PENDING\]/);
  assert.match(result.stdout, /handoff_only_by_design/);
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
    assert.deepEqual(persisted.memory.decisionIds, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("orchestrator handoff only emits explicit or referenced decision IDs", () => {
  const recommendation = getOrchestratorRecommendation("Release validation", "full", {
    policyAutoRoute: true,
  });

  const emptyArtifact = buildOrchestratorHandoff({
    sourceCommand: "workflow run",
    recommendation,
    query: "Release validation",
    summary: "No linked decisions",
  });
  assert.deepEqual(emptyArtifact.memory.decisionIds, []);

  const linkedArtifact = buildOrchestratorHandoff({
    sourceCommand: "workflow run",
    recommendation,
    query: "Release validation",
    summary: "Linked decisions",
    decisionIds: ["dec-101", "DEC-101", "not-a-decision"],
    contextRefs: ["team-sync decision DEC-202", "docs/reference/CODE_GRAPH.md"],
  });

  assert.deepEqual(linkedArtifact.memory.decisionIds, ["DEC-101", "DEC-202"]);
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

test("adaptive routing infers profile strengths and structured output for local coding work", () => {
  const routing = buildAdaptiveWorkRoutingRecommendation({
    query: "Implement a cross-file refactor with structured JSON patch output across the repo",
    mode: "full",
    changedFiles: [
      "packages/cli/src/index.ts",
      "packages/cli/src/runtime/orchestrator-handoff.ts",
      "packages/cli/test/workflows.test.js",
      "packages/agentic-orchestrator/src/snipara_orchestrator/cli.py",
      "packages/agentic-orchestrator/src/snipara_orchestrator/routing/resolver.py",
      "docs/benchmarks/LOCAL_MODEL_CONTEXT_BENCHMARK_20260626.md",
    ],
    preferredEndpointTypes: ["local"],
    workerRole: "coding",
  });

  assert.equal(routing.requirements.structuredOutputRequired, true);
  assert.ok(routing.workProfile.preferredProfileStrengths.includes("code"));
  assert.ok(routing.workProfile.preferredProfileStrengths.includes("structured_output"));
  assert.ok(routing.workProfile.preferredProfileStrengths.includes("refactor"));
  assert.ok(routing.workProfile.preferredProfileStrengths.includes("long_context"));
  assert.ok(routing.workProfile.preferredProfileStrengths.includes("repo_scan"));
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
    const orchestratorArgsLog = path.join(dir, "orchestrator-args.jsonl");
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
          SNIPARA_TEST_ORCHESTRATOR_ARGS_LOG: orchestratorArgsLog,
          SNIPARA_TEST_LOCAL_ORCHESTRATOR_CATALOG_RESPONSE: JSON.stringify({
            schemaVersion: "snipara.orchestrator.runtime_catalog.v1",
            source: "openai_compatible_local",
            provider: "lm-studio",
            baseUrl: "http://127.0.0.1:1234",
            models: ["ggml-org/devstral-small-2-24b-instruct-2512-gguf"],
            apiPaths: {
              models: "/v1/models",
              chatCompletions: "/v1/chat/completions",
              responses: "/v1/responses",
            },
            candidates: [
              {
                candidateId: "local-devstral",
                workerClass: "coding",
                catalogSource: "openai_compatible_local",
                endpointType: "local",
                workerRoles: ["coding"],
                capabilities: ["docs_write"],
                isAvailable: true,
                workerProfileId: "local-devstral-refactor",
              },
            ],
            workerEndpoints: {
              "local-devstral": {
                provider: "lm-studio",
                baseUrl: "http://127.0.0.1:1234",
                model: "ggml-org/devstral-small-2-24b-instruct-2512-gguf",
                apiPaths: {
                  responses: "/v1/responses",
                },
                workerProfileId: "local-devstral-refactor",
              },
            },
            workerProfiles: {
              "local-devstral-refactor": {
                profileId: "local-devstral-refactor",
                strengths: ["code", "refactor", "agentic_exploration"],
                structuredOutputFit: "medium",
                timeoutRisk: "high",
              },
            },
          }),
          SNIPARA_TEST_LOCAL_ORCHESTRATOR_ROUTE_RESPONSE: JSON.stringify({
            status: "resolved",
            selected: {
              candidate: {
                candidateId: "local-devstral",
                workerClass: "coding",
                catalogSource: "openai_compatible_local",
                endpointType: "local",
              },
              score: 0.91,
              scoreBreakdown: {
                capabilityFit: 0.2,
                preferredStrengthFit: 0.3,
                timeoutPenalty: -0.1,
              },
              reasons: ["candidate satisfies local documentation route"],
            },
            policyDecision: {
              mode: "approval_required",
              approvalRequired: true,
              executionAllowed: false,
            },
            evaluatedCount: 1,
            rejectedCount: 0,
            fallback: "main_agent",
            reasons: ["candidate satisfies local documentation route"],
            warnings: [
              "Selected local worker because the planner retains deep reasoning and work is scoped.",
            ],
          }),
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
    assert.equal(payload.adaptive_routing.gateway.source, "local_orchestrator");
    assert.equal(payload.adaptive_routing.gateway.success, true);
    assert.equal(payload.adaptive_routing.gateway.candidateCount, 1);
    assert.equal(
      payload.adaptive_routing.runtimeCatalog.workerProfiles["local-devstral-refactor"].profileId,
      "local-devstral-refactor"
    );
    assert.equal(
      payload.adaptive_routing.runtimeCatalog.candidates[0].candidateId,
      "local-devstral"
    );
    assert.equal(
      payload.adaptive_routing.runtimeCatalog.workerEndpoints["local-devstral"].model,
      "ggml-org/devstral-small-2-24b-instruct-2512-gguf"
    );
    assert.equal(
      payload.adaptive_routing.resolution.selected.candidate.candidateId,
      "local-devstral"
    );
    assert.deepEqual(payload.adaptive_routing.resolution.selected.scoreBreakdown, {
      capabilityFit: 0.2,
      preferredStrengthFit: 0.3,
      timeoutPenalty: -0.1,
    });
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
    assert.equal(persisted.routing.gateway.source, "local_orchestrator");
    assert.equal(persisted.routing.gateway.candidateCount, 1);
    assert.equal(persisted.routing.runtimeCatalog.candidates[0].endpointType, "local");
    assert.equal(
      persisted.routing.runtimeCatalog.workerProfiles["local-devstral-refactor"].profileId,
      "local-devstral-refactor"
    );
    assert.equal(
      persisted.routing.runtimeCatalog.workerEndpoints["local-devstral"].model,
      "ggml-org/devstral-small-2-24b-instruct-2512-gguf"
    );
    assert.equal(persisted.routing.resolution.selected.candidate.endpointType, "local");
    assert.deepEqual(persisted.routing.resolution.selected.scoreBreakdown, {
      capabilityFit: 0.2,
      preferredStrengthFit: 0.3,
      timeoutPenalty: -0.1,
    });
    assert.match(
      persisted.routing.routingCard.warnings.join(" "),
      /companion does not launch or claim workers/
    );
    const orchestratorCalls = fs
      .readFileSync(orchestratorArgsLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const catalogCall = orchestratorCalls.find(
      (entry) =>
        entry.command === "snipara-orchestrator" && entry.args?.[0] === "local-model-catalog"
    );
    assert.ok(catalogCall, "expected local-model-catalog to be invoked");
    assert.ok(catalogCall.args.includes("--all-models"));
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

test("workflow run explains when project policy blocks requested local routing", () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "snipara-adaptive-routing-policy-blocks-local-")
  );
  try {
    fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
    fs.mkdirSync(path.join(dir, ".snipara", "workflow"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".snipara", "workflow", "current.json"),
      JSON.stringify(
        {
          schemaVersion: "snipara.workflow.v2",
          workflowId: "adaptive-routing-policy-blocks-local",
          goal: "Prepare local worker handoff",
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
        "--routing-local-base-url",
        "http://127.0.0.1:1234",
        "--routing-local-model",
        "qwen/qwen3-coder-30b",
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
            adaptiveRoutingMode: "off",
            adaptiveRoutingAllowedEndpointTypes: ["cloud"],
            adaptiveRoutingPreferredEndpointTypes: [],
            adaptiveRoutingAllowedWorkerClasses: ["documentation", "tests", "review"],
          }),
        },
        nodeArgs: ["-r", preloadPath],
      }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.adaptive_routing.gateway, undefined);
    assert.deepEqual(payload.adaptive_routing.requirements.allowedEndpointTypes, ["cloud"]);
    assert.deepEqual(payload.adaptive_routing.requirements.preferredEndpointTypes ?? [], []);
    assert.match(
      payload.adaptive_routing.routingCard.warnings.join(" "),
      /Local worker routing was requested, but the effective Adaptive Work Routing policy does not allow local endpoints/
    );
    assert.match(
      payload.adaptive_routing.routingCard.warnings.join(" "),
      /Companion skipped local orchestrator routing/
    );
    assert.equal(payload.orchestrator_handoff.relativePath, ORCHESTRATOR_HANDOFF_RELATIVE_PATH);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("local worker declarations feed workflow run routing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-local-worker-routing-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
    fs.mkdirSync(path.join(dir, ".snipara", "workflow"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".snipara", "workflow", "current.json"),
      JSON.stringify(
        {
          schemaVersion: "snipara.workflow.v2",
          workflowId: "local-worker-routing",
          goal: "Use local GPT-OSS coding worker",
          status: "active",
          currentPhaseId: "coding-worker",
          planSource: "inline",
          createdAt: "2026-06-18T21:30:00.000Z",
          updatedAt: "2026-06-18T21:30:00.000Z",
          phases: [
            {
              id: "coding-worker",
              title: "Coding worker",
              query: "Let a local coding worker update a small file",
              status: "in_progress",
              files: ["src/example.ts"],
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    );

    const addResult = runCli(
      [
        "workers",
        "local",
        "add",
        "--id",
        "local-gpt-oss-20b-coding",
        "--role",
        "coding",
        "--provider",
        "lm-studio",
        "--base-url",
        "http://127.0.0.1:1234",
        "--model",
        "openai/gpt-oss-20b",
        "--json",
      ],
      { cwd: dir }
    );
    assert.equal(addResult.status, 0, addResult.stderr || addResult.stdout);
    const addPayload = JSON.parse(addResult.stdout);
    assert.equal(addPayload.worker.id, "local-gpt-oss-20b-coding");
    assert.equal(addPayload.worker.workerRole, "coding");
    assert.equal(addPayload.worker.model, "openai/gpt-oss-20b");
    assert.deepEqual(addPayload.worker.writeScope, []);

    const workerConfig = JSON.parse(
      fs.readFileSync(
        path.join(dir, ".snipara", "workers", "local-gpt-oss-20b-coding.json"),
        "utf8"
      )
    );
    assert.equal(workerConfig.workerId, "local-gpt-oss-20b-coding");
    assert.equal(workerConfig.capabilities.roles.includes("coding"), true);
    const policy = JSON.parse(
      fs.readFileSync(path.join(dir, ".snipara", "adaptive-routing.json"), "utf8")
    );
    assert.ok(policy.allowedEndpointTypes.includes("local"));
    assert.ok(policy.preferredEndpointTypes.includes("local"));

    const preloadPath = writeWorkflowPreload(dir);
    const orchestratorArgsLog = path.join(dir, "orchestrator-args.jsonl");
    const result = runCli(
      [
        "workflow",
        "run",
        "--mode",
        "standard",
        "--query",
        "Use the declared local coding worker for a small implementation task",
        "--adaptive-routing-dry-run",
        "--routing-local-worker",
        "local-gpt-oss-20b-coding",
        "--emit-orchestrator-handoff",
        "--json",
      ],
      {
        cwd: dir,
        env: {
          SNIPARA_API_KEY: "snp-test",
          SNIPARA_PROJECT_ID: "project_1",
          SNIPARA_API_URL: "https://api.snipara.com",
          SNIPARA_TEST_ORCHESTRATOR_ARGS_LOG: orchestratorArgsLog,
          SNIPARA_TEST_AUTOMATION_SETTINGS: JSON.stringify({
            adaptiveRoutingMode: "off",
            adaptiveRoutingAllowedEndpointTypes: ["cloud"],
          }),
          SNIPARA_TEST_LOCAL_ORCHESTRATOR_CATALOG_RESPONSE: JSON.stringify({
            schemaVersion: "snipara.orchestrator.runtime_catalog.v1",
            source: "openai_compatible_local",
            provider: "lm-studio",
            baseUrl: "http://127.0.0.1:1234",
            models: ["openai/gpt-oss-20b"],
            candidates: [
              {
                candidateId: "local-gpt-oss-20b-coding",
                workerClass: "coding",
                catalogSource: "openai_compatible_local",
                endpointType: "local",
                workerRoles: ["coding"],
                capabilities: ["code", "refactor"],
                isAvailable: true,
              },
            ],
            workerEndpoints: {
              "local-gpt-oss-20b-coding": {
                provider: "lm-studio",
                baseUrl: "http://127.0.0.1:1234",
                model: "openai/gpt-oss-20b",
              },
            },
          }),
          SNIPARA_TEST_LOCAL_ORCHESTRATOR_ROUTE_RESPONSE: JSON.stringify({
            status: "resolved",
            selected: {
              candidate: {
                candidateId: "local-gpt-oss-20b-coding",
                workerClass: "coding",
                endpointType: "local",
              },
              score: 0.88,
              scoreBreakdown: {
                capabilityFit: 0.4,
              },
              reasons: ["declared local coding worker selected"],
            },
            fallback: "main_agent",
            reasons: ["declared local coding worker selected"],
            warnings: [],
          }),
        },
        nodeArgs: ["-r", preloadPath],
      }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.local_worker.id, "local-gpt-oss-20b-coding");
    assert.equal(payload.adaptive_routing.gateway.source, "local_orchestrator");
    assert.equal(payload.adaptive_routing.gateway.success, true);
    assert.equal(payload.adaptive_routing.requirements.workerRole, "coding");
    assert.deepEqual(payload.adaptive_routing.requirements.allowedEndpointTypes, ["local"]);
    assert.deepEqual(payload.adaptive_routing.requirements.preferredEndpointTypes, ["local"]);
    assert.match(
      payload.adaptive_routing.routingCard.warnings.join(" "),
      /Declared local worker local-gpt-oss-20b-coding selected/
    );

    const orchestratorCalls = fs
      .readFileSync(orchestratorArgsLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const catalogCall = orchestratorCalls.find(
      (entry) =>
        entry.command === "snipara-orchestrator" && entry.args?.[0] === "local-model-catalog"
    );
    assert.ok(catalogCall, "expected local-model-catalog to be invoked");
    assert.ok(catalogCall.args.includes("--model"));
    assert.ok(catalogCall.args.includes("openai/gpt-oss-20b"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workers local list and remove manage per-worker registry files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-local-workers-list-remove-"));
  try {
    const preloadPath = writeWorkflowPreload(dir);

    const addResult = runCli(
      [
        "workers",
        "local",
        "add",
        "--id",
        "local-gpt-oss-20b-coding",
        "--role",
        "coding",
        "--provider",
        "lm-studio",
        "--base-url",
        "http://127.0.0.1:1234",
        "--model",
        "openai/gpt-oss-20b",
        "--json",
      ],
      {
        cwd: dir,
        nodeArgs: ["-r", preloadPath],
      }
    );
    assert.equal(addResult.status, 0, addResult.stderr || addResult.stdout);
    const addPayload = JSON.parse(addResult.stdout);
    assert.equal(addPayload.worker.reasoning, "medium");

    const addSecondResult = runCli(
      [
        "workers",
        "local",
        "add",
        "--id",
        "local-codex-mini",
        "--role",
        "documentation",
        "--transport",
        "cli",
        "--command",
        "codex",
        "--reasoning",
        "high",
        "--json",
      ],
      {
        cwd: dir,
        nodeArgs: ["-r", preloadPath],
      }
    );
    assert.equal(addSecondResult.status, 0, addSecondResult.stderr || addSecondResult.stdout);
    const addSecondPayload = JSON.parse(addSecondResult.stdout);
    assert.equal(addSecondPayload.worker.reasoning, "high");

    const listResult = runCli(["workers", "local", "list", "--json"], {
      cwd: dir,
    });
    assert.equal(listResult.status, 0, listResult.stderr || listResult.stdout);
    const listPayload = JSON.parse(listResult.stdout);
    assert.equal(listPayload.configured, true);
    assert.equal(listPayload.workers.length, 2);

    const removeResult = runCli(
      ["workers", "local", "remove", "local-gpt-oss-20b-coding", "--json"],
      {
        cwd: dir,
      }
    );
    assert.equal(removeResult.status, 0, removeResult.stderr || removeResult.stdout);
    const removePayload = JSON.parse(removeResult.stdout);
    assert.equal(removePayload.removed.id, "local-gpt-oss-20b-coding");
    assert.equal(removePayload.config.workers.length, 1);

    assert.ok(
      !fs.existsSync(path.join(dir, ".snipara", "workers", "local-gpt-oss-20b-coding.json")),
      "expected removed worker profile file to be deleted"
    );

    const listAfterResult = runCli(["workers", "local", "list", "--json"], {
      cwd: dir,
    });
    const listAfterPayload = JSON.parse(listAfterResult.stdout);
    assert.equal(listAfterPayload.workers.length, 1);
    assert.equal(listAfterPayload.workers[0].id, "local-codex-mini");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workers local probe drafts a persisted declaration suggestion", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-local-workers-probe-"));
  try {
    const preloadPath = writeWorkflowPreload(dir);
    const probeResult = runCli(
      [
        "workers",
        "local",
        "probe",
        "--base-url",
        "http://127.0.0.1:1234",
        "--provider",
        "lm-studio",
        "--role",
        "coding",
        "--model",
        "tiny-coder",
        "--worker-id",
        "local-gpt-oss-20b-coding",
        "--json",
      ],
      {
        cwd: dir,
        nodeArgs: ["-r", preloadPath],
        env: {
          SNIPARA_TEST_LOCAL_ORCHESTRATOR_CATALOG_RESPONSE: JSON.stringify({
            schemaVersion: "snipara.orchestrator.runtime_catalog.v1",
            source: "openai_compatible_local",
            provider: "lm-studio",
            baseUrl: "http://127.0.0.1:1234",
            models: ["openai/gpt-oss-20b"],
            candidates: [],
            workerEndpoints: {},
          }),
        },
      }
    );
    assert.equal(probeResult.status, 0, probeResult.stderr || probeResult.stdout);
    const payload = JSON.parse(probeResult.stdout);
    assert.equal(payload.suggestion.id, "local-gpt-oss-20b-coding");
    assert.equal(payload.suggestion.model, "tiny-coder");
    assert.equal(payload.suggestion.reasoning, "low");
    assert.equal(payload.suggestion.workerRole, "coding");
    assert.equal(payload.suggestion.baseUrl, "http://127.0.0.1:1234");
    assert.deepEqual(payload.suggestion.writeScope, []);
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

test("workflow auto mode deterministically selects workflow depth", () => {
  assert.equal(resolveAutoWorkflowMode("show what changed in this repo"), "lite");
  assert.equal(resolveAutoWorkflowMode("fix typo in README small diff"), "lite");
  assert.equal(resolveAutoWorkflowMode("implement login error handling"), "standard");
  assert.equal(resolveAutoWorkflowMode("why did we choose hosted MCP for memory?"), "standard");
  assert.equal(resolveAutoWorkflowMode("ship a multi-phase schema migration plan"), "full");
  assert.equal(
    resolveAutoWorkflowMode("coordinate production proof gate with workers"),
    "orchestrate"
  );
});

test("workflow lite mode does not require hosted configuration", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-lite-no-config-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
    const result = runCli(
      ["workflow", "run", "--mode", "lite", "--query", "fix typo in README", "--json"],
      { cwd: dir }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.effective_mode, "lite");
    assert.deepEqual(payload.retrieval_policy.mandatory_calls, []);
    assert.equal(payload.context, undefined);
    assert.equal(payload.session_bootstrap, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workflow auto lite does not call hosted context or bootstrap tools", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-auto-lite-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
    const preloadPath = writeWorkflowPreload(dir);
    const toolLogPath = path.join(dir, "tools.log");
    const result = runCli(
      ["workflow", "run", "--mode", "auto", "--query", "fix typo in README small diff", "--json"],
      {
        cwd: dir,
        nodeArgs: ["--require", preloadPath],
        env: {
          SNIPARA_API_KEY: "test-key",
          SNIPARA_PROJECT_ID: "proj_test",
          SNIPARA_API_URL: "https://api.test",
          SNIPARA_TEST_TOOL_LOG: toolLogPath,
        },
      }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.effective_mode, "lite");
    const calledTools = fs.existsSync(toolLogPath) ? fs.readFileSync(toolLogPath, "utf8") : "";
    assert.doesNotMatch(calledTools, /snipara_context_query/);
    assert.doesNotMatch(calledTools, /snipara_session_memories/);
    assert.doesNotMatch(calledTools, /snipara_recall/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("session-bootstrap text output is silent for an empty pushed brief", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-bootstrap-empty-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
    const preloadPath = writeWorkflowPreload(dir);
    const result = runCli(["session-bootstrap"], {
      cwd: dir,
      nodeArgs: ["--require", preloadPath],
      env: {
        SNIPARA_API_KEY: "test-key",
        SNIPARA_PROJECT_ID: "proj_test",
        SNIPARA_API_URL: "https://api.test",
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("session-bootstrap text output is silent in an unconfigured empty project", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-bootstrap-blank-project-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
    const result = runCli(["session-bootstrap", "--include-session-context"], {
      cwd: dir,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("session-bootstrap text output is tiny and high-signal", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-bootstrap-signal-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
    const preloadPath = writeWorkflowPreload(dir);
    const sessionMemories = {
      critical: {
        memories: [
          {
            id: "old_env",
            content:
              "Symlinked .env files structure: /Users/alopez/Devs/Snipara/.env is the source of truth.",
            type: "FACT",
            category: "configuration",
            confidence: 0.23,
            created_at: "2026-02-06T11:55:45.516Z",
          },
          {
            id: "old_injection",
            content:
              "Memory Injection feature is complete and working. The hooks use rlm_remember and rlm_recall.",
            type: "DECISION",
            category: "architecture",
            confidence: 0.67,
            created_at: "2026-01-25T21:59:29.495Z",
          },
        ],
        count: 2,
        tokens: 300,
      },
      daily: {
        memories: [
          {
            id: "today_final",
            content:
              "Checkpoint: workflow:final-commit. Implemented and released true Control Plane Lite lifecycle. LITE has zero mandatory Snipara calls and snipara-companion@3.2.7 is published.",
            type: "CONTEXT",
            category: "journal:2026-07-03",
            confidence: 1,
            created_at: "2026-07-03T20:11:10.540Z",
          },
        ],
        count: 1,
        tokens: 120,
      },
      total_tokens: 420,
    };
    const result = runCli(["session-bootstrap", "--include-session-context"], {
      cwd: dir,
      nodeArgs: ["--require", preloadPath],
      env: {
        SNIPARA_API_KEY: "test-key",
        SNIPARA_PROJECT_ID: "proj_test",
        SNIPARA_API_URL: "https://api.test",
        SNIPARA_TEST_SESSION_MEMORIES: JSON.stringify(sessionMemories),
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Control Plane Lite lifecycle/);
    assert.doesNotMatch(result.stdout, /Symlinked \.env files/);
    assert.doesNotMatch(result.stdout, /Memory Injection feature/);
    assert.doesNotMatch(result.stdout, /more available on demand/);
    assert.ok(result.stdout.trim().split("\n").length <= 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("continue-workspace emits stable continuity contract for editor integrations", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-continuity-contract-"));
  try {
    fs.mkdirSync(path.join(dir, ".snipara", "source"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
    fs.writeFileSync(
      path.join(dir, ".snipara", "source", "latest.json"),
      JSON.stringify(
        {
          version: "snipara.local_source_snapshot.v1",
          generatedAt: "2026-07-05T09:00:00.000Z",
          root: dir,
          provider: "local_folder",
          revision: "rev_local",
          summary: { totalFiles: 2, totalBytes: 120, skipped: 0 },
        },
        null,
        2
      ),
      "utf8"
    );
    saveTeamSyncState(
      {
        ...createEmptyTeamSyncState(),
        handoffs: [
          {
            id: "handoff_1",
            type: "handoff",
            summary: "Activation complete",
            next: "Open the first brief",
            files: ["README.md"],
            attention: "watch",
            createdAt: "2026-07-05T09:00:00.000Z",
          },
        ],
      },
      dir
    );
    writeSessionSnapshot({ cwd: dir });

    const preloadPath = writeWorkflowPreload(dir);
    const sessionMemories = {
      critical: {
        memories: [
          {
            id: "decision_1",
            content: "Use create-snipara as the canonical activation engine.",
            type: "DECISION",
            category: "activation",
            confidence: 0.98,
            created_at: "2026-07-05T08:00:00.000Z",
          },
        ],
        count: 1,
        tokens: 24,
      },
      daily: { memories: [], count: 0, tokens: 0 },
      total_tokens: 24,
    };

    const result = runCli(["continue-workspace", "--include-session-context", "--json"], {
      cwd: dir,
      nodeArgs: ["--require", preloadPath],
      env: {
        SNIPARA_API_KEY: "test-key",
        SNIPARA_PROJECT_ID: "proj_test",
        SNIPARA_API_URL: "https://api.test",
        SNIPARA_SESSION_ID: "sess_test",
        SNIPARA_TEST_SESSION_MEMORIES: JSON.stringify(sessionMemories),
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.version, "snipara.companion.continuity.v1");
    assert.equal(payload.configured, true);
    assert.equal(payload.project.projectId, "proj_test");
    assert.equal(payload.project.sessionId, "sess_test");
    assert.equal(payload.bootstrap.critical.count, 1);
    assert.deepEqual(payload.bootstrapQuality.warnings, []);
    assert.equal(payload.bootstrapQuality.counts.critical_memories, 1);
    assert.equal(payload.sessionContext.included, true);
    assert.equal(payload.source.status, "present");
    assert.equal(payload.source.snapshotPath, ".snipara/source/latest.json");
    assert.equal(payload.teamSync.handoffCount, 1);
    assert.equal(payload.teamSync.latestHandoff.summary, "Activation complete");
    assert.equal(payload.artifacts.workflowStatePath, WORKFLOW_STATE_RELATIVE_PATH);
    assert.ok(payload.nextActions.some((action) => action.id === "refresh_source_snapshot"));
    assert.ok(payload.nextActions.some((action) => action.id === "run_impact_gate"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test("memory guard gives source context a longer bounded timeout than recall", () => {
  assert.equal(MEMORY_GUARD_RECALL_TIMEOUT_MS, 15_000);
  assert.equal(MEMORY_GUARD_CONTEXT_TIMEOUT_MS, 30_000);
  assert.ok(MEMORY_GUARD_CONTEXT_TIMEOUT_MS > MEMORY_GUARD_RECALL_TIMEOUT_MS);
});

test("activity timeline appends events and builds fail-closed session snapshot", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-activity-"));
  try {
    appendActivityEvent({
      cwd: dir,
      source: "workflow",
      kind: "phase-start",
      title: "Build local timeline",
      workflowId: "workflow_1",
      phaseId: "phase_1",
      files: ["packages/cli/src/commands/activity.ts"],
      metadata: { action: "read" },
      timestamp: "2026-07-02T20:00:00.000Z",
    });
    appendActivityEvent({
      cwd: dir,
      source: "team-sync",
      kind: "team-sync-handoff",
      title: "Parallel work visible",
      refs: ["handoff_1"],
      metadata: { action: "read" },
      timestamp: "2026-07-02T20:01:00.000Z",
    });

    const events = readActivityTimeline({ cwd: dir });
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, "team-sync-handoff");

    const snapshot = writeSessionSnapshot({ cwd: dir });
    assert.equal(snapshot.schemaVersion, "snipara.session_snapshot.v0");
    assert.equal(snapshot.activity.totalEvents, 2);
    assert.equal(snapshot.summary.latestActivityTitle, "Parallel work visible");
    assert.equal(snapshot.summary.latestActivityKind, "team-sync-handoff");
    assert.deepEqual(snapshot.summary.touchedFiles, ["packages/cli/src/commands/activity.ts"]);
    assert.equal(snapshot.summary.risk, "none");
    assert.match(snapshot.summary.recommendedNextAction, /Review the latest activity/);
    assert.equal(snapshot.intentDetection.intent, "investigating");
    assert.equal(snapshot.intentDetection.hardRoutingAllowed, false);
    assert.equal(snapshot.intentDetection.advisoryRouting.hardRoutingAllowed, false);
    assert.equal(snapshot.routing.hardRoutingAllowed, false);
    assert.ok(snapshot.performance.buildMs < 1000);

    const rebuilt = buildSessionSnapshot({ cwd: dir, limit: 1 });
    assert.equal(rebuilt.activity.latestEvents.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workflow resume includes the local session snapshot", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-resume-session-"));
  try {
    writeWorkflowState(dir);
    appendActivityEvent({
      cwd: dir,
      source: "workflow",
      kind: "phase-start",
      title: "Resume consumes local activity",
      workflowId: "agentic-work",
      phaseId: "verify",
      files: ["packages/cli/src/commands/workflows.ts"],
      metadata: { action: "write" },
      timestamp: "2026-07-02T21:00:00.000Z",
    });
    const preloadPath = writeWorkflowPreload(dir);

    const result = runCli(["workflow", "resume", "--include-session-context", "--json"], {
      cwd: dir,
      env: {
        SNIPARA_API_KEY: "test-key",
        SNIPARA_PROJECT_ID: "snipara",
        SNIPARA_API_URL: "https://api.snipara.com",
      },
      nodeArgs: ["--require", preloadPath],
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.local_session_snapshot.schemaVersion, "snipara.session_snapshot.v0");
    assert.equal(
      payload.local_session_snapshot.summary.latestActivityTitle,
      "Resume consumes local activity"
    );
    assert.equal(payload.local_session_snapshot.summary.risk, "none");
    assert.deepEqual(payload.local_session_snapshot.summary.touchedFiles, [
      "packages/cli/src/commands/workflows.ts",
    ]);
    assert.equal(payload.local_session_snapshot.intentDetection.intent, "implementing_feature");
    assert.equal(payload.local_session_snapshot.intentDetection.hardRoutingAllowed, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workflow session prints advisory intent detection", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-session-intent-"));
  try {
    writeWorkflowState(dir);
    appendActivityEvent({
      cwd: dir,
      source: "workflow",
      kind: "test",
      title: "node --test failed",
      outcome: "failed",
      files: ["packages/cli/test/workflows.test.js", "packages/cli/src/commands/workflows.ts"],
      metadata: { action: "test" },
      timestamp: "2026-07-02T21:30:00.000Z",
    });
    appendActivityEvent({
      cwd: dir,
      source: "workflow",
      kind: "phase-commit",
      title: "Fix workflow session output",
      files: ["packages/cli/src/commands/workflows.ts"],
      metadata: { action: "write" },
      timestamp: "2026-07-02T21:31:00.000Z",
    });

    const result = runCli(["workflow", "session"], { cwd: dir });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Intent:\s+debugging \(high\)/);
    assert.match(result.stdout, /Suggested mode:\s+standard \(advisory\)/);
    assert.match(result.stdout, /Hard routing allowed:\s+false/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workflow decide creates review-only policy suggestion for repeated receipts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-policy-suggestion-"));
  try {
    const pendingDir = path.join(dir, ".snipara", "decisions", "pending");
    fs.mkdirSync(pendingDir, { recursive: true });

    function writePendingRequest(sourceRef) {
      const request = {
        schemaVersion: "snipara.decision_request.v0",
        requestId: `decision-${sourceRef}`,
        fingerprint: `fingerprint-${sourceRef}`,
        createdAt: "2026-07-02T20:00:00.000Z",
        producer: {
          kind: "memory_review_queue",
          command: "memory reviews",
          sourceRef,
        },
        decision: "reject_memory_candidate",
        question: `Reject memory candidate ${sourceRef}?`,
        blocking: false,
        expiresAt: null,
        evidence: {
          summary: "Repeated pi-hermes-ops memory should be rejected.",
          refs: [sourceRef],
          items: [
            {
              ref: `memory:${sourceRef}`,
              title: `pi-hermes memory ${sourceRef}`,
              summary: "pi-hermes-ops memory candidate",
              kind: "memory_review_queue",
              metadata: {
                category: "pi-hermes-ops",
                type: "decision",
              },
            },
          ],
          reasonCodes: ["duplicate_ops_memory", "human_rejected"],
          applyPath: "manual_context_review",
          applyCommand: "Review memory queue manually.",
        },
        options: ["accept", "reject"],
        recommendation: "reject",
      };
      fs.writeFileSync(
        path.join(pendingDir, `${request.requestId}.json`),
        `${stableTestJsonStringify(request)}\n`,
        "utf8"
      );
      return request;
    }

    const first = writePendingRequest("mem_1");
    let result = runCli(
      [
        "workflow",
        "decide",
        first.requestId,
        "--choose",
        "reject",
        "--reviewer",
        "alopez",
        "--note",
        "pi-hermes duplicate from old deployment notes",
        "--json",
      ],
      { cwd: dir }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).policySuggestionWrite, undefined);

    const second = writePendingRequest("mem_2");
    result = runCli(
      [
        "workflow",
        "decide",
        second.requestId,
        "--choose",
        "reject",
        "--reviewer",
        "alopez",
        "--note",
        "pi-hermes backfill resurrected obsolete notes",
        "--json",
      ],
      { cwd: dir }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.policySuggestionWrite.status, "written");
    assert.equal(payload.policySuggestion.producer.kind, "policy_suggestion");
    assert.equal(payload.policySuggestion.evidence.applyPath, "manual_context_review");
    assert.match(payload.policySuggestion.evidence.applyCommand, /manually/);

    const timeline = JSON.parse(
      fs
        .readFileSync(path.join(dir, ".snipara", "activity", "timeline.jsonl"), "utf8")
        .trim()
        .split("\n")
        .at(-1)
    );
    assert.equal(timeline.kind, "policy-suggestion-created");
    assert.equal(timeline.metadata.manualApplyRequired, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workflow policy-ledger summarizes pending and resolved policy decisions for agents", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-policy-ledger-"));
  try {
    const pendingDir = path.join(dir, ".snipara", "decisions", "pending");
    fs.mkdirSync(pendingDir, { recursive: true });
    const policyRequest = {
      schemaVersion: "snipara.decision_request.v0",
      requestId: "decision-policy-auth",
      fingerprint: "fingerprint-policy-auth",
      createdAt: "2026-07-06T08:00:00.000Z",
      producer: {
        kind: "project_policy_review",
        command: "run --emit-policy-decisions",
        sourceRef: "policy:auth",
      },
      decision: "project_policy_require_review",
      question: "May the agent proceed once on the auth policy change?",
      blocking: true,
      expiresAt: null,
      evidence: {
        summary: "Project Policy requires review before auth changes.",
        refs: ["policy:auth"],
        reasonCodes: ["project_policy_review"],
        files: ["src/auth.ts"],
        applyPath: "manual_project_policy_review",
        applyCommand: "Resolve with snipara-companion workflow decide.",
      },
      options: ["approve_once", "require_changes", "mark_policy_stale", "keep_advisory"],
      recommendation: "require_changes",
    };
    fs.writeFileSync(
      path.join(pendingDir, `${policyRequest.requestId}.json`),
      `${stableTestJsonStringify(policyRequest)}\n`,
      "utf8"
    );

    let result = runCli(["workflow", "policy-ledger", "--json"], { cwd: dir });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    let payload = JSON.parse(result.stdout);
    assert.equal(payload.summary.pending, 1);
    assert.equal(payload.summary.refused, 0);
    assert.equal(payload.entries[0].producerKind, "project_policy_review");
    assert.match(payload.agentPrompt[0], /Ask the user/);
    assert.match(payload.agentPrompt[0], /workflow decide decision-policy-auth/);

    result = runCli(
      [
        "workflow",
        "decide",
        policyRequest.requestId,
        "--choose",
        "require_changes",
        "--reviewer",
        "alopez",
        "--note",
        "auth policy needs a narrower plan",
        "--json",
      ],
      { cwd: dir }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    result = runCli(["workflow", "policy-ledger", "--json"], { cwd: dir });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    payload = JSON.parse(result.stdout);
    assert.equal(payload.summary.pending, 0);
    assert.equal(payload.summary.refused, 1);
    assert.equal(payload.entries[0].status, "refused");
    assert.equal(payload.entries[0].humanChoice, "require_changes");
    assert.equal(
      payload.agentPrompt[0],
      "No pending Project Policy decision needs a human response right now."
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workflow apply-decisions previews and writes policy suggestion drafts idempotently", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-apply-decisions-"));
  try {
    const resolvedDir = path.join(dir, ".snipara", "decisions", "resolved");
    fs.mkdirSync(resolvedDir, { recursive: true });
    const record = {
      schemaVersion: "snipara.decision_resolution.v0",
      request: {
        schemaVersion: "snipara.decision_request.v0",
        requestId: "decision-promote-policy",
        fingerprint: "fingerprint-promote-policy",
        createdAt: "2026-07-06T08:00:00.000Z",
        producer: {
          kind: "policy_suggestion",
          command: "workflow decide",
          sourceRef: ".snipara/decisions/resolved",
        },
        decision: "promote_recurring_decision_policy",
        question: "Create a reusable triage policy?",
        blocking: false,
        expiresAt: null,
        evidence: {
          summary: "Repeated decisions should become a reviewable Project Policy draft.",
          refs: ["decision-a", "decision-b"],
          reasonCodes: ["recurring_decision_receipts", "project_policy"],
          files: ["AGENTS.md"],
          applyPath: "manual_context_review",
          applyCommand: "Review the suggested rule manually.",
        },
        options: ["create_policy_suggestion", "ignore_once", "reject_policy_suggestion"],
        recommendation: "create_policy_suggestion",
      },
      response: {
        schemaVersion: "snipara.decision_response.v0",
        requestId: "decision-promote-policy",
        choice: "create_policy_suggestion",
        reviewer: "alopez",
        note: "Make it a local draft first.",
        appliedActions: [],
        resolvedAt: "2026-07-06T08:05:00.000Z",
      },
    };
    fs.writeFileSync(
      path.join(resolvedDir, `${record.request.requestId}.json`),
      `${stableTestJsonStringify(record)}\n`,
      "utf8"
    );

    let result = runCli(["workflow", "apply-decisions", "--dry-run", "--json"], { cwd: dir });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    let payload = JSON.parse(result.stdout);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.summary.needsApply, 1);
    assert.equal(payload.summary.written, 0);
    assert.equal(payload.items[0].state, "needs_apply");
    assert.match(payload.items[0].policyDraftPath, /\.snipara\/policies\/drafts/);
    assert.equal(
      fs.existsSync(
        path.join(dir, ".snipara", "policies", "drafts", "decision-promote-policy.json")
      ),
      false
    );

    result = runCli(["workflow", "apply-decisions", "--json"], { cwd: dir });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    payload = JSON.parse(result.stdout);
    assert.equal(payload.dryRun, false);
    assert.equal(payload.summary.written, 1);
    assert.equal(payload.summary.applied, 1);
    assert.equal(payload.items[0].state, "applied");
    assert.equal(
      fs.existsSync(
        path.join(dir, ".snipara", "policies", "drafts", "decision-promote-policy.json")
      ),
      true
    );

    result = runCli(["workflow", "apply-decisions", "--json"], { cwd: dir });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    payload = JSON.parse(result.stdout);
    assert.equal(payload.summary.written, 0);
    assert.equal(payload.summary.applied, 1);
    assert.equal(payload.items[0].alreadyApplied, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workflow sync-policy-ledger dry-run collects local policy receipts without network", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-sync-policy-ledger-"));
  try {
    const resolvedDir = path.join(dir, ".snipara", "decisions", "resolved");
    fs.mkdirSync(resolvedDir, { recursive: true });
    const record = {
      schemaVersion: "snipara.decision_resolution.v0",
      request: {
        schemaVersion: "snipara.decision_request.v0",
        requestId: "decision-sync-policy",
        fingerprint: "fingerprint-sync-policy",
        createdAt: "2026-07-06T08:00:00.000Z",
        producer: {
          kind: "policy_suggestion",
          command: "workflow decide",
          sourceRef: ".snipara/decisions/resolved",
        },
        decision: "promote_sync_policy",
        question: "Create a reusable sync policy?",
        blocking: false,
        expiresAt: null,
        evidence: {
          summary: "Repeated decisions should be visible in the hosted ledger.",
          refs: ["decision-sync-policy"],
          reasonCodes: ["project_policy"],
          files: ["AGENTS.md"],
          applyPath: "manual_context_review",
          applyCommand: "Review the suggested rule manually.",
        },
        options: ["create_policy_suggestion", "reject_policy_suggestion"],
        recommendation: "create_policy_suggestion",
      },
      response: {
        schemaVersion: "snipara.decision_response.v0",
        requestId: "decision-sync-policy",
        choice: "create_policy_suggestion",
        reviewer: "alopez",
        note: "Sync this receipt.",
        appliedActions: [],
        resolvedAt: "2026-07-06T08:05:00.000Z",
      },
    };
    fs.writeFileSync(
      path.join(resolvedDir, `${record.request.requestId}.json`),
      `${stableTestJsonStringify(record)}\n`,
      "utf8"
    );

    let result = runCli(["workflow", "apply-decisions", "--json"], { cwd: dir });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    result = runCli(["workflow", "sync-policy-ledger", "--dry-run", "--json"], { cwd: dir });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.summary.resolvedDecisions, 1);
    assert.equal(payload.summary.applyReceipts, 1);
    assert.equal(payload.summary.policyDrafts, 1);
    assert.equal(payload.summary.total, 3);
    assert.deepEqual(payload.artifacts.map((artifact) => artifact.kind).sort(), [
      "apply_receipt",
      "decision_resolution",
      "policy_draft",
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
