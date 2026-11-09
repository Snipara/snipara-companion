const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const test = require("node:test");
const { buildTaskReference, observeTaskWorkspace, projectManagedProgress, taskVerificationKind,
  validateTaskIntake, taskIntakeHash } = require("../dist/index.js");
const { resolveOrchestratorSourceFixture } = require("./support/source-fixtures.js");
const fixtureFile = path.join(__dirname, "fixtures/task-reference-v1.json");
const corpus = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
const brief = (template = corpus.intake) => {
  const value = structuredClone(template);
  value.source.bodySha256 = createHash("sha256").update(value.goal).digest("hex");
  return validateTaskIntake({ ...value, contentSha256: taskIntakeHash(value) });
};
const options = (entry) => { const { name: _, ...input } = structuredClone(entry); return { ...input, intake: brief() }; };

test("immutable intake identity survives owner/path/revision changes but not repository/worktree changes", () => {
  const [base, controller, worktree, foreign, policy] = corpus.references.map((entry) => buildTaskReference(options(entry)));
  assert.equal(base.schemaVersion, "snipara.task_reference.v1");
  assert.equal(base.taskId, corpus.intake.id);
  assert.equal(base.identitySha256, controller.identitySha256);
  assert.notEqual(base.referenceSha256, controller.referenceSha256);
  assert.equal(base.verificationContractSha256, controller.verificationContractSha256);
  assert.equal(base.workspace.repositoryId, worktree.workspace.repositoryId);
  assert.notEqual(base.workspace.worktreeId, worktree.workspace.worktreeId);
  assert.notEqual(base.identitySha256, worktree.identitySha256);
  assert.notEqual(base.workspace.repositoryId, foreign.workspace.repositoryId);
  assert.notEqual(base.identitySha256, foreign.identitySha256);
  assert.equal(base.identitySha256, policy.identitySha256);
  assert.notEqual(base.verificationContractSha256, policy.verificationContractSha256);
  assert.equal(base.projectBinding, null, "a local Git identity is never a trusted hosted project");
  assert.deepEqual(base.authority, { kind: "read_only_projection", executionGranted: false, integrationGranted: false });
  const { referenceSha256, ...body } = base;
  assert.equal(referenceSha256, taskIntakeHash(body));
  const input = options(corpus.references[0]);
  const changed = { ...corpus.intake, goal: "A distinct immutable operator contract" };
  input.intake = brief(changed);
  assert.notEqual(buildTaskReference(input).identitySha256, base.identitySha256);
});

for (const row of corpus.progress) test(`common task progression: ${row.name}`, () => {
  const result = projectManagedProgress({ ...corpus.progressDefaults, ...row.input });
  assert.equal(result.state, row.state); assert.equal(result.evidence, row.evidence);
  assert.equal(result.executionObserved, false); assert.equal(result.integrationObserved, false);
  assert.notEqual(result.state, "completed");
  if (row.name === "historical-closure") assert.equal(result.recordedClosure, true);
  if (row.name === "no-runtime-checks") assert.ok(result.reasonCodes.includes("no_runtime_checks_required"));
});

test("runtime flags and reference paths cannot be interpreted through truthiness or traversal", () => {
  for (const mutation of [
    (x) => { x.workspaceRoot = "/workspace//repo"; },
    (x) => { x.workspaceRoot = "/workspace/repo/"; },
    (x) => { x.intakePath = "../another-intake.json"; },
    (x) => { x.lifecycle.statePath = ".git/config"; },
    (x) => { x.lifecycle.statePath = "C:/private/state.json"; },
    (x) => { x.lifecycle.ownerKind = "provider_claim"; },
    (x) => { x.lifecycle.revisionSha256 = "unverified"; },
    (x) => { x.effectiveVerification = ["\nmalformed"]; },
  ]) {
    const input = options(corpus.references[0]); mutation(input);
    assert.throws(() => buildTaskReference(input));
  }
  for (const key of ["referenceAvailable", "contractComplete", "localChangesObserved", "workDeclared", "recordedClosure", "requiredChecksPassed"])
    assert.throws(() => projectManagedProgress({ ...corpus.progressDefaults, [key]: "false" }));
  assert.equal(taskVerificationKind([]), "none");
  assert.equal(taskVerificationKind(["git  diff --check"]), "static");
  assert.equal(taskVerificationKind(["git diff --check", "python -m pytest"]), "runtime");
});

test("local metadata observes shared Git dir and distinct worktrees without invoking a process", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "task-reference-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, "primary"), other = path.join(parent, "other");
  const common = path.join(root, ".git"), privateGit = path.join(common, "worktrees/other");
  fs.mkdirSync(path.join(common, "objects"), { recursive: true });
  fs.mkdirSync(privateGit, { recursive: true }); fs.mkdirSync(other);
  fs.writeFileSync(path.join(common, "HEAD"), "ref: refs/heads/dev\n");
  fs.writeFileSync(path.join(privateGit, "HEAD"), "ref: refs/heads/other\n");
  fs.writeFileSync(path.join(privateGit, "commondir"), "../..\n");
  fs.writeFileSync(path.join(other, ".git"), `gitdir: ${privateGit}\n`);
  const a = observeTaskWorkspace(root), b = observeTaskWorkspace(other);
  assert.equal(a.gitCommonDir, b.gitCommonDir); assert.notEqual(a.root, b.root);
  fs.writeFileSync(path.join(privateGit, "commondir"), "missing-target\n");
  assert.throws(() => observeTaskWorkspace(other), "missing common-dir target cannot fall back to the private Git dir");
  fs.unlinkSync(path.join(privateGit, "commondir"));
  fs.symlinkSync(path.join(common, "HEAD"), path.join(privateGit, "commondir"));
  assert.throws(() => observeTaskWorkspace(other));
  fs.unlinkSync(path.join(other, ".git")); fs.writeFileSync(path.join(other, ".git"), "x".repeat(4097));
  assert.throws(() => observeTaskWorkspace(other));
});

test("shared Unicode corpus has identical Python and TypeScript wire output", (t) => {
  let command = process.env.SNIPARA_ORCHESTRATOR_TEST_PYTHON, args;
  const consume = "import hashlib,json,sys; from snipara_orchestrator.task_reference import build_task_reference,project_managed_progress; from snipara_orchestrator.task_intake import task_intake_hash; c=json.load(sys.stdin); c['intake']['source']['bodySha256']=hashlib.sha256(c['intake']['goal'].encode('utf8')).hexdigest(); b={**c['intake'],'contentSha256':task_intake_hash(c['intake'])}; refs=[build_task_reference(intake=b,intake_path=r['intakePath'],workspace_root=r['workspaceRoot'],git_common_dir=r['gitCommonDir'],lifecycle=r['lifecycle'],effective_verification=r['effectiveVerification']) for r in c['references']]; names={'referenceAvailable':'reference_available','contractComplete':'contract_complete','blockingReasons':'blocking_reasons','localChangesObserved':'local_changes_observed','workDeclared':'work_declared','recordedClosure':'recorded_closure','verificationKind':'verification_kind','freshRecommendation':'fresh_recommendation','requiredChecksPassed':'required_checks_passed'}; progress=[project_managed_progress(**{names[k]:v for k,v in {**c['progressDefaults'],**r['input']}.items()}) for r in c['progress']]; print(json.dumps({'references':refs,'progress':progress},ensure_ascii=False))";
  if (command !== undefined) {
    assert.ok(command && fs.existsSync(command), "the explicit installed interpreter must exist");
    assert.equal(process.env.SNIPARA_ORCHESTRATOR_TEST_SOURCE, undefined);
    args = ["-I", "-B", "-c", consume];
  } else {
    const source = resolveOrchestratorSourceFixture(process.env.SNIPARA_ORCHESTRATOR_TEST_SOURCE);
    if (!source) {
      assert.notEqual(process.env.SNIPARA_REQUIRE_TASK_REFERENCE_PARITY, "1", "cross-language source is required by this qualification");
      return t.skip("standalone Companion test input has no Orchestrator consumer");
    }
    command = "python3";
    // This branch proves the two real stdlib-only source algorithms, not the
    // installed package's __init__/dependency surface (covered above/consumer proof).
    const sourceLoader = [
      "import importlib.util,pathlib,sys",
      "intake=pathlib.Path(sys.argv[1]).resolve(strict=True)",
      "assert intake.name == 'task_intake.py'",
      "assert 'snipara_orchestrator' not in sys.modules",
      "for leaf in ('task_intake', 'task_reference'):",
      " file=intake.parent/(leaf+'.py')",
      " assert file.is_file() and not file.is_symlink()",
      " name='snipara_orchestrator.'+leaf",
      " spec=importlib.util.spec_from_file_location(name,file)",
      " module=importlib.util.module_from_spec(spec)",
      " sys.modules[name]=module",
      " spec.loader.exec_module(module)",
      " assert pathlib.Path(module.__file__).resolve(strict=True) == file",
      "assert 'snipara_orchestrator' not in sys.modules",
      consume,
      "assert 'snipara_orchestrator' not in sys.modules",
    ].join("\n");
    args = ["-I", "-S", "-B", "-c", sourceLoader, source];
  }
  const observed = JSON.parse(execFileSync(command, args, { input: JSON.stringify(corpus), encoding: "utf8", timeout: 20000, maxBuffer: 2_000_000 }));
  assert.deepEqual(observed.references, corpus.references.map((row) => buildTaskReference(options(row))));
  assert.deepEqual(observed.progress, corpus.progress.map((row) => projectManagedProgress({ ...corpus.progressDefaults, ...row.input })));
});
