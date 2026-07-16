const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const {
  COLLABORATION_STATE_RELATIVE_PATH,
  buildCollaborationGuardActionCards,
  buildHostedGuardPayload,
  buildCollaborationHooksInstallPlan,
  compactHostedGuardResources,
  createEmptyCollaborationState,
  getCollaborationStatePath,
  deriveLocalCollaborationResourcesFromFiles,
  loadCollaborationState,
  normalizeCollaborationFiles,
  parseCollaborationResources,
  saveCollaborationState,
  shouldFailCollaborationGuard,
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

function writeHostedCollaborationPreload(dir) {
  const preloadPath = path.join(dir, "collaboration-preload.js");
  fs.writeFileSync(
    preloadPath,
    [
      "const fs = require('node:fs');",
      "globalThis.fetch = async (url, init = {}) => {",
      "  const parsedUrl = new URL(String(url));",
      "  const path = parsedUrl.pathname;",
      "  const body = init.body ? JSON.parse(init.body) : {};",
      "  const logPath = process.env.SNIPARA_TEST_COLLAB_LOG;",
      "  if (logPath) fs.appendFileSync(logPath, `${JSON.stringify({ path, method: init.method, body })}\\n`, 'utf8');",
      "  const project = { id: 'project_1', name: 'App', slug: 'app' };",
      "  if (path.endsWith('/collaboration/sessions') && init.method === 'POST') {",
      "    const resources = [",
      "      ...(body.resources || []),",
      "      ...(body.files || []).map((file) => ({ kind: 'FILE', id: file, sourcePath: file })),",
      "    ];",
      "    return ok({",
      "      project,",
      "      session: {",
      "        id: body.workSessionId || 'work_1',",
      "        actorId: body.actorId || 'agent_1',",
      "        actorType: body.actorType || 'AGENT',",
      "        actorLabel: body.actorLabel || 'Codex',",
      "        sessionId: body.sessionId || 'session_1',",
      "        client: body.client || 'snipara-companion',",
      "        repository: body.repository || 'acme/app',",
      "        branch: body.branch || 'dev',",
      "        task: body.task || null,",
      "        status: 'ACTIVE',",
      "        dirtyFiles: body.files || [],",
      "        startedAt: '2026-06-09T12:00:00.000Z',",
      "        lastHeartbeatAt: '2026-06-09T12:00:00.000Z',",
      "      },",
      "      resources,",
      "    }, 201);",
      "  }",
      "  if (path.endsWith('/collaboration/sessions') && init.method === 'GET') {",
      "    return ok({",
      "      project,",
      "      sessions: [{ id: 'work_1', actorId: 'agent_1', actorType: 'AGENT', status: 'ACTIVE', dirtyFiles: ['src/index.ts'] }],",
      "      leases: [{ id: 'lease_1', resourceKind: 'FILE', resourceId: 'src/index.ts', mode: 'EXCLUSIVE', status: 'ACTIVE', claimedByActorId: 'agent_1', claimedByActorType: 'AGENT' }],",
      "      events: [{ id: 'event_1', eventType: 'guard.evaluate', severity: 'WARNING', summary: 'Review overlap', createdAt: '2026-06-09T12:02:00.000Z' }],",
      "      sessionSnapshots: [],",
      "      leaseSnapshots: [],",
      "    });",
      "  }",
      "  if (path.endsWith('/collaboration/leases') && init.method === 'POST') {",
      "    const resources = [",
      "      ...(body.resources || []),",
      "      ...(body.files || []).map((file) => ({ kind: 'FILE', id: file, sourcePath: file })),",
      "    ];",
      "    return ok({",
      "      project,",
      "      resources,",
      "      leases: resources.map((resource, index) => ({",
      "        id: `lease_${index + 1}`,",
      "        workSessionId: body.workSessionId || 'work_1',",
      "        resourceKind: resource.kind,",
      "        resourceId: resource.id,",
      "        resourceLabel: resource.label || null,",
      "        mode: body.mode || 'ADVISORY',",
      "        status: 'ACTIVE',",
      "        claimedByActorId: body.actorId || 'agent_1',",
      "        claimedByActorType: body.actorType || 'AGENT',",
      "        claimedByLabel: body.actorLabel || 'Codex',",
      "        reason: body.reason || null,",
      "        claimedAt: '2026-06-09T12:01:00.000Z',",
      "        heartbeatAt: '2026-06-09T12:01:00.000Z',",
      "        expiresAt: null,",
      "      })),",
      "    }, 201);",
      "  }",
      "  if (path.includes('/collaboration/leases/') && init.method === 'PATCH') {",
      "    const leaseId = path.split('/').pop();",
      "    return ok({",
      "      project,",
      "      lease: { id: leaseId, resourceKind: 'FILE', resourceId: 'src/index.ts', mode: 'EXCLUSIVE', status: 'RELEASED', claimedByActorId: 'agent_1', claimedByActorType: 'AGENT' },",
      "    });",
      "  }",
      "  if (path.endsWith('/collaboration/guard') && init.method === 'POST') {",
      "    const resources = [",
      "      ...(body.resources || []),",
      "      ...(body.files || []).map((file) => ({ kind: 'FILE', id: file, sourcePath: file })),",
      "    ];",
      "    return ok({",
      "      project,",
      "      resources,",
      "      evaluation: {",
      "        decision: 'BLOCKED',",
      "        severity: 'CRITICAL',",
      "        evaluatedAt: '2026-06-09T12:02:00.000Z',",
      "        resources,",
      "        conflicts: [{",
      "          code: 'hard_block_lease_overlap',",
      "          decision: 'BLOCKED',",
      "          severity: 'CRITICAL',",
      "          resource: resources[0],",
      "          conflictingActor: { actorId: 'agent_2', actorType: 'AGENT', actorLabel: 'Other agent' },",
      "          reason: 'Other agent has a hard block on FILE:src/index.ts.',",
      "          recommendedAction: 'Wait for release or coordinate override.',",
      "          leaseId: 'lease_blocking',",
      "        }],",
      "        recommendedActions: ['Wait for release or coordinate override.'],",
      "      },",
      "      guardEvent: { id: 'guard_1' },",
      "    });",
      "  }",
      "  return ok({});",
      "};",
      "function ok(data, status = 200) {",
      "  return {",
      "    ok: true,",
      "    status,",
      "    statusText: 'OK',",
      "    json: async () => ({ success: true, data }),",
      "  };",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  return preloadPath;
}

function writeHostedReviewOnlyGuardPreload(dir) {
  const preloadPath = path.join(dir, "collaboration-review-only-preload.js");
  fs.writeFileSync(
    preloadPath,
    [
      "const fs = require('node:fs');",
      "globalThis.fetch = async (url, init = {}) => {",
      "  const parsedUrl = new URL(String(url));",
      "  const path = parsedUrl.pathname;",
      "  const body = init.body ? JSON.parse(init.body) : {};",
      "  const logPath = process.env.SNIPARA_TEST_COLLAB_LOG;",
      "  if (logPath) fs.appendFileSync(logPath, `${JSON.stringify({ path, method: init.method, body })}\\n`, 'utf8');",
      "  const project = { id: 'project_1', name: 'App', slug: 'app' };",
      "  if (path.endsWith('/collaboration/guard') && init.method === 'POST') {",
      "    const resources = [",
      "      ...(body.resources || []),",
      "      ...(body.files || []).map((file) => ({ kind: 'FILE', id: file, sourcePath: file })),",
      "    ];",
      "    return ok({",
      "      project,",
      "      resources,",
      "      evaluation: {",
      "        decision: 'REVIEW_REQUIRED',",
      "        severity: 'WARNING',",
      "        evaluatedAt: '2026-06-09T12:02:00.000Z',",
      "        resources,",
      "        conflicts: [",
      "          {",
      "            code: 'stale_session_overlap',",
      "            decision: 'WATCH',",
      "            severity: 'WATCH',",
      "            resource: resources[0],",
      "            conflictingActor: { actorId: body.actorId || 'agent_1', actorType: 'AGENT', actorLabel: 'Codex' },",
      "            reason: 'Codex has stale activity on snipara-web.',",
      "            recommendedAction: 'Refresh collaboration state before treating this resource as free.',",
      "            workSessionId: body.workSessionId || 'work_1',",
      "          },",
      "          {",
      "            code: 'decision_consistency_review',",
      "            decision: 'REVIEW_REQUIRED',",
      "            severity: 'WARNING',",
      "            resource: resources[0],",
      "            conflictingActor: { actorId: 'memory', actorType: 'SYSTEM', actorLabel: 'Decision Consistency' },",
      "            reason: 'Change touches approved decision mem_1; review consistency before proceeding.',",
      "            recommendedAction: 'Review the recorded decision and update or supersede it if this change is intentional.',",
      "          },",
      "        ],",
      "        recommendedActions: [",
      "          'Refresh collaboration state before treating this resource as free.',",
      "          'Review the recorded decision and update or supersede it if this change is intentional.',",
      "        ],",
      "      },",
      "      guardEvent: { id: 'guard_1' },",
      "    });",
      "  }",
      "  return ok({});",
      "};",
      "function ok(data, status = 200) {",
      "  return {",
      "    ok: true,",
      "    status,",
      "    statusText: 'OK',",
      "    json: async () => ({ success: true, data }),",
      "  };",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  return preloadPath;
}

function writeHostedGoGuardPreload(dir) {
  const preloadPath = path.join(dir, "collaboration-go-preload.js");
  fs.writeFileSync(
    preloadPath,
    [
      "globalThis.fetch = async (url, init = {}) => {",
      "  const parsedUrl = new URL(String(url));",
      "  const path = parsedUrl.pathname;",
      "  const body = init.body ? JSON.parse(init.body) : {};",
      "  const project = { id: 'project_1', name: 'App', slug: 'app' };",
      "  if (path.endsWith('/collaboration/guard') && init.method === 'POST') {",
      "    const resources = [",
      "      ...(body.resources || []),",
      "      ...(body.files || []).map((file) => ({ kind: 'FILE', id: file, sourcePath: file })),",
      "    ];",
      "    return ok({",
      "      project,",
      "      resources,",
      "      evaluation: {",
      "        decision: 'CLEAR',",
      "        severity: 'INFO',",
      "        evaluatedAt: '2026-06-09T12:02:00.000Z',",
      "        resources,",
      "        conflicts: [],",
      "        recommendedActions: [],",
      "      },",
      "      guardEvent: { id: 'guard_1' },",
      "    });",
      "  }",
      "  return ok({});",
      "};",
      "function ok(data, status = 200) {",
      "  return { ok: true, status, statusText: 'OK', json: async () => ({ success: true, data }) };",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  return preloadPath;
}

function hostedEnv(extra = {}) {
  return {
    SNIPARA_API_KEY: "snp-test",
    SNIPARA_PROJECT_ID: "project_1",
    SNIPARA_API_URL: "https://api.snipara.com",
    SNIPARA_SESSION_ID: "session_1",
    SNIPARA_AUTOMATION_CLIENT: "codex",
    ...extra,
  };
}

test("collaboration helpers normalize files, resources, and local state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-collaboration-state-"));
  const resources = parseCollaborationResources(["file:./src/index.ts", "ROUTE:/api/projects"]);
  const state = createEmptyCollaborationState(new Date("2026-06-09T12:00:00.000Z"));

  state.workSessionId = "work_1";
  state.files = normalizeCollaborationFiles(["./src/index.ts", "src/index.ts"]);
  state.resources = resources;
  saveCollaborationState(state, dir);

  assert.equal(getCollaborationStatePath(dir), path.join(dir, COLLABORATION_STATE_RELATIVE_PATH));
  const loaded = loadCollaborationState(dir);
  assert.equal(loaded.schemaVersion, "snipara.collaboration.v1");
  assert.deepEqual(loaded.files, ["src/index.ts"]);
  assert.deepEqual(loaded.resources, [
    { kind: "FILE", id: "src/index.ts" },
    { kind: "ROUTE", id: "/api/projects" },
  ]);

  fs.writeFileSync(getCollaborationStatePath(dir), "{not-json", "utf8");
  const recovered = loadCollaborationState(dir);
  assert.equal(recovered.schemaVersion, "snipara.collaboration.v1");
  assert.deepEqual(recovered.files, []);
});

test("collaboration local state expires stale active leases on load", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-collaboration-expired-"));
  const state = createEmptyCollaborationState(new Date("2026-06-09T12:00:00.000Z"));
  state.workSessionId = "workflow:lease-hygiene";
  state.leases = [
    {
      id: "lease_expired",
      mode: "ADVISORY",
      status: "ACTIVE",
      resources: [{ kind: "FILE", id: "src/index.ts" }],
      claimedAt: "2026-06-09T12:00:00.000Z",
      expiresAt: "2020-01-01T00:00:00.000Z",
      workSessionId: "workflow:lease-hygiene",
    },
  ];
  saveCollaborationState(state, dir);

  const loaded = loadCollaborationState(dir);
  assert.equal(loaded.leases[0].status, "EXPIRED");
});

test("collaboration helpers derive route, package, schema, surface, and symbol resources", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-collaboration-resources-"));
  fs.mkdirSync(path.join(dir, "apps/web/src/app/api/projects/[projectId]/guard"), {
    recursive: true,
  });
  const routePath = "apps/web/src/app/api/projects/[projectId]/guard/route.ts";
  fs.writeFileSync(
    path.join(dir, routePath),
    "export function POST() { return Response.json({ ok: true }); }\n",
    "utf8"
  );

  const resources = deriveLocalCollaborationResourcesFromFiles([routePath], dir, 100);
  const keys = resources.map((resource) => `${resource.kind}:${resource.id}`);

  assert.ok(keys.includes(`FILE:${routePath}`));
  assert.ok(keys.includes("ROUTE:/api/projects/:projectId/guard"));
  assert.ok(keys.includes("PACKAGE:snipara-web"));
  assert.ok(keys.includes("SYMBOL:module:apps/web/src/app/api/projects/[projectId]/guard/route"));
  assert.ok(keys.includes("SURFACE:tests:apps/web/src/app/api/projects/[projectId]/guard/route"));
});

test("collaboration guard payload caps hosted files and symbol resources", () => {
  const files = Array.from({ length: 520 }, (_, index) => `src/file-${index}.ts`);
  const resources = [
    { kind: "DEPLOY", id: "production-deployment" },
    { kind: "SURFACE", id: "deployment" },
    ...Array.from({ length: 980 }, (_, index) => ({
      kind: "SYMBOL",
      id: `symbol:${index.toString().padStart(4, "0")}`,
      sourcePath: `src/file-${index % 20}.ts`,
    })),
  ];

  const payload = buildHostedGuardPayload(files, resources);
  assert.equal(payload.files.length, 450);
  assert.equal(payload.filesTruncated, true);
  assert.equal(payload.resources.length <= 850, true);
  assert.equal(payload.resourcesTruncated, true);
  assert.equal(
    payload.resources.some(
      (resource) => resource.kind === "CUSTOM" && resource.id === "hosted-guard-resource-summary"
    ),
    true
  );
  assert.equal(
    payload.resources.some(
      (resource) => resource.kind === "DEPLOY" && resource.id === "production-deployment"
    ),
    true
  );

  const compactedResources = compactHostedGuardResources(resources);
  assert.equal(compactedResources.length <= 850, true);
});

test("collaboration start publishes a hosted work session and stores local state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-collaboration-start-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  const preloadPath = writeHostedCollaborationPreload(dir);
  const logPath = path.join(dir, "collab-log.jsonl");

  const result = runCli(
    [
      "collaboration",
      "start",
      "--summary",
      "Add safe collaboration guards",
      "--files",
      "src/index.ts",
      "--actor-id",
      "agent_1",
      "--actor",
      "Codex",
      "--branch",
      "dev",
      "--json",
    ],
    {
      cwd: dir,
      env: hostedEnv({ SNIPARA_TEST_COLLAB_LOG: logPath }),
      nodeArgs: ["-r", preloadPath],
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.hosted.status, "ok");
  assert.equal(payload.state.workSessionId, "work_1");
  assert.equal(payload.state.actorId, "agent_1");
  assert.deepEqual(payload.state.files, ["src/index.ts"]);
  assert.equal(fs.existsSync(path.join(dir, COLLABORATION_STATE_RELATIVE_PATH)), true);

  const logged = fs.readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(logged[0].body.actorId, "agent_1");
  assert.equal(logged[0].body.task, "Add safe collaboration guards");
});

test("collaboration watch publishes presence and auto-claims resources once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-collaboration-watch-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/index.ts"), "export const value = 1;\n", "utf8");
  const preloadPath = writeHostedCollaborationPreload(dir);
  const logPath = path.join(dir, "collab-log.jsonl");

  const result = runCli(
    [
      "collaboration",
      "watch",
      "--once",
      "--files",
      "src/index.ts",
      "--actor-id",
      "agent_1",
      "--branch",
      "dev",
      "--json",
    ],
    {
      cwd: dir,
      env: hostedEnv({ SNIPARA_TEST_COLLAB_LOG: logPath }),
      nodeArgs: ["-r", preloadPath],
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.hosted.status, "ok");
  assert.equal(payload.watch.claimHosted.status, "ok");
  assert.equal(payload.state.leases.length > 0, true);

  const logged = fs.readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(
    logged.some((entry) => entry.path.endsWith("/collaboration/sessions")),
    true
  );
  assert.equal(
    logged.some((entry) => entry.path.endsWith("/collaboration/leases")),
    true
  );
});

test("collaboration claim creates hosted leases and keeps local lease state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-collaboration-claim-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  const preloadPath = writeHostedCollaborationPreload(dir);

  const result = runCli(
    [
      "collaboration",
      "claim",
      "--files",
      "src/index.ts",
      "--mode",
      "EXCLUSIVE",
      "--reason",
      "editing entrypoint",
      "--actor-id",
      "agent_1",
      "--branch",
      "dev",
      "--json",
    ],
    {
      cwd: dir,
      env: hostedEnv(),
      nodeArgs: ["-r", preloadPath],
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.hosted.status, "ok");
  assert.equal(payload.hosted.data.leases[0].mode, "EXCLUSIVE");
  assert.equal(payload.state.leases[0].id, "lease_1");
  assert.equal(loadCollaborationState(dir).leases[0].status, "ACTIVE");
});

test("collaboration guard exits non-zero for hosted blocking conflicts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-collaboration-guard-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  const preloadPath = writeHostedCollaborationPreload(dir);

  const result = runCli(
    [
      "collaboration",
      "guard",
      "--files",
      "src/index.ts",
      "--action",
      "edit",
      "--actor-id",
      "agent_1",
      "--json",
    ],
    {
      cwd: dir,
      env: hostedEnv(),
      nodeArgs: ["-r", preloadPath],
    }
  );

  assert.equal(result.status, 2, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.hosted.status, "ok");
  assert.equal(payload.hosted.data.evaluation.decision, "BLOCKED");
  assert.equal(payload.actionCards[0].kind, "blocking_conflict");
  assert.equal(payload.actionCards[0].safeToAck, false);
  assert.equal(payload.state.lastGuard.decision, "BLOCKED");
  assert.equal(loadCollaborationState(dir).lastGuard.conflictCount, 1);
});

test("collaboration guard success is one line unless verbose", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-collaboration-guard-go-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  const preloadPath = writeHostedGoGuardPreload(dir);

  const result = runCli(
    [
      "collaboration",
      "guard",
      "--files",
      "src/index.ts",
      "--action",
      "edit",
      "--actor-id",
      "agent_1",
    ],
    {
      cwd: dir,
      env: hostedEnv(),
      nodeArgs: ["-r", preloadPath],
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "Collaboration guard: go");

  const verbose = runCli(
    [
      "collaboration",
      "guard",
      "--files",
      "src/index.ts",
      "--action",
      "edit",
      "--actor-id",
      "agent_1",
      "--verbose",
    ],
    {
      cwd: dir,
      env: hostedEnv(),
      nodeArgs: ["-r", preloadPath],
    }
  );

  assert.equal(verbose.status, 0, verbose.stderr || verbose.stdout);
  assert.match(verbose.stdout, /Collaboration guard/);
  assert.match(verbose.stdout, /State:/);
  assert.match(verbose.stdout, /Guard: CLEAR/);
});

test("collaboration guard can acknowledge review-only release warnings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-collaboration-review-only-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  const preloadPath = writeHostedReviewOnlyGuardPreload(dir);

  const blocked = runCli(
    [
      "collaboration",
      "guard",
      "--profile",
      "pre-deploy",
      "--action",
      "pre-deploy",
      "--actor-id",
      "agent_1",
      "--enforce",
      "--json",
    ],
    {
      cwd: dir,
      env: hostedEnv(),
      nodeArgs: ["-r", preloadPath],
    }
  );

  assert.equal(blocked.status, 2, blocked.stderr || blocked.stdout);
  const blockedPayload = JSON.parse(blocked.stdout);
  assert.equal(blockedPayload.hosted.data.evaluation.decision, "REVIEW_REQUIRED");
  assert.equal(blockedPayload.enforcement.reviewOnlyAcknowledged, false);

  const acknowledged = runCli(
    [
      "collaboration",
      "guard",
      "--profile",
      "pre-deploy",
      "--action",
      "pre-deploy",
      "--actor-id",
      "agent_1",
      "--enforce",
      "--ack-review-only",
      "--json",
    ],
    {
      cwd: dir,
      env: hostedEnv(),
      nodeArgs: ["-r", preloadPath],
    }
  );

  assert.equal(acknowledged.status, 0, acknowledged.stderr || acknowledged.stdout);
  const payload = JSON.parse(acknowledged.stdout);
  assert.equal(payload.hosted.data.evaluation.decision, "REVIEW_REQUIRED");
  assert.equal(payload.enforcement.reviewOnlyAcknowledged, true);
  assert.equal(payload.enforcement.ackSource, "explicit");
  assert.equal(payload.enforcement.failed, false);
  assert.ok(payload.actionCards.some((card) => card.kind === "safe_to_ack" && card.safeToAck));
  assert.ok(payload.actionCards.some((card) => card.kind === "needs_handoff"));
  assert.equal(payload.state.lastGuard.decision, "REVIEW_REQUIRED");
  assert.equal(loadCollaborationState(dir).lastGuard.conflictCount, 2);
  assert.equal(loadCollaborationState(dir).reviewOnlyAcknowledgements.length, 1);

  const hookRerun = runCli(
    [
      "collaboration",
      "guard",
      "--profile",
      "pre-deploy",
      "--action",
      "pre-deploy",
      "--actor-id",
      "agent_1",
      "--enforce",
      "--json",
    ],
    {
      cwd: dir,
      env: hostedEnv(),
      nodeArgs: ["-r", preloadPath],
    }
  );

  assert.equal(hookRerun.status, 0, hookRerun.stderr || hookRerun.stdout);
  const hookPayload = JSON.parse(hookRerun.stdout);
  assert.equal(hookPayload.enforcement.reviewOnlyAcknowledged, true);
  assert.equal(hookPayload.enforcement.ackSource, "persisted");
  assert.equal(loadCollaborationState(dir).reviewOnlyAcknowledgements.length, 0);

  const secondHookRerun = runCli(
    [
      "collaboration",
      "guard",
      "--profile",
      "pre-deploy",
      "--action",
      "pre-deploy",
      "--actor-id",
      "agent_1",
      "--enforce",
      "--json",
    ],
    {
      cwd: dir,
      env: hostedEnv(),
      nodeArgs: ["-r", preloadPath],
    }
  );
  assert.equal(secondHookRerun.status, 2, secondHookRerun.stderr || secondHookRerun.stdout);
});

test("collaboration guard stores state at the git root from nested package invocations", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-collaboration-git-root-"));
  const nestedDir = path.join(dir, "packages", "cli");
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  const gitInit = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  assert.equal(gitInit.status, 0, gitInit.stderr);
  const preloadPath = writeHostedReviewOnlyGuardPreload(dir);

  const result = runCli(
    [
      "collaboration",
      "guard",
      "--profile",
      "pre-commit",
      "--action",
      "pre-commit",
      "--resource",
      "SURFACE:checkout-git-write",
      "--actor-id",
      "agent_1",
      "--enforce",
      "--ack-review-only",
      "--json",
    ],
    {
      cwd: nestedDir,
      env: hostedEnv(),
      nodeArgs: ["-r", preloadPath],
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(
    payload.statePath,
    path.join(fs.realpathSync(dir), COLLABORATION_STATE_RELATIVE_PATH)
  );
  assert.equal(fs.existsSync(payload.statePath), true);
  assert.equal(fs.existsSync(path.join(nestedDir, COLLABORATION_STATE_RELATIVE_PATH)), false);
});

test("collaboration guard action cards classify missing evaluations", () => {
  const cards = buildCollaborationGuardActionCards(undefined);
  assert.equal(cards[0].kind, "guard_unavailable");
  assert.equal(cards[0].safeToAck, false);
});

test("collaboration guard fails open for hosted outages but fails closed for blocking conflicts", () => {
  assert.equal(
    shouldFailCollaborationGuard({
      hostedStatus: "error",
      evaluation: undefined,
      enforce: true,
      ackReviewOnly: false,
    }),
    false
  );

  assert.equal(
    shouldFailCollaborationGuard({
      hostedStatus: "ok",
      evaluation: {
        decision: "BLOCKED",
        severity: "CRITICAL",
        evaluatedAt: "2026-07-06T00:00:00.000Z",
        resources: [],
        conflicts: [],
        recommendedActions: [],
      },
      enforce: true,
      ackReviewOnly: false,
    }),
    true
  );
});

test("collaboration guard profile expands blocking deployment resources", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-collaboration-guard-profile-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  const preloadPath = writeHostedCollaborationPreload(dir);
  const logPath = path.join(dir, "collab-log.jsonl");

  const result = runCli(
    [
      "collaboration",
      "guard",
      "--profile",
      "pre-deploy",
      "--action",
      "pre-deploy",
      "--actor-id",
      "agent_1",
      "--json",
    ],
    {
      cwd: dir,
      env: hostedEnv({ SNIPARA_TEST_COLLAB_LOG: logPath }),
      nodeArgs: ["-r", preloadPath],
    }
  );

  assert.equal(result.status, 2, result.stderr || result.stdout);
  const logged = fs.readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
  const guardBody = logged.find((entry) => entry.path.endsWith("/collaboration/guard")).body;
  assert.equal(guardBody.action, "pre-deploy");
  assert.equal(
    guardBody.resources.some(
      (resource) => resource.kind === "DEPLOY" && resource.id === "production-deployment"
    ),
    true
  );
  assert.equal(
    guardBody.resources.some(
      (resource) => resource.kind === "SURFACE" && resource.id === "deployment"
    ),
    true
  );
});

test("collaboration git write profiles include checkout claim surface", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-collaboration-git-write-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  const preloadPath = writeHostedCollaborationPreload(dir);
  const logPath = path.join(dir, "collab-log.jsonl");

  const result = runCli(
    [
      "collaboration",
      "guard",
      "--profile",
      "pre-commit",
      "--action",
      "pre-commit",
      "--files",
      "src/index.ts",
      "--actor-id",
      "agent_1",
      "--json",
    ],
    {
      cwd: dir,
      env: hostedEnv({ SNIPARA_TEST_COLLAB_LOG: logPath }),
      nodeArgs: ["-r", preloadPath],
    }
  );

  assert.equal(result.status, 2, result.stderr || result.stdout);
  const logged = fs.readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
  const guardBody = logged.find((entry) => entry.path.endsWith("/collaboration/guard")).body;
  assert.equal(
    guardBody.resources.some(
      (resource) => resource.kind === "SURFACE" && resource.id === "checkout-git-write"
    ),
    true
  );
});

test("collaboration guard reads dirty git files with spaces", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-collaboration-dirty-"));
  spawnSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "with space.ts"), "export const value = 1;\n", "utf8");
  spawnSync("git", ["add", "-N", "src/with space.ts"], { cwd: dir, stdio: "ignore" });
  const preloadPath = writeHostedCollaborationPreload(dir);
  const logPath = path.join(dir, "collab-log.jsonl");

  const result = runCli(
    ["collaboration", "guard", "--action", "edit", "--actor-id", "agent_1", "--json"],
    {
      cwd: dir,
      env: hostedEnv({ SNIPARA_TEST_COLLAB_LOG: logPath }),
      nodeArgs: ["-r", preloadPath],
    }
  );

  assert.equal(result.status, 2, result.stderr || result.stdout);
  const logged = fs.readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
  const guardBody = logged.find((entry) => entry.path.endsWith("/collaboration/guard")).body;
  assert.ok(guardBody.files.includes("src/with space.ts"));
});

test("collaboration hooks install plan writes blocking managed hooks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-collaboration-hooks-"));
  spawnSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  const result = buildCollaborationHooksInstallPlan({ dir });

  assert.equal(result.mode, "blocking");
  assert.deepEqual(
    result.hooks.map((hook) => hook.hook),
    ["pre-commit", "pre-push"]
  );
  assert.equal(
    result.hooks.every((hook) => hook.action === "created"),
    true
  );
  const preCommitHook = fs.readFileSync(path.join(dir, ".git", "hooks", "pre-commit"), "utf8");
  assert.match(preCommitHook, /snipara_companion_hook collaboration guard --profile pre-commit/);
  assert.match(preCommitHook, /pnpm --filter snipara-companion exec tsx src\/index\.ts/);
  assert.match(preCommitHook, /snipara-companion "\$@"/);
  assert.match(preCommitHook, /collaboration claim --resource SURFACE:checkout-git-write/);
  assert.match(preCommitHook, /collaboration claim .*--json >\/dev\/null \|\| true/);
  assert.match(preCommitHook, /guard --profile pre-commit .*--resource SURFACE:checkout-git-write/);
  assert.match(preCommitHook, /--mode EXCLUSIVE --ttl-seconds 300/);
  assert.doesNotMatch(preCommitHook, /snipara-companion@latest/);
  assert.match(preCommitHook, /SNIPARA_COLLABORATION_GUARD=0/);
  assert.match(preCommitHook, /return 127/);
});

test("collaboration status reads hosted active sessions and leases", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-collaboration-status-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  const preloadPath = writeHostedCollaborationPreload(dir);

  const result = runCli(["collaboration", "status", "--json"], {
    cwd: dir,
    env: hostedEnv(),
    nodeArgs: ["-r", preloadPath],
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.hosted.status, "ok");
  assert.equal(payload.hosted.data.sessions.length, 1);
  assert.equal(payload.hosted.data.leases.length, 1);
});

test("collaboration ide-status prints compact local and hosted JSON for extensions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-collaboration-ide-status-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  const preloadPath = writeHostedCollaborationPreload(dir);

  const result = runCli(["collaboration", "ide-status"], {
    cwd: dir,
    env: hostedEnv(),
    nodeArgs: ["-r", preloadPath],
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.version, "snipara.collaboration.ide-status.v1");
  assert.equal(payload.hosted.status, "ok");
  assert.equal(payload.hosted.activeSessions.length, 1);
  assert.equal(payload.hosted.recentEvents.length, 1);
});
