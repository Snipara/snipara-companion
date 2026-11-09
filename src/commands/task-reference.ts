/** Read-only identity and progression over existing task owners; never a task store. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { taskIntakeHash, validateTaskIntake, type TaskIntake } from "./task-intake";

type OwnerKind = "companion_workflow" | "orchestrator_controller";
type VerificationKind = "none" | "static" | "runtime";
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export interface TaskLifecycleReference {
  ownerKind: OwnerKind;
  ownerId: string;
  statePath: string;
  revisionSha256: string;
}
export interface TaskReferenceV1 {
  schemaVersion: "snipara.task_reference.v1";
  taskId: string;
  intake: { path: string; contentSha256: string };
  workspace: { root: string; repositoryId: string; worktreeId: string };
  projectBinding: null;
  lifecycle: TaskLifecycleReference;
  verificationContractSha256: string;
  identitySha256: string;
  authority: { kind: "read_only_projection"; executionGranted: false; integrationGranted: false };
  referenceSha256: string;
}
export interface TaskReferenceInput {
  intake: TaskIntake;
  intakePath: string;
  workspaceRoot: string;
  gitCommonDir: string;
  lifecycle: TaskLifecycleReference;
  effectiveVerification: string[];
}
function text(value: string, limit = 4096): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > limit ||
    [...value].some((char) => {
      const code = char.codePointAt(0)!;
      return code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff);
    })) throw new Error("Invalid task reference text");
  return value;
}
function relative(value: string): string {
  text(value, 2048);
  if (path.posix.isAbsolute(value) || /^[a-z]:/i.test(value) || value.includes("\\") ||
    value.split("/").some((part) => !part || [".", "..", ".git"].includes(part)))
    throw new Error("Task reference artifact must be workspace-relative");
  return value;
}
function absolute(value: string): string {
  text(value);
  if (!path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || value.includes("\\") ||
    (value !== "/" && value.endsWith("/")))
    throw new Error("Task reference needs a canonical POSIX workspace");
  return value;
}
/** Hashes establish equality of observations, not authenticity or execution authority. */
export function buildTaskReference(input: TaskReferenceInput): TaskReferenceV1 {
  const intake = validateTaskIntake(input.intake), lifecycle = input.lifecycle;
  if (!ID.test(intake.id) || !ID.test(lifecycle.ownerId) || !SHA.test(lifecycle.revisionSha256) ||
    !["companion_workflow", "orchestrator_controller"].includes(lifecycle.ownerKind))
    throw new Error("Invalid task owner or intake identity");
  if (!Array.isArray(input.effectiveVerification) || input.effectiveVerification.length > 256)
    throw new Error("Task verification contract is not bounded");
  const commands = input.effectiveVerification.map((command) => {
    if (!command.trim()) throw new Error("Task verification command is empty");
    return text(command, 4096);
  });
  const root = absolute(input.workspaceRoot), common = absolute(input.gitCommonDir);
  const workspace = { root, repositoryId: `local-git:${digest(common)}`, worktreeId: `local-worktree:${digest(root)}` };
  const identity = { taskId: intake.id, intakeSha256: intake.contentSha256,
    repositoryId: workspace.repositoryId, worktreeId: workspace.worktreeId };
  const value: Omit<TaskReferenceV1, "referenceSha256"> = {
    schemaVersion: "snipara.task_reference.v1", taskId: intake.id,
    intake: { path: relative(input.intakePath), contentSha256: intake.contentSha256 },
    workspace, projectBinding: null,
    lifecycle: { ownerKind: lifecycle.ownerKind, ownerId: lifecycle.ownerId,
      statePath: relative(lifecycle.statePath), revisionSha256: lifecycle.revisionSha256 },
    verificationContractSha256: taskIntakeHash({ criteria: intake.criteria, files: intake.files, commands }),
    identitySha256: taskIntakeHash(identity),
    authority: { kind: "read_only_projection", executionGranted: false, integrationGranted: false },
  };
  return { ...value, referenceSha256: taskIntakeHash(value) };
}
function metadata(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > 4096) throw new Error("Git metadata is not a bounded regular file");
    const bytes = Buffer.alloc(4097), length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (length > 4096) throw new Error("Git metadata exceeds its bound");
    return new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, length)).replace(/\r?\n$/, "");
  } finally { fs.closeSync(fd); }
}
/** Inspect local Git metadata only; never execute Git, infer a remote or read credentials. */
export function observeTaskWorkspace(workspaceRoot: string): { root: string; gitCommonDir: string } {
  const directory = (value: string): string => {
    const resolved = fs.realpathSync(value);
    if (!fs.statSync(resolved).isDirectory()) throw new Error("Task workspace directory unavailable");
    return absolute(resolved);
  };
  const root = directory(workspaceRoot), marker = path.join(root, ".git"), info = fs.lstatSync(marker);
  let gitDir: string;
  if (info.isDirectory()) gitDir = directory(marker);
  else if (info.isFile()) {
    const pointer = /^gitdir: ([^\r\n]+)$/.exec(metadata(marker));
    if (!pointer) throw new Error("Task Git metadata pointer is invalid");
    gitDir = directory(path.resolve(root, pointer[1]));
  } else throw new Error("Task Git metadata marker is unsupported");
  const commonFile = path.join(gitDir, "commondir");
  let commonValue: string | null = null;
  try {
    commonValue = metadata(commonFile);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (commonValue !== null && (!commonValue || /[\r\n]/.test(commonValue)))
    throw new Error("Task common Git directory is invalid");
  const gitCommonDir = commonValue === null ? gitDir : directory(path.resolve(gitDir, commonValue));
  if (!fs.lstatSync(path.join(gitDir, "HEAD")).isFile() ||
    !fs.lstatSync(path.join(gitCommonDir, "objects")).isDirectory())
    throw new Error("Task Git metadata is incomplete");
  return { root, gitCommonDir };
}

export interface ManagedProgressInput {
  referenceAvailable: boolean;
  contractComplete: boolean;
  blockingReasons: string[];
  localChangesObserved: boolean;
  workDeclared: boolean;
  recordedClosure: boolean;
  verificationKind: VerificationKind;
  freshRecommendation: "integrate" | "correct" | "block" | null;
  requiredChecksPassed: boolean;
}
export interface ManagedProgressV1 {
  schemaVersion: "snipara.task_progress.v1";
  state: "needs_clarification" | "blocked" | "working" | "ready" | "verification_required" | "review_required" | "integration_possible";
  evidence: "not_observed" | "fresh_required_checks";
  reasonCodes: string[];
  verificationKind: VerificationKind;
  recordedClosure: boolean;
  executionObserved: false;
  integrationObserved: false;
  authority: "read_only_projection";
}
/** Classifies display requirements only; never exempts a command from its execution policy. */
export function taskVerificationKind(commands: string[]): VerificationKind {
  return !commands.length ? "none" : commands.every((command) => command.trim().replace(/\s+/g, " ") === "git diff --check") ? "static" : "runtime";
}
export function projectManagedProgress(input: ManagedProgressInput): ManagedProgressV1 {
  for (const value of [input.referenceAvailable, input.contractComplete, input.localChangesObserved,
    input.workDeclared, input.recordedClosure, input.requiredChecksPassed])
    if (typeof value !== "boolean") throw new Error("Task progress flags must be booleans");
  if (!["none", "static", "runtime"].includes(input.verificationKind) ||
    ![null, "integrate", "correct", "block"].includes(input.freshRecommendation) ||
    !Array.isArray(input.blockingReasons) || input.blockingReasons.length > 256)
    throw new Error("Invalid task progress projection");
  input.blockingReasons.forEach((reason) => text(reason));
  let state: ManagedProgressV1["state"] = "ready";
  let evidence: ManagedProgressV1["evidence"] = "not_observed";
  let reasonCodes = [input.verificationKind === "none" ? "no_runtime_checks_required" :
    input.verificationKind === "static" ? "static_review_required" : "runtime_checks_required"];
  if (!input.contractComplete) { state = "needs_clarification"; reasonCodes = ["task_contract_incomplete"]; }
  else if (!input.referenceAvailable) { state = "blocked"; reasonCodes = ["task_reference_unavailable"]; }
  else if (input.blockingReasons.length) { state = "blocked"; reasonCodes = ["existing_task_blockers"]; }
  else if (input.freshRecommendation === "correct" || input.freshRecommendation === "block") {
    state = "blocked"; reasonCodes = [input.freshRecommendation === "correct" ? "fresh_candidate_requires_correction" : "fresh_candidate_blocked"];
  } else if (input.freshRecommendation === "integrate" && input.requiredChecksPassed) {
    state = "integration_possible"; evidence = "fresh_required_checks"; reasonCodes = ["fresh_required_gates_passed"];
  } else if (input.localChangesObserved) { state = "working"; reasonCodes = ["scoped_source_changes_observed"]; }
  else if (input.workDeclared || input.recordedClosure) {
    state = input.verificationKind === "runtime" ? "verification_required" : "review_required";
    reasonCodes = [input.verificationKind === "runtime" ? "runtime_verification_not_observed" :
      input.verificationKind === "static" ? "static_review_not_observed" : "no_runtime_checks_required", "recorded_outcome_unverified"];
  }
  return { schemaVersion: "snipara.task_progress.v1", state, evidence, reasonCodes,
    verificationKind: input.verificationKind, recordedClosure: input.recordedClosure,
    executionObserved: false, integrationObserved: false, authority: "read_only_projection" };
}
