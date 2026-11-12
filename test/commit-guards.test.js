/**
 * Pre-commit guards under the environment git really gives hooks.
 *
 * The tests run the repository's own `.husky/pre-commit` through a real
 * `git commit` inside a linked worktree. `pnpm` is replaced by a shim that, like
 * `pnpm --filter ... exec`, changes the working directory to `packages/cli`
 * before running the built Companion; lint, lint-staged and type-check are
 * stubbed because they are not what is being tested. Hosted calls are answered
 * by a fetch stub that records every request.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const cli = path.resolve(__dirname, "../dist/index.js");
const realHook = path.resolve(__dirname, "../../../.husky/pre-commit");
const hookOptions = {
  skip: fs.existsSync(realHook) ? false : "requires monorepo .husky/pre-commit (absent in standalone export)",
};

function git(cwd, args, options = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", ...options });
  return result;
}
function mustGit(cwd, args, options) {
  const result = git(cwd, args, options);
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "snipara-commit-guards-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, "main");
  const linked = path.join(root, "linked");
  const out = path.join(root, "out");
  const bin = path.join(root, "bin");
  fs.mkdirSync(main);
  fs.mkdirSync(out);
  fs.mkdirSync(bin);
  mustGit(main, ["init", "-q", "-b", "main"]);
  mustGit(main, ["config", "user.name", "Fixture"]);
  mustGit(main, ["config", "user.email", "fixture@example.test"]);
  fs.mkdirSync(path.join(main, "packages/cli"), { recursive: true });
  fs.mkdirSync(path.join(main, ".husky"), { recursive: true });
  fs.mkdirSync(path.join(main, "docs"), { recursive: true });
  fs.writeFileSync(path.join(main, "packages/cli/.keep"), "");
  fs.writeFileSync(path.join(main, "app.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(main, "package.json"), "{}");
  fs.copyFileSync(realHook, path.join(main, ".husky/pre-commit"));
  fs.chmodSync(path.join(main, ".husky/pre-commit"), 0o755);
  mustGit(main, ["add", "-A"]);
  mustGit(main, ["commit", "-q", "-m", "base", "--no-verify"]);
  mustGit(main, ["config", "core.hooksPath", ".husky"]);
  mustGit(main, ["worktree", "add", "-q", "-b", "feature", linked]);

  // pnpm shim: `pnpm --filter snipara-companion exec tsx src/index.ts ...` runs the built CLI from packages/cli.
  fs.writeFileSync(
    path.join(bin, "pnpm"),
    `#!/bin/sh
case "$1" in
  --filter)
    shift 5
    cd "$SNIPARA_WORKSPACE_DIR/packages/cli" || exit 99
    case "$1" in
      memory-guard) node "$SNIPARA_TEST_CLI" "$@" --json | tee "$SNIPARA_TEST_OUT/memory.json" ;;
      *) node "$SNIPARA_TEST_CLI" "$@" ;;
    esac
    exit $?
    ;;
  lint-staged|lint|type-check)
    [ "$1" != "$SNIPARA_TEST_FAIL" ] || exit 9
    exit 0
    ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(path.join(bin, "snipara-companion"), `#!/bin/sh\nexec node "$SNIPARA_TEST_CLI" "$@"\n`, { mode: 0o755 });

  const preload = path.join(root, "preload.js");
  fs.writeFileSync(
    preload,
    `const fs = require("node:fs");
globalThis.fetch = async (url, init = {}) => {
  const p = new URL(String(url)).pathname;
  const body = init.body ? JSON.parse(init.body) : {};
  fs.appendFileSync(process.env.SNIPARA_TEST_OUT + "/requests.jsonl", JSON.stringify({ path: p, method: init.method, body }) + "\\n");
  const project = { id: "project_1", name: "App", slug: "app" };
  const ok = (data) => ({ ok: true, status: 200, statusText: "OK", json: async () => ({ success: true, data }) });
  if (p.endsWith("/collaboration/guard")) {
    const resources = [...(body.resources || []), ...(body.files || []).map((f) => ({ kind: "FILE", id: f, sourcePath: f }))];
    const blocked = process.env.SNIPARA_TEST_GUARD === "BLOCKED";
    return ok({ project, resources, guardEvent: { id: "g1" }, evaluation: {
      decision: blocked ? "BLOCKED" : "CLEAR", severity: blocked ? "CRITICAL" : "INFO",
      evaluatedAt: "2026-11-11T10:00:00.000Z", resources,
      conflicts: blocked ? [{ code: "hard_block_lease_overlap", decision: "BLOCKED", severity: "CRITICAL", resource: resources[0],
        conflictingActor: { actorId: "a2", actorType: "AGENT", actorLabel: "Other" }, reason: "Another agent holds a hard block.",
        recommendedAction: "Wait for release.", leaseId: "l1" }] : [],
      recommendedActions: [] } });
  }
  return ok({ project, resources: [], leases: [], session: { id: "work_1", actorId: "agent_1", actorType: "AGENT", status: "ACTIVE", dirtyFiles: [] } });
};
`
  );

  // Unrelated work in the linked worktree: a dirty tracked file and an untracked one.
  fs.writeFileSync(path.join(linked, "app.ts"), "export const a = 2; // unstaged\n");
  fs.writeFileSync(path.join(linked, "scratch.ts"), "untracked\n");
  fs.mkdirSync(path.join(linked, "docs"), { recursive: true });
  fs.writeFileSync(path.join(linked, "docs/note.md"), "documentation only\n");
  mustGit(linked, ["add", "docs/note.md"]);

  const env = (extra = {}) => ({
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env.PATH}`,
    NODE_OPTIONS: `--require ${preload}`,
    SNIPARA_API_KEY: "snp-test",
    SNIPARA_PROJECT_ID: "project_1",
    SNIPARA_API_URL: "https://api.snipara.com",
    SNIPARA_SESSION_ID: "session_1",
    SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK: "1",
    SNIPARA_TEST_CLI: cli,
    SNIPARA_TEST_OUT: out,
    ...extra,
  });
  const requests = () => {
    const file = path.join(out, "requests.jsonl");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  };
  return { root, main, linked, out, env, requests };
}

test("real git commit in a linked worktree: guards inspect only the staged docs file and the commit succeeds", hookOptions, (t) => {
  const f = fixture(t);
  const before = mustGit(f.linked, ["rev-parse", "HEAD"]);
  const result = git(f.linked, ["commit", "-m", "docs only"], { env: f.env() });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.notEqual(mustGit(f.linked, ["rev-parse", "HEAD"]), before);

  const guards = f.requests().filter((r) => r.path.endsWith("/collaboration/guard"));
  assert.ok(guards.length >= 1, "the collaboration guard must have been evaluated");
  for (const guard of guards) {
    assert.deepEqual(guard.body.files, ["docs/note.md"], "only the staged file may be sent");
  }
  const memory = JSON.parse(fs.readFileSync(path.join(f.out, "memory.json"), "utf8"));
  assert.deepEqual(memory.files, ["docs/note.md"]);
  assert.equal(memory.shouldBlock, false);
  assert.deepEqual(memory.releaseSurfaces, []);
  // Nothing unrelated was sent anywhere.
  assert.ok(!JSON.stringify(f.requests()).includes("scratch.ts"));
  assert.ok(!JSON.stringify(f.requests()).includes("app.ts"));
});

test("hook environment variables as git sets them reach the guard entry points directly", hookOptions, (t) => {
  const f = fixture(t);
  const gitDir = mustGit(f.linked, ["rev-parse", "--absolute-git-dir"]);
  const hookEnv = f.env({
    GIT_DIR: gitDir,
    GIT_INDEX_FILE: path.join(gitDir, "index"),
    SNIPARA_WORKSPACE_DIR: f.linked,
  });
  const cwd = path.join(f.linked, "docs"); // a subdirectory, as when a tool changes directory
  const memory = spawnSync(process.execPath, [cli, "memory-guard", "check", "--trigger", "pre-commit", "--staged", "--strict", "--json"], { cwd, env: hookEnv, encoding: "utf8" });
  assert.equal(memory.status, 0, memory.stderr);
  const parsed = JSON.parse(memory.stdout);
  assert.deepEqual(parsed.files, ["docs/note.md"]);
  assert.equal(parsed.shouldBlock, false);

  const guard = spawnSync(process.execPath, [cli, "collaboration", "guard", "--profile", "pre-commit", "--action", "pre-commit", "--resource", "SURFACE:checkout-git-write", "--enforce", "--json"], { cwd, env: hookEnv, encoding: "utf8" });
  assert.equal(guard.status, 0, guard.stderr);
  assert.doesNotThrow(() => JSON.parse(guard.stdout));
  const sent = f.requests().filter((r) => r.path.endsWith("/collaboration/guard"));
  assert.deepEqual(sent.at(-1).body.files, ["docs/note.md"]);
});

test("a blocking collaboration guard fails the commit and names the failed step on stderr", hookOptions, (t) => {
  const f = fixture(t);
  const before = mustGit(f.linked, ["rev-parse", "HEAD"]);
  const result = git(f.linked, ["commit", "-m", "blocked"], { env: f.env({ SNIPARA_TEST_GUARD: "BLOCKED" }) });
  assert.notEqual(result.status, 0);
  assert.equal(mustGit(f.linked, ["rev-parse", "HEAD"]), before, "no commit may be created");
  assert.match(result.stderr, /Collaboration guard failed \(pre-commit\): BLOCKED/);
  assert.match(result.stderr, /Snipara pre-commit failed: collaboration guard \(exit 2\)/);
});

test("a failing later step is named with its exit code, and a missing Companion explains itself", hookOptions, (t) => {
  const f = fixture(t);
  const lint = git(f.linked, ["commit", "-m", "lint"], { env: f.env({ SNIPARA_TEST_FAIL: "lint" }) });
  assert.notEqual(lint.status, 0); // git reports its own status for a failed hook
  assert.match(lint.stderr, /Snipara pre-commit failed: lint \(exit 9\)/);

  // No Companion on PATH and no source tree: the hook must say what is missing.
  fs.rmSync(path.join(f.root, "bin/snipara-companion"));
  fs.rmSync(path.join(f.root, "bin/pnpm"));
  const missing = git(f.linked, ["commit", "-m", "missing"], { env: f.env({ PATH: `${path.join(f.root, "bin")}:/usr/bin:/bin` }) });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /snipara-companion is required for the Snipara collaboration guard/);
  assert.match(missing.stderr, /Snipara pre-commit failed: collaboration claim \(exit 127\)/);
});

test("memory guard passes when it has nothing to check: docs only, strict, no hosted guidance", hookOptions, (t) => {
  const f = fixture(t);
  const env = f.env({ SNIPARA_API_KEY: "", SNIPARA_PROJECT_ID: "", SNIPARA_LOCAL_ONLY: "1", SNIPARA_WORKSPACE_DIR: f.linked });
  const result = spawnSync(process.execPath, [cli, "memory-guard", "check", "--trigger", "pre-commit", "--staged", "--strict", "--json"], { cwd: f.linked, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.shouldBlock, false);
  assert.equal(parsed.triggered, false);
  assert.deepEqual(parsed.files, ["docs/note.md"]);
  assert.ok(!/no memory or context guidance/.test(result.stdout + result.stderr));
});

test("a release surface without guidance is advisory, but an unconfirmed destructive step still blocks", hookOptions, (t) => {
  const f = fixture(t);
  const env = f.env({ SNIPARA_API_KEY: "", SNIPARA_PROJECT_ID: "", SNIPARA_LOCAL_ONLY: "1", SNIPARA_WORKSPACE_DIR: f.linked });
  const destructive = spawnSync(process.execPath, [cli, "memory-guard", "check", "--trigger", "manual", "--intent", "delete all production memories", "--destructive", "--strict", "--json"], { cwd: f.linked, env, encoding: "utf8" });
  assert.equal(destructive.status, 20, destructive.stderr + destructive.stdout);
  assert.equal(JSON.parse(destructive.stdout).shouldBlock, true);
});
