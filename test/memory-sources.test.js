const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const cli = path.resolve(__dirname, "../dist/index.js");

const LONG = "Changed the retrieval path and the ranking weights. ".repeat(40);

/** Fake hosted MCP: records every tool call; `behaviour` can fail or answer per tool. */
async function fakeServer(t, behaviour = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const tool = body.params?.name;
      const args = body.params?.arguments ?? {};
      calls.push({ tool, args });
      res.setHeader("content-type", "application/json");
      const reply = (result) => res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(result) }] } }));
      const failure = behaviour.fail?.(tool, args, calls.filter((c) => c.tool === tool).length);
      if (failure) return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: failure } }));
      if (behaviour.answer?.[tool]) return reply(behaviour.answer[tool](args));
      if (tool === "snipara_end_of_task_commit") return reply({ success: true, stored_count: 0, skipped_count: 0, candidates: [], stored_candidates: [], skipped_candidates: [] });
      if (tool === "snipara_recall") return reply({ memories: [], warnings: [], total_searched: 0, query: "" });
      reply({});
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { calls, url: `http://127.0.0.1:${server.address().port}` };
}

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-memsrc-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => spawnSync("git", args, { cwd, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  fs.mkdirSync(path.join(cwd, ".snipara/plans"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "docs"));
  fs.writeFileSync(path.join(cwd, "docs/design.md"), "# Design\n\n## Decision\n\nText\n");
  fs.writeFileSync(path.join(cwd, ".snipara/plans/p.json"), JSON.stringify({ id: "wf", goal: "Goal", mode: "standard",
    phases: [{ id: "one", title: "One", query: "q1" }, { id: "two", title: "Two", query: "q2" }] }));
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { cwd, git };
}

function run(cwd, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, HOME: cwd, SNIPARA_WORKSPACE_DIR: cwd, SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const hosted = (server) => ({
  SNIPARA_API_KEY: "snp-test", SNIPARA_PROJECT_ID: "project_1", SNIPARA_API_URL: server.url, SNIPARA_SESSION_ID: "s1",
  SNIPARA_AUTOMATION_CLIENT: "claude",
});
const local = { SNIPARA_LOCAL_ONLY: "1" };

async function started(t, server, extra = {}) {
  const f = fixture(t);
  const started = await run(f.cwd, ["workflow", "start", "--plan-file", ".snipara/plans/p.json", "--skip-agent-context", "--json"], local);
  assert.equal(started.status, 0, started.stderr);
  const phaseStart = await run(f.cwd, ["workflow", "phase-start", "one", "--json"], local);
  assert.equal(phaseStart.status, 0, phaseStart.stderr);
  fs.writeFileSync(path.join(f.cwd, "change.txt"), "x");
  f.git("add", "-A");
  f.git("commit", "-q", "-m", "work");
  return { ...f, env: { ...hosted(server), ...extra } };
}

const commits = (server) => server.calls.filter((c) => c.tool === "snipara_end_of_task_commit");
const outcomes = (server) => server.calls.filter((c) => c.tool === "snipara_memory_outcome");

test("phase-commit sends a short body, category phase-commit and exact source pointers", async (t) => {
  const server = await fakeServer(t);
  const f = await started(t, server);
  const result = await run(f.cwd, ["workflow", "phase-commit", "one", "--summary", LONG, "--source", "docs/design.md#Decision", "--json"], f.env);
  assert.equal(result.status, 0, result.stderr);
  const [call] = commits(server);
  assert.ok(call.args.summary.length <= 600, `summary ${call.args.summary.length}`);
  assert.equal(call.args.category, "phase-commit");
  const sources = call.args.sources;
  assert.ok(sources.length <= 8);
  assert.deepEqual(sources[0], { path: ".snipara/plans/p.json", json_pointer: "/phases/0" });
  assert.deepEqual(sources[1], { path: ".snipara/workflow/current.json", json_pointer: "/phases/0" });
  assert.deepEqual(sources.find((s) => s.heading), { path: "docs/design.md", heading: "Decision" });
  const shas = sources.filter((s) => s.commit).map((s) => s.commit);
  assert.ok(shas.length >= 1 && shas.every((sha) => /^[0-9a-f]{40}$/.test(sha)));
  assert.equal(shas[0], f.git("rev-parse", "HEAD").stdout.trim());
});

test("final-commit sends a short body, category final-commit and pointers (handoff when present)", async (t) => {
  const server = await fakeServer(t);
  const f = await started(t, server);
  fs.mkdirSync(path.join(f.cwd, ".snipara/orchestrator"), { recursive: true });
  fs.writeFileSync(path.join(f.cwd, ".snipara/orchestrator/handoff.json"), "{}");
  const result = await run(f.cwd, ["final-commit", "--summary", LONG, "--outcome", "partial", "--json"], f.env);
  assert.equal(result.status, 0, result.stderr);
  const [call] = commits(server);
  assert.ok(call.args.summary.length <= 600, `summary ${call.args.summary.length}`);
  assert.equal(call.args.category, "final-commit");
  assert.ok(call.args.sources.some((s) => s.path === ".snipara/orchestrator/handoff.json"));
  assert.ok(call.args.sources.some((s) => s.path === ".snipara/plans/p.json"));
  assert.ok(call.args.sources.length <= 8);
});

test("a malformed pointer is dropped and the write retried once with the same body", async (t) => {
  const server = await fakeServer(t, {
    fail: (tool, args, n) => (tool === "snipara_end_of_task_commit" && n === 1 ? "Validation error: sources[1] json_pointer is not a valid RFC 6901 pointer" : undefined),
  });
  const f = await started(t, server);
  const result = await run(f.cwd, ["workflow", "phase-commit", "one", "--summary", "Short", "--json"], f.env);
  assert.equal(result.status, 0, result.stderr);
  const sent = commits(server);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].args.summary, sent[0].args.summary);
  assert.equal(sent[1].args.sources.length, sent[0].args.sources.length - 1);
  assert.ok(!sent[1].args.sources.includes(sent[0].args.sources[1]));
});

test("a validation error that names no pointer drops all pointers, still one retry, never a longer body", async (t) => {
  const server = await fakeServer(t, {
    fail: (tool, args, n) => (tool === "snipara_end_of_task_commit" && n === 1 ? "sources: invalid pointer" : undefined),
  });
  const f = await started(t, server);
  const result = await run(f.cwd, ["workflow", "phase-commit", "one", "--summary", LONG, "--json"], f.env);
  assert.equal(result.status, 0, result.stderr);
  const sent = commits(server);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].args.sources, undefined);
  assert.ok(sent[1].args.summary.length <= sent[0].args.summary.length);
});

const manyMemories = (count) => ({
  memories: Array.from({ length: count }, (_, i) => ({ memory_id: `mem_${i}`, content: `SECRET-TEXT-${i}`, type: "decision", scope: "project", relevance: 0.9, confidence: 0.8 })),
  warnings: [], total_searched: count, query: "q",
});

test("served ids are tracked per phase, bounded and text-free", async (t) => {
  const server = await fakeServer(t, { answer: { snipara_recall: () => manyMemories(150) } });
  const f = await started(t, server);
  const recalled = await run(f.cwd, ["recall", "-q", "anything", "--limit", "150"], f.env);
  assert.equal(recalled.status, 0, recalled.stderr);
  const file = path.join(f.cwd, ".snipara/workflow/served-memories.json");
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes("SECRET-TEXT"));
  const data = JSON.parse(raw);
  assert.equal(data.workflowId, "wf");
  assert.equal(data.phases.one.length, 50);
  assert.ok(data.phases.one.every((id) => /^mem_\d+$/.test(id)));
  assert.ok(fs.statSync(file).size < 4096);
});

test("local-only mode tracks nothing and sends nothing", async (t) => {
  const server = await fakeServer(t, { answer: { snipara_recall: () => manyMemories(3) } });
  const f = await started(t, server);
  fs.writeFileSync(path.join(f.cwd, ".snipara/workflow/served-memories.json"), JSON.stringify({ version: 1, workflowId: "wf", phases: { one: ["mem_1"] } }));
  const result = await run(f.cwd, ["workflow", "phase-commit", "one", "--summary", "Done", "--json"], { ...f.env, ...local });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(server.calls, []);
  assert.equal(fs.existsSync(path.join(f.cwd, ".snipara/workflow/outcome-pending.json")), false);
});

async function commitWithServed(f, server, extraArgs = [], phase = "one") {
  fs.writeFileSync(path.join(f.cwd, ".snipara/workflow/served-memories.json"), JSON.stringify({ version: 1, workflowId: "wf", phases: { [phase]: ["mem_1", "mem_2"] } }));
  return run(f.cwd, ["workflow", "phase-commit", phase, "--summary", "Done", "--json", ...extraArgs], f.env);
}

test("the phase outcome is succeeded_unverified without a receipt and sent once with an idempotent run id", async (t) => {
  const server = await fakeServer(t);
  const f = await started(t, server);
  const result = await commitWithServed(f, server);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(outcomes(server).length, 1);
  const payload = outcomes(server)[0].args;
  assert.equal(payload.result, "succeeded_unverified");
  assert.deepEqual(payload.memory_ids, ["mem_1", "mem_2"]);
  assert.equal(payload.phase_id, "wf:0");
  assert.equal(payload.session_id, "s1");
  assert.equal(payload.receipt_ref, undefined);
  assert.equal(payload.verdicts, undefined);
  assert.equal(JSON.parse(result.stdout).memory.send, "sent");
  assert.equal(commits(server)[0].args.session_id, "s1");
});

test("succeeded_verified only with a recorded Sandbox receipt from this phase", async (t) => {
  const server = await fakeServer(t);
  const f = await started(t, server);
  const old = new Date(Date.now() - 3600_000).toISOString();
  fs.writeFileSync(path.join(f.cwd, ".snipara/workflow/validation-receipts.json"), JSON.stringify({ version: 1, receipts: [{ runId: "a".repeat(32), verifiedAt: old }] }));
  const stale = await commitWithServed(f, server);
  assert.equal(stale.status, 0, stale.stderr);
  assert.equal(outcomes(server)[0].args.result, "succeeded_unverified", "a receipt older than the phase does not count");

  const g = await started(t, server);
  const fresh = new Date(Date.now() + 1000).toISOString();
  fs.writeFileSync(path.join(g.cwd, ".snipara/workflow/validation-receipts.json"), JSON.stringify({ version: 1, receipts: [{ runId: "b".repeat(32), verifiedAt: fresh }] }));
  const verified = await commitWithServed(g, server);
  assert.equal(verified.status, 0, verified.stderr);
  const payload = outcomes(server)[1].args;
  assert.equal(payload.result, "succeeded_verified");
  assert.equal(payload.receipt_ref, "b".repeat(32));
});

test("blocked and abandoned phases never confirm", async (t) => {
  const server = await fakeServer(t);
  const f = await started(t, server);
  const failed = await commitWithServed(f, server, ["--outcome", "blocked"]);
  assert.equal(failed.status, 0, failed.stderr);
  assert.equal(outcomes(server)[0].args.result, "failed");
  const g = await started(t, server);
  const abandoned = await commitWithServed(g, server, ["--outcome", "abandoned"]);
  assert.equal(abandoned.status, 0, abandoned.stderr);
  assert.equal(outcomes(server)[1].args.result, "abandoned");
});

test("no refutation is sent unless the agent or user passes a verdict", async (t) => {
  const server = await fakeServer(t);
  const f = await started(t, server);
  await commitWithServed(f, server);
  const plain = outcomes(server)[0].args;
  assert.equal(plain.verdicts, undefined);
  const g = await started(t, server);
  const explicit = await commitWithServed(g, server, ["--memory-misled", "mem_2", "--memory-helped", "mem_1", "--memory-helped", "bad id!"]);
  assert.equal(explicit.status, 0, explicit.stderr);
  const payload = outcomes(server)[1].args;
  assert.deepEqual(payload.verdicts, { "mem_1": "helped", "mem_2": "misled" });
});

test("a failed outcome send never fails the commit and is retried at the next commit", async (t) => {
  const server = await fakeServer(t, {
    fail: (tool, args, n) => (tool === "snipara_memory_outcome" && n === 1 ? "temporarily unavailable" : undefined),
  });
  const f = await started(t, server);
  const first = await commitWithServed(f, server);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).memory.send, "queued");
  const pending = JSON.parse(fs.readFileSync(path.join(f.cwd, ".snipara/workflow/outcome-pending.json"), "utf8"));
  assert.equal(pending.pending.length, 1);

  const next = await run(f.cwd, ["workflow", "phase-start", "two", "--json"], local);
  assert.equal(next.status, 0, next.stderr);
  const second = await commitWithServed(f, server, [], "two");
  assert.equal(second.status, 0, second.stderr);
  const runIds = outcomes(server).map((c) => c.args.phase_id);
  assert.deepEqual(runIds, ["wf:0", "wf:0", "wf:1"]);
  assert.equal(fs.existsSync(path.join(f.cwd, ".snipara/workflow/outcome-pending.json")), false);
});

test("default phase-commit receipts stay under 2 KB and show counts only", async (t) => {
  const server = await fakeServer(t);
  const f = await started(t, server);
  const text = await commitWithServed(f, server);
  assert.equal(text.status, 0, text.stderr);
  assert.ok(Buffer.byteLength(text.stdout) < 2048);
  assert.deepEqual(Object.keys(JSON.parse(text.stdout).memory).sort(), ["outcome", "send", "served", "sources"]);
  const g = await started(t, server);
  fs.writeFileSync(path.join(g.cwd, ".snipara/workflow/served-memories.json"), JSON.stringify({ version: 1, workflowId: "wf", phases: { one: ["mem_1"] } }));
  const plain = await run(g.cwd, ["workflow", "phase-commit", "one", "--summary", "Done"], g.env);
  assert.equal(plain.status, 0, plain.stderr);
  assert.ok(Buffer.byteLength(plain.stdout) < 2048);
  assert.match(plain.stdout, /Memory: sources \d+, served 1, outcome succeeded_unverified, send sent/);
});

test("recall tolerates the compact and the full response shapes", async (t) => {
  const compact = { memories: [{ memory_id: "m1", content: "Compact memory", type: "decision", scope: "project", relevance: 0.9, confidence: 0.8, sources: [{ path: "a.md" }] }], total_searched: 1 };
  const full = { memories: [{ memory_id: "m2", content: "Full memory", type: "decision", scope: "project", status: "active", relevance: 0.9, confidence: 0.8, authority: { level: "high" }, owner: { id: "o" }, temporal: {} }],
    warnings: [], total_searched: 1, query: "q", timing_ms: 12, scope_partitions: [], candidate_selection: {} };
  for (const [shape, answer, text] of [["compact", compact, "Compact memory"], ["full", full, "Full memory"]]) {
    const server = await fakeServer(t, { answer: { snipara_recall: () => answer } });
    const f = fixture(t);
    const result = await run(f.cwd, ["recall", "-q", "q"], hosted(server));
    assert.equal(result.status, 0, `${shape}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(text));
    assert.match(result.stdout, /Searched:\s+1/);
    const json = await run(f.cwd, ["recall", "-q", "q", "--json"], hosted(server));
    assert.deepEqual(JSON.parse(json.stdout).warnings, []);
    assert.equal(server.calls[0].args.include_metadata, undefined, "recall must not ask for the heavy shape");
  }
});
