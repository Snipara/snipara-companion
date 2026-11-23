const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const {
  isLocalStatePath,
  isLocalStateStatusLine,
  withoutLocalStateStatusLines,
  readLocalGitState,
  normalizeRecallResult,
  buildVerificationPlan,
} = require("../dist/index.js");

test("local state helper matches a .snipara segment at any depth", () => {
  assert.equal(isLocalStatePath(".snipara/code-impact/latest.json"), true);
  assert.equal(isLocalStatePath("packages/cli/.snipara/collaboration/"), true);
  assert.equal(isLocalStatePath("a\\.snipara\\b"), true);
  assert.equal(isLocalStatePath("src/.sniparaignore"), false);
  assert.equal(isLocalStatePath("src/snipara/x.ts"), false);
  assert.equal(isLocalStateStatusLine("?? packages/cli/.snipara/collaboration/"), true);
  assert.equal(isLocalStateStatusLine("R  a.ts -> pkg/.snipara/a.ts"), true);
  assert.equal(isLocalStateStatusLine(" M src/index.ts"), false);
  assert.equal(isLocalStateStatusLine("M src/index.ts"), false);
  assert.deepEqual(
    withoutLocalStateStatusLines(["?? .snipara/x/", "?? pkg/.snipara/y/", " M src/a.ts"]),
    [" M src/a.ts"]
  );
});

test("status git state ignores an untracked nested .snipara directory", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-dirty-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  fs.mkdirSync(path.join(repo, "packages", "cli", ".snipara", "collaboration"), {
    recursive: true,
  });
  fs.writeFileSync(path.join(repo, "packages", "cli", ".snipara", "collaboration", "s.json"), "{}");
  assert.deepEqual(readLocalGitState(repo).statusLines, []);
  fs.writeFileSync(path.join(repo, "real.txt"), "x");
  assert.deepEqual(readLocalGitState(repo).statusLines, ["?? real.txt"]);
});

test("recall result keeps the requested query when the server omits it", () => {
  assert.equal(normalizeRecallResult({ memories: [] }, "some text").query, "some text");
  assert.equal(
    normalizeRecallResult({ memories: [], query: "from server" }, "some text").query,
    "from server"
  );
});

test("a skipped impact is reported as skipped, not unavailable", () => {
  const plan = buildVerificationPlan({ changedFiles: [], skipImpact: true });
  const codes = plan.missingChecks.map((gap) => gap.code);
  assert.ok(codes.includes("impact_skipped"));
  assert.ok(!codes.includes("impact_unavailable"));
});
