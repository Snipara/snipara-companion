const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { loadRuntimeSource } = require("./helpers/runtime-source.cjs");
const { boundJson, countBy } = loadRuntimeSource(
  path.resolve(__dirname, "../src/runtime/bounded-output.ts")
);

test("long arrays keep their first items and say how many were left out", () => {
  const bounded = boundJson({ rows: Array.from({ length: 12 }, (_, i) => i) }, { maxItems: 3 });
  assert.deepEqual(bounded, { rows: [0, 1, 2, { omitted: 9 }] });
  assert.deepEqual(boundJson([1, 2], { maxItems: 3 }), [1, 2]);
});

test("long strings are cut with the number of characters left out, and named keys are dropped", () => {
  const bounded = boundJson(
    { note: "x".repeat(20), authority: { heavy: true }, nested: [{ authority: 1, kept: "ok" }] },
    { maxChars: 5, dropKeys: ["authority"] }
  );
  assert.equal(bounded.note, "xxxxx… (15 more characters)");
  assert.equal("authority" in bounded, false);
  assert.deepEqual(bounded.nested, [{ kept: "ok" }]);
});

test("scalars and null pass through unchanged, and countBy groups by a field", () => {
  assert.deepEqual(boundJson({ a: null, b: 3, c: true }), { a: null, b: 3, c: true });
  assert.deepEqual(countBy([{ kind: "FILE" }, { kind: "FILE" }, { kind: "SYMBOL" }, 7], "kind"), {
    FILE: 2,
    SYMBOL: 1,
    "?": 1,
  });
});

test("the commands that used to print megabytes expose --detail for the full answer", () => {
  const cli = path.resolve(__dirname, "../dist/index.js");
  for (const args of [
    ["brief"],
    ["session-bootstrap"],
    ["collaboration", "status"],
    ["team-sync", "what-changed"],
  ]) {
    const help = spawnSync(process.execPath, [cli, ...args, "--help"], {
      encoding: "utf8",
      env: { ...process.env, SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK: "1" },
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--detail/, args.join(" "));
  }
  const root = spawnSync(process.execPath, [cli, "--help"], {
    encoding: "utf8",
    env: { ...process.env, SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK: "1" },
  });
  assert.doesNotMatch(root.stdout, /controller-bridge/);
});
