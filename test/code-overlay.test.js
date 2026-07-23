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
  mergeHybridCodeResults,
  readLocalCodeOverlayCache,
  readLocalCodePromotionState,
  resolveCodeGraphMode,
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

function makeDeepTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-code-overlay-deep-"));
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.email", "agent@example.com"]);
  runGit(dir, ["config", "user.name", "Agent"]);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "helper.ts"),
    ["export function helper() {", "  return 'ok';", "}", ""].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "src", "service.ts"),
    [
      "import { helper } from './helper';",
      "export function service() {",
      "  return helper();",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "src", "controller.ts"),
    [
      "import { service } from './service';",
      "export function controller() {",
      "  return service();",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "src", "route.ts"),
    [
      "import { controller } from './controller';",
      "export function route() {",
      "  return controller();",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-m", "deep graph"]);
  return dir;
}

function makeSemanticTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-code-overlay-semantic-"));
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.email", "agent@example.com"]);
  runGit(dir, ["config", "user.name", "Agent"]);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "contracts.ts"),
    ["export interface SessionContract {", "  load(): string;", "}", ""].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "src", "session-repository.ts"),
    [
      "import type { SessionContract } from './contracts';",
      "export class SessionRepository implements SessionContract {",
      "  load() { return 'session'; }",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "src", "session-adapter.ts"),
    [
      "import { SessionRepository } from './session-repository';",
      "export function sessionAdapter() {",
      "  return new SessionRepository().load();",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "src", "session-facade.ts"),
    [
      "import { sessionAdapter } from './session-adapter';",
      "export function sessionFacade() { return sessionAdapter(); }",
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "src", "route.ts"),
    [
      "import { sessionFacade } from './session-facade';",
      "export function GET() { return sessionFacade(); }",
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "tests", "session-repository.test.ts"),
    [
      "import { SessionRepository } from '../src/session-repository';",
      "export function testRepository() { return new SessionRepository().load(); }",
      "",
    ].join("\n"),
    "utf8"
  );
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-m", "semantic graph"]);
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
  const enqueueLine = (line) => {
    if (!line) {
      return;
    }
    const parsed = JSON.parse(line);
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve(parsed);
    } else {
      queue.push(parsed);
    }
  };
  const drainBuffer = () => {
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
      enqueueLine(line);
    }
  };
  const flushFinalBuffer = () => {
    const line = buffer.trim();
    buffer = "";
    enqueueLine(line);
  };
  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    drainBuffer();
  });
  stream.on("end", flushFinalBuffer);
  stream.on("close", flushFinalBuffer);
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

  assert.equal(manifest.version, "snipara.local_code_overlay.v2");
  assert.equal(manifest.mode, "local_commit");
  assert.equal(manifest.canonical, false);
  assert.equal(manifest.currentWorkingTreeVisible, false);
  assert.ok(!manifest.warnings.some((warning) => warning.code === "local_working_tree_overlay"));
  assert.equal(manifest.files.length, 2);
  assert.ok(manifest.symbols.some((symbol) => symbol.name === "run"));
  assert.ok(manifest.imports.some((item) => item.specifier === "./helper"));
  assert.ok(manifest.edges.some((edge) => edge.kind === "IMPORTS"));
  assert.ok(manifest.edges.some((edge) => edge.kind === "CALLS"));
});

test("working tree overlay includes dirty hash and redacts secret-like files without excluding them", () => {
  const repo = makeTempRepo();
  fs.writeFileSync(path.join(repo, ".sniparaignore"), "src/ignored.ts\n", "utf8");
  fs.writeFileSync(path.join(repo, "src", "ignored.ts"), "export const ignored = true;\n", "utf8");
  fs.writeFileSync(
    path.join(repo, "src", "secret.ts"),
    [
      "import { helper } from './helper';",
      "const apiKey = 'abcdefghijklmnopqrstuvwxyz1234567890';",
      "export function useSecretConfig() {",
      "  return helper();",
      "}",
      "",
    ].join("\n"),
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
  assert.ok(manifest.files.some((file) => file.path === "src/secret.ts"));
  assert.ok(manifest.files.some((file) => file.path === "src/config-reference.ts"));
  assert.ok(manifest.symbols.some((symbol) => symbol.filePath === "src/secret.ts"));
  assert.ok(manifest.imports.some((item) => item.filePath === "src/secret.ts"));
  assert.equal(manifest.excluded.byReason.ignored, 1);
  assert.equal(manifest.excluded.byReason.secret_pattern, 0);
  assert.ok(manifest.warnings.some((warning) => warning.code === "secret_like_lines_redacted"));
  assert.match(
    manifest.warnings.find((warning) => warning.code === "secret_like_lines_redacted").message,
    /src\/secret\.ts:2/
  );
});

test("working tree overlay scans a local folder without Git metadata", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-code-overlay-no-git-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules", "ignored"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"local-folder"}\n', "utf8");
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
  fs.writeFileSync(
    path.join(dir, "node_modules", "ignored", "index.ts"),
    "export const ignored = true;\n",
    "utf8"
  );

  const manifest = buildLocalCodeOverlay({ cwd: dir, mode: "working_tree" });

  assert.equal(manifest.localHeadSha, null);
  assert.equal(manifest.baseSha, null);
  assert.equal(manifest.overlayKind, "working_tree");
  assert.ok(manifest.dirtyTreeHash);
  assert.ok(manifest.warnings.some((warning) => warning.code === "local_folder_overlay"));
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    ["src/helper.ts", "src/index.ts"]
  );
  assert.ok(manifest.symbols.some((symbol) => symbol.name === "run"));
  assert.ok(manifest.imports.some((item) => item.specifier === "./helper"));
});

test("local overlay cache round-trips through .snipara/code-overlay/latest.json", () => {
  const repo = makeTempRepo();
  const manifest = buildLocalCodeOverlay({ cwd: repo, mode: "working_tree" });
  const cachePath = writeLocalCodeOverlayCache(manifest);
  const cached = readLocalCodeOverlayCache(repo);

  assert.equal(cachePath, getLocalCodeOverlayCachePath(repo));
  assert.ok(fs.existsSync(cachePath));
  assert.equal(cached.version, "snipara.local_code_overlay.v2");
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

  assert.equal(payload.request.overlay.version, "snipara.local_code_overlay.v2");
  assert.equal(payload.request.overlay.canonical, false);
  assert.equal(payload.request.source_client, "test-agent");
  assert.equal(payload.request.session_id, "session_1");
  assert.equal(payload.request.ttl_hours, 6);
  assert.equal(payload.request.retire_previous, true);
  assert.equal(payload.cachePath, getLocalCodeOverlayCachePath(repo));
});

test("hosted overlay upload payload rejects invalid ttl values", () => {
  const repo = makeTempRepo();

  assert.throws(
    () =>
      buildHostedCodeOverlayUploadPayload({
        dir: repo,
        ttlHours: 0,
      }),
    /--ttl-hours must be a positive integer/
  );
  assert.throws(
    () =>
      buildHostedCodeOverlayUploadPayload({
        dir: repo,
        ttlHours: 999,
      }),
    /--ttl-hours must be less than or equal to 168/
  );
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
  assert.equal(statusPayload.current.version, "snipara.local_code_overlay.v2");
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

test("TypeScript AST extraction produces stable symbol identities and call edges", () => {
  const repo = makeDeepTempRepo();
  const first = buildLocalCodeOverlay({ cwd: repo, mode: "working_tree" });
  const firstHelper = first.symbols.find((symbol) => symbol.name === "helper");
  const service = first.symbols.find((symbol) => symbol.name === "service");

  assert.ok(firstHelper);
  assert.ok(service);
  assert.ok(
    first.edges.some(
      (edge) =>
        edge.kind === "CALLS" && edge.from === service.localKey && edge.to === firstHelper.localKey
    )
  );
  assert.ok(first.references.some((reference) => reference.name === "helper"));

  fs.writeFileSync(
    path.join(repo, "src", "helper.ts"),
    `\n${fs.readFileSync(path.join(repo, "src", "helper.ts"), "utf8")}`,
    "utf8"
  );
  const second = buildLocalCodeOverlay({ cwd: repo, mode: "working_tree" });
  const secondHelper = second.symbols.find((symbol) => symbol.name === "helper");

  assert.equal(secondHelper.localKey, firstHelper.localKey);
  assert.notEqual(secondHelper.line, firstHelper.line);
});

test("semantic overlay explains contracts, architecture roles, and dependency criticality", () => {
  const repo = makeSemanticTempRepo();
  const manifest = buildLocalCodeOverlay({ cwd: repo, mode: "working_tree" });
  const contract = manifest.symbols.find((symbol) => symbol.name === "SessionContract");
  const repository = manifest.symbols.find((symbol) => symbol.name === "SessionRepository");

  assert.equal(manifest.extractorVersion, 3);
  assert.equal(contract.exported, true);
  assert.equal(repository.exported, true);
  assert.equal(manifest.semantic.version, "snipara.semantic.v1");
  assert.equal(manifest.semantic.modelType, "rule-based-heuristic");
  assert.equal(manifest.semantic.scoreContract.kind, "heuristic_prior");
  assert.equal(manifest.semantic.scoreContract.calibrated, false);
  assert.equal(manifest.semantic.scoreContract.probability, false);
  assert.equal(manifest.semantic.scoreContract.basis, "hand-tuned-v1");
  assert.ok(
    manifest.semantic.assertions.every(
      (assertion) => assertion.scoreKind === "heuristic_prior" && assertion.calibrated === false
    )
  );
  assert.ok(
    manifest.semantic.publicContracts.some(
      (assertion) =>
        assertion.subject === contract.localKey &&
        assertion.predicate === "implicit_contract" &&
        assertion.value === "exported_type_contract"
    )
  );
  assert.ok(
    manifest.semantic.architectureRoles.some(
      (assertion) => assertion.subject === repository.localKey && assertion.value === "repository"
    )
  );
  assert.ok(manifest.semantic.architectureRoles.some((assertion) => assertion.value === "adapter"));
  assert.ok(manifest.semantic.architectureRoles.some((assertion) => assertion.value === "facade"));

  const impact = runCli(
    [
      "code",
      "impact",
      "--source",
      "local",
      "--changed-files",
      "src/session-repository.ts",
      "--depth",
      "4",
      "--json",
    ],
    { cwd: repo }
  );
  assert.equal(impact.status, 0, impact.stderr);
  const payload = JSON.parse(impact.stdout).result;
  assert.equal(payload.semantic.scope, "impact");
  assert.equal(payload.semantic.historicalRegression.mode, "shadow");
  assert.equal(payload.semantic.historicalRegression.riskContributionEnabled, false);
  assert.ok(payload.semantic.summary.criticalDependencyCount > 0);
  assert.ok(payload.semantic.summary.incidentalDependencyCount > 0);
  assert.ok(payload.risk.semanticRiskPoints > 0);
  assert.ok(payload.risk.reasons.some((reason) => /semantic dependenc/.test(reason)));
});

test("semantic overlay loads bounded project naming terms without custom regex", () => {
  const repo = makeSemanticTempRepo();
  fs.mkdirSync(path.join(repo, ".snipara"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src", "securite"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".snipara", "semantic-rules.json"),
    JSON.stringify({
      replaceDefaults: true,
      sensitivePathTerms: ["securite"],
      architectureRoleTerms: { repository: ["depot"] },
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(repo, "src", "securite", "depot-session.ts"),
    "export class DepotSession { load() { return 'ok'; } }\n",
    "utf8"
  );

  const manifest = buildLocalCodeOverlay({ cwd: repo, mode: "working_tree" });
  const depot = manifest.symbols.find((symbol) => symbol.name === "DepotSession");

  assert.ok(depot);
  assert.equal(manifest.semantic.ruleConfig.source, "project-file");
  assert.equal(manifest.semantic.ruleConfig.replaceDefaults, true);
  assert.deepEqual(manifest.semantic.ruleConfig.configuredRoles, ["repository"]);
  assert.ok(
    manifest.semantic.architectureRoles.some(
      (assertion) => assertion.subject === depot.localKey && assertion.value === "repository"
    )
  );
  assert.ok(
    manifest.semantic.dependencyCriticality.some(
      (assertion) => assertion.subject === depot.localKey && assertion.value === "critical"
    )
  );
});

test("local callers, neighbors, and impact traverse bounded transitive paths", () => {
  const repo = makeDeepTempRepo();

  const callers = runCli(
    ["code", "callers", "--source", "local", "-q", "helper", "--depth", "3", "--json"],
    { cwd: repo }
  );
  assert.equal(callers.status, 0, callers.stderr);
  const callersPayload = JSON.parse(callers.stdout).result;
  assert.equal(callersPayload.depth, 3);
  assert.ok(callersPayload.callers.some((caller) => caller.filePath === "src/service.ts"));
  assert.ok(callersPayload.callers.some((caller) => caller.filePath === "src/controller.ts"));
  assert.ok(callersPayload.callers.some((caller) => caller.filePath === "src/route.ts"));

  const neighbors = runCli(
    ["code", "neighbors", "--source", "local", "-q", "helper", "--depth", "2", "--json"],
    { cwd: repo }
  );
  assert.equal(neighbors.status, 0, neighbors.stderr);
  const neighborsPayload = JSON.parse(neighbors.stdout).result;
  assert.ok(neighborsPayload.nodes.some((node) => node.filePath === "src/service.ts"));
  assert.ok(neighborsPayload.nodes.some((node) => node.filePath === "src/controller.ts"));

  const impact = runCli(
    [
      "code",
      "impact",
      "--source",
      "local",
      "--changed-files",
      "src/helper.ts",
      "--depth",
      "3",
      "--transitive",
      "--json",
    ],
    { cwd: repo }
  );
  assert.equal(impact.status, 0, impact.stderr);
  const impactPayload = JSON.parse(impact.stdout).result;
  assert.deepEqual(impactPayload.transitiveFiles, [
    "src/controller.ts",
    "src/route.ts",
    "src/service.ts",
  ]);
  assert.equal(impactPayload.risk.depth, 3);
  assert.ok(impactPayload.risk.score > 0);
  assert.ok(impactPayload.risk.reasons.length > 0);

  const boundedImpact = runCli(
    [
      "code",
      "impact",
      "--source",
      "local",
      "--changed-files",
      "src/helper.ts",
      "--depth",
      "3",
      "--max-nodes",
      "2",
      "--json",
    ],
    { cwd: repo }
  );
  assert.equal(boundedImpact.status, 0, boundedImpact.stderr);
  const boundedImpactPayload = JSON.parse(boundedImpact.stdout).result;
  assert.equal(boundedImpactPayload.traversal.maxNodes, 2);
  assert.ok(boundedImpactPayload.traversal.visitedCount <= 2);
  assert.equal(boundedImpactPayload.traversal.truncated, true);
});

test("overlay cache reuses unchanged per-file extraction slices", () => {
  const repo = makeDeepTempRepo();
  const first = buildLocalCodeOverlay({ cwd: repo, mode: "working_tree" });
  writeLocalCodeOverlayCache(first);
  fs.appendFileSync(path.join(repo, "src", "route.ts"), "export const runtime = 'edge';\n", "utf8");

  const second = buildLocalCodeOverlay({ cwd: repo, mode: "working_tree" });

  assert.equal(second.incremental.parsedFiles, 1);
  assert.equal(second.incremental.reusedFiles, 3);
  assert.equal(second.incremental.deletedFiles, 0);
});

test("hybrid merge preserves source provenance and unions affected files", () => {
  const merged = mergeHybridCodeResults(
    "impact",
    {
      changedFiles: ["src/local.ts"],
      impactedFiles: ["src/local.ts"],
      risk: { level: "medium", score: 42 },
      semantic: {
        assertions: [{ id: "local-role", predicate: "architecture_role", value: "adapter" }],
        historicalRegression: { mode: "shadow", riskContributionEnabled: false },
      },
    },
    {
      affected_files: ["src/hosted.ts", "src/local.ts"],
      risk: { level: "high", score: 80 },
      semantic: {
        assertions: [
          { id: "hosted-contract", predicate: "implicit_contract", value: "public_surface" },
        ],
        historical_regression: { mode: "shadow", risk_contribution_enabled: false },
      },
      recommended_tests: [{ command: "pnpm test" }],
      index_freshness: { stale: false },
    }
  );

  assert.equal(merged.mode, "hybrid");
  assert.equal(merged.provenance.canonicalBase, "hosted_graph");
  assert.equal(merged.provenance.checkoutDelta, "local_overlay");
  assert.deepEqual(merged.merged.affectedFiles, ["src/hosted.ts", "src/local.ts"]);
  assert.equal(merged.merged.affectedFileCount, 2);
  assert.equal(merged.risk.source, "hosted_graph");
  assert.equal(merged.risk.score, 80);
  assert.equal(merged.semantic.version, "snipara.semantic.hybrid.v1");
  assert.equal(merged.semantic.summary.assertionCount, 2);
  assert.equal(merged.semantic.historicalRegression.mode, "shadow");
  assert.deepEqual(merged.recommended_tests, [{ command: "pnpm test" }]);
});

test("auto source uses hosted for clean checkouts and hybrid for local deltas", () => {
  assert.deepEqual(
    resolveCodeGraphMode({
      requested: "auto",
      dirtyFiles: [],
      aheadCount: 0,
      hostedConfigured: true,
      fallbackHosted: false,
    }),
    { selected: "hosted_graph", reason: "auto_hosted_clean_checkout" }
  );
  assert.deepEqual(
    resolveCodeGraphMode({
      requested: "auto",
      dirtyFiles: ["src/local.ts"],
      aheadCount: 0,
      hostedConfigured: true,
      fallbackHosted: false,
    }),
    { selected: "hybrid_graph", reason: "working_tree_dirty" }
  );
  assert.deepEqual(
    resolveCodeGraphMode({
      requested: "local",
      dirtyFiles: [],
      aheadCount: 0,
      hostedConfigured: true,
      fallbackHosted: true,
    }),
    { selected: "hybrid_graph", reason: "fallback_hosted_requested" }
  );
});

test("local traversal rejects an invalid direction instead of silently widening it", () => {
  const repo = makeTempRepo();
  const result = runCli(
    [
      "code",
      "impact",
      "--source",
      "local",
      "--changed-files",
      "src/helper.ts",
      "--direction",
      "sideways",
      "--json",
    ],
    { cwd: repo }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--direction must be one of: in, out, both/);
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
  assert.ok(
    payload.sourceSelection.limitations.some((item) =>
      item.includes("compiler-AST edges for TypeScript")
    )
  );
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

test("top-level impact prints a human-readable local blast radius by default", () => {
  const repo = makeTempRepo();

  const result = runCli(["impact", "src/helper.ts", "--source", "local"], { cwd: repo });
  assert.equal(result.status, 0, result.stderr);

  assert.match(result.stdout, /Code impact - local - src\/helper\.ts/);
  assert.match(result.stdout, /Source: local_overlay/);
  assert.match(result.stdout, /Incoming \(1\) - files that depend on this/);
  assert.match(result.stdout, /  src\/index\.ts/);
  assert.match(result.stdout, /Outgoing \(0\) - files this depends on/);
  assert.match(result.stdout, /Use --json for full overlay details\./);
  assert.doesNotMatch(result.stdout, /"scope"/);
  assert.doesNotMatch(result.stdout, /"files"/);
});

test("top-level impact keeps secret-like target files visible with a redaction warning", () => {
  const repo = makeTempRepo();
  fs.writeFileSync(
    path.join(repo, "src", "secret.ts"),
    [
      "import { helper } from './helper';",
      "const accessToken = 'abcdefghijklmnopqrstuvwxyz1234567890';",
      "export function readSecretBackedConfig() {",
      "  return helper();",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(repo, "src", "consumer.ts"),
    [
      "import { readSecretBackedConfig } from './secret';",
      "export function consume() {",
      "  return readSecretBackedConfig();",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(repo, "src", "unrelated.ts"),
    "const apiKey = 'zyxwvutsrqponmlkjihgfedcba9876543210';\n",
    "utf8"
  );

  const result = runCli(["impact", "src/secret.ts", "--source", "local"], { cwd: repo });
  assert.equal(result.status, 0, result.stderr);

  assert.match(result.stdout, /Code impact - local - src\/secret\.ts/);
  assert.match(result.stdout, /Incoming \(1\) - files that depend on this/);
  assert.match(result.stdout, /  src\/consumer\.ts/);
  assert.match(result.stdout, /Outgoing \(1\) - files this depends on/);
  assert.match(result.stdout, /  src\/helper\.ts/);
  assert.match(result.stdout, /secret_like_lines_redacted/);
  assert.match(result.stdout, /src\/secret\.ts:2/);
  assert.doesNotMatch(result.stdout, /src\/unrelated\.ts/);
  assert.doesNotMatch(result.stdout, /Missing targets/);
  assert.doesNotMatch(result.stdout, /larger --max-files/);
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
  assert.match(payload.warnings[0].message, /check the path, \.sniparaignore/);
  assert.doesNotMatch(payload.warnings[0].message, /larger --max-files/);
  assert.equal(payload.missingTargetDetails[0].reason, "not_in_overlay");
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
