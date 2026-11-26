const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { checkEditOverlap } = require("../dist/index.js");

function checkout(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-edit-overlap-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}
const edit = (cwd, sessionId, file, minute, tool = "Edit") =>
  checkEditOverlap({ cwd, tool, sessionId, toolInput: JSON.stringify({ file_path: path.join(cwd, file) }),
    now: new Date(Date.UTC(2026, 10, 26, 10, minute)) });

test("a second session editing the same file of the checkout is warned, the first session is not", (t) => {
  const cwd = checkout(t);
  assert.equal(edit(cwd, "session-a-1234567", "src/transport.py", 0), null);
  assert.equal(edit(cwd, "session-a-1234567", "src/transport.py", 2), null);
  const warning = edit(cwd, "session-b-7654321", "src/transport.py", 5);
  assert.match(warning, /session \(session-\) edited src\/transport\.py 3 min ago in this checkout/);
  assert.equal(edit(cwd, "session-b-7654321", "src/transport.py", 6), null);
  assert.match(edit(cwd, "session-a-1234567", "src/transport.py", 7, "Write"), /edited src\/transport\.py 1 min ago/);
  assert.equal(edit(cwd, "session-b-7654321", "src/other.py", 8), null);
});

test("edits older than 30 minutes, other tools, paths outside the checkout and unknown sessions are not warned", (t) => {
  const cwd = checkout(t);
  edit(cwd, "session-a", "src/a.ts", 0);
  assert.equal(edit(cwd, "session-b", "src/a.ts", 31), null);
  edit(cwd, "session-a", "src/b.ts", 40);
  assert.equal(edit(cwd, "session-b", "src/b.ts", 41, "Read"), null);
  assert.equal(checkEditOverlap({ cwd, tool: "Edit", toolInput: JSON.stringify({ file_path: path.join(cwd, "src/b.ts") }) }), null);
  assert.equal(checkEditOverlap({ cwd, tool: "Edit", sessionId: "session-b", toolInput: JSON.stringify({ file_path: "/etc/hosts" }) }), null);
  const record = JSON.parse(fs.readFileSync(path.join(cwd, ".snipara/collaboration/edits.json"), "utf8"));
  assert.deepEqual(Object.keys(record.files).sort(), ["src/a.ts", "src/b.ts"]);
});
