const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const {
  buildHostedCodeOverlayUploadPayload,
  buildLocalCodeOverlay,
  getLocalCodeOverlayCachePath,
  getLocalCodePromotionStatePath,
  readLocalCodeOverlayCache,
  readLocalCodePromotionState,
  writeLocalCodeOverlayCache,
} = require("../dist/index.js");

const cliPath = path.join(__dirname, "..", "dist", "index.js");

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-code-overlay-"));
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.email", "agent@example.com"]);
  runGit(dir, ["config", "user.name", "Agent"]);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "index.ts"),
    [
      "import { helper } from './helper';",
      "export function run() {",
      "  return helper();",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "src", "helper.ts"),
    ["export function helper() {", "  return 'ok';", "}", ""].join("\n"),
    "utf8"
  );
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-m", "initial"]);
  return dir;
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    input: options.input,
    env: {
      ...process.env,
      SNIPARA_API_KEY: "",
      SNIPARA_PROJECT_ID: "",
      SNIPARA_API_URL: "",
    },
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJsonFile(filePath, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for child process exit")),
      timeoutMs
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

function createJsonLineReader(stream) {
  let buffer = "";
  const queue = [];
  const waiters = [];
  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
      if (!line) {
        continue;
      }
      const parsed = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve(parsed);
      } else {
        queue.push(parsed);
      }
    }
  });
  return function readNext(timeoutMs = 5000) {
    if (queue.length > 0) {
      return Promise.resolve(queue.shift());
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) {
          waiters.splice(index, 1);
        }
        reject(new Error("Timed out waiting for JSON-RPC line"));
      }, timeoutMs);
      waiters.push({
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
      });
    });
  };
}

test("buildLocalCodeOverlay reports local commit metadata and code structure", () => {
  const repo = makeTempRepo();
  const manifest = buildLocalCodeOverlay({ cwd: repo, mode: "local_commit", commit: "HEAD" });

  assert.equal(manifest.version, "snipara.local_code_overlay.v1");
  assert.equal(manifest.mode, "local_commit");
  assert.equal(manifest.canonical, false);
  assert.equal(manifest.currentWorkingTreeVisible, false);
  assert.ok(!manifest.warnings.some((warning) => warning.code === "local_working_tree_overlay"));
  assert.equal(manifest.files.length, 2);
  assert.ok(manifest.symbols.some((symbol) => symbol.name === "run"));
  assert.ok(manifest.imports.some((item) => item.specifier === "./helper"));
});

test("working tree overlay includes dirty hash and excludes ignored or secret-like files", () => {
  const repo = makeTempRepo();
  fs.writeFileSync(path.join(repo, ".sniparaignore"), "src/ignored.ts\n", "utf8");
  fs.writeFileSync(path.join(repo, "src", "ignored.ts"), "export const ignored = true;\n", "utf8");
  fs.writeFileSync(
    path.join(repo, "src", "secret.ts"),
    "const apiKey = 'abcdefghijklmnopqrstuvwxyz1234567890';\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(repo, "src", "config-reference.ts"),
    [
      "const tokenResponse = { api_key: 'placeholder' };",
      "export const config = { apiKey: tokenResponse.api_key };",
      "export const envKey = process.env.SNIPARA_API_KEY;",
      "",
    ].join("\n"),
    "utf8"
  );
  fs.appendFileSync(path.join(repo, "src", "index.ts"), "export const dirty = true;\n", "utf8");

  const manifest = buildLocalCodeOverlay({ cwd: repo, mode: "working_tree" });

  assert.equal(manifest.currentWorkingTreeVisible, true);
  assert.ok(manifest.dirtyTreeHash);
  assert.ok(manifest.warnings.some((warning) => warning.code === "local_working_tree_overlay"));
  assert.ok(!manifest.files.some((file) => file.path === "src/ignored.ts"));
  assert.ok(!manifest.files.some((file) => file.path === "src/secret.ts"));
  assert.ok(manifest.files.some((file) => file.path === "src/config-reference.ts"));
  assert.equal(manifest.excluded.byReason.ignored, 1);
  assert.equal(manifest.excluded.byReason.secret_pattern, 1);
});

test("local overlay cache round-trips through .snipara/code-overlay/latest.json", () => {
  const repo = makeTempRepo();
  const manifest = buildLocalCodeOverlay({ cwd: repo, mode: "working_tree" });
  const cachePath = writeLocalCodeOverlayCache(manifest);
  const cached = readLocalCodeOverlayCache(repo);

  assert.equal(cachePath, getLocalCodeOverlayCachePath(repo));
  assert.ok(fs.existsSync(cachePath));
  assert.equal(cached.version, "snipara.local_code_overlay.v1");
  assert.equal(cached.files.length, manifest.files.length);
});

test("hosted overlay upload payload wraps cached non-canonical manifest", () => {
  const repo = makeTempRepo();
  const manifest = buildLocalCodeOverlay({ cwd: repo, mode: "working_tree" });
  writeLocalCodeOverlayCache(manifest);

  const payload = buildHostedCodeOverlayUploadPayload({
    dir: repo,
    cached: true,
    ttlHours: 6,
    sourceClient: "test-agent",
    sessionId: "session_1",
  });

  assert.equal(payload.request.overlay.version, "snipara.local_code_overlay.v1");
  assert.equal(payload.request.overlay.canonical, false);
  assert.equal(payload.request.source_client, "test-agent");
  assert.equal(payload.request.session_id, "session_1");
  assert.equal(payload.request.ttl_hours, 6);
  assert.equal(payload.request.retire_previous, true);
  assert.equal(payload.cachePath, getLocalCodeOverlayCachePath(repo));
});

test("code sync and status expose JSON for CLI-only agents", () => {
  const repo = makeTempRepo();
  const head = runGit(repo, ["rev-parse", "HEAD"]);

  const sync = runCli(["code", "sync", "--commit", "HEAD", "--only-if-head", head, "--json"], {
    cwd: repo,
  });
  assert.equal(sync.status, 0, sync.stderr);
  const syncPayload = JSON.parse(sync.stdout);
  assert.equal(syncPayload.mode, "local_commit");
  assert.equal(syncPayload.canonical, false);
  assert.ok(syncPayload.cachePath.endsWith(path.join(".snipara", "code-overlay", "latest.json")));

  const status = runCli(["code", "status", "--json"], { cwd: repo });
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.equal(statusPayload.current.version, "snipara.local_code_overlay.v1");
  assert.equal(statusPayload.cache.overlayKind, "local_commit");
});

test("code sync skips cache writes when guarded HEAD moved", () => {
  const repo = makeTempRepo();
  const oldHead = runGit(repo, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(repo, "src", "new.ts"), "export const newer = true;\n", "utf8");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "newer"]);

  const sync = runCli(["code", "sync", "--commit", oldHead, "--only-if-head", oldHead, "--json"], {
    cwd: repo,
  });
  assert.equal(sync.status, 0, sync.stderr);
  const payload = JSON.parse(sync.stdout);
  assert.equal(payload.skipped, true);
  assert.equal(payload.skipReason, "head_changed");
  assert.equal(fs.existsSync(getLocalCodeOverlayCachePath(repo)), false);
});

test("code local commands query cached overlay imports and file-level paths", () => {
  const repo = makeTempRepo();

  const sync = runCli(["code", "sync", "--working-tree", "--json"], { cwd: repo });
  assert.equal(sync.status, 0, sync.stderr);

  const imports = runCli(
    ["code", "local", "imports", "--cached", "--qualified-name", "run", "--json"],
    { cwd: repo }
  );
  assert.equal(imports.status, 0, imports.stderr);
  const importsPayload = JSON.parse(imports.stdout);
  assert.equal(importsPayload.target.name, "run");
  assert.ok(importsPayload.imports.some((item) => item.specifier === "./helper"));
  assert.ok(importsPayload.resolvedEdges.some((edge) => edge.to === "src/helper.ts"));

  const callers = runCli(
    ["code", "local", "callers", "--cached", "--qualified-name", "helper", "--json"],
    { cwd: repo }
  );
  assert.equal(callers.status, 0, callers.stderr);
  const callersPayload = JSON.parse(callers.stdout);
  assert.equal(callersPayload.target.name, "helper");
  assert.ok(callersPayload.callers.some((caller) => caller.filePath === "src/index.ts"));

  const neighbors = runCli(
    ["code", "local", "neighbors", "--cached", "--qualified-name", "run", "--json"],
    { cwd: repo }
  );
  assert.equal(neighbors.status, 0, neighbors.stderr);
  const neighborsPayload = JSON.parse(neighbors.stdout);
  assert.ok(neighborsPayload.outgoing.some((edge) => edge.to === "src/helper.ts"));

  const shortestPath = runCli(
    ["code", "local", "shortest-path", "--cached", "--from", "run", "--to", "helper", "--json"],
    { cwd: repo }
  );
  assert.equal(shortestPath.status, 0, shortestPath.stderr);
  const shortestPathPayload = JSON.parse(shortestPath.stdout);
  assert.equal(shortestPathPayload.found, true);
  assert.deepEqual(shortestPathPayload.path, ["src/index.ts", "src/helper.ts"]);
});

test("code unified commands can force local overlay source", () => {
  const repo = makeTempRepo();

  const result = runCli(["code", "callers", "--source", "local", "-q", "helper", "--json"], {
    cwd: repo,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.sourceSelection.requested, "local");
  assert.equal(payload.sourceSelection.selected, "local_overlay");
  assert.equal(payload.sourceSelection.reason, "source_forced_local");
  assert.equal(payload.result.target.name, "helper");
  assert.ok(payload.result.callers.some((caller) => caller.filePath === "src/index.ts"));
  assert.ok(payload.sourceSelection.limitations.includes("local_overlay_file_import_model"));
  assert.ok(
    payload.sourceSelection.guidance.some((item) =>
      item.includes("Use --source hosted after login")
    )
  );
});

test("top-level impact runs locally by default without project auth", () => {
  const repo = makeTempRepo();

  const result = runCli(["impact", "src/helper.ts", "--json"], { cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.sourceSelection.requested, "auto");
  assert.equal(payload.sourceSelection.selected, "local_overlay");
  assert.equal(payload.sourceSelection.reason, "auto_local_default");
  assert.deepEqual(payload.result.changedFiles, ["src/helper.ts"]);
  assert.ok(
    payload.sourceSelection.guidance.some((item) =>
      item.includes("no account or network call is required")
    )
  );
});

test("code unified commands auto-select local overlay for dirty worktrees", () => {
  const repo = makeTempRepo();
  fs.appendFileSync(path.join(repo, "src/helper.ts"), "\nexport const dirty = true;\n", "utf8");

  const result = runCli(["code", "imports", "-q", "helper", "--json"], { cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.sourceSelection.requested, "auto");
  assert.equal(payload.sourceSelection.selected, "local_overlay");
  assert.equal(payload.sourceSelection.reason, "working_tree_dirty");
  assert.equal(payload.sourceSelection.dirtyFileCount, 1);
  assert.ok(payload.sourceSelection.dirtyFilesSample.includes("src/helper.ts"));
  assert.ok(
    payload.sourceSelection.guidance.some((item) =>
      item.includes("working tree has uncommitted edits")
    )
  );
  assert.equal(payload.result.target.name, "helper");
});

test("code unified commands fail clearly when hosted is forced without config", () => {
  const repo = makeTempRepo();

  const result = runCli(["code", "callers", "--source", "hosted", "-q", "helper", "--json"], {
    cwd: repo,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Hosted Snipara is not configured/);
});

test("code local impact warns when requested targets are absent from the selected overlay", () => {
  const repo = makeTempRepo();

  const sync = runCli(["code", "sync", "--working-tree", "--json"], { cwd: repo });
  assert.equal(sync.status, 0, sync.stderr);

  const impact = runCli(
    ["code", "local", "impact", "--cached", "--changed-files", "src/missing.ts", "--json"],
    { cwd: repo }
  );
  assert.equal(impact.status, 0, impact.stderr);
  const payload = JSON.parse(impact.stdout);

  assert.deepEqual(payload.changedFiles, []);
  assert.deepEqual(payload.missingTargetFiles, ["src/missing.ts"]);
  assert.equal(payload.warnings[0].code, "local_impact_targets_missing");
  assert.match(payload.warnings[0].message, /Rebuild without --cached/);
});

test("code hooks install writes background Git hooks for local overlay sync and promotion", () => {
  const repo = makeTempRepo();

  const result = runCli(
    ["code", "hooks", "install", "--max-files", "17", "--no-request-reindex", "--json"],
    { cwd: repo }
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.requestReindex, false);
  assert.equal(payload.execution, "background");
  assert.equal(payload.maxFiles, 17);
  assert.deepEqual(
    payload.hooks.map((hook) => hook.action),
    ["created", "created"]
  );

  const postCommit = path.join(repo, ".git", "hooks", "post-commit");
  const prePush = path.join(repo, ".git", "hooks", "pre-push");
  const postCommitContent = fs.readFileSync(postCommit, "utf8");
  const prePushContent = fs.readFileSync(prePush, "utf8");

  assert.match(postCommitContent, /snipara:code-overlay post-commit:start/);
  assert.match(postCommitContent, /SNIPARA_CODE_OVERLAY_HEAD="\$\(git rev-parse --verify HEAD/);
  assert.match(
    postCommitContent,
    /snipara-companion code sync --commit "\$SNIPARA_CODE_OVERLAY_HEAD"/
  );
  assert.match(postCommitContent, /--only-if-head/);
  assert.match(postCommitContent, /&/);
  assert.match(prePushContent, /snipara:code-overlay pre-push:start/);
  assert.match(prePushContent, /SNIPARA_CODE_OVERLAY_PRE_PUSH_INPUT="\$\(cat\)"/);
  assert.match(prePushContent, /snipara-companion code promote --from-hook pre-push/);
  assert.doesNotMatch(prePushContent, /--request-reindex/);
  assert.match(prePushContent, /&/);
  assert.ok(fs.statSync(postCommit).mode & 0o111);
  assert.ok(fs.statSync(prePush).mode & 0o111);
});

test("code hooks install can still write synchronous hooks explicitly", () => {
  const repo = makeTempRepo();

  const result = runCli(["code", "hooks", "install", "--synchronous", "--json"], { cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.execution, "foreground");

  const postCommitContent = fs.readFileSync(
    path.join(repo, ".git", "hooks", "post-commit"),
    "utf8"
  );
  const prePushContent = fs.readFileSync(path.join(repo, ".git", "hooks", "pre-push"), "utf8");

  assert.match(
    postCommitContent,
    /snipara-companion code sync --commit "\$SNIPARA_CODE_OVERLAY_HEAD"/
  );
  assert.match(prePushContent, /snipara-companion code promote --from-hook pre-push/);
  assert.doesNotMatch(postCommitContent, /\) >\/dev\/null 2>&1 &/);
  assert.doesNotMatch(prePushContent, /SNIPARA_CODE_OVERLAY_PRE_PUSH_INPUT="\$\(cat\)"/);
});

test("code hooks install writes Husky user hooks when hooksPath points at .husky/_", () => {
  const repo = makeTempRepo();
  const huskyShimDir = path.join(repo, ".husky", "_");
  fs.mkdirSync(huskyShimDir, { recursive: true });
  fs.writeFileSync(path.join(huskyShimDir, "h"), "#!/usr/bin/env sh\nexit 0\n", "utf8");
  fs.writeFileSync(
    path.join(huskyShimDir, "post-commit"),
    '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n',
    "utf8"
  );
  runGit(repo, ["config", "core.hooksPath", ".husky/_"]);

  const result = runCli(["code", "hooks", "install", "--json"], { cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const postCommitPath = path.join(fs.realpathSync(repo), ".husky", "post-commit");
  const shimContent = fs.readFileSync(path.join(huskyShimDir, "post-commit"), "utf8");
  const userHookContent = fs.readFileSync(postCommitPath, "utf8");

  assert.equal(payload.hooks[0].path, postCommitPath);
  assert.match(userHookContent, /snipara:code-overlay post-commit:start/);
  assert.match(
    userHookContent,
    /snipara-companion code sync --commit "\$SNIPARA_CODE_OVERLAY_HEAD"/
  );
  assert.match(userHookContent, /--only-if-head/);
  assert.doesNotMatch(shimContent, /snipara:code-overlay/);
});

test("code promote records superseded state when hosted indexed sha matches pushed sha", () => {
  const repo = makeTempRepo();
  const head = runGit(repo, ["rev-parse", "HEAD"]);

  const result = runCli(
    ["code", "promote", "--pushed-sha", head, "--indexed-sha", "HEAD", "--json"],
    { cwd: repo }
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.version, "snipara.local_code_promotion.v1");
  assert.equal(payload.status, "superseded_by_hosted_index");
  assert.equal(payload.hostedCanonicalVisible, true);
  assert.equal(payload.pushedSha, head);
  assert.equal(payload.indexedSha, head);
  assert.ok(fs.existsSync(getLocalCodeOverlayCachePath(repo)));
  assert.equal(payload.statePath, getLocalCodePromotionStatePath(repo));

  const state = readLocalCodePromotionState(repo);
  assert.equal(state.status, "superseded_by_hosted_index");
  assert.equal(readLocalCodeOverlayCache(repo).mode, "local_commit");
});

test("code serve exposes local overlay through localhost HTTP JSON", async () => {
  const repo = makeTempRepo();
  const readyFile = path.join(repo, "ready.json");
  const server = spawn(
    process.execPath,
    [
      cliPath,
      "code",
      "serve",
      "--transport",
      "http",
      "--port",
      "0",
      "--ready-file",
      readyFile,
      "--json",
    ],
    {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SNIPARA_API_KEY: "",
        SNIPARA_PROJECT_ID: "",
        SNIPARA_API_URL: "",
      },
    }
  );

  try {
    const ready = await waitForJsonFile(readyFile);
    const statusResponse = await fetch(`${ready.baseUrl}/v1/local-code/status`);
    assert.equal(statusResponse.status, 200);
    const statusPayload = await statusResponse.json();
    assert.equal(statusPayload.current.canonical, false);

    const importsResponse = await fetch(`${ready.baseUrl}/v1/local-code/imports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ qualifiedName: "run" }),
    });
    assert.equal(importsResponse.status, 200);
    const importsPayload = await importsResponse.json();
    assert.equal(importsPayload.target.name, "run");
    assert.ok(importsPayload.resolvedEdges.some((edge) => edge.to === "src/helper.ts"));
  } finally {
    const exited = waitForExit(server);
    server.kill("SIGTERM");
    await exited;
  }
});

test("code mcp exposes snipara_local_code tools over stdio JSON-RPC", async () => {
  const repo = makeTempRepo();
  const mcp = spawn(process.execPath, [cliPath, "code", "mcp"], {
    cwd: repo,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      SNIPARA_API_KEY: "",
      SNIPARA_PROJECT_ID: "",
      SNIPARA_API_URL: "",
    },
  });
  const readNext = createJsonLineReader(mcp.stdout);

  try {
    mcp.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      })}\n`
    );
    const initialized = await readNext();
    assert.equal(initialized.result.serverInfo.name, "snipara-local-code-overlay");

    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    const tools = await readNext();
    assert.ok(tools.result.tools.some((tool) => tool.name === "snipara_local_code_imports"));

    mcp.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "snipara_local_code_imports",
          arguments: { qualifiedName: "run" },
        },
      })}\n`
    );
    const toolCall = await readNext();
    assert.equal(toolCall.result.isError, false);
    assert.equal(toolCall.result.structuredContent.target.name, "run");
    assert.ok(
      toolCall.result.structuredContent.resolvedEdges.some((edge) => edge.to === "src/helper.ts")
    );
  } finally {
    const exited = waitForExit(mcp);
    mcp.kill("SIGTERM");
    await exited;
  }
});
