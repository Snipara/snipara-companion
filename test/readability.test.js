const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildFunctionComplexityReport,
  FUNCTION_COMPLEXITY_BUDGET,
  parseGitChangedLineRanges,
} = require("../dist/index.js");

test("parseGitChangedLineRanges keeps added-line hunk ranges per file", () => {
  const ranges = parseGitChangedLineRanges([
    "+++ b/src/app.ts", "@@ -1 +1,3 @@", "@@ -8,2 +12,1 @@", "+++ b/src/view.js",
    "@@ -0,0 +1 @@", "+++ /dev/null", "@@ -1 +0,0 @@", "+++ b/src/next.ts", "@@ -1 +1 @@",
  ].join("\n"));

  assert.deepEqual(ranges.get("src/app.ts"), [{ start: 1, end: 3 }, { start: 12, end: 12 }]);
  assert.deepEqual(ranges.get("src/view.js"), [{ start: 1, end: 1 }]);
  assert.deepEqual(ranges.get("src/next.ts"), [{ start: 1, end: 1 }]);
  assert.equal(ranges.has("src/deleted.ts"), false);
});

test("function complexity reports only touched functions and applies readable thresholds", () => {
  const source = [
    "function simple(value) { if (value) return true; return false; }",
    "function review(value) { return value && value && value && value && value && value && value && value && value && value && value && value; }",
    "function split(value) { if (value) { if (value) { if (value) { if (value) { if (value) { if (value) { if (value) return true; } } } } } } return false; }",
  ].join("\n");

  const report = buildFunctionComplexityReport([
    { filePath: "src/example.ts", source, changedLines: [{ start: 1, end: 3 }] },
  ]);

  assert.equal(report.status, "split");
  assert.equal(report.fileCount, 1);
  assert.equal(report.functionCount, 3);
  assert.deepEqual(report.functions.map(({ name, status }) => ({ name, status })), [
    { name: "simple", status: "within_budget" },
    { name: "review", status: "review" },
    { name: "split", status: "split" },
  ]);
  assert.equal(report.functions[2].maxDepth, FUNCTION_COMPLEXITY_BUDGET.split.depth + 1);
});

test("function complexity ignores functions outside changed lines", () => {
  const report = buildFunctionComplexityReport([
    {
      filePath: "src/example.ts",
      source: "import value from './value';\nfunction untouched() { return value; }\n",
      changedLines: [{ start: 1, end: 1 }],
    },
  ]);

  assert.equal(report.functionCount, 0);
  assert.equal(report.status, "within_budget");
});
