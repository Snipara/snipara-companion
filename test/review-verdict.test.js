const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { buildReviewBrief, parseReviewerOutput, computeVerdict, reviewCommand, recordCheckCommand, verdictCommand,
  readReviewReceipt, readCheckReceipts, gitState } = require("../dist/index.js");

const check = (over = {}) => ({ schema: "snipara.check-receipt.v1", name: "sandbox:unit", ok: true, tree: "T1", dirty: false, at: "2026-11-13T00:00:00Z", ...over });
const review = (over = {}) => ({ schema: "snipara.review-receipt.v1", commit: "C1", tree: "T1", dirty: false, base: "B", reviewer: "codex",
  readOnlyEnforced: true, briefSha256: "x", diffChars: 10, reviewedChars: 10, verdict: "pass", findings: [], createdAt: "2026-11-13T00:00:00Z", ...over });

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-review-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n"); git("add", "."); git("commit", "-q", "-m", "first");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n"); git("add", "."); git("commit", "-q", "-m", "add the second line");
  return { dir, git };
}
const quiet = async (fn) => { const log = console.log, err = console.error; const lines = []; console.log = (v) => lines.push(String(v)); console.error = (v) => lines.push(String(v));
  try { return [await fn(), lines.join("\n")]; } finally { console.log = log; console.error = err; } };

test("brief carries the task, the checks and a bounded diff, and asks for findings only", () => {
  const brief = buildReviewBrief({ task: "Add the second line", base: "aaaaaaaaaaaaaaaa", commit: "bbbbbbbbbbbbbbbb", stat: " a.txt | 1 +",
    diff: "x".repeat(70000), checks: [check(), check({ name: "lint", ok: false, detail: "3 findings" })], memories: ["Loopback only by address."] });
  assert.match(brief, /You did not write it/);
  assert.match(brief, /"findings"/);
  assert.match(brief, /## Task\nAdd the second line/);
  assert.match(brief, /- sandbox:unit: passed/);
  assert.match(brief, /- lint: FAILED \(3 findings\)/);
  assert.match(brief, /Loopback only by address/);
  assert.match(brief, /diff cut at 60000 characters of 70000/);
  assert.ok(brief.length < 62000);
  assert.match(buildReviewBrief({ task: "t", base: "a", commit: "b", stat: "", diff: "d" }), /None recorded\./);
});

test("reviewer output: findings are kept only when well formed; a blocker decides the verdict", () => {
  const ok = parseReviewerOutput('Here you go:\n{"findings":[{"severity":"major","file":"a.ts","line":12,"summary":"misses  the empty case"}]}');
  assert.deepEqual(ok, { verdict: "pass", findings: [{ severity: "major", summary: "misses the empty case", file: "a.ts", line: 12 }] });
  // A finding that is not well formed is never dropped: it could be the objection.
  assert.equal(parseReviewerOutput('{"findings":[{"severity":"major","summary":"x"},{"severity":"praise","summary":"nice"}]}'), null);
  assert.equal(parseReviewerOutput('{"findings":[{"severity":"blocker","summary":""}]}'), null);
  // Too many findings to keep: unreadable, never a silent cut.
  assert.equal(parseReviewerOutput(JSON.stringify({ findings: Array.from({ length: 51 }, () => ({ severity: "minor", summary: "x" })) })), null);
  assert.equal(parseReviewerOutput('{"findings":[{"severity":"blocker","summary":"drops rows"}]}').verdict, "blockers");
  assert.deepEqual(parseReviewerOutput('{"findings":[]}'), { verdict: "pass", findings: [] });
  for (const bad of ["no json here", "{not json}", '{"verdict":"pass"}']) assert.equal(parseReviewerOutput(bad), null);
});

test("verdict: verified needs passed checks and a passing review on the same clean tree", () => {
  assert.equal(computeVerdict({ tree: "T1", dirty: false, checks: [check()], review: review() }).state, "verified");
  const none = computeVerdict({ tree: "T1", dirty: false, checks: [], review: null });
  assert.equal(none.state, "not_verified"); assert.equal(none.missing.length, 2);
  // Receipts of another tree, or taken with uncommitted changes, do not count.
  assert.equal(computeVerdict({ tree: "T1", dirty: false, checks: [check({ tree: "T0" }), check({ dirty: true })], review: review({ tree: "T0" }) }).state, "not_verified");
  const noSandbox = computeVerdict({ tree: "T1", dirty: false, checks: [], review: review() });
  assert.equal(noSandbox.state, "partial"); assert.match(noSandbox.missing[0], /no check receipt/); assert.match(noSandbox.has[0], /separate review passed/);
  const failed = computeVerdict({ tree: "T1", dirty: false, checks: [check(), check({ name: "lint", ok: false })], review: review() });
  assert.equal(failed.state, "partial"); assert.match(failed.missing[0], /failed checks: lint/);
  const blocked = computeVerdict({ tree: "T1", dirty: false, checks: [check()], review: review({ verdict: "blockers", findings: [{ severity: "blocker", summary: "x" }] }) });
  assert.equal(blocked.state, "partial"); assert.match(blocked.missing[0], /1 blocker/);
  assert.equal(computeVerdict({ tree: "T1", dirty: false, checks: [check()], review: review({ verdict: "unreadable" }) }).state, "partial");
  const cut = computeVerdict({ tree: "T1", dirty: false, checks: [check()], review: review({ diffChars: 90000, reviewedChars: 60000 }) });
  assert.equal(cut.state, "partial"); assert.match(cut.missing[0], /only the first 60000 of 90000 characters/);
  assert.match(computeVerdict({ tree: "T1", dirty: false, checks: [check()], review: review({ readOnlyEnforced: false }) }).has[1], /read-only access not enforced/);
  const dirty = computeVerdict({ tree: "T1", dirty: true, checks: [check()], review: review() });
  assert.equal(dirty.state, "partial"); assert.match(dirty.missing[0], /uncommitted changes/);
});

test("review runs the given reviewer on the commit's diff and binds the receipt to its tree", async (t) => {
  const { dir } = repo(t);
  const state = gitState(dir);
  const seen = path.join(dir, "..", `brief-${path.basename(dir)}.txt`);
  t.after(() => fs.rmSync(seen, { force: true }));
  const reviewer = `cat > '${seen}'; printf '%s' '{"findings":[{"severity":"minor","file":"a.txt","line":2,"summary":"second line has no test"}]}'`;
  const [code, out] = await quiet(() => reviewCommand({ cwd: dir, task: "Add the second line", reviewer }));
  assert.equal(code, 0);
  assert.match(out, /review: pass; reviewer cat/);
  assert.match(out, /minor: a\.txt:2 — second line has no test/);
  const brief = fs.readFileSync(seen, "utf8");
  assert.match(brief, /\+two/); assert.match(brief, /## Task\nAdd the second line/);
  const receipt = readReviewReceipt(dir, state.tree);
  assert.equal(receipt.tree, state.tree); assert.equal(receipt.commit, state.commit); assert.equal(receipt.dirty, false);
  assert.equal(receipt.findings.length, 1);
  assert.equal(receipt.readOnlyEnforced, false); assert.equal(receipt.reviewedChars, receipt.diffChars);

  const [blocked] = await quiet(() => reviewCommand({ cwd: dir, reviewer: `cat >/dev/null; echo '{"findings":[{"severity":"blocker","summary":"breaks a"}]}'` }));
  assert.equal(blocked, 2);
  const [unreadable, text] = await quiet(() => reviewCommand({ cwd: dir, reviewer: "cat >/dev/null; echo sorry" }));
  assert.equal(unreadable, 3); assert.match(text, /held no usable findings object/);
  const [crashed, why] = await quiet(() => reviewCommand({ cwd: dir, reviewer: "cat >/dev/null; exit 7" }));
  assert.equal(crashed, 3); assert.match(why, /could not be run/);
  assert.equal(readReviewReceipt(dir, state.tree).verdict, "unreadable");
});

test("verdict command: partial without the Sandbox, verified with a check receipt, never blocks unless asked", async (t) => {
  const { dir } = repo(t);
  let [code, out] = await quiet(() => verdictCommand({ cwd: dir }));
  assert.equal(code, 0); assert.match(out, /verdict: not verified/);
  await quiet(() => reviewCommand({ cwd: dir, reviewer: `cat >/dev/null; echo '{"findings":[]}'` }));
  [code, out] = await quiet(() => verdictCommand({ cwd: dir }));
  assert.equal(code, 0); assert.match(out, /verdict: partial/); assert.match(out, /- no check receipt for this tree/);
  [code] = await quiet(() => verdictCommand({ cwd: dir, require: "verified" }));
  assert.equal(code, 2);
  // A check run while an untracked file sits in the tree does not vouch for the commit.
  fs.writeFileSync(path.join(dir, "stray.txt"), "x");
  await quiet(() => recordCheckCommand({ cwd: dir, name: "unit", ok: true }));
  assert.equal(readCheckReceipts(dir)[0].dirty, true);
  [, out] = await quiet(() => verdictCommand({ cwd: dir }));
  assert.match(out, /- no check receipt for this tree/);
  fs.rmSync(path.join(dir, "stray.txt"));
  await quiet(() => recordCheckCommand({ cwd: dir, name: "unit", ok: true }));
  assert.equal(readCheckReceipts(dir).length, 1);
  [code, out] = await quiet(() => verdictCommand({ cwd: dir, require: "verified", json: true }));
  assert.equal(code, 0); assert.equal(JSON.parse(out).state, "verified");
  // A new commit has its own tree: the receipts of the previous one no longer vouch for it.
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
  [code, out] = await quiet(() => verdictCommand({ cwd: dir }));
  assert.match(out, /uncommitted changes/);
  execFileSync("git", ["commit", "-qam", "third"], { cwd: dir });
  [code, out] = await quiet(() => verdictCommand({ cwd: dir }));
  assert.match(out, /verdict: not verified/);
});
