const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

// Do not silently test a different bundle when the qualification host supplies one.
const cliPath = process.env.SNIPARA_COMPANION_TEST_CLI === undefined
  ? path.resolve(__dirname, "../dist/index.js")
  : path.resolve(process.env.SNIPARA_COMPANION_TEST_CLI);
assert.ok(!Object.hasOwn(process.env, "SNIPARA_COMPANION_TEST_CLI") ||
  process.env.SNIPARA_COMPANION_TEST_CLI.trim(), "CLI override must not be empty");
assert.ok(fs.existsSync(cliPath) && fs.statSync(cliPath).isFile(), `CLI bundle missing: ${cliPath}`);

const statePath = (cwd) => path.join(cwd, ".snipara/collaboration/session.json");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

// This is a transport fixture, not an implementation of CLI identity resolution.
// Persistent IDs are minted independently of logical IDs and must already exist
// for resume/lease operations. The registry survives separate CLI processes.
function hostedPreload() {
  const fs = require("node:fs");
  const registryFile = process.env.BOUNDARY_REGISTRY;
  const logFile = process.env.BOUNDARY_LOG;
  const db = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  const save = () => fs.writeFileSync(registryFile, JSON.stringify(db));
  const response = (data, status = 200) => ({
    ok: status < 400, status, statusText: status < 400 ? "OK" : "Not Found",
    json: async () => status < 400 ? { success: true, data } : { success: false, error: data },
    text: async () => JSON.stringify(data),
  });
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.hostname !== "boundary.example.test") throw new Error("Unexpected fixture host");
    const pathname = parsed.pathname;
    const body = JSON.parse(init.body || "{}");
    const method = init.method || "GET";
    fs.appendFileSync(logFile, JSON.stringify({ pathname, method, body }) + "\n");
    if (pathname.includes("/mcp/")) {
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: body.id,
        result: { content: [{ type: "text", text: "{}" }] } }) };
    }
    const projectId = decodeURIComponent(pathname.match(/\/projects\/([^/]+)/)?.[1] || "");
    const project = { id: projectId, slug: projectId, name: projectId };
    const resources = body.resources || (body.files || []).map(id => ({ kind: "FILE", id, sourcePath: id }));
    if (pathname.endsWith("/collaboration/sessions") && method === "POST") {
      let session;
      if (body.workSessionId !== undefined) {
        session = db.sessions[body.workSessionId];
        if (!session || session.projectId !== projectId || session.actorId !== body.actorId ||
            session.sessionId !== body.sessionId || session.worktree !== body.worktree) {
          return response("Unknown persistent work session", 404);
        }
      } else {
        const id = `server-session-${++db.next}`;
        session = { ...body, id, projectId, status: "ACTIVE", dirtyFiles: body.files || [],
          startedAt: "2026-10-01T00:00:00.000Z", lastHeartbeatAt: "2026-10-01T00:00:00.000Z" };
        db.sessions[id] = session;
        save();
      }
      return response({ project, session, resources }, 201);
    }
    if (pathname.endsWith("/collaboration/leases") && method === "POST") {
      const session = db.sessions[body.workSessionId];
      if (!session || session.projectId !== projectId || session.actorId !== body.actorId ||
          session.sessionId !== body.sessionId) return response("Unknown lease owner", 404);
      const leases = resources.map(resource => {
        const lease = { id: `server-lease-${++db.next}`, workSessionId: session.id,
          resourceKind: resource.kind, resourceId: resource.id, mode: body.mode || "ADVISORY",
          status: "ACTIVE", claimedByActorId: session.actorId, claimedByActorType: session.actorType,
          claimedByLabel: session.actorLabel, claimedAt: "2026-10-01T00:00:00.000Z",
          heartbeatAt: "2026-10-01T00:00:00.000Z", expiresAt: "2099-10-01T00:00:00.000Z" };
        db.leases[lease.id] = lease;
        return lease;
      });
      save();
      return response({ project, resources, leases }, 201);
    }
    if (pathname.includes("/collaboration/leases/") && method === "PATCH") {
      const lease = db.leases[decodeURIComponent(pathname.split("/").pop())];
      const owner = lease && db.sessions[lease.workSessionId];
      if (!owner || owner.projectId !== projectId || owner.actorId !== body.actorId ||
          owner.sessionId !== body.sessionId) return response("Unknown lease owner", 404);
      if (body.action === "heartbeat") lease.heartbeatCount = (lease.heartbeatCount || 0) + 1;
      if (body.action === "release") lease.status = "RELEASED";
      save();
      return response({ project, lease });
    }
    if (pathname.includes("/collaboration/")) throw new Error(`Unhandled collaboration request: ${method} ${pathname}`);
    if (pathname.endsWith("/team-sync/work-briefs")) return response({ project,
      brief: { id: "brief", task: body.task, generatedAt: "2026-10-01T00:00:00.000Z",
        evidenceLevel: "hosted", activeCollisions: [], staleAssumptions: [], failedJobs: [], recommendedActions: [] },
      whatChanged: { changes: [], decisions: [], nextActions: [], recommendedActions: [],
        summary: { changeCount: 0, decisionChanges: 0, staleAssumptions: 0, failedJobs: 0, overlapClusters: 0 } } });
    return response({ settings: {} });
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-session-boundaries-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const preload = path.join(root, "fetch.cjs");
  fs.writeFileSync(preload, `(${hostedPreload.toString()})();\n`);
  const registry = path.join(root, "registry.json");
  const log = path.join(root, "calls.jsonl");
  writeJson(registry, { next: 0, sessions: {}, leases: {} });
  // Allowlist instead of spreading process.env: no personal keys, config paths,
  // NODE_OPTIONS, workspace, project, actor or logical session can leak in.
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
    TMPDIR: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"),
    SNIPARA_API_KEY: "synthetic-boundary-key", SNIPARA_API_URL: "https://boundary.example.test",
    SNIPARA_PROJECT_ID: "project-a", SNIPARA_AGENT_ID: "alice", SNIPARA_ACTOR_LABEL: "Test actor",
    BOUNDARY_REGISTRY: registry, BOUNDARY_LOG: log, CI: "1", NO_COLOR: "1" };
  function workspace(name) {
    const cwd = path.join(root, name);
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src/a.ts"), "export const a = 1;\n");
    writeJson(path.join(cwd, "package.json"), { name: "boundary-fixture" });
    writeJson(path.join(cwd, "plan.json"), { mode: "full", steps: [
      { id: "edit", title: "Edit", files: ["src/a.ts"] },
    ] });
    return cwd;
  }
  function raw(cwd, args, overrides = {}) {
    const result = spawnSync(process.execPath, ["--require", preload, cliPath, ...args], {
      cwd, env: { ...env, ...overrides }, encoding: "utf8", timeout: 30000,
    });
    assert.ifError(result.error);
    return result;
  }
  function run(cwd, args, overrides = {}) {
    const result = raw(cwd, args, overrides);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  }
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const sessions = () => calls().filter(c => c.pathname.endsWith("/collaboration/sessions") && c.method === "POST");
  function start(cwd, id = "alpha", overrides = {}) {
    const before = calls().length;
    const output = run(cwd, ["workflow", "start", "--id", id, "--goal", "Qualify session boundaries",
      "--plan-file", path.join(cwd, "plan.json"), "--skip-agent-context", "--force", "--json"], overrides);
    return { receipt: output.coordination.startReceipt, calls: calls().slice(before), state: readJson(statePath(cwd)) };
  }
  function git(cwd, args) {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  return { root, workspace, raw, run, start, calls, sessions, git, registry };
}

function assertStarted(result, { resume, workflow = "alpha", actor = "alice", project = "project-a" } = {}) {
  const { receipt, state, calls } = result;
  assert.equal(receipt.hostedSessionStatus, "ok", receipt.hostedError);
  assert.equal(receipt.hostedClaimStatus, "ok", receipt.hostedError);
  assert.match(receipt.workSessionId, /^server-session-\d+$/);
  const sessions = calls.filter(c => c.pathname.endsWith("/collaboration/sessions"));
  assert.equal(sessions.length, 1);
  const request = sessions[0];
  assert.ok(request.pathname.includes(`/projects/${project}/`));
  assert.equal(request.body.workSessionId, resume);
  assert.ok(request.body.sessionId.startsWith(`workflow:${workflow}:`));
  assert.notEqual(request.body.sessionId, receipt.workSessionId);
  assert.equal(request.body.actorId, actor);
  assert.equal(state.workSessionId, receipt.workSessionId);
  assert.equal(state.sessionId, request.body.sessionId);
  assert.equal(state.actorId, actor);
  assert.ok(Object.values(state.workflowSessions).includes(receipt.workSessionId));
  const claims = calls.filter(c => c.pathname.endsWith("/collaboration/leases") && c.method === "POST");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].body.workSessionId, receipt.workSessionId);
  assert.equal(claims[0].body.sessionId, request.body.sessionId);
  assert.equal(claims[0].body.actorId, actor);
  assert.ok(claims[0].body.resources.some(r => r.kind === "FILE" && r.id === "src/a.ts"));
  const leases = state.leases.filter(l => l.workSessionId === receipt.workSessionId && l.status === "ACTIVE");
  assert.ok(leases.length > 0);
  assert.ok(leases.every(l => l.id.startsWith("server-lease-")));
  return receipt.workSessionId;
}

test("hosted workflow stores server identity, resumes it, and isolates workflow, actor and project", t => {
  const f = fixture(t);
  const cwd = f.workspace("checkout");
  const first = f.start(cwd);
  const a = assertStarted(first);
  const originalMap = { ...first.state.workflowSessions };
  assert.equal(assertStarted(f.start(cwd), { resume: a }), a);
  const b = assertStarted(f.start(cwd, "beta"), { workflow: "beta" });
  const c = assertStarted(f.start(cwd, "alpha", { SNIPARA_AGENT_ID: "bob" }), { actor: "bob" });
  const d = assertStarted(f.start(cwd, "alpha", { SNIPARA_PROJECT_ID: "project-b" }), { project: "project-b" });
  assert.equal(new Set([a, b, c, d]).size, 4);
  assert.equal(assertStarted(f.start(cwd, "beta"), { resume: b, workflow: "beta" }), b);
  assert.equal(assertStarted(f.start(cwd, "alpha", { SNIPARA_AGENT_ID: "bob" }),
    { resume: c, actor: "bob" }), c);
  assert.equal(assertStarted(f.start(cwd, "alpha", { SNIPARA_PROJECT_ID: "project-b" }),
    { resume: d, project: "project-b" }), d);
  assert.equal(assertStarted(f.start(cwd), { resume: a }), a);
  const state = readJson(statePath(cwd));
  assert.equal(Object.keys(state.workflowSessions).length, 4);
  for (const [key, value] of Object.entries(originalMap)) assert.equal(state.workflowSessions[key], value);
  const logicalIds = f.sessions().filter(c => !c.body.workSessionId).map(c => c.body.sessionId);
  assert.equal(new Set(logicalIds).size, 4);
});

test("separate git worktrees do not adopt copied collaboration identity", t => {
  const f = fixture(t);
  const main = f.workspace("main");
  f.git(main, ["init"]);
  f.git(main, ["add", "package.json", "plan.json", "src/a.ts"]);
  f.git(main, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"]);
  const other = path.join(f.root, "other");
  f.git(main, ["worktree", "add", "--detach", other]);
  assert.ok(fs.statSync(path.join(other, ".git")).isFile());
  const first = f.start(main);
  const a = assertStarted(first);
  // Even an accidentally copied state file must not authorize identity adoption.
  writeJson(statePath(other), first.state);
  const second = f.start(other);
  const b = assertStarted(second);
  assert.notEqual(a, b);
  assert.notEqual(first.state.worktree, second.state.worktree);
  assert.equal(assertStarted(f.start(main), { resume: a }), a);
  assert.equal(assertStarted(f.start(other), { resume: b }), b);
  assert.equal(readJson(statePath(main)).workSessionId, a);
  assert.equal(readJson(statePath(other)).workSessionId, b);
});

test("hosted state missing workflowSessions creates a workflow identity once", t => {
  const f = fixture(t);
  const cwd = f.workspace("legacy");
  const first = f.start(cwd);
  const oldId = assertStarted(first);
  const legacy = { ...first.state };
  delete legacy.workflowSessions;
  writeJson(statePath(cwd), legacy);
  const migrated = f.start(cwd);
  const fresh = assertStarted(migrated);
  assert.notEqual(fresh, oldId);
  assert.equal(Object.keys(migrated.state.workflowSessions).length, 1);
  assert.equal(assertStarted(f.start(cwd), { resume: fresh }), fresh);
});

// The host verifies installed package metadata and the frozen published bundle SHA256.
// This child-process check qualifies the selected executable's reported version only.
test("selected CLI reports the expected Companion version", t => {
  const f = fixture(t);
  const expected = process.env.SNIPARA_COMPANION_TEST_EXPECTED_VERSION || "3.7.4";
  assert.match(expected, /^\d+\.\d+\.\d+$/);
  const result = f.raw(f.workspace("version"), ["--version"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), expected);
});

test("literal legacy local fallback state never becomes a persistent hosted resume ID", t => {
  const f = fixture(t);
  const cwd = f.workspace("local-legacy");
  const logical = "workflow:alpha";
  const resource = { kind: "FILE", id: "src/a.ts" };
  const oldLease = { id: `local:${logical}:FILE:src/a.ts`, workSessionId: logical,
    mode: "ADVISORY", status: "ACTIVE", resources: [resource],
    claimedAt: "2026-10-01T00:00:00.000Z", expiresAt: "2099-10-01T00:00:00.000Z" };
  writeJson(statePath(cwd), { schemaVersion: "snipara.collaboration.v1",
    updatedAt: "2026-10-01T00:00:00.000Z", workSessionId: logical,
    sessionId: logical, actorId: "alice", actorType: "AGENT", worktree: cwd,
    files: ["src/a.ts"], resources: [resource], leases: [oldLease],
    reviewOnlyAcknowledgements: [] });
  assert.equal(f.calls().length, 0);
  assert.deepEqual(readJson(f.registry).sessions, {});
  const first = f.start(cwd);
  const id = assertStarted(first);
  assert.notEqual(id, logical);
  assert.deepEqual(first.state.leases.find(l => l.id === oldLease.id), oldLease,
    "legacy fallback lease is retained, not silently migrated or released");
  const second = f.start(cwd);
  assert.equal(assertStarted(second, { resume: id }), id);
  assert.deepEqual(second.state.leases.find(l => l.id === oldLease.id), oldLease);
  assert.deepEqual(f.sessions().map(c => c.body.workSessionId), [undefined, id]);
  assert.equal(readJson(f.registry).leases[oldLease.id], undefined);
});

test("unknown persisted server ID is refused without replacement or hosted lease call", t => {
  const f = fixture(t);
  const cwd = f.workspace("unknown");
  const first = f.start(cwd);
  const known = assertStarted(first);
  const state = readJson(statePath(cwd));
  const key = Object.keys(state.workflowSessions)[0];
  const unknown = "server-session-unknown";
  state.workflowSessions[key] = unknown;
  state.workSessionId = unknown;
  writeJson(statePath(cwd), state);
  const serverBefore = readJson(f.registry);
  for (let attempt = 0; attempt < 2; attempt++) {
    const refused = f.start(cwd);
    assert.equal(refused.receipt.hostedSessionStatus, "error");
    assert.equal(refused.receipt.hostedClaimStatus, "skipped");
    assert.match(refused.receipt.hostedError, /Unknown persistent work session|404/i);
    assert.equal(refused.receipt.workSessionId, unknown);
    const requests = refused.calls.filter(c => c.pathname.includes("/collaboration/"));
    assert.equal(requests.length, 1, "refusal must not retry creation or call hosted leases");
    assert.equal(requests[0].body.workSessionId, unknown);
    assert.ok(requests[0].pathname.endsWith("/collaboration/sessions"));
    assert.equal(refused.state.workflowSessions[key], unknown);
    assert.equal(refused.state.workSessionId, unknown);
    assert.deepEqual(readJson(f.registry), serverBefore);
    assert.notEqual(refused.state.workSessionId, known);
  }
});

// Ownership qualification below uses separate workspaces with one owner per local cache.
// It does not establish filtering of mixed-owner leases in a shared checkout/cache.
// In particular, no shared-cache watch/release safety guarantee is made by this suite.
const sortedIds = leases => leases.map(l => l.id).sort();
const patchId = call => decodeURIComponent(call.pathname.split("/").pop());

test("collaboration watch and release resolve default identity without a configured logical session", t => {
  const f = fixture(t);
  const cwd = f.workspace("default-identity");
  f.run(cwd, ["collaboration", "watch", "--once", "--files", "src/a.ts", "--json"]);
  const initial = readJson(statePath(cwd));
  assert.match(initial.workSessionId, /^server-session-\d+$/);
  assert.equal(initial.actorId, "alice");
  assert.equal(initial.sessionId, undefined);
  const ids = initial.leases.map(l => l.id).sort();
  assert.ok(ids.length > 0);
  const before = f.calls().length;
  f.run(cwd, ["collaboration", "watch", "--once", "--files", "src/a.ts", "--json"]);
  f.run(cwd, ["collaboration", "release", "--all", "--json"]);
  const calls = f.calls().slice(before);
  const sessions = calls.filter(c => c.pathname.endsWith("/collaboration/sessions"));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].body.workSessionId, initial.workSessionId);
  const patches = calls.filter(c => c.method === "PATCH");
  assert.equal(patches.length, ids.length * 2);
  for (const action of ["heartbeat", "release"]) {
    const selected = patches.filter(c => c.body.action === action);
    assert.deepEqual(selected.map(patchId).sort(), ids);
    for (const call of selected) {
      assert.equal(call.body.actorId, "alice");
      assert.equal(call.body.actorType, "AGENT");
      assert.equal(call.body.actorLabel, "Test actor");
      assert.equal(call.body.sessionId, undefined);
    }
  }
  const state = readJson(statePath(cwd));
  const registry = readJson(f.registry);
  assert.deepEqual(state.leases.map(l => l.id).sort(), ids);
  assert.deepEqual(Object.keys(registry.leases).sort(), ids);
  for (const id of ids) {
    assert.equal(state.leases.find(l => l.id === id).status, "RELEASED");
    assert.equal(registry.leases[id].status, "RELEASED");
    assert.equal(registry.leases[id].workSessionId, initial.workSessionId);
    assert.equal(registry.leases[id].heartbeatCount, 1);
  }
});

for (const competing of [
  { name: "different workflow, same actor", workflow: "beta", actor: "alice" },
  { name: "same workflow, competing actor", workflow: "alpha", actor: "bob" },
]) {
  test(`heartbeat/release preserve foreign leases across separate workspaces: ${competing.name}`, t => {
    const f = fixture(t);
    const cwd = f.workspace("owner");
    const foreignCwd = f.workspace("foreign");
    const started = f.start(cwd);
    const id = assertStarted(started);
    const foreign = f.start(foreignCwd, competing.workflow, { SNIPARA_AGENT_ID: competing.actor });
    const foreignId = assertStarted(foreign, { workflow: competing.workflow, actor: competing.actor });
    assert.notEqual(id, foreignId);
    const ownedIds = sortedIds(started.state.leases);
    const foreignIds = sortedIds(foreign.state.leases);
    assert.ok(ownedIds.length > 0);
    assert.ok(foreignIds.length > 0);
    assert.equal(new Set([...ownedIds, ...foreignIds]).size, ownedIds.length + foreignIds.length);
    const serverBefore = readJson(f.registry);
    const allIds = Object.keys(serverBefore.leases).sort();
    assert.deepEqual(allIds, [...ownedIds, ...foreignIds].sort());
    const foreignLocalBefore = readJson(statePath(foreignCwd));
    const foreignServerBefore = foreignIds.map(leaseId => serverBefore.leases[leaseId]);
    // resolveCollaborationContext reads this public config/env default; no identity flags.
    const identity = { SNIPARA_SESSION_ID: started.state.sessionId };
    const before = f.calls().length;
    f.run(cwd, ["collaboration", "watch", "--once", "--files", "src/a.ts", "--json"], identity);
    const watched = readJson(statePath(cwd));
    assert.equal(watched.workSessionId, id);
    assert.deepEqual(sortedIds(watched.leases), ownedIds);
    assert.deepEqual(watched.workflowSessions, started.state.workflowSessions);
    const afterWatch = readJson(f.registry);
    assert.deepEqual(Object.keys(afterWatch.leases).sort(), allIds);
    for (const leaseId of ownedIds) {
      assert.deepEqual(afterWatch.leases[leaseId], { ...serverBefore.leases[leaseId], heartbeatCount: 1 });
    }
    assert.deepEqual(foreignIds.map(leaseId => afterWatch.leases[leaseId]), foreignServerBefore);
    f.run(cwd, ["collaboration", "release", "--all", "--json"], identity);
    const calls = f.calls().slice(before);
    const resumes = calls.filter(c => c.pathname.endsWith("/collaboration/sessions"));
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0].body.workSessionId, id);
    assert.equal(resumes[0].body.sessionId, started.state.sessionId);
    const patches = calls.filter(c => c.method === "PATCH");
    assert.equal(patches.length, ownedIds.length * 2);
    for (const action of ["heartbeat", "release"]) {
      const matching = patches.filter(c => c.body.action === action);
      assert.deepEqual(matching.map(patchId).sort(), ownedIds);
      for (const request of matching) {
        assert.equal(request.body.actorId, "alice");
        assert.equal(request.body.actorType, "AGENT");
        assert.equal(request.body.actorLabel, "Test actor");
        assert.equal(request.body.sessionId, started.state.sessionId);
      }
    }
    const released = readJson(statePath(cwd));
    const serverReleased = readJson(f.registry);
    assert.deepEqual(sortedIds(released.leases), ownedIds, "no local lease disappears");
    assert.deepEqual(Object.keys(serverReleased.leases).sort(), allIds, "no registry lease disappears");
    for (const leaseId of ownedIds) {
      assert.deepEqual(released.leases.find(l => l.id === leaseId),
        { ...watched.leases.find(l => l.id === leaseId), status: "RELEASED" });
      assert.deepEqual(serverReleased.leases[leaseId], { ...afterWatch.leases[leaseId], status: "RELEASED" });
      assert.equal(serverReleased.leases[leaseId].workSessionId, id);
    }
    assert.equal(released.workSessionId, id);
    assert.equal(released.sessionId, started.state.sessionId);
    assert.deepEqual(released.workflowSessions, started.state.workflowSessions);
    assert.deepEqual(foreignIds.map(leaseId => serverReleased.leases[leaseId]), foreignServerBefore);
    assert.deepEqual(readJson(statePath(foreignCwd)), foreignLocalBefore);

    // This tests CLI handling against our strict mock ownership contract, not backend authorization.
    const rejectionBefore = f.calls().length;
    const rejected = f.raw(cwd, ["collaboration", "release", "--lease-id", foreignIds[0], "--json"], identity);
    assert.equal(rejected.status, 2, rejected.stderr || rejected.stdout);
    const payload = JSON.parse(rejected.stdout);
    assert.equal(payload.hosted.status, "error");
    assert.match(payload.hosted.error, /Unknown lease owner|404/i);
    const rejectionCalls = f.calls().slice(rejectionBefore);
    assert.equal(rejectionCalls.length, 1);
    assert.equal(rejectionCalls[0].method, "PATCH");
    assert.equal(patchId(rejectionCalls[0]), foreignIds[0]);
    assert.equal(rejectionCalls[0].body.actorId, "alice");
    assert.equal(rejectionCalls[0].body.sessionId, started.state.sessionId);
    assert.deepEqual(readJson(f.registry), serverReleased);
    assert.deepEqual(readJson(statePath(foreignCwd)), foreignLocalBefore);
    assert.equal(assertStarted(f.start(cwd), { resume: id }), id);
  });
}
