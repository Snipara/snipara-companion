const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const {
  archiveInactiveTeamSyncWork,
  buildAgenticHandoffMarkdown,
  buildTeamSyncHandoffRecord,
  buildTeamSyncStartWorkRecord,
  buildTeamSyncSummary,
  completeTeamSyncWorkFromEvidence,
  createEmptyTeamSyncState,
  getTeamSyncStatePath,
  loadTeamSyncState,
  ORCHESTRATOR_HANDOFF_RELATIVE_PATH,
  saveTeamSyncState,
  TEAM_SYNC_STATE_RELATIVE_PATH,
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

function writeHostedTeamSyncPreload(dir) {
  const preloadPath = path.join(dir, "team-sync-preload.js");
  fs.writeFileSync(
    preloadPath,
    [
      "const fs = require('node:fs');",
      "globalThis.fetch = async (url, init = {}) => {",
      "  const parsedUrl = new URL(String(url));",
      "  const path = parsedUrl.pathname;",
      "  if (path.includes('/mcp/')) {",
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
      "    if (toolName === 'snipara_session_memories') {",
      "      return {",
      "        ok: true,",
      "        status: 200,",
      "        statusText: 'OK',",
      "        json: async () => ({",
      "          jsonrpc: '2.0',",
      "          id: 1,",
      "          result: {",
      "            content: [{",
      "              type: 'text',",
      "              text: JSON.stringify({",
      "                critical: { memories: [{ id: 'mem_1', content: 'workflow phase committed' }], count: 1, tokens: 120 },",
      "                daily: { memories: [{ id: 'ctx_1', content: 'resume with hosted handoff' }], count: 1, tokens: 80 },",
      "                total_tokens: 200,",
      "              }),",
      "            }],",
      "          },",
      "        }),",
      "      };",
      "    }",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      statusText: 'OK',",
      "      json: async () => ({",
      "        jsonrpc: '2.0',",
      "        id: 1,",
      "        result: { content: [{ type: 'text', text: '{}' }] },",
      "      }),",
      "    };",
      "  }",
      "  if (path.endsWith('/team-sync/work-briefs')) {",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      statusText: 'OK',",
      "      json: async () => ({",
      "        success: true,",
      "        data: {",
      "          project: { id: 'project_1', name: 'App', slug: 'app', githubRepo: 'acme/app', githubBranch: 'main' },",
      "          brief: {",
      "            id: 'brief_1',",
      "            generatedAt: '2026-05-25T12:45:00.000Z',",
      "            task: 'Add invite permissions',",
      "            evidenceLevel: 'clear',",
      "            summary: 'Hosted start-work brief',",
      "            likelyFiles: [{ path: 'apps/web/src/lib/auth/permissions.ts', score: 100, reason: 'task match' }],",
      "            likelySymbols: [],",
      "            activeCollisions: [{ path: 'apps/web/src/lib/billing/checkout.ts', workItemIds: ['pack_182'], workItemTitles: ['Billing checkout'], severity: 'medium' }],",
      "            relevantDecisions: [{ id: 'decision_1', title: 'Invited users keep personal API keys', status: 'ACTIVE', impact: 'HIGH', updatedAt: '2026-05-25T12:00:00.000Z', summary: 'keep keys', tags: ['auth'], recommendedAction: 'Review auth rule' }],",
      "            recommendedReads: [],",
      "            recommendedTests: ['pnpm test auth'],",
      "            recommendedTools: [],",
      "            packageSurfaces: ['snipara-companion'],",
      "            releaseSurfaces: [],",
      "            sourceFacts: [],",
      "            freshness: { index: null, codeGraph: null, caveats: [] },",
      "            sessionContext: null,",
      "            recommendedActions: ['Verify ownership guard before route edits.'],",
      "            caveats: ['Index health is omitted for API-key Start Work Brief requests today.'],",
      "            target: { repository: 'acme/app', branch: 'invite-permissions', baseSha: null, projectDefaultBranch: 'main', sessionId: 'session_1', client: 'codex' },",
      "          },",
      "          whatChanged: {",
      "            version: 'what-changed-v2',",
      "            generatedAt: '2026-05-25T12:45:00.000Z',",
      "            scope: { mode: 'for_paths', paths: ['apps/web/src/lib/auth/permissions.ts'], explicitPaths: [], recentFiles: ['apps/web/src/lib/auth/permissions.ts'], branch: 'invite-permissions', projectDefaultBranch: 'main', sessionId: 'session_1', since: null },",
      "            summary: { changeCount: 1, directChanges: 1, nearbyChanges: 0, projectChanges: 0, criticalSurfaceChanges: 0, failedPacks: 0, weakAuthorityChanges: 0, branchFiltered: true, branchMatches: 1, sessionSignals: 0, executionSessions: 0, executionEvents: 0, decisionChanges: 1, staleAssumptions: 0, overlapClusters: 1, failedJobs: 0, recommendedActions: 1, latestChangedAt: '2026-05-25T12:44:00.000Z' },",
      "            changes: [{ id: 'pack_1', title: 'Harden invite permissions', repository: 'acme/app', pullNumber: 42, sourceUrl: 'https://github.com/acme/app/pull/42', status: 'READY', updatedAt: '2026-05-25T12:44:00.000Z', headSha: 'abc123', branch: 'invite-permissions', relevance: 'direct', changedFiles: ['apps/web/src/lib/auth/permissions.ts'], matchedFiles: ['apps/web/src/lib/auth/permissions.ts'], impactedSymbols: ['auth.hasProjectAccess'], recommendedAction: 'Review permission guard changes' }],",
      "            decisions: [{ id: 'decision_1', title: 'Invited users keep personal API keys', status: 'ACTIVE', impact: 'HIGH', updatedAt: '2026-05-25T12:00:00.000Z', summary: 'keep keys', tags: ['auth'], recommendedAction: 'Review auth rule' }],",
      "            staleAssumptions: [],",
      "            failedJobs: [],",
      "            freshness: { index: null, codeGraph: null, caveats: [] },",
      "            sessionContext: null,",
      "            recommendedActions: ['Verify ownership guard before route edits.'],",
      "            caveats: [],",
      "          },",
      "        },",
      "      }),",
      "    };",
      "  }",
      "  if (path.endsWith('/team-sync/changes')) {",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      statusText: 'OK',",
      "      json: async () => ({",
      "        success: true,",
      "        data: {",
      "          project: { id: 'project_1', name: 'App', slug: 'app', githubRepo: 'acme/app', githubBranch: 'main' },",
      "          limit: 25,",
      "          whatChanged: {",
      "            version: 'what-changed-v2',",
      "            generatedAt: '2026-05-25T12:46:00.000Z',",
      "            scope: { mode: 'for_paths', paths: ['apps/web/src/lib/auth/permissions.ts'], explicitPaths: [], recentFiles: ['apps/web/src/lib/auth/permissions.ts'], branch: 'invite-permissions', projectDefaultBranch: 'main', sessionId: 'session_1', since: null },",
      "            summary: { changeCount: 2, directChanges: 1, nearbyChanges: 0, projectChanges: 1, criticalSurfaceChanges: 0, failedPacks: 0, weakAuthorityChanges: 0, branchFiltered: true, branchMatches: 1, sessionSignals: 1, executionSessions: 1, executionEvents: 2, decisionChanges: 1, staleAssumptions: 1, overlapClusters: 1, failedJobs: 0, recommendedActions: 1, latestChangedAt: '2026-05-25T12:46:00.000Z' },",
      "            changes: [{ id: 'pack_1', title: 'Harden invite permissions', repository: 'acme/app', pullNumber: 42, sourceUrl: 'https://github.com/acme/app/pull/42', status: 'READY', updatedAt: '2026-05-25T12:44:00.000Z', headSha: 'abc123', branch: 'invite-permissions', relevance: 'direct', changedFiles: ['apps/web/src/lib/auth/permissions.ts'], matchedFiles: ['apps/web/src/lib/auth/permissions.ts'], impactedSymbols: ['auth.hasProjectAccess'], recommendedAction: 'Review permission guard changes' }],",
      "            decisions: [{ id: 'decision_1', title: 'Invited users keep personal API keys', status: 'ACTIVE', impact: 'HIGH', updatedAt: '2026-05-25T12:00:00.000Z', summary: 'keep keys', tags: ['auth'], recommendedAction: 'Review auth rule' }],",
      "            staleAssumptions: [{ id: 'stale_1', severity: 'warning', reason: 'Billing checkout is still active in PR #182.', observedAt: '2026-05-25T12:43:00.000Z', recommendedAction: 'Re-check collision risk before merge.' }],",
      "            failedJobs: [],",
      "            freshness: { index: null, codeGraph: null, caveats: [] },",
      "            sessionContext: { sessionId: 'session_1', latestAt: '2026-05-25T12:40:00.000Z', files: ['apps/web/src/lib/auth/permissions.ts'], commands: ['pnpm test auth'], tasks: ['Inspect invite permissions'], checkpoints: [], contexts: [], runtime: null, caveats: [] },",
      "            recommendedActions: ['Verify ownership guard before route edits.'],",
      "            caveats: ['Index health is omitted for API-key Team Sync changes requests today.'],",
      "          },",
      "          changes: [{ id: 'pack_1', title: 'Harden invite permissions', repository: 'acme/app', pullNumber: 42, sourceUrl: 'https://github.com/acme/app/pull/42', status: 'READY', updatedAt: '2026-05-25T12:44:00.000Z', headSha: 'abc123', branch: 'invite-permissions', relevance: 'direct', changedFiles: ['apps/web/src/lib/auth/permissions.ts'], matchedFiles: ['apps/web/src/lib/auth/permissions.ts'], impactedSymbols: ['auth.hasProjectAccess'], recommendedAction: 'Review permission guard changes' }],",
      "        },",
      "      }),",
      "    };",
      "  }",
      "  if (path.endsWith('/team-sync/handoffs') && init.method === 'POST') {",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      statusText: 'OK',",
      "      json: async () => ({",
      "        success: true,",
      "        data: {",
      "          project: { id: 'project_1', name: 'App', slug: 'app' },",
      "          handoff: { id: 'handoff_hosted_1', summary: 'Moved project access check', task: 'Add invite permissions', branch: 'invite-permissions', baseSha: 'abc123', headSha: 'abc123', sessionId: 'session_1', client: 'codex', files: ['apps/web/src/lib/auth/permissions.ts'], commands: [], tests: ['pnpm test auth'], blocker: null, assumptions: [], nextStep: 'Run permissions tests before merge', attention: 'proof_required', durable: false, createdAt: '2026-05-25T12:47:00.000Z', expiresAt: null, source: 'companion', createdBy: 'API key', caveats: [] },",
      "        },",
      "      }),",
      "    };",
      "  }",
      "  if (path.endsWith('/agents/memory/why-capture') && init.method === 'POST') {",
      "    const body = JSON.parse(init.body || '{}');",
      "    const logPath = process.env.SNIPARA_TEST_WHY_CAPTURE_LOG;",
      "    if (logPath) {",
      "      fs.appendFileSync(logPath, `${JSON.stringify(body)}\\n`, 'utf8');",
      "    }",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      statusText: 'OK',",
      "      json: async () => ({ success: true, data: { previewOnly: body.previewOnly === true, confirmed: body.confirmed === true, candidateCount: 1, ...(body.confirmed ? { capturedCount: 1 } : {}) } }),",
      "    };",
      "  }",
      "  if (path.endsWith('/team-sync/handoffs/latest')) {",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      statusText: 'OK',",
      "      json: async () => ({",
      "        success: true,",
      "        data: {",
      "          project: { id: 'project_1', name: 'App', slug: 'app' },",
      "          handoff: { id: 'handoff_hosted_1', summary: 'Moved project access check', task: 'Add invite permissions', branch: 'invite-permissions', baseSha: 'abc123', headSha: 'abc123', sessionId: 'session_1', client: 'codex', files: ['apps/web/src/lib/auth/permissions.ts'], commands: ['pnpm test auth'], tests: ['pnpm test auth'], blocker: 'Confirm ownership guard before merge.', assumptions: [], nextStep: 'Run permissions tests before merge', attention: 'proof_required', durable: false, createdAt: '2026-05-25T12:47:00.000Z', expiresAt: null, source: 'companion', createdBy: 'API key', caveats: [] },",
      "          match: { score: 0.92, reasons: ['branch match', 'file overlap'] },",
      "          sessionContext: { sessionId: 'session_1', latestAt: '2026-05-25T12:48:00.000Z', files: ['apps/web/src/lib/auth/permissions.ts'], commands: ['pnpm test auth'], tasks: ['Inspect invite permissions'], checkpoints: [{ id: 'checkpoint_1', sessionId: 'session_1', task: 'Inspect invite permissions', source: 'manual', filesTracked: ['apps/web/src/lib/auth/permissions.ts'], commands: ['pnpm test auth'], createdAt: '2026-05-25T12:48:00.000Z', expiresAt: null }], contexts: [], runtime: null, caveats: [] },",
      "          executionMemory: { sessions: [], events: [], caveats: [] },",
      "          recommendedActions: ['Run permissions tests before merge.', 'Inspect the latest checkpoint before re-running commands.'],",
      "          caveats: [],",
      "        },",
      "      }),",
      "    };",
      "  }",
      "  if (path.endsWith('/automation/events') && init.method === 'POST') {",
      "    const body = JSON.parse(init.body || '{}');",
      "    const events = Array.isArray(body.events) ? body.events : [];",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      statusText: 'OK',",
      "      json: async () => ({",
      "        success: true,",
      "        data: {",
      "          accepted: events.length,",
      "          sessionIds: [...new Set(events.map((event) => event.session_id || 'session_1'))],",
      "          events: [{ id: 'runtime_event_receipt_1', sessionId: process.env.SNIPARA_SESSION_ID || 'session_1', createdAt: '2026-05-25T12:49:00.000Z', task: 'Runtime checkpoint', source: 'auto' }],",
      "        },",
      "      }),",
      "    };",
      "  }",
      "  if (path.endsWith('/automation/events')) {",
      "    const workflowId = process.env.SNIPARA_TEST_WORKFLOW_ID || 'align-team-sync';",
      "    const phaseId = process.env.SNIPARA_TEST_PHASE_ID || 'phase-4';",
      "    const sandboxSessionId = process.env.SNIPARA_TEST_SANDBOX_SESSION_ID || 'sandbox-align-team-sync-phase-4-abc123';",
      "    return {",
      "      ok: true,",
      "      status: 200,",
      "      statusText: 'OK',",
      "      json: async () => ({",
      "        success: true,",
      "        data: {",
      "          count: 1,",
      "          events: [{",
      "            id: 'runtime_event_1',",
      "            sessionId: process.env.SNIPARA_SESSION_ID || 'session_1',",
      "            createdAt: '2026-05-25T12:49:00.000Z',",
      "            event: {",
      "              type: 'tool_result',",
      "              client: 'snipara-companion',",
      "              workspace: '/tmp/workspace',",
      "              session_id: process.env.SNIPARA_SESSION_ID || 'session_1',",
      "              agent_id: 'local-agent',",
      "              timestamp: '2026-05-25T12:49:00.000Z',",
      "              privacy_level: 'standard',",
      "              payload: {",
      "                tool_name: 'snipara_sandbox_runtime_checkpoint',",
      "                task: 'Align snipara-companion outputs',",
      "                files: ['packages/cli/src/commands/team-sync.ts'],",
      "                commands: ['pnpm test auth'],",
      "                workflow_id: workflowId,",
      "                workflow_phase_id: phaseId,",
      "                runtime_checkpoint: {",
      "                  summary: process.env.SNIPARA_TEST_RUNTIME_SUMMARY || 'Resume-ready sandbox state',",
      "                  captured_at: '2026-05-25T12:49:00.000Z',",
      "                  automation_session_id: process.env.SNIPARA_SESSION_ID || 'session_1',",
      "                  sandbox_session_id: sandboxSessionId,",
      "                  environment: 'docker',",
      "                  profile: 'analysis',",
      "                  bootstrap_query: 'Align the hosted resume output',",
      "                  files: ['packages/cli/src/commands/team-sync.ts'],",
      "                  commands: ['pnpm test auth'],",
      "                  artifacts: ['artifacts/runtime.json'],",
      "                  rehydratable_state: { inputs: { target: 'auth' } },",
      "                },",
      "              },",
      "            },",
      "          }],",
      "        },",
      "      }),",
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

test("team sync records are deterministic for the same timestamp and content", () => {
  const now = new Date("2026-05-14T12:00:00.000Z");
  const record = buildTeamSyncStartWorkRecord({
    summary: "Refactor auth middleware",
    files: ["apps/web/src/lib/auth/require-auth.ts", "apps/web/src/lib/auth/require-auth.ts"],
    branch: "codex/auth-refactor",
    actor: "codex",
    now,
  });

  assert.equal(record.id, "work_703fd9b99b");
  assert.equal(record.type, "work");
  assert.deepEqual(record.files, ["apps/web/src/lib/auth/require-auth.ts"]);
  assert.equal(record.branch, "codex/auth-refactor");
  assert.equal(record.actor, "codex");
  assert.equal(record.updatedAt, "2026-05-14T12:00:00.000Z");
});

test("team sync handoff summary includes active work, handoffs, and touched files", () => {
  const state = createEmptyTeamSyncState(new Date("2026-05-14T12:00:00.000Z"));
  state.work.push(
    buildTeamSyncStartWorkRecord({
      summary: "Refactor auth middleware",
      files: ["apps/web/src/lib/auth/require-auth.ts"],
      now: new Date("2026-05-14T12:01:00.000Z"),
    })
  );
  state.handoffs.push(
    buildTeamSyncHandoffRecord({
      summary: "Moved project access check",
      next: "Run permissions tests",
      attention: "proof",
      files: ["apps/web/src/lib/auth/require-auth.ts", "apps/web/src/lib/auth/permissions.ts"],
      now: new Date("2026-05-14T12:02:00.000Z"),
    })
  );

  const summary = buildTeamSyncSummary(state, undefined, new Date("2026-05-14T12:03:00.000Z"));

  assert.equal(summary.activeWorkCount, 1);
  assert.equal(summary.staleWorkCount, 0);
  assert.equal(summary.completedWorkCount, 0);
  assert.equal(summary.handoffCount, 1);
  assert.equal(summary.latestHandoff.summary, "Moved project access check");
  assert.deepEqual(summary.files, [
    "apps/web/src/lib/auth/permissions.ts",
    "apps/web/src/lib/auth/require-auth.ts",
  ]);
});

test("agentic handoff markdown exposes the expected sections", () => {
  const record = buildTeamSyncHandoffRecord({
    summary: "Moved project access check",
    next: "Run permissions tests",
    attention: "proof",
    files: ["apps/web/src/lib/auth/permissions.ts"],
    now: new Date("2026-05-14T12:02:00.000Z"),
  });

  const markdown = buildAgenticHandoffMarkdown({
    version: "snipara.agentic_handoff.v1",
    generatedAt: "2026-05-14T12:02:00.000Z",
    command: "snipara-companion handoff",
    record,
    statePath: "/tmp/work/.snipara/team-sync/session.json",
    hosted: { status: "skipped" },
    sections: {
      whatChanged: ["Moved project access check"],
      verified: ["Local handoff recorded."],
      risky: ["Attention: proof."],
      remains: ["Run permissions tests"],
      whereToResume: ["snipara-companion status"],
    },
    suggestedCommands: ["snipara-companion status"],
  });

  assert.match(markdown, /# Agent Handoff/);
  assert.match(markdown, /## What Changed/);
  assert.match(markdown, /## What Is Verified/);
  assert.match(markdown, /## What Is Risky/);
  assert.match(markdown, /## What Remains/);
  assert.match(markdown, /## Where To Resume/);
});

test("top-level handoff persists Team Sync and writes an artifact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-agentic-handoff-"));
  const output = path.join(dir, "handoff.md");

  const result = runCli(
    [
      "handoff",
      "--summary",
      "Moved project access check",
      "--next",
      "Run permissions tests",
      "--attention",
      "proof",
      "--files",
      "apps/web/src/lib/auth/permissions.ts",
      "--output",
      output,
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /# Agent Handoff/);
  assert.match(result.stdout, /## Where To Resume/);
  assert.ok(fs.existsSync(output));
  assert.match(fs.readFileSync(output, "utf8"), /Moved project access check/);

  const state = loadTeamSyncState(dir);
  assert.equal(state.handoffs.length, 1);
  assert.equal(state.handoffs[0].summary, "Moved project access check");
  assert.equal(state.handoffs[0].attention, "proof");
});

test("top-level handoff json returns the artifact schema", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-agentic-handoff-json-"));

  const result = runCli(
    [
      "handoff",
      "--summary",
      "Status command ready",
      "--next",
      "Publish package",
      "--files",
      "packages/cli/src/index.ts",
      "--json",
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.version, "snipara.agentic_handoff.v1");
  assert.equal(payload.record.summary, "Status command ready");
  assert.deepEqual(payload.sections.remains, ["Publish package"]);
  assert.ok(payload.suggestedCommands.includes("snipara-companion status"));
});

test("top-level handoff can attach an ADE adapter pack", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-agentic-handoff-adapter-"));

  const result = runCli(
    [
      "handoff",
      "--summary",
      "Auth hardening ready for delegated implementation",
      "--next",
      "Run auth regression tests",
      "--files",
      "apps/web/src/lib/auth.ts",
      "--attention",
      "proof",
      "--adapter-pack",
      "--target",
      "codex",
      "--context",
      "AGENTS.md",
      "docs/features/PROJECT_INTELLIGENCE.md",
      "--proof",
      "pnpm test auth",
      "--acceptance",
      "auth tests pass",
      "--conflict-posture",
      "review_only",
      "--json",
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.adapter.version, "snipara.ade_adapter_pack.v1");
  assert.equal(payload.adapter.target.id, "codex");
  assert.equal(payload.adapter.conflictPosture, "review_only");
  assert.deepEqual(payload.adapter.proofGates, ["pnpm test auth"]);
  assert.deepEqual(payload.adapter.acceptanceCriteria, ["auth tests pass"]);
  assert.ok(payload.adapter.receiptExpectation.required);
  assert.match(payload.adapter.receiptExpectation.command, /snipara-companion handoff/);
  assert.ok(payload.adapter.receiptExpectation.requiredFields.includes("proofVerificationStatus"));
  assert.ok(payload.adapter.receiptExpectation.requiredFields.includes("proofSource"));
  assert.equal(payload.adapter.target.profile, "Hosted MCP-aware coding agent");
  assert.equal(payload.adapter.target.runtimeControl, "handoff_only");
  assert.match(payload.adapter.prompt, /Auth hardening ready/);
  assert.match(payload.adapter.prompt, /proofVerification\.status=verified/);
  assert.match(payload.adapter.caveats.join("\n"), /does not control the target client runtime/);
});

test("top-level handoff preserves commas inside adapter acceptance criteria", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-agentic-handoff-comma-"));

  const result = runCli(
    [
      "handoff",
      "--summary",
      "Route orchestrator artifact",
      "--next",
      "Run gate",
      "--adapter-pack",
      "--acceptance",
      "handoff has schemaVersion, routing, coordination, and validation",
      "--json",
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.adapter.acceptanceCriteria, [
    "handoff has schemaVersion, routing, coordination, and validation",
  ]);
});

test("top-level handoff normalizes claude adapter alias to Claude Code", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-agentic-handoff-claude-"));

  const result = runCli(
    [
      "handoff",
      "--summary",
      "Docs update ready",
      "--next",
      "Run docs tests",
      "--adapter-pack",
      "--target",
      "claude",
      "--json",
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.adapter.target.id, "claude-code");
  assert.match(payload.adapter.target.instruction, /canonical receipt fields/);
  assert.equal(payload.adapter.target.runtimeControl, "handoff_only");
});

test("top-level handoff supports portable ADE adapter targets", () => {
  for (const target of ["cursor", "orca", "kimi", "custom"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `snipara-agentic-handoff-${target}-`));

    const result = runCli(
      [
        "handoff",
        "--summary",
        `${target} handoff`,
        "--next",
        "Return proof receipt",
        "--adapter-pack",
        "--target",
        target,
        "--json",
      ],
      { cwd: dir }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.adapter.target.id, target);
    assert.ok(payload.adapter.target.profile);
    assert.equal(payload.adapter.target.runtimeControl, "handoff_only");
    assert.match(payload.adapter.prompt, new RegExp(`${target} handoff`));
    assert.match(payload.adapter.caveats.join("\n"), /portable contract/);
  }
});

test("team sync summary separates active, stale, and completed work", () => {
  const state = createEmptyTeamSyncState(new Date("2026-05-17T12:00:00.000Z"));
  const stale = buildTeamSyncStartWorkRecord({
    summary: "Legacy API key cleanup",
    now: new Date("2026-05-15T09:00:00.000Z"),
  });
  const active = buildTeamSyncStartWorkRecord({
    summary: "Harden team sync output",
    now: new Date("2026-05-17T10:00:00.000Z"),
  });
  const completed = buildTeamSyncStartWorkRecord({
    summary: "Close stale work items",
    now: new Date("2026-05-16T11:00:00.000Z"),
  });
  completed.status = "completed";
  completed.completedAt = "2026-05-17T08:30:00.000Z";
  completed.updatedAt = "2026-05-17T08:30:00.000Z";
  completed.completionReason = "Merged locally";

  state.work.push(stale, active, completed);

  const summary = buildTeamSyncSummary(state, undefined, new Date("2026-05-17T12:00:00.000Z"));

  assert.equal(summary.activeWorkCount, 1);
  assert.equal(summary.staleWorkCount, 1);
  assert.equal(summary.completedWorkCount, 1);
  assert.equal(summary.latestActiveWork.summary, "Harden team sync output");
  assert.equal(summary.latestStaleWork.summary, "Legacy API key cleanup");
  assert.equal(summary.latestCompletedWork.summary, "Close stale work items");
  assert.equal(summary.staleWorkExplanation.staleAfterHours, 48);
  assert.equal(summary.staleWorkExplanation.autoArchiveAfterDays, 14);
  assert.equal(summary.staleWorkExplanation.activeStaleCount, 1);
  assert.equal(summary.staleWorkExplanation.autoArchivableCount, 0);
  assert.equal(summary.staleWorkExplanation.completedIgnoredCount, 1);
  assert.match(
    summary.staleWorkExplanation.message,
    /stale after 48h but not old enough for 14d sweep auto-archive/
  );
  assert.equal(summary.hygieneActions.length, 2);
  assert.equal(summary.hygieneActions[0].kind, "complete-work");
  assert.match(summary.hygieneActions[0].command, /team-sync complete-work --id/);
  assert.equal(summary.hygieneActions[1].kind, "handoff");
});

test("team sync archives active work after the inactivity threshold", () => {
  const state = createEmptyTeamSyncState(new Date("2026-05-17T12:00:00.000Z"));
  const oldWork = buildTeamSyncStartWorkRecord({
    summary: "Investigate old release thread",
    now: new Date("2026-05-01T10:00:00.000Z"),
  });
  const freshWork = buildTeamSyncStartWorkRecord({
    summary: "Continue current release",
    now: new Date("2026-05-17T10:00:00.000Z"),
  });
  state.work.push(oldWork, freshWork);

  const archived = archiveInactiveTeamSyncWork(state, {
    now: new Date("2026-05-17T12:00:00.000Z"),
    thresholdMs: 14 * 24 * 60 * 60 * 1000,
  });
  const summary = buildTeamSyncSummary(state, undefined, new Date("2026-05-17T12:00:00.000Z"));

  assert.equal(archived.length, 1);
  assert.equal(archived[0].summary, "Investigate old release thread");
  assert.equal(state.work[0].status, "archived");
  assert.equal(state.work[0].archivedAt, "2026-05-17T12:00:00.000Z");
  assert.equal(state.work[0].archiveReason, "No update for 14 day(s)");
  assert.equal(summary.activeWorkCount, 1);
  assert.equal(summary.staleWorkCount, 0);
  assert.equal(summary.archivedWorkCount, 1);
  assert.equal(summary.latestArchivedWork.summary, "Investigate old release thread");
});

test("team sync completes active work from workflow completion evidence", () => {
  const state = createEmptyTeamSyncState(new Date("2026-05-17T12:00:00.000Z"));
  state.work.push(
    buildTeamSyncStartWorkRecord({
      summary: "Implement Outcome Loop RFC in executable phase commits",
      files: ["docs/planning/OUTCOME_LOOP_RFC.md", "apps/web/src/lib/jobs"],
      now: new Date("2026-05-17T10:00:00.000Z"),
    }),
    buildTeamSyncStartWorkRecord({
      summary: "Promote and deploy Outcome Loop release from dev to production",
      files: ["docs/planning/OUTCOME_LOOP_RFC.md"],
      now: new Date("2026-05-17T10:05:00.000Z"),
    })
  );

  const completed = completeTeamSyncWorkFromEvidence(state, {
    workflowGoal: "Implement Outcome Loop RFC in executable phase commits",
    summary: "All Outcome Loop implementation phases completed",
    files: ["docs/planning/OUTCOME_LOOP_RFC.md"],
    reason: "Workflow outcome-loop completed.",
    now: new Date("2026-05-17T12:00:00.000Z"),
  });
  const summary = buildTeamSyncSummary(state, undefined, new Date("2026-05-17T12:00:00.000Z"));

  assert.equal(completed.length, 1);
  assert.equal(completed[0].status, "completed");
  assert.equal(completed[0].completionReason, "Workflow outcome-loop completed.");
  assert.equal(state.work[1].status, "active");
  assert.equal(summary.activeWorkCount, 1);
  assert.equal(summary.completedWorkCount, 1);
});

test("team sync completes active work when workflow goal is slug-like but files and tokens match", () => {
  const state = createEmptyTeamSyncState(new Date("2026-06-29T18:00:00.000Z"));
  state.work.push(
    buildTeamSyncStartWorkRecord({
      summary:
        "Correct Companion and Orchestrator audit findings, publish affected package surfaces, then promote dev to main and deploy",
      files: ["packages/cli/src/commands/team-sync.ts", "packages/cli/src/commands/workflows.ts"],
      now: new Date("2026-06-29T16:41:00.000Z"),
    }),
    buildTeamSyncStartWorkRecord({
      summary: "Promote unrelated frontend release from dev to main and deploy",
      files: ["apps/web/src/app/(marketing)/page.tsx"],
      now: new Date("2026-06-29T16:42:00.000Z"),
    })
  );

  const completed = completeTeamSyncWorkFromEvidence(state, {
    workflowGoal: "companion-orchestrator-audit-corrections-20260629",
    summary:
      "Completed phased Companion and Orchestrator corrections end to end with package publication and deploy verification.",
    files: ["packages/cli/src/commands/workflows.ts"],
    reason: "Workflow companion-orchestrator-audit-corrections-20260629 completed.",
    now: new Date("2026-06-29T18:02:00.000Z"),
  });

  assert.equal(completed.length, 1);
  assert.equal(completed[0].status, "completed");
  assert.match(completed[0].completionReason, /companion-orchestrator-audit-corrections/);
  assert.equal(state.work[1].status, "active");
});

test("team sync sweep previews and archives inactive work", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-team-sync-sweep-"));
  const state = createEmptyTeamSyncState(new Date("2026-05-17T12:00:00.000Z"));
  state.work.push(
    buildTeamSyncStartWorkRecord({
      summary: "Purge stale continuity noise",
      now: new Date("2026-05-01T10:00:00.000Z"),
    })
  );
  saveTeamSyncState(state, dir);

  const humanPreview = runCli(["team-sync", "sweep", "--days", "14", "--dry-run"], { cwd: dir });
  assert.equal(humanPreview.status, 0, humanPreview.stderr || humanPreview.stdout);
  assert.match(humanPreview.stdout, /Sweep detail:/);
  assert.match(humanPreview.stdout, /would be archived/);
  assert.equal(loadTeamSyncState(dir).work[0].status, "active");

  const preview = runCli(["team-sync", "sweep", "--days", "14", "--dry-run", "--json"], {
    cwd: dir,
  });
  assert.equal(preview.status, 0, preview.stderr || preview.stdout);
  const previewPayload = JSON.parse(preview.stdout);
  assert.equal(previewPayload.dryRun, true);
  assert.equal(previewPayload.archivedCount, 1);
  assert.equal(previewPayload.explanation.mode, "preview");
  assert.equal(previewPayload.explanation.candidateCount, 1);
  assert.equal(previewPayload.explanation.archivedCount, 0);
  assert.equal(previewPayload.explanation.remainingStaleCount, 0);
  assert.match(previewPayload.explanation.message, /would be archived/);
  assert.ok(
    previewPayload.summary.hygieneActions.some(
      (action) =>
        action.kind === "sweep-preview" &&
        action.command === "snipara-companion team-sync sweep --days 14 --dry-run"
    )
  );
  assert.ok(
    previewPayload.summary.hygieneActions.some(
      (action) =>
        action.kind === "sweep-archive" &&
        action.command === "snipara-companion team-sync sweep --days 14"
    )
  );
  assert.equal(loadTeamSyncState(dir).work[0].status, "active");

  const result = runCli(["team-sync", "sweep", "--days", "14", "--json"], { cwd: dir });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.dryRun, false);
  assert.equal(payload.archivedCount, 1);
  assert.equal(payload.explanation.mode, "archive");
  assert.equal(payload.explanation.archivedCount, 1);
  assert.equal(payload.explanation.remainingStaleCount, 0);
  assert.deepEqual(payload.summary.hygieneActions, []);

  const loaded = loadTeamSyncState(dir);
  assert.equal(loaded.work[0].status, "archived");
  assert.equal(loaded.work[0].archiveReason, "No update for 14 day(s)");
});

test("team sync state persists under .snipara/team-sync/session.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-team-sync-"));
  const state = createEmptyTeamSyncState(new Date("2026-05-14T12:00:00.000Z"));
  state.work.push(
    buildTeamSyncStartWorkRecord({
      summary: "Implement brief",
      files: ["apps/web/src/lib/services/team-sync.ts"],
      now: new Date("2026-05-14T12:01:00.000Z"),
    })
  );

  saveTeamSyncState(state, dir);

  assert.equal(getTeamSyncStatePath(dir), path.join(dir, TEAM_SYNC_STATE_RELATIVE_PATH));
  assert.equal(fs.existsSync(path.join(dir, TEAM_SYNC_STATE_RELATIVE_PATH)), true);
  const loaded = loadTeamSyncState(dir);
  assert.equal(loaded.schemaVersion, state.schemaVersion);
  assert.equal(loaded.updatedAt, state.updatedAt);
  assert.equal(loaded.work[0].id, state.work[0].id);
  assert.equal(loaded.work[0].summary, "Implement brief");
  assert.deepEqual(loaded.work[0].files, ["apps/web/src/lib/services/team-sync.ts"]);
  assert.equal(loaded.work[0].status, "active");
  assert.equal(loaded.work[0].updatedAt, "2026-05-14T12:01:00.000Z");
  assert.deepEqual(loaded.handoffs, []);
});

test("team sync load normalizes legacy work records without updatedAt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-team-sync-legacy-"));
  fs.mkdirSync(path.join(dir, ".snipara", "team-sync"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".snipara", "team-sync", "session.json"),
    JSON.stringify(
      {
        schemaVersion: "snipara.team-sync.v1",
        updatedAt: "2026-05-15T15:11:11.358Z",
        work: [
          {
            id: "work_9275b0f4b6",
            type: "work",
            summary: "Remove stale API key fallback usage",
            files: [],
            status: "active",
            createdAt: "2026-05-15T15:11:11.358Z",
          },
        ],
        handoffs: [],
      },
      null,
      2
    ),
    "utf8"
  );

  const loaded = loadTeamSyncState(dir);
  assert.equal(loaded.work[0].updatedAt, "2026-05-15T15:11:11.358Z");
  assert.equal(loaded.work[0].status, "active");
});

test("team-sync start-work keeps local state and prints hosted brief when configured", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-team-sync-cli-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  const preloadPath = writeHostedTeamSyncPreload(dir);

  const result = runCli(
    [
      "team-sync",
      "start-work",
      "--summary",
      "Add invite permissions",
      "--branch",
      "invite-permissions",
      "--files",
      "apps/web/src/lib/auth/permissions.ts",
      "--emit-orchestrator-handoff",
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

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Start Work Brief status: loaded/);
  assert.match(
    result.stdout,
    /What Changed loaded: 1 changes, 1 decisions, 0 stale assumptions, 1 overlaps, 1 next actions\./
  );
  assert.match(result.stdout, /First next action: Verify ownership guard before route edits\./);
  assert.match(result.stdout, /Hosted Start Work Brief/);
  assert.match(result.stdout, /Likely files: apps\/web\/src\/lib\/auth\/permissions\.ts/);
  assert.match(result.stdout, /Decisions: Invited users keep personal API keys/);
  assert.match(result.stdout, /Orchestrator recommendation/);
  assert.match(result.stdout, /Level: confirm/);
  assert.match(result.stdout, /Prepared Orchestrator Handoff/);
  assert.match(
    result.stdout,
    /snipara-orchestrator agents coordinate --plan \.snipara\/orchestrator\/handoff\.json/
  );
  assert.equal(fs.existsSync(path.join(dir, TEAM_SYNC_STATE_RELATIVE_PATH)), true);
  assert.equal(fs.existsSync(path.join(dir, ORCHESTRATOR_HANDOFF_RELATIVE_PATH)), true);
});

test("team-sync start-work appends a hosted journal checkpoint when configured", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-team-sync-journal-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  const preloadPath = writeHostedTeamSyncPreload(dir);
  const journalLog = path.join(dir, "journal-log.jsonl");

  const result = runCli(
    [
      "team-sync",
      "start-work",
      "--summary",
      "Add invite permissions",
      "--branch",
      "invite-permissions",
      "--files",
      "apps/web/src/lib/auth/permissions.ts",
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
  assert.deepEqual(payload.startWorkBriefStatus, {
    status: "loaded",
    hostedStatus: "ok",
    message: "hosted Start Work Brief and What Changed context are loaded",
    whatChangedLoaded: true,
    generatedAt: "2026-05-25T12:45:00.000Z",
    evidenceLevel: "clear",
    changeCount: 1,
    decisionCount: 1,
    staleAssumptionCount: 0,
    failedJobCount: 0,
    overlapCount: 1,
    nextActionCount: 1,
    firstNextAction: "Verify ownership guard before route edits.",
  });
  assert.equal(payload.journal.status, "ok");
  const logged = fs
    .readFileSync(journalLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(logged.length, 1);
  assert.match(logged[0].text, /Checkpoint: team-sync:start-work/);
  assert.match(logged[0].text, /Summary: Add invite permissions/);
  assert.match(logged[0].text, /Branch: invite-permissions/);
  assert.deepEqual(logged[0].tags, ["companion", "checkpoint", "team-sync:start-work"]);
});

test("team-sync handoff publishes the hosted capsule when configured", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-team-sync-handoff-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  const preloadPath = writeHostedTeamSyncPreload(dir);
  const whyCaptureLog = path.join(dir, "team-sync-why-capture.jsonl");

  const result = runCli(
    [
      "team-sync",
      "handoff",
      "--summary",
      "Moved project access check",
      "--next",
      "Run permissions tests before merge",
      "--attention",
      "proof",
      "--files",
      "apps/web/src/lib/auth/permissions.ts",
    ],
    {
      cwd: dir,
      env: {
        SNIPARA_API_KEY: "snp-test",
        SNIPARA_PROJECT_ID: "project_1",
        SNIPARA_API_URL: "https://api.snipara.com",
        SNIPARA_SESSION_ID: "session_1",
        SNIPARA_AUTOMATION_CLIENT: "codex",
        SNIPARA_TEST_WHY_CAPTURE_LOG: whyCaptureLog,
      },
      nodeArgs: ["-r", preloadPath],
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Hosted Handoff/);
  assert.match(result.stdout, /Handoff ID: handoff_hosted_1/);
  assert.match(result.stdout, /Attention: proof_required/);
  const whyCapture = fs
    .readFileSync(whyCaptureLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(whyCapture.length, 2);
  assert.equal(whyCapture[0].previewOnly, true);
  assert.equal(whyCapture[1].confirmed, true);
  assert.equal(whyCapture[1].sourceKind, "handoff");
  assert.match(whyCapture[1].sourceText, /Run permissions tests before merge/);
});

test("team-sync what-changed includes hosted continuity evidence in json mode", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-team-sync-what-changed-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  const preloadPath = writeHostedTeamSyncPreload(dir);
  const state = createEmptyTeamSyncState(new Date("2026-05-25T12:40:00.000Z"));
  state.work.push(
    buildTeamSyncStartWorkRecord({
      summary: "Add invite permissions",
      files: ["apps/web/src/lib/auth/permissions.ts"],
      branch: "invite-permissions",
      now: new Date("2026-05-25T12:40:00.000Z"),
    })
  );
  saveTeamSyncState(state, dir);

  const result = runCli(["team-sync", "what-changed", "--emit-orchestrator-handoff", "--json"], {
    cwd: dir,
    env: {
      SNIPARA_API_KEY: "snp-test",
      SNIPARA_PROJECT_ID: "project_1",
      SNIPARA_API_URL: "https://api.snipara.com",
      SNIPARA_SESSION_ID: "session_1",
      SNIPARA_AUTOMATION_CLIENT: "codex",
    },
    nodeArgs: ["-r", preloadPath],
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.hosted.status, "ok");
  assert.equal(payload.hosted.data.whatChanged.version, "what-changed-v2");
  assert.equal(payload.hosted.data.whatChanged.summary.changeCount, 2);
  assert.equal(payload.orchestratorRecommendation.level, "confirm");
  assert.equal(payload.orchestratorHandoff.relativePath, ORCHESTRATOR_HANDOFF_RELATIVE_PATH);
  assert.equal(fs.existsSync(path.join(dir, ORCHESTRATOR_HANDOFF_RELATIVE_PATH)), true);
  assert.equal(
    payload.hosted.data.whatChanged.staleAssumptions[0].reason,
    "Billing checkout is still active in PR #182."
  );
});

test("team-sync what-changed can auto-route orchestrator by policy", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-team-sync-policy-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  const state = createEmptyTeamSyncState(new Date("2026-05-25T12:40:00.000Z"));
  state.work.push(
    buildTeamSyncStartWorkRecord({
      summary: "Coordinate release validation",
      files: ["packages/cli/src/commands/team-sync.ts"],
      branch: "dev",
      now: new Date("2026-05-25T12:40:00.000Z"),
    })
  );
  saveTeamSyncState(state, dir);

  const result = runCli(
    [
      "team-sync",
      "what-changed",
      "--auto-route-orchestrator",
      "--orchestrator-policy-source",
      "enterprise-proof-gates",
      "--json",
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.orchestratorRecommendation.level, "auto");
  assert.equal(payload.orchestratorRecommendation.policySource, "enterprise-proof-gates");
  assert.equal(payload.orchestratorHandoff.relativePath, ORCHESTRATOR_HANDOFF_RELATIVE_PATH);
  assert.equal(fs.existsSync(path.join(dir, ORCHESTRATOR_HANDOFF_RELATIVE_PATH)), true);
});

test("team-sync what-changed accepts include-session-context as a compatibility alias", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-team-sync-session-context-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  const state = createEmptyTeamSyncState(new Date("2026-05-25T12:40:00.000Z"));
  state.work.push(
    buildTeamSyncStartWorkRecord({
      summary: "Review continuity state",
      files: ["packages/cli/src/commands/team-sync.ts"],
      branch: "dev",
      now: new Date("2026-05-25T12:40:00.000Z"),
    })
  );
  saveTeamSyncState(state, dir);

  const result = runCli(["team-sync", "what-changed", "--include-session-context", "--json"], {
    cwd: dir,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.compatibilityNotes[0], /workflow resume --include-session-context/);
});

test("workflow runtime-checkpoint persists sandbox resume metadata locally", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-workflow-runtime-checkpoint-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  fs.mkdirSync(path.join(dir, ".snipara", "workflow"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".snipara", "workflow", "current.json"),
    JSON.stringify(
      {
        schemaVersion: "snipara.workflow.v2",
        workflowId: "runtime-resume-checkpoint",
        goal: "Exercise runtime checkpointing",
        status: "active",
        currentPhaseId: "phase-runtime",
        planSource: "inline",
        createdAt: "2026-05-25T12:30:00.000Z",
        updatedAt: "2026-05-25T12:30:00.000Z",
        phases: [
          {
            id: "phase-runtime",
            title: "Run deterministic sandbox checks",
            query: "Validate runtime wiring",
            status: "in_progress",
            files: ["packages/cli/src/commands/workflows.ts"],
            needsRuntime: true,
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );

  const preloadPath = writeHostedTeamSyncPreload(dir);
  const result = runCli(
    [
      "workflow",
      "runtime-checkpoint",
      "phase-runtime",
      "--summary",
      "Resume-ready sandbox state",
      "--environment",
      "docker",
      "--profile",
      "analysis",
      "--artifacts",
      "artifacts/runtime.json",
      "--commands",
      "pnpm test auth",
      "--rehydrate-json",
      JSON.stringify({ inputs: { target: "auth" } }),
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

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Runtime checkpoint/);
  assert.match(result.stdout, /Hosted runtime event: runtime_event_receipt_1/);

  const saved = JSON.parse(
    fs.readFileSync(path.join(dir, ".snipara", "workflow", "current.json"), "utf8")
  );
  assert.equal(saved.schemaVersion, "snipara.workflow.v2");
  assert.equal(saved.runtime.sandbox.bindings[0].phaseId, "phase-runtime");
  assert.match(saved.runtime.sandbox.bindings[0].sessionId, /^sandbox-/);
  assert.equal(
    saved.runtime.sandbox.bindings[0].lastCheckpoint.summary,
    "Resume-ready sandbox state"
  );
  assert.equal(
    saved.runtime.sandbox.bindings[0].lastCheckpoint.rehydratableState.inputs.target,
    "auth"
  );
});

test("team-sync resume and workflow resume surface the hosted handoff context", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-team-sync-resume-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  fs.mkdirSync(path.join(dir, ".snipara", "workflow"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".snipara", "workflow", "current.json"),
    JSON.stringify(
      {
        schemaVersion: "snipara.workflow.v2",
        workflowId: "align-team-sync",
        goal: "Align Team Sync surfaces",
        status: "active",
        currentPhaseId: "phase-4",
        planSource: "inline",
        createdAt: "2026-05-25T12:30:00.000Z",
        updatedAt: "2026-05-25T12:30:00.000Z",
        phases: [
          {
            id: "phase-4",
            title: "Align snipara-companion outputs",
            query: "Align the hosted resume output",
            status: "in_progress",
            files: ["packages/cli/src/commands/team-sync.ts"],
            needsRuntime: true,
          },
        ],
        runtime: {
          sandbox: {
            provider: "snipara-sandbox",
            bindings: [
              {
                phaseId: "phase-4",
                sessionId: "sandbox-align-team-sync-phase-4-abc123",
                automationSessionId: "session_1",
                boundAt: "2026-05-25T12:32:00.000Z",
                bootstrapQuery: "Align the hosted resume output",
                environment: "docker",
                profile: "analysis",
                artifacts: ["artifacts/runtime.json"],
                lastCheckpoint: {
                  summary: "Local runtime checkpoint",
                  capturedAt: "2026-05-25T12:45:00.000Z",
                  automationSessionId: "session_1",
                  bootstrapQuery: "Align the hosted resume output",
                  files: ["packages/cli/src/commands/team-sync.ts"],
                  commands: ["pnpm test auth"],
                  artifacts: ["artifacts/runtime.json"],
                  rehydratableState: {
                    inputs: {
                      target: "auth",
                    },
                  },
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
  const state = createEmptyTeamSyncState(new Date("2026-05-25T12:40:00.000Z"));
  state.work.push(
    buildTeamSyncStartWorkRecord({
      summary: "Add invite permissions",
      files: ["apps/web/src/lib/auth/permissions.ts"],
      branch: "invite-permissions",
      now: new Date("2026-05-25T12:40:00.000Z"),
    })
  );
  state.handoffs.push(
    buildTeamSyncHandoffRecord({
      summary: "Moved project access check",
      next: "Run permissions tests before merge",
      attention: "proof",
      files: ["apps/web/src/lib/auth/permissions.ts"],
      now: new Date("2026-05-25T12:41:00.000Z"),
    })
  );
  saveTeamSyncState(state, dir);
  const preloadPath = writeHostedTeamSyncPreload(dir);
  const env = {
    SNIPARA_API_KEY: "snp-test",
    SNIPARA_PROJECT_ID: "project_1",
    SNIPARA_API_URL: "https://api.snipara.com",
    SNIPARA_SESSION_ID: "session_1",
    SNIPARA_AUTOMATION_CLIENT: "codex",
  };

  const resumeResult = runCli(["team-sync", "resume"], {
    cwd: dir,
    env,
    nodeArgs: ["-r", preloadPath],
  });
  assert.equal(resumeResult.status, 0, resumeResult.stderr || resumeResult.stdout);
  assert.match(resumeResult.stdout, /Hosted Resume Context/);
  assert.match(resumeResult.stdout, /Latest hosted handoff: Moved project access check/);
  assert.match(resumeResult.stdout, /Checkpoints: 1/);

  const workflowResumeResult = runCli(["workflow", "resume"], {
    cwd: dir,
    env,
    nodeArgs: ["-r", preloadPath],
  });
  assert.equal(
    workflowResumeResult.status,
    0,
    workflowResumeResult.stderr || workflowResumeResult.stdout
  );
  assert.match(workflowResumeResult.stdout, /Resume boundary/);
  assert.match(workflowResumeResult.stdout, /Runtime Resume/);
  assert.match(
    workflowResumeResult.stdout,
    /Sandbox session: sandbox-align-team-sync-phase-4-abc123/
  );
  assert.match(workflowResumeResult.stdout, /Reattach path:/);
  assert.match(workflowResumeResult.stdout, /Rehydrate path:/);
  assert.match(workflowResumeResult.stdout, /snipara_repl_context/);
  assert.match(
    workflowResumeResult.stdout,
    /does not snapshot or exactly restore a live Snipara Sandbox process/
  );
  assert.match(workflowResumeResult.stdout, /snipara-companion workflow phase-start phase-4/);

  const workflowResult = runCli(["workflow", "resume", "--json"], {
    cwd: dir,
    env,
    nodeArgs: ["-r", preloadPath],
  });
  assert.equal(workflowResult.status, 0, workflowResult.stderr || workflowResult.stdout);
  const workflowPayload = JSON.parse(workflowResult.stdout);
  assert.equal(workflowPayload.team_sync_resume.handoff.id, "handoff_hosted_1");
  assert.equal(workflowPayload.session_bootstrap.critical.count, 1);
  assert.equal(workflowPayload.session_context.included, false);
  assert.equal(workflowPayload.session_context.max_tokens, 0);
  assert.equal(
    workflowPayload.runtime_resume.binding.sessionId,
    "sandbox-align-team-sync-phase-4-abc123"
  );
  assert.equal(workflowPayload.runtime_resume.checkpoint.summary, "Resume-ready sandbox state");
});

test("team-sync resume accepts include-session-context as a compatibility alias", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-team-sync-resume-session-context-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  const state = createEmptyTeamSyncState(new Date("2026-05-25T12:40:00.000Z"));
  state.work.push(
    buildTeamSyncStartWorkRecord({
      summary: "Resume continuity state",
      files: ["packages/cli/src/commands/team-sync.ts"],
      branch: "dev",
      now: new Date("2026-05-25T12:40:00.000Z"),
    })
  );
  saveTeamSyncState(state, dir);

  const result = runCli(["team-sync", "resume", "--include-session-context", "--json"], {
    cwd: dir,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.compatibilityNotes[0], /workflow resume --include-session-context/);
});
