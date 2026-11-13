const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildPhaseBrief, assemblePhaseBrief, phasePlanAdvice, createClient } = require("../dist/index.js");
const phase = { id: "fix", title: "Fix query routing", query: "routing", status: "in_progress",
  files: ["src/query.ts"], tasks: [{ id: "route", title: "Preserve the query scope", files: ["src/query.ts"] }] };
const memory = { memory_id: "mem-route", type: "decision", content: "Keep project scope explicit.", sources: [{ path: "docs/scope.md", line_start: 12 }] };
const context = { sections: [{ file: "docs/query.md", lines: [10, 18], title: "Query scope" }] };
const node = (file, name) => ({ file_path: file, qualified_name: name, symbol_key: name });
const risks = { index_freshness: { indexed_commit_sha: "a".repeat(40), warnings: [{ code: "old" }] },
  impact: { impact_chains: [
    { source: node("src/query.ts", "query"), target: node("src/api.ts", "apiQuery") },
    { source: node("src/query.ts", "query"), target: node("src/query.ts", "localQuery") },
  ] } };
const sessions = { sessions: [
  { id: "self", sessionId: "logical-self", actorLabel: "Me", status: "ACTIVE", repository: "repo", dirtyFiles: ["src/query.ts"] },
  { id: "other", actorLabel: "Claude", status: "ACTIVE", repository: "repo", dirtyFiles: ["src/query.ts"], lastHeartbeatAt: "2026-11-12T12:00:00Z" },
], leases: [] };

test("assembles all five sections from concurrent stubbed client lookups", async () => {
  const started = [];
  const wrap = (name, value) => async () => { started.push(name); await Promise.resolve(); return value; };
  const { brief, briefLookups } = await buildPhaseBrief(phase, { local: { workSessionId: "self", repository: "repo" }, client: {
    codeImpact: wrap("risks", risks), getCollaborationState: wrap("sessions", sessions),
    recallMemories: async (query, options) => { assert.equal(query, "Fix query routing"); assert.equal(options.limit, 3); assert.equal(options.task, "Fix query routing"); started.push("memories"); return { memories: [memory] }; },
    queryContext: async (_, tokens, options) => { assert.equal(tokens, 600); assert.equal(options.returnReferences, undefined); assert.equal(options.includeSharedContext, false); started.push("context"); return context; },
  } });
  assert.equal(started.length, 4);
  assert.deepEqual(Object.keys(brief), ["text", "tasks", "risks", "sessions", "memories", "context"]);
  assert.match(brief.text, /1\. route: Preserve/);
  assert.match(brief.text, /apiQuery/); assert.doesNotMatch(brief.text, /localQuery/);
  assert.match(brief.text, /indexed a+; stale\/warning/);
  assert.doesNotMatch(brief.text, /Me:/); assert.match(brief.text, /Claude:/);
  assert.match(brief.text, /mem-route \[decision\]/); assert.match(brief.text, /docs\/scope.md:12/);
  assert.match(brief.text, /docs\/query.md:10-18 — Query scope/);
  assert.equal(briefLookups.risks, risks);
});

test("risks use the dependents list of the server and fit the section limit", () => {
  const dependents = { total_dependents: 8, test_files: 3, dependents: Array.from({ length: 8 }, (_, i) => ({
    file_path: `apps/mcp-server/src/engine/scoring/some_long_module_name_${i}.py`, is_test: i > 4 })) };
  const brief = assemblePhaseBrief(phase, { risks: { brief: true, dependents,
    index_freshness: { indexed_commit_sha: "33b4793b1ba9aaaaaaaaaaaaaaaaaaaaaaaaaaaa", warnings: [] } } });
  assert.equal(brief.risks.length, 1);
  assert.match(brief.risks[0], /^8 files depend on the changed files \(3 tests\): /);
  assert.match(brief.risks[0], /; indexed 33b4793b1ba9$/);
});

test("own file claims are not listed as another session", () => {
  const own = { id: "self", actorId: "sess_me", status: "ACTIVE", actorLabel: "Me" };
  const lease = { status: "ACTIVE", resourceId: phase.files?.[0] ?? phase.tasks[0].files[0], claimedByActorId: "sess_me", claimedByLabel: "Me" };
  const brief = assemblePhaseBrief(phase, { sessions: { sessions: [own], leases: [lease] } }, { workSessionId: "self" });
  assert.equal(brief.sessions, undefined);
  const other = assemblePhaseBrief(phase, { sessions: { sessions: [own], leases: [{ ...lease, claimedByActorId: "sess_other", claimedByLabel: "Other" }] } }, { workSessionId: "self" });
  assert.match(other.sessions[0], /^Other: /);
});

test("omits empty sections and explicit abstentions", () => {
  assert.deepEqual(assemblePhaseBrief({ tasks: [] }, {}), { text: "" });
  const brief = assemblePhaseBrief(phase, { memories: { memories: [memory], no_supporting_memory: true },
    context: { ...context, no_supporting_source: true } });
  assert.deepEqual(Object.keys(brief), ["text", "tasks"]);
});

test("caps total text and structured arrays; raw lookups remain uncut", async () => {
  const memories = Array.from({ length: 20 }, (_, i) => ({ ...memory, memory_id: `m${i}`, content: "word ".repeat(1000) }));
  const { brief, briefLookups } = await buildPhaseBrief({ ...phase, tasks: Array.from({ length: 20 }, () => phase.tasks[0]) }, { client: {
    codeImpact: async () => risks, getCollaborationState: async () => sessions,
    recallMemories: async () => ({ memories }), queryContext: async () => ({ sections: Array.from({ length: 20 }, () => context.sections[0]) }),
  } });
  assert.ok(brief.text.length <= 1500);
  for (const key of ["risks", "sessions", "memories", "context"]) assert.ok((brief[key]?.length ?? 0) <= 3);
  assert.equal(briefLookups.memories.memories.length, 20);
});

test("timeout is a successful result with one trailing Skipped line", async () => {
  const result = await buildPhaseBrief(phase, { timeoutMs: 5, client: {
    codeImpact: async () => ({}), getCollaborationState: async () => ({ sessions: [], leases: [] }),
    recallMemories: () => new Promise(() => {}), queryContext: async () => ({ sections: [] }),
  } });
  assert.equal(result.brief.text.split("\n").at(-1), "Skipped: memories (timeout)");
  assert.equal(process.exitCode ?? 0, 0);
});

test("local-only and absent client never call hosted lookups", async () => {
  const before = process.env.SNIPARA_LOCAL_ONLY;
  process.env.SNIPARA_LOCAL_ONLY = "1";
  try {
    const fail = () => { throw new Error("hosted call forbidden"); };
    const { brief } = await buildPhaseBrief(phase, { client: { codeImpact: fail, getCollaborationState: fail, recallMemories: fail, queryContext: fail } });
    assert.deepEqual(Object.keys(brief), ["text", "tasks"]);
    assert.deepEqual((await buildPhaseBrief(phase)).brief, brief);
  } finally { if (before === undefined) delete process.env.SNIPARA_LOCAL_ONLY; else process.env.SNIPARA_LOCAL_ONLY = before; }
});

test("real recall client records served ids for phase outcomes without network", async () => {
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-brief-"));
  try {
    fs.mkdirSync(path.join(dir, ".snipara/workflow"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".snipara/workflow/current.json"), JSON.stringify({ workflowId: "wf", currentPhaseId: "fix" }));
    process.chdir(dir);
    const client = createClient();
    // Stub the transport, retaining recall normalization and the existing outcome recorder.
    client.mcpCall = async () => ({ memories: [memory] });
    await buildPhaseBrief(phase, { client: {
      recallMemories: client.recallMemories.bind(client), codeImpact: async () => ({}),
      getCollaborationState: async () => ({ sessions: [], leases: [] }), queryContext: async () => ({ sections: [] }),
    } });
    const served = JSON.parse(fs.readFileSync(path.join(dir, ".snipara/workflow/served-memories.json"), "utf8"));
    assert.deepEqual(served.phases.fix, ["mem-route"]);
  } finally { process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("plan advice is advisory, actionable and at most three lines", () => {
  assert.deepEqual(phasePlanAdvice([phase]), []);
  assert.match(phasePlanAdvice([{ id: "empty" }]).join("\n"), /Add files.*\nAdd simple tasks/);
  const advice = phasePlanAdvice([{ id: "large", tasks: Array.from({ length: 8 }, () => ({ title: "x".repeat(201), files: Array(6).fill("file") })) }, { id: "empty" }]);
  assert.equal(advice.length, 2);
  assert.equal(phasePlanAdvice([{ id: "large", tasks: Array.from({ length: 8 }, () => ({ title: "x".repeat(201) })) }, { id: "empty" }]).length, 3);
  assert.match(advice.join("\n"), /at most 7/);
  assert.match(phasePlanAdvice([{ id: "long", files: ["file"], tasks: [{ title: "x".repeat(201) }] }])[0], /Shorten/);
});

test("directory claims overlap and logical current session is excluded", () => {
  const brief = assemblePhaseBrief(phase, { sessions: { sessions: [sessions.sessions[0]], leases: [
    { status: "ACTIVE", workSessionId: "self", resourceId: "src", claimedByLabel: "Me" },
    { status: "ACTIVE", workSessionId: "claim-owner", resourceId: "src", claimedByLabel: "Reviewer", heartbeatAt: "now" },
  ] } }, { sessionId: "logical-self", workSessionId: "self" });
  assert.doesNotMatch(brief.text, /Me:/);
  assert.match(brief.text, /Reviewer: src; now/);
});

test("CLI --no-brief preserves receipt fields and saves the compact brief", () => {
  const { spawnSync } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-receipt-"));
  try {
    fs.mkdirSync(path.join(dir, ".snipara/workflow"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".snipara/workflow/current.json"), JSON.stringify({
      schemaVersion: "snipara.workflow.v2", workflowId: "wf", goal: phase.title,
      status: "active", currentPhaseId: "fix", createdAt: "2026-11-12T12:00:00Z",
      updatedAt: "2026-11-12T12:00:00Z", phases: [phase],
    }));
    const result = spawnSync(process.execPath, [path.resolve(__dirname, "../dist/index.js"), "workflow", "phase-start", "fix", "--no-brief", "--json"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, SNIPARA_LOCAL_ONLY: "1", SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.workflowId, "wf");
    assert.equal(receipt.operation, "phase-start");
    assert.deepEqual(Object.keys(receipt.brief), ["text", "tasks"]);
    const detail = JSON.parse(fs.readFileSync(path.join(dir, receipt.detailPath), "utf8"));
    assert.deepEqual(detail.brief, receipt.brief);
    assert.deepEqual(detail.briefLookups, {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
