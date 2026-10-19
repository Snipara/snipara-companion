/** Five-step presentation of existing feature/workflow receipts; never a second task engine. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { normalizeFeatureSlug, resolveFeatureArtifactPaths, type FeatureWorkItemManifest } from "./feature";
import { buildVerificationPlan, type VerificationPlan } from "./verify";
import { canonicalBridgeProof } from "./controller-bridge";
import { resumeWorkflowContinuity, readWorkflowContinuityFile, resolveWorkflowContinuityFile,
  type WorkflowContinuityResume } from "./workflow-continuity";
import { readTaskContext, normalizeTaskContextRequest, taskContextRequestHash, type WorkflowTaskContextRequest } from "./workflow-task-context";
import { createTaskIntake, readTaskIntake, revalidateTaskIntake, taskIntakeHash, validateTaskIntake, writeTaskIntake, type TaskIntake } from "./task-intake";
import { checkpointText } from "../session/checkpoint";
import { assertManagedWorkflowSchemaVersion, type ManagedWorkflowState, type ManagedWorkflowTask } from "./workflows";

type Data = Record<string, unknown>;
const record = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const clean = (value: unknown, max = 4000): string => typeof value === "string" ? checkpointText(value, max) : "";
const OUTPUT = ".snipara/tasks";
const STATE = ".snipara/workflow/current.json";
const MAX_BYTES = 2 * 1024 * 1024;
export interface TaskJourneyInput {
  goal: string; criteria?: string[]; files?: string[]; verification?: string[]; source?: unknown;
}
export interface TaskJourneyOptions {
  action: "start" | "show" | "work" | "verify" | "decide" | "resume" | "close";
  cwd?: string; slug?: string; input?: TaskJourneyInput; intake?: TaskIntake; intakePath?: string;
  summary?: string; outcome?: "completed" | "partial" | "blocked" | "abandoned";
  why?: string; evidence?: string[]; contextRequest?: WorkflowTaskContextRequest;
  refreshDossier?: boolean; controllerId?: string; candidateId?: string; orchestratorBin?: string;
}
export interface TaskJourneyCard {
  schemaVersion: "snipara.task_journey.v1";
  generatedAt: string;
  task: { id: string; goal: string; objective: string; criteria: string[]; files: string[]; scope: string[];
    verification: string[]; intakeSha256: string | null; source: unknown;
    featurePath: string | null; workflowId: string | null; intake: TaskIntake | null };
  status: "needs_clarification" | "ready" | "working" | "verification_required" | "review_required" |
    "correction_required" | "blocked" | "integration_possible" | "integrated" | "closed";
  steps: Array<{ id: "frame" | "work" | "verify" | "decide" | "resume"; label: string; status: string; detail: string }>;
  evidence: Array<{ kind: string; path?: string; sha256?: string; authority: string; status: string }>;
  blockers: string[];
  capabilities: Array<{ id: string; status: string; detail: string; observedAt?: string }>;
  nextAction: { kind: string; argv: string[]; reason: string; expectedResult: string; effects: string[];
    dispatchesAgent: false; automaticExecution: false };
  authority: { executionGranted: false; integrationGranted: false; deploymentGranted: false;
    declarationsAreFunctionalProof: false; semanticContextUseVerified: false;
    issueBodyAuthority: "untrusted_source"; semanticUseVerified: false };
  continuity: WorkflowContinuityResume | null;
  runtimeDelivery: { status: "not_observed" | "caller_output_observed"; semanticUseVerified: false };
  recommendation: { action: "integrate" | "correct" | "block" | "human_review"; source: string; fresh: boolean };
  verificationPlan?: VerificationPlan;
  preparedContext?: { envelope?: unknown; context?: unknown };
  dossier?: unknown;
  notices: string[];
}
function localJson(cwd: string, relative: string): Data | null {
  try {
    const bytes = readWorkflowContinuityFile({ cwd, path: relative, maxBytes: MAX_BYTES });
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!record(parsed)) throw new Error("Expected an object");
    return parsed;
  } catch (error) {
    if (record(error) && error.code === "ENOENT") return null;
    throw new Error("Task artifact is unsafe, invalid, unavailable or oversized");
  }
}
function stateAt(cwd: string): ManagedWorkflowState | null {
  const value = localJson(cwd, STATE);
  if (!value) return null;
  assertManagedWorkflowSchemaVersion(value.schemaVersion);
  if (typeof value.workflowId !== "string" || typeof value.goal !== "string" || !Array.isArray(value.phases))
    throw new Error("Current workflow contract is invalid");
  return value as unknown as ManagedWorkflowState;
}
function safeJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, item: unknown) => {
    if (/^(?:stdout|stderr|rawLogs?|transcript|privateReasoning|password|secret|authorization|apiKey|api_key|accessToken)$/i.test(key))
      return "[REDACTED]";
    return typeof item === "string" ? checkpointText(item, MAX_BYTES, false) : item;
  }));
}
function idFor(options: { slug?: string }, state: ManagedWorkflowState | null): string {
  if (options.slug) {
    if (normalizeFeatureSlug(options.slug) !== options.slug) throw new Error("Task id must be a normalized feature slug");
    return options.slug;
  }
  return state?.workflowId.startsWith("feature-") ? state.workflowId.slice(8) : "current";
}
function featureAt(cwd: string, slug: string): { manifest: FeatureWorkItemManifest | null; root: string } {
  const paths = resolveFeatureArtifactPaths(slug, { cwd, outputDir: OUTPUT });
  const relative = path.relative(cwd, paths.manifest).replace(/\\/g, "/");
  const value = localJson(cwd, relative);
  if (value && (value.schemaVersion !== "snipara.feature_work_item.v1" || value.slug !== slug ||
    typeof value.goal !== "string" || !Array.isArray(value.acceptanceCriteria))) throw new Error("Feature manifest identity differs");
  return { manifest: value as unknown as FeatureWorkItemManifest | null, root: paths.root };
}
function intakeAt(cwd: string, root: string): TaskIntake | null {
  const relative = path.relative(cwd, path.join(root, "task-intake.json")).replace(/\\/g, "/");
  const file = resolveWorkflowContinuityFile({ cwd, path: relative });
  if (!fs.existsSync(file)) return null;
  readWorkflowContinuityFile({ cwd, path: relative, maxBytes: 256000 });
  return readTaskIntake(file);
}
function taskOf(state: ManagedWorkflowState | null): { phaseId: string; task: ManagedWorkflowTask } | null {
  if (!state) return null;
  const all = state.phases.flatMap((phase) => (phase.tasks ?? []).map((task) => ({ phaseId: phase.id, task })));
  return all.find((item) => item.task.status === "in_progress") ??
    all.find((item) => item.task.status === "blocked") ?? all.find((item) => item.task.status === "pending") ?? all[0] ?? null;
}
function action(slug: string, verb: string, expectedResult: string, effects: string[] = []): TaskJourneyCard["nextAction"] {
  return { kind: verb, argv: ["snipara-companion", "task", verb, slug, "--json"], reason: expectedResult,
    expectedResult, effects, dispatchesAgent: false, automaticExecution: false };
}
export function buildTaskJourneyCard(options: { cwd?: string; slug?: string } = {}): TaskJourneyCard {
  const cwd = fs.realpathSync(options.cwd ?? process.cwd()), current = stateAt(cwd);
  const slug = idFor(options, current), feature = featureAt(cwd, slug);
  const state = options.slug && current?.workflowId !== `feature-${slug}` ? null : current;
  const intake = intakeAt(cwd, feature.root);
  const focused = taskOf(state), task = focused?.task;
  const continuity = state ? resumeWorkflowContinuity({ cwd, state }) : null;
  const criteria = intake?.criteria ?? feature.manifest?.acceptanceCriteria ?? (task?.acceptance ? [task.acceptance] : []);
  const files = intake?.files ?? task?.files ?? [];
  const verification = intake?.verification ?? task?.verification ?? [];
  const goal = intake?.goal ?? feature.manifest?.goal ?? state?.goal ?? "";
  const blockers: string[] = [];
  const unsupportedScope = files.some((scope) => [...scope].some((char) => "[]{}".includes(char)));
  if (!goal || !criteria.length) blockers.push("The task needs an explicit objective and observable acceptance criteria");
  if (unsupportedScope) blockers.push("Bracket and brace scope patterns are not admitted by this façade; make the intended file scope explicit before preparing or recording work");
  if (feature.manifest && !state) blockers.push(current
    ? "This feature has no bound current workflow; another current workflow was preserved"
    : "This feature has no current workflow pointer; inspect its saved artifacts before explicitly restoring work");
  if (state && feature.manifest && (feature.manifest.goal !== state.goal ||
    (intake && (intake.goal !== state.goal || JSON.stringify(intake.criteria) !== JSON.stringify(feature.manifest.acceptanceCriteria)))))
    blockers.push("The selected brief, feature specification and workflow no longer describe the same contract");
  if (intake && task && (task.acceptance !== intake.criteria.join("\n") ||
    JSON.stringify(task.files ?? []) !== JSON.stringify(intake.files) ||
    JSON.stringify(task.verification ?? []) !== JSON.stringify(intake.verification)))
    blockers.push("The current task criteria, scope or verification commands differ from the selected immutable brief");
  if (continuity && continuity.status !== "exact_snapshot") blockers.push(...continuity.reasons,
    ...continuity.changes.map((item) => `Revalidation required: ${item}`));
  if (task?.status === "blocked") blockers.push(clean(task.lastError ?? task.summary ?? "The previous attempt requires a correction"));
  const declaredDone = !!state && state.phases.every((phase) => (phase.tasks ?? []).every((item) => ["completed", "skipped"].includes(item.status)));
  let status: TaskJourneyCard["status"] = !goal || !criteria.length ? "needs_clarification"
    : blockers.length ? "blocked" : state?.finalReport ? "closed" : task?.status === "in_progress" ? "working"
      : declaredDone ? "verification_required" : "ready";
  if (task?.status === "blocked" && continuity?.status === "exact_snapshot" && blockers.length === 1) status = "correction_required";
  const evidence: TaskJourneyCard["evidence"] = [];
  if (intake) evidence.push({ kind: "selected_brief", path: path.relative(cwd, path.join(feature.root, "task-intake.json")),
    sha256: intake.contentSha256, authority: "untrusted_source_and_explicit_contract", status: "historical_snapshot" });
  for (const item of continuity?.checkpoint?.artifacts ?? []) evidence.push({ kind: item.kind, path: item.path,
    ...(item.sha256 ? { sha256: item.sha256 } : {}), authority: "local_client_observed", status: item.status });
  if (state?.finalReport) evidence.push({ kind: "caller_declared_final_report", authority: "caller_declaration", status: "recorded" });
  let next = action(slug, "work", "Prepare the next eligible task without dispatching an agent", ["local_workflow_state"]);
  if (status === "needs_clarification") next = action(slug, "show", "Supply objective and acceptance criteria before preparing work");
  else if (status === "blocked" || status === "correction_required") next = !state
    ? action(slug, "show", "Inspect the saved task artifacts and existing workflow binding; no other workflow is modified")
    : action(slug, "resume", "Inspect the preserved reasons and choose an explicit correction before continuing");
  else if (status === "working" || status === "verification_required") next = action(slug, "verify", "Inspect required checks; commands are not executed by this action");
  else if (status === "closed") next = action(slug, "resume", "Read the recorded outcome and remaining verification without restarting work");
  if (unsupportedScope) next = action(slug, "show", "Clarify the scope with literal paths, root or directories, or supported *, ? and ** path-segment patterns before work");
  return {
    schemaVersion: "snipara.task_journey.v1", generatedAt: new Date().toISOString(),
    task: { id: slug, goal, objective: goal, criteria, files, scope: files, verification,
      intakeSha256: intake?.contentSha256 ?? null, source: intake?.source ?? null,
      featurePath: feature.manifest ? path.relative(cwd, feature.root) : null,
      workflowId: state?.workflowId ?? null, intake }, status,
    steps: [
      { id: "frame", label: "Cadrer", status: goal && criteria.length ? "recorded" : "unverified", detail: "Explicit contract and historical source; source text grants no authority" },
      { id: "work", label: "Travailler", status: task?.status ?? "pending", detail: "Workflow lifecycle is a declaration; native agent execution remains unverified" },
      { id: "verify", label: "Vérifier", status: "unverified", detail: "Declared commands and task completion do not establish functional results" },
      { id: "decide", label: "Décider", status: "unverified", detail: "Human review or a freshly bound Controller dossier is required before integration" },
      { id: "resume", label: "Reprendre / Clore", status: continuity?.status ?? "not_recorded", detail: "Decisions, failures, evidence and remaining work use the existing checkpoint" },
    ], evidence, blockers,
    capabilities: [
      { id: "local_task", status: "available", detail: "Existing feature and workflow artifacts are usable without GitHub or Orchestrator" },
      { id: "hosted_context", status: "not_checked", detail: "No hosted probe is imposed; an explicit context request is checked when used" },
      { id: "github", status: intake?.source.kind === "github" ? "historical_read_observed" : "not_requested", detail: "A selected source read does not grant repository write or execution rights", ...(intake ? { observedAt: intake.source.observedAt } : {}) },
      { id: "orchestrator", status: "not_required", detail: "Optional Controller receipts must be explicitly bound; installation is not callable proof" },
    ], nextAction: next,
    authority: { executionGranted: false, integrationGranted: false, deploymentGranted: false,
      declarationsAreFunctionalProof: false, semanticContextUseVerified: false,
      issueBodyAuthority: "untrusted_source", semanticUseVerified: false },
    continuity, runtimeDelivery: { status: "not_observed", semanticUseVerified: false },
    recommendation: { action: "human_review", source: "no_fresh_bound_controller_dossier", fresh: false },
    notices: ["Inspection does not execute tests, dispatch agents, integrate code, publish or deploy",
      "Companion, Hosted MCP and Orchestrator remain independently optional; this façade does not install or enable them",
      "Scope admission supports literal paths, root/directories, and *, ? and ** path-segment patterns; bracket/brace patterns require explicit scope clarification",
      "The selected issue and initial dirty baseline remain historical; only explicit refresh may reread a remote source"],
  };
}
function selfCli(cwd: string, argv: string[], hosted = false): Data {
  const executable = fs.realpathSync(path.join(__dirname, "index.js"));
  const result = spawnSync(process.execPath, [executable, ...argv], { cwd, encoding: "utf8", shell: false,
    timeout: hosted ? 130000 : 30000, maxBuffer: MAX_BYTES,
    env: { ...process.env, SNIPARA_WORKSPACE_DIR: cwd, SNIPARA_LOCAL_ONLY: hosted ? "0" : "1",
      SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) throw new Error(`Existing workflow action refused: ${clean(result.stderr || result.stdout || result.error?.message, 1600)}`);
  const output = result.stdout.trim();
  const boundary = output.lastIndexOf("\n{");
  const value: unknown = JSON.parse(output.slice(boundary < 0 ? 0 : boundary + 1));
  if (!record(value)) throw new Error("Existing workflow action returned no bounded JSON object");
  return value;
}
function locked<T>(cwd: string, callback: (lock: { path: string; sha256: string }) => T): T {
  const relative = ".snipara/workflow/task-journey.lock";
  const file = resolveWorkflowContinuityFile({ cwd, path: relative });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
  catch { throw new Error("A task façade action is already active or its admission lock needs inspection"); }
  const identity = JSON.stringify({ pid: process.pid, admissionId: sha(`${process.pid}:${Date.now()}:${Math.random()}`) });
  fs.writeFileSync(fd, identity); fs.fsyncSync(fd);
  try { return callback({ path: relative, sha256: sha(identity) }); }
  finally {
    fs.closeSync(fd);
    try { if (readWorkflowContinuityFile({ cwd, path: relative, maxBytes: 1000 }).toString("utf8") === identity) fs.unlinkSync(file); }
    catch { /* Never remove a replaced or unverifiable lock. */ }
  }
}
function revalidateAdmission(cwd: string, brief: TaskIntake, intakePath?: string,
  lock?: { path: string; sha256: string }): void {
  const allowed = new Map<string, string>();
  if (intakePath) {
    const relative = path.relative(cwd, path.resolve(cwd, intakePath)).replace(/\\/g, "/");
    const bytes = readWorkflowContinuityFile({ cwd, path: relative, maxBytes: 256000 });
    const exported = validateTaskIntake(JSON.parse(bytes.toString("utf8")));
    if (exported.contentSha256 !== brief.contentSha256) throw new Error("Exported intake artifact does not match the supplied immutable brief");
    allowed.set(relative, sha(bytes));
  }
  if (lock) {
    const bytes = readWorkflowContinuityFile({ cwd, path: lock.path, maxBytes: 1000 });
    if (sha(bytes) !== lock.sha256) throw new Error("Task admission lock changed before repository revalidation");
    allowed.set(lock.path, lock.sha256);
  }
  const observed = revalidateTaskIntake(brief, { workspaceRoot: cwd });
  if (observed.status === "exact") return;
  const baseline = brief.repositorySnapshot.dirtyBaseline;
  const baselinePaths = new Set(baseline.map((item) => item.path));
  const current = observed.currentRepositorySnapshot.dirtyBaseline.filter((item) => {
    const admitted = allowed.get(item.path);
    return !admitted || baselinePaths.has(item.path) || item.status !== "??" || item.sha256 !== admitted;
  });
  if (observed.status === "blocked" || observed.reasonCodes.some((reason) => reason !== "repository_dirty_baseline_changed") ||
    taskIntakeHash(current) !== taskIntakeHash(baseline))
    throw new Error(`Selected intake requires revalidation before admission: ${observed.reasonCodes.join(", ")}`);
}
function start(options: TaskJourneyOptions, cwd: string): TaskJourneyCard {
  const supplied = options.intake ? validateTaskIntake(options.intake) : createTaskIntake({ workspaceRoot: cwd,
    goal: options.input?.goal ?? "", criteria: options.input?.criteria, files: options.input?.files,
    verification: options.input?.verification }).brief;
  const slug = options.slug ?? `task-${sha(supplied.goal).slice(0, 12)}`;
  idFor({ slug }, null);
  return locked(cwd, (lock) => {
    const previous = stateAt(cwd);
    if (previous && previous.status !== "completed") {
      if (previous.workflowId !== `feature-${slug}`) throw new Error("An existing active workflow was preserved; resume or close it before starting another task");
      const old = intakeAt(cwd, featureAt(cwd, slug).root);
      const stableContract = (intake: TaskIntake) => {
        const { kind, repository, issueNumber, url, updatedAt, bodySha256, authority } = intake.source;
        return [intake.goal, intake.criteria, intake.files, intake.verification,
          { kind, repository, issueNumber, url, updatedAt, bodySha256, authority }];
      };
      if (!old || JSON.stringify(stableContract(old)) !== JSON.stringify(stableContract(supplied)))
        throw new Error("Existing task contract differs; create an explicit new task or revise it through the existing specification workflow");
      if (options.contextRequest !== undefined) {
        const requested = normalizeTaskContextRequest(options.contextRequest);
        const recorded = normalizeTaskContextRequest(taskOf(previous)?.task.contextRequest);
        if (!requested || !recorded || taskContextRequestHash(requested) !== taskContextRequestHash(recorded))
          throw new Error("Existing task context request differs; create an explicit new task or revise the existing plan before loading other sources");
      }
      return buildTaskJourneyCard({ cwd, slug });
    }
    revalidateAdmission(cwd, supplied, options.intakePath, lock);
    const paths = resolveFeatureArtifactPaths(slug, { cwd, outputDir: OUTPUT });
    if (!supplied.criteria.length) {
      const incomplete = buildTaskJourneyCard({ cwd, slug });
      incomplete.task = { ...incomplete.task, goal: supplied.goal, objective: supplied.goal, criteria: supplied.criteria,
        files: supplied.files, scope: supplied.files, verification: supplied.verification, intake: supplied,
        intakeSha256: supplied.contentSha256, source: supplied.source };
      incomplete.status = "needs_clarification";
      incomplete.notices.push("Incomplete framing was returned to the caller; no existing workflow or feature artifact was replaced");
      return incomplete;
    }
    if (fs.existsSync(paths.manifest)) throw new Error("Existing task artifacts were preserved; use show or choose another task id");
    selfCli(cwd, ["feature", "init", slug, "--goal", supplied.goal, "--output-dir", OUTPUT,
      ...supplied.criteria.flatMap((item) => ["--acceptance", item]), "--json"]);
    writeTaskIntake(cwd, path.relative(cwd, path.join(paths.root, "task-intake.json")).replace(/\\/g, "/"), supplied);
    const plan = { goal: supplied.goal, mode: "standard", steps: [{ id: "work", title: supplied.goal,
      query: supplied.goal, acceptance: supplied.criteria.join("\n"), files: supplied.files,
      tasks: [{ id: "implement", title: supplied.goal, query: supplied.goal, acceptance: supplied.criteria.join("\n"),
        files: supplied.files, verification: supplied.verification, ...(options.contextRequest ? { contextRequest: options.contextRequest } : {}) }] }] };
    // Existing Feature task generation consumes this existing workflow-plan artifact.
    const planFile = resolveWorkflowContinuityFile({ cwd, path: path.relative(cwd, paths.workflowPlan).replace(/\\/g, "/") });
    fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    selfCli(cwd, ["feature", "tasks", slug, "--output-dir", OUTPUT, "--json"]);
    selfCli(cwd, ["workflow", "start", "--goal", supplied.goal, "--id", `feature-${slug}`,
      "--plan-file", path.relative(cwd, paths.workflowPlan), "--skip-agent-context", "--json"]);
    return buildTaskJourneyCard({ cwd, slug });
  });
}
function boundState(cwd: string, slug?: string): { state: ManagedWorkflowState; slug: string } {
  const state = stateAt(cwd);
  if (!state) throw new Error("No existing workflow is bound to this task");
  const selected = idFor({ slug }, state);
  if (state.workflowId !== `feature-${selected}`) throw new Error("The selected task is not the current workflow; no other task was modified");
  return { state, slug: selected };
}
function scopeContains(file: string, declared: string): boolean {
  const scope = declared.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  if (!scope || scope === ".") return true;
  if (!scope.includes("*") && !scope.includes("?")) return file === scope || file.startsWith(`${scope}/`);
  // Conservative path-segment glob semantics; unsupported bracket/brace patterns fail closed.
  if ([...scope].some((char) => "[]{}".includes(char))) return false;
  const parts = scope.split("/");
  const expression = parts.map((part, index) => part === "**" ? (index === parts.length - 1 ? ".*" : "(?:[^/]+/)*")
    : `${part.split("").map((char) => char === "*" ? "[^/]*" : char === "?" ? "[^/]" : char.replace(/[.+^$()|\\]/g, "\\$&")).join("")}${index < parts.length - 1 ? "/" : ""}`).join("");
  return new RegExp(`^${expression}$`).test(file);
}
function canRecordScopedOutcome(card: TaskJourneyCard, task: ManagedWorkflowTask, options: TaskJourneyOptions): boolean {
  const continuity = card.continuity, snapshot = continuity?.checkpoint;
  if (options.action !== "work" || !options.summary || !options.outcome || task.status !== "in_progress" ||
    !continuity || !snapshot || continuity.reasons.length || continuity.currentRepository.errors.length ||
    card.blockers.some((item) => !item.startsWith("Revalidation required:"))) return false;
  const before = snapshot.repository, after = continuity.currentRepository;
  for (const key of ["head", "tree", "branch", "roots", "indexHash"] as const)
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) return false;
  const sourceRefs = new Set(snapshot.artifacts.filter((item) => item.kind === "task_file").map((item) => item.path));
  if (continuity.changes.some((item) => item !== "dirty file content" &&
    !(item.startsWith("Changed or unavailable snapshot file: ") && sourceRefs.has(item.slice("Changed or unavailable snapshot file: ".length))))) return false;
  const oldFiles = new Map(before.dirty.map((item) => [item.path, JSON.stringify([item.status, item.fingerprint])]));
  const newFiles = new Map(after.dirty.map((item) => [item.path, JSON.stringify([item.status, item.fingerprint])]));
  const changed = [...new Set([...oldFiles.keys(), ...newFiles.keys()])].filter((file) => oldFiles.get(file) !== newFiles.get(file));
  return changed.length > 0 && changed.every((file) => (task.files ?? []).some((scope) => scopeContains(file, scope)));
}
export async function executeTaskJourney(options: TaskJourneyOptions): Promise<TaskJourneyCard> {
  const cwd = fs.realpathSync(options.cwd ?? process.cwd());
  if (options.action === "start") return start(options, cwd);
  let card = buildTaskJourneyCard(options);
  if (options.action === "show") return card;
  if (options.action === "resume") {
    const state = stateAt(cwd), selected = taskOf(state);
    if (state?.workflowId === card.task.workflowId && selected?.task.contextRequest && selected.task.contextReceipt) {
      try {
        card.preparedContext = { context: readTaskContext(selected.task.contextReceipt, {
          workflowId: state.workflowId, phaseId: selected.phaseId, taskId: selected.task.id, attempt: selected.task.attempt,
        }, selected.task.contextRequest, cwd) };
        card.runtimeDelivery = { status: "caller_output_observed", semanticUseVerified: false };
      } catch {
        card.status = "blocked"; card.blockers.push("Saved task-local context could not be reloaded from its exact receipt");
      }
    }
    return card;
  }
  if (options.action === "verify") {
    const plan = buildVerificationPlan({ cwd, task: card.task.goal, changedFiles: card.task.files, skipImpact: true });
    card.verificationPlan = plan;
    card.nextAction = action(card.task.id, "decide", "Review the evidence and remaining unknowns; integration is not performed");
    return card;
  }
  if (options.action === "decide") {
    if (!options.refreshDossier) {
      card.status = card.blockers.length ? "blocked" : "review_required";
      card.nextAction = action(card.task.id, "show", "Inspect the evidence for human review or explicitly bind an existing Controller dossier");
      return card;
    }
    if (!options.orchestratorBin || !path.isAbsolute(options.orchestratorBin) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.controllerId ?? "") ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.candidateId ?? ""))
      throw new Error("A fresh dossier requires an explicit existing Controller/candidate and absolute public Orchestrator executable");
    const executable = fs.realpathSync(options.orchestratorBin);
    if (path.basename(executable) !== "snipara-orchestrator" || !fs.statSync(executable).isFile()) throw new Error("Expected the public Orchestrator executable");
    const result = spawnSync(executable, ["controller", "candidate", "dossier", "--workspace", cwd,
      "--controller-id", options.controllerId!, "--candidate-id", options.candidateId!, "--format", "json"],
    { cwd, encoding: "utf8", shell: false, timeout: 30000, maxBuffer: MAX_BYTES, stdio: ["ignore", "pipe", "pipe"] });
    if (result.error || result.status !== 0) throw new Error("The explicitly bound Controller dossier could not be freshly observed");
    const data: unknown = JSON.parse(result.stdout);
    const dossier = record(data) && record(data.dossier) ? data.dossier : data;
    if (!record(dossier) || dossier.schemaVersion !== "snipara.evidence_dossier.v1" || !record(dossier.subject) ||
      dossier.subject.controllerId !== options.controllerId || dossier.subject.candidateId !== options.candidateId ||
      !record(dossier.recommendation) || !["integrate", "correct", "block"].includes(String(dossier.recommendation.action)))
      throw new Error("Fresh dossier identity or recommendation differs from the selected Controller candidate");
    if (!record(dossier.contract) || dossier.contract.objective !== card.task.goal)
      throw new Error("The Controller dossier objective is not bound to this selected task");
    if (!record(dossier.subject.repository) || typeof dossier.subject.repository.path !== "string" ||
      !path.isAbsolute(dossier.subject.repository.path) || fs.realpathSync(dossier.subject.repository.path) !== cwd)
      throw new Error("The Controller dossier repository is not the selected workspace");
    const contractCriteria = record(dossier.contract.featureAcceptance) && Array.isArray(dossier.contract.featureAcceptance.criteria)
      ? dossier.contract.featureAcceptance.criteria : [];
    const taskCriteria = Array.isArray(dossier.contract.scope) ? dossier.contract.scope.flatMap((item: unknown) =>
      record(item) && Array.isArray(item.acceptance) ? item.acceptance : []) : [];
    if (card.task.criteria.some((item) => ![...contractCriteria, ...taskCriteria].includes(item)))
      throw new Error("The Controller dossier does not bind the selected task's acceptance criteria");
    const dossierFiles = Array.isArray(dossier.contract.scope) ? dossier.contract.scope.flatMap((item: unknown) =>
      record(item) && Array.isArray(item.files) ? item.files : []) : [];
    if (JSON.stringify([...new Set(dossierFiles)].sort()) !== JSON.stringify([...new Set(card.task.files)].sort()))
      throw new Error("The Controller dossier scope differs from the selected task's declared scope");
    if (dossier.recommendation.action === "integrate" && (!Array.isArray(dossier.gates) || !dossier.gates.length ||
      dossier.gates.some((item: unknown) => !record(item) || (item.required === true && item.status !== "passed"))))
      throw new Error("Integration recommendation is missing its observed mandatory gate results");
    if (dossier.recommendation.action === "integrate") {
      const after = record(dossier.after) ? dossier.after : {};
      const commands = Array.isArray(dossier.commands) ? dossier.commands : [];
      for (const expected of card.task.verification) {
        const required = canonicalBridgeProof(expected);
        const observed = commands.some((item: unknown) => {
          if (!record(item) || typeof item.command !== "string" || item.status !== "passed" || item.passed !== true ||
            item.exitCode !== 0 || item.authority !== "host_runner_observed" || typeof item.evidenceRef !== "string" ||
            !item.evidenceRef || !record(item.cwdIdentity) || !/^[a-f0-9]{40}$/.test(String(after.candidateCommitSha)) ||
            !/^[a-f0-9]{40}$/.test(String(after.candidateTreeSha)) ||
            item.cwdIdentity.candidateCommitSha !== after.candidateCommitSha || item.cwdIdentity.candidateTreeSha !== after.candidateTreeSha)
            return false;
          try { return canonicalBridgeProof(item.command) === required; } catch { return false; }
        });
        if (!observed) throw new Error("Selected verification command has no passed host-observed result bound to the exact candidate");
      }
    }
    // Controller already bounds/redacts its dossier. Preserve its content/hash relationship.
    card.dossier = dossier;
    card.recommendation = { action: dossier.recommendation.action as "integrate" | "correct" | "block", source: "fresh_explicit_controller_dossier", fresh: true };
    card.status = card.blockers.length ? "blocked" : card.recommendation.action === "integrate" ? "integration_possible"
      : card.recommendation.action === "correct" ? "correction_required" : "blocked";
    card.steps[3] = { ...card.steps[3], status: card.recommendation.action, detail: "Fresh Controller recommendation only; no integration authority granted" };
    card.steps[2] = { ...card.steps[2], status: "controller_receipts_observed",
      detail: "Existing Controller gates were reobserved; individual criterion coverage remains as declared in the dossier" };
    card.capabilities = card.capabilities.map((item) => item.id === "orchestrator" ? {
      id: item.id, status: "read_only_call_observed", detail: "The explicit public Controller dossier command completed; native dispatch authorization remains separate",
      observedAt: card.generatedAt,
    } : item);
    card.nextAction = action(card.task.id, "show", "Inspect the dossier; use the existing separately authorized Controller integration procedure");
    return card;
  }
  return locked(cwd, () => {
    const bound = boundState(cwd, options.slug), selected = taskOf(bound.state);
    card = buildTaskJourneyCard({ cwd, slug: bound.slug });
    const scopedOutcome = selected && canRecordScopedOutcome(card, selected.task, options);
    if ((!scopedOutcome && (card.continuity?.status !== "exact_snapshot" || card.status === "blocked")) || card.status === "needs_clarification") {
      card.status = "blocked";
      if (card.nextAction.kind !== "show") card.nextAction = action(bound.slug, "resume", "Resolve the snapshot or contract mismatch before changing workflow state");
      return card;
    }
    if (!selected) throw new Error("No task exists in the selected workflow");
    if (options.action === "work") {
      if (options.summary) {
        if (!options.outcome) throw new Error("Recording work requires an explicit declared outcome");
        selfCli(cwd, ["workflow", "task-commit", selected.phaseId, selected.task.id, "--summary", options.summary,
          "--outcome", options.outcome, ...(options.why ? ["--why", options.why] : []),
          ...(options.evidence ?? []).flatMap((item) => ["--evidence", item]), "--json"]);
      } else if (selected.task.status === "in_progress") return card;
      else {
        if (selected.task.status === "blocked") {
          if (!options.why) throw new Error("Retry requires an explicit reason describing what failed and what changes");
          selfCli(cwd, ["workflow", "task-retry", selected.phaseId, selected.task.id, "--reason", options.why, "--json"]);
        }
        const prepared = selfCli(cwd, ["workflow", "task-start", selected.phaseId, selected.task.id,
          "--skip-agent-context", "--json"], !!selected.task.contextRequest);
        card = buildTaskJourneyCard({ cwd, slug: bound.slug });
        card.preparedContext = { envelope: safeJson(prepared.context_envelope), context: prepared.task_context };
        card.runtimeDelivery = { status: "caller_output_observed", semanticUseVerified: false };
        return card;
      }
    } else if (options.action === "close") {
      if (!options.summary || !options.outcome) throw new Error("Closing requires an explicit summary and declared outcome");
      if (options.outcome === "completed" && bound.state.phases.some((phase) => (phase.tasks ?? []).some((task) => !["completed", "skipped"].includes(task.status))))
        throw new Error("Record each task outcome before declaring the workflow closed as completed");
      for (const phase of bound.state.phases.filter((item) => !["completed", "skipped"].includes(item.status)))
        selfCli(cwd, ["workflow", "phase-commit", phase.id, "--summary", options.summary, "--outcome", options.outcome,
          ...(options.why ? ["--why", options.why] : []), ...(options.evidence ?? []).flatMap((item) => ["--evidence", item]), "--json"]);
      selfCli(cwd, ["final-commit", "--summary", options.summary, "--outcome", options.outcome,
        ...(options.why ? ["--why", options.why] : []), ...(options.evidence ?? []).flatMap((item) => ["--evidence", item]), "--json"]);
    }
    return buildTaskJourneyCard({ cwd, slug: bound.slug });
  });
}
export function formatTaskJourneyCard(card: TaskJourneyCard): string {
  return ["Snipara — tâche", `${card.task.goal || "Objectif à préciser"} [${card.status}]`,
    ...card.steps.map((step) => `${step.label}: ${step.status} — ${step.detail}`),
    ...card.blockers.map((item) => `Blocage: ${item}`),
    `Décision: ${card.recommendation.action} (${card.recommendation.source})`,
    ...card.evidence.map((item) => `Preuve: ${item.kind} — ${item.path ?? item.status}${item.sha256 ? ` (${item.sha256})` : ""}`),
    `Prochain geste: ${card.nextAction.argv.map((item) => JSON.stringify(item)).join(" ")}`,
    `Résultat attendu: ${card.nextAction.expectedResult}`,
    "Aucune exécution d’agent, intégration, publication ou mise en production n’est autorisée par cette carte.",
    ...card.notices].join("\n");
}
