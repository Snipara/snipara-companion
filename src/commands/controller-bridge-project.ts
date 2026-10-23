/** Source-bound reporting is evidence inspection, never execution or approval. */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { readControllerProgress, type ControllerProgress } from "./controller-progress";
import {
  bridgeCanonical,
  bridgeHash,
  bridgeLocalPath,
  readBridgeBytes,
  readBridgeSource,
} from "./controller-bridge-io";
import {
  bridgeId,
  bridgeRecord,
  canonicalBridgeProof,
  CONTROLLER_BRIDGE_VERSION,
  exportControllerBridge,
} from "./controller-bridge";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!bridgeRecord(value)) throw new Error("Invalid source-bound bridge artifact");
  return value;
}
function source(cwd: string, file: unknown): { value: ObjectValue; hash: string } {
  if (typeof file !== "string") throw new Error("Invalid bound source path");
  const result = readBridgeSource(cwd, file);
  return { value: object(result.value), hash: result.hash };
}
function same(left: unknown, right: unknown, label: string): void {
  if (bridgeCanonical(left) !== bridgeCanonical(right)) throw new Error(`Bridge ${label} mismatch`);
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid bound source array");
  return value;
}
function list(value: unknown): string[] {
  const result = array(value);
  if (result.some((entry) => typeof entry !== "string"))
    throw new Error("Invalid bound source string array");
  return result as string[];
}
function inScope(file: string, scope: string): boolean {
  if (scope.endsWith("/**")) return file.startsWith(scope.slice(0, -2));
  const pattern = scope
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${pattern}$`).test(file);
}
export interface ControllerBridgeProjectOptions {
  bridgeFile: string;
  controllerFile: string;
  dir?: string;
  json?: boolean;
}
export interface ControllerBridgeProjection {
  schemaVersion: "snipara.companion_controller_bridge_projection.v1";
  bridgeId: string;
  controllerProgress: ControllerProgress;
  sourceHashes: Array<{ kind: string; id: string; sha256: string }>;
  tasks: Array<{
    workPackageId: string;
    taskId: string;
    reportedStatus: string;
    nativeProofSourceVerified: boolean;
    proposalId: string | null;
  }>;
  candidate: null | {
    candidateId: string;
    treeSha: string;
    combinedPatchSha256: string;
    reportedReviewVerdict: string | null;
  };
  completionEvidence: {
    taskProofs: "verified" | "pending";
    objectiveAcceptance: "not_checked";
    reportedObjectiveStatus: string;
    authority: "source_bound_local_artifacts";
  };
  authority: "source_bound_local_artifacts";
  identityAuthenticated: false;
  executionAllowed: false;
  taskClosureAllowed: false;
}
export function projectControllerBridge(
  options: ControllerBridgeProjectOptions
): ControllerBridgeProjection {
  const cwd = fs.realpathSync(options.dir ?? process.cwd());
  const artifactRead = source(cwd, options.bridgeFile);
  const artifact = artifactRead.value;
  if (artifact.schemaVersion !== CONTROLLER_BRIDGE_VERSION || artifact.executionAllowed !== false)
    throw new Error("Unsupported bridge artifact schema or authority");
  if (artifact.taskContextVersion != null && artifact.taskContextVersion !== "source-context-v1")
    throw new Error("Unsupported task context version");
  const hasRuntimeContext = "runtimeSourceContextVersion" in artifact || "sourceRuntimeContext" in artifact;
  let runtimeRef: ObjectValue | undefined;
  let runtimeSource: ReturnType<typeof source> | undefined;
  if (hasRuntimeContext) {
    if (artifact.runtimeSourceContextVersion !== "runtime-source-context-v1")
      throw new Error("Unsupported runtime source context version");
    runtimeRef = object(artifact.sourceRuntimeContext);
    runtimeSource = source(cwd, runtimeRef.path);
    same(runtimeSource.hash, runtimeRef.sha256, "runtime context source hash");
  }
  const leadRef = object(artifact.sourceLeadPlan);
  const policyRef = object(artifact.sourcePolicy);
  const workflowRef = object(artifact.workflowPlan);
  const reconstructed = exportControllerBridge(
    {
      leadPlanFile: String(leadRef.path),
      policyFile: String(policyRef.path),
      ...(runtimeRef ? { taskContextFile: String(runtimeRef.path) } : {}),
      reviewerId: bridgeId(object(artifact.review).reviewedBy),
      outDir: path.relative(
        cwd,
        path.dirname(path.dirname(bridgeLocalPath(cwd, options.bridgeFile)))
      ),
      dir: cwd,
    },
    false,
    artifact.taskContextVersion === "source-context-v1"
  );
  same(artifact, reconstructed, "reviewed source reconstruction");
  const lead = source(cwd, leadRef.path);
  const policy = source(cwd, policyRef.path);
  const workflow = source(cwd, workflowRef.path);
  same(lead.hash, leadRef.sha256, "Lead Plan source hash");
  same(policy.hash, policyRef.sha256, "policy source hash");
  same(workflow.hash, workflowRef.sha256, "workflow source hash");
  const identity = {
    ...(artifact.taskContextVersion ? { taskContextVersion: artifact.taskContextVersion } : {}),
    ...(runtimeRef ? {
      runtimeSourceContextVersion: artifact.runtimeSourceContextVersion,
      sourceRuntimeContext: runtimeRef,
    } : {}),
    sourceLeadPlan: leadRef,
    sourcePolicy: policyRef,
    controllerId: artifact.controllerId,
    baseSha: artifact.baseSha,
    mapping: artifact.mapping,
    policyHandshake: artifact.policyHandshake,
    review: artifact.review,
  };
  same(artifact.artifactId, `bridge-${bridgeHash(bridgeCanonical(identity))}`, "artifact identity");
  const controllerId = bridgeId(artifact.controllerId);
  const root = `.snipara/orchestrator/project-controllers/${controllerId}`;
  if (bridgeLocalPath(cwd, options.controllerFile) !== bridgeLocalPath(cwd, `${root}/state.json`))
    throw new Error("Controller source must be its canonical state artifact");
  const progress = readControllerProgress(options.controllerFile, cwd);
  const stateRead = source(cwd, options.controllerFile);
  const state = stateRead.value;
  same(stateRead.hash, progress.sourceHash, "state read consistency");
  same(state.controllerId, controllerId, "controller identity");
  same(state.baseSha, artifact.baseSha, "controller base SHA");
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1000,
  }).trim();
  same(head, artifact.baseSha, "current HEAD");
  if (
    typeof state.sourcePlan !== "string" ||
    bridgeLocalPath(cwd, state.sourcePlan) !== bridgeLocalPath(cwd, String(workflowRef.path))
  )
    throw new Error("Controller plan is not the bound workflow");
  const handshake = object(artifact.policyHandshake);
  const controllerPolicy = object(state.policy);
  same(controllerPolicy.requiredProofs, handshake.requiredProofs, "policy proof floor");
  same(controllerPolicy.requireIndependentReview, true, "review policy");
  if ("boundedProofRepairs" in handshake)
    same(
      controllerPolicy.boundedProofRepairs,
      handshake.boundedProofRepairs,
      "bounded repair policy"
    );
  same(
    controllerPolicy.independentReviewerIds,
    handshake.independentReviewerIds,
    "reviewer allowlist"
  );
  same(handshake.executionGranted, false, "execution grant");
  same(handshake.runtimeProfileBindingRequired, true, "profile requirement");
  const workflowBridge = object(workflow.value.controllerBridge);
  same(workflowBridge.artifactId, artifact.artifactId, "workflow bridge identity");
  same(workflowBridge.policyHandshake, handshake, "workflow policy handshake");
  const planTasks = new Map(
    array(workflow.value.steps).map((value) => {
      const task = object(value);
      return [bridgeId(task.id), task] as const;
    })
  );
  const mappings = array(artifact.mapping).map(object);
  const stateTasks = object(state.tasks);
  same(Object.keys(stateTasks).sort(), [...planTasks.keys()].sort(), "task set");
  const sourceHashes = [
    { kind: "bridge", id: String(artifact.artifactId), sha256: artifactRead.hash },
    { kind: "lead_plan", id: String(leadRef.path), sha256: lead.hash },
    { kind: "policy", id: String(policyRef.path), sha256: policy.hash },
    { kind: "workflow_plan", id: String(workflowRef.path), sha256: workflow.hash },
    { kind: "controller", id: controllerId, sha256: stateRead.hash },
  ];
  if (runtimeRef && runtimeSource)
    sourceHashes.push({ kind: "runtime_context", id: String(runtimeRef.path), sha256: runtimeSource.hash });
  const acceptedProposals = new Map<
    string,
    { patchHash: string; producerId: string; attempt: number }
  >();
  const tasks = mappings.map((mapping) => {
    const taskId = bridgeId(mapping.taskId);
    const expected = planTasks.get(taskId);
    if (!expected) throw new Error("Bridge maps an unknown Controller task");
    const actual = object(stateTasks[taskId]);
    for (const key of [
      "query",
      "files",
      "verify",
      "acceptance",
      "dependsOn",
      "workerRole",
      "capabilities",
      "risk",
      "maxAttempts",
      "runtimeProfileId",
      "effectScope",
    ])
      same(actual[key], expected[key], `task ${key}`);
    // Python serializes the optional targetAttempt as null; the bridge omits it.
    if (expected.sourceContext != null || actual.sourceContext != null) {
      const expectedContext = object(expected.sourceContext);
      const actualContext = { ...object(actual.sourceContext) };
      if (expectedContext.targetAttempt === undefined && actualContext.targetAttempt === null)
        delete actualContext.targetAttempt;
      same(actualContext, expectedContext, "task sourceContext");
    }
    same(expected.runtimeProfileId, mapping.runtimeProfileId, "runtime profile binding");
    const reportedStatus = String(actual.status);
    let proposalId: string | null = null;
    let nativeProofSourceVerified = false;
    if (reportedStatus === "completed") {
      proposalId = bridgeId(actual.integrationProposalId);
      const proposalRead = source(cwd, `${root}/proposals/${proposalId}.json`);
      const proposal = proposalRead.value;
      if (proposal.schemaVersion !== "snipara.integration_proposal.v1")
        throw new Error("Unsupported proposal source schema");
      same(proposal.controllerId, controllerId, "proposal controller");
      same(proposal.taskId, taskId, "proposal task");
      same(proposal.proposalId, proposalId, "proposal identity");
      same(proposal.runtimeProfileId, mapping.runtimeProfileId, "proposal runtime profile");
      if (!Number.isSafeInteger(proposal.attempt) || Number(proposal.attempt) < 1)
        throw new Error("Invalid source proposal attempt");
      const expectedNativePath = `${root}/dispatches/${taskId}-attempt-${proposal.attempt}.json`;
      if (
        typeof proposal.sourceReceipt !== "string" ||
        bridgeLocalPath(cwd, proposal.sourceReceipt) !== bridgeLocalPath(cwd, expectedNativePath)
      )
        throw new Error("Proposal receipt source is not attempt-bound");
      const nativeRead = source(cwd, expectedNativePath);
      const native = nativeRead.value;
      if (
        native.schemaVersion !== "snipara.host_native_run.v1" ||
        native.state !== "completed" ||
        typeof native.runId !== "string" ||
        !/^host-run-[0-9a-f]{16}$/.test(native.runId)
      )
        throw new Error("Invalid native proof source");
      same(
        native.idempotencyKeyHash,
        bridgeHash(`${controllerId}:${taskId}:${proposal.attempt}`),
        "native task attempt identity"
      );
      if (typeof native.providerSessionId !== "string" || !native.providerSessionId.trim())
        throw new Error("Native proof source requires a provider session identity");
      const evidence = object(native.evidence);
      const workPackage = object(native.workPackage);
      const originalTask =
        "Controller-owned isolated worktree. Do not commit, reset, merge, push, deploy, publish, or change branches. " +
        String(expected.query);
      if (
        typeof workPackage.task !== "string" ||
        (workPackage.task !== originalTask &&
          !workPackage.task.startsWith(originalTask + "\nUntrusted verified "))
      )
        throw new Error("Native proof task differs from the bound source query");
      same(workPackage.writeScope, expected.files, "native dispatched scope");
      same(workPackage.acceptanceCriteria, expected.acceptance, "native acceptance contract");
      same(evidence.proofPassed, true, "native proof result");
      same(evidence.scopeViolations, [], "native scope");
      same(evidence.proofScopeViolations, [], "proof scope");
      const required = [
        ...new Set(
          [...list(handshake.requiredProofs), ...list(expected.verify)].map(canonicalBridgeProof)
        ),
      ];
      same(
        list(workPackage.proofRequired).map(canonicalBridgeProof),
        required,
        "native dispatched proof floor"
      );
      const proofResults = array(evidence.proofResults).map(object);
      if (proofResults.length !== required.length)
        throw new Error("Native proof list does not match the immutable floor");
      proofResults.forEach((result, index) => {
        same(result.index, index, "proof index");
        same(result.command, required[index], "proof command");
        same(result.status, "passed", "proof status");
        same(result.passed, true, "proof pass");
        same(result.exitCode, 0, "proof exit");
      });
      const changedFiles = list(evidence.changedFiles);
      if (
        changedFiles.some(
          (file) =>
            file.startsWith("/") ||
            file.includes("\\") ||
            file.split("/").includes("..") ||
            !list(expected.files).some((scope) => inScope(file, scope))
        )
      )
        throw new Error("Native changed file is outside the bound scope");
      same([...changedFiles].sort(), list(proposal.changedFiles).sort(), "proposal changed files");
      const expectedPatchPath = `${root}/proposals/${proposalId}.patch`;
      if (
        typeof proposal.patchPath !== "string" ||
        bridgeLocalPath(cwd, proposal.patchPath) !== bridgeLocalPath(cwd, expectedPatchPath)
      )
        throw new Error("Proposal patch is not identity-bound");
      const patchHash = bridgeHash(readBridgeBytes(cwd, expectedPatchPath, 20_000_000));
      acceptedProposals.set(proposalId, {
        patchHash,
        producerId: bridgeId(proposal.workerId),
        attempt: Number(proposal.attempt),
      });
      sourceHashes.push(
        { kind: "native_receipt", id: native.runId, sha256: nativeRead.hash },
        { kind: "proposal", id: proposalId, sha256: proposalRead.hash },
        { kind: "proposal_patch", id: proposalId, sha256: patchHash }
      );
      nativeProofSourceVerified = true;
    }
    return {
      workPackageId: String(mapping.workPackageId),
      taskId,
      reportedStatus,
      nativeProofSourceVerified,
      proposalId,
    };
  });
  let candidate: ControllerBridgeProjection["candidate"] = null;
  if (state.latestIntegrationCandidateId != null) {
    const candidateId = bridgeId(state.latestIntegrationCandidateId);
    const candidateRead = source(cwd, `${root}/candidates/${candidateId}.json`);
    const value = candidateRead.value;
    if (value.schemaVersion !== "snipara.integration_candidate.v1" || value.status !== "composed")
      throw new Error("Unsupported candidate composition source");
    same(value.candidateId, candidateId, "candidate identity");
    same(value.controllerId, controllerId, "candidate controller");
    same(value.baseSha, artifact.baseSha, "candidate base SHA");
    if (
      typeof value.candidateTreeSha !== "string" ||
      !/^[a-f0-9]{40}$/.test(value.candidateTreeSha)
    )
      throw new Error("Invalid candidate tree SHA");
    const objectType = execFileSync("git", ["cat-file", "-t", value.candidateTreeSha], {
      cwd,
      encoding: "utf8",
      maxBuffer: 1000,
    }).trim();
    same(objectType, "tree", "candidate Git tree object");
    if (value.candidateCommitSha != null) {
      if (
        typeof value.candidateCommitSha !== "string" ||
        !/^[a-f0-9]{40}$/.test(value.candidateCommitSha)
      )
        throw new Error("Invalid candidate commit SHA");
      const commitTree = execFileSync("git", ["rev-parse", `${value.candidateCommitSha}^{tree}`], {
        cwd,
        encoding: "utf8",
        maxBuffer: 1000,
      }).trim();
      same(commitTree, value.candidateTreeSha, "candidate commit tree");
    }
    const patchHash = bridgeHash(
      readBridgeBytes(cwd, `${root}/candidates/${candidateId}.patch`, 20_000_000)
    );
    same(value.combinedPatchSha256, patchHash, "candidate patch hash");
    const inputs = array(value.proposals).map(object);
    same(
      inputs.map((input) => bridgeId(input.proposalId)).sort(),
      [...acceptedProposals.keys()].sort(),
      "candidate proposal set"
    );
    for (const input of inputs) {
      const accepted = acceptedProposals.get(bridgeId(input.proposalId))!;
      same(input.patchSha256, accepted.patchHash, "candidate input patch hash");
      same(input.producerId, accepted.producerId, "immutable producer");
      same(input.producerAttempt, accepted.attempt, "immutable attempt");
    }
    sourceHashes.push(
      { kind: "candidate", id: candidateId, sha256: candidateRead.hash },
      { kind: "candidate_patch", id: candidateId, sha256: patchHash }
    );
    candidate = {
      candidateId,
      treeSha: value.candidateTreeSha,
      combinedPatchSha256: patchHash,
      reportedReviewVerdict: null,
    };
    const indexFile = `${root}/candidate-reviews/index.json`;
    if (fs.existsSync(bridgeLocalPath(cwd, indexFile))) {
      const index = source(cwd, indexFile);
      if (list(index.value.receiptIds).length > 1024)
        throw new Error("Review history exceeds inspection bounds");
      for (const id of list(index.value.receiptIds)) {
        const reviewRead = source(cwd, `${root}/candidate-reviews/receipts/${bridgeId(id)}.json`);
        const review = reviewRead.value;
        if (review.schemaVersion !== "snipara.candidate_review.v1")
          throw new Error("Unsupported review source schema");
        if (review.candidateId !== candidateId) continue;
        same(review.controllerId, controllerId, "review controller");
        same(review.receiptId, id, "review identity");
        same(review.candidateTreeSha, candidate.treeSha, "review tree");
        same(review.combinedPatchSha256, patchHash, "review patch");
        const reviewer = bridgeId(review.reviewerId);
        if (
          !list(handshake.independentReviewerIds).includes(reviewer) ||
          [...acceptedProposals.values()].some((item) => item.producerId === reviewer)
        )
          throw new Error("Review identity conflicts with policy or producer");
        if (
          review.authoritySource !== "operator_asserted" ||
          !["accepted", "refused"].includes(String(review.verdict))
        )
          throw new Error("Unsupported review authority or verdict");
        const expires = Date.parse(String(review.expiresAt));
        const reviewed = Date.parse(String(review.reviewedAt));
        if (
          !Number.isFinite(expires) ||
          !Number.isFinite(reviewed) ||
          expires <= Date.now() ||
          reviewed > Date.now() ||
          expires <= reviewed ||
          expires - reviewed > 30 * 86_400_000
        )
          throw new Error("Review source is expired or future-dated");
        candidate.reportedReviewVerdict = String(review.verdict);
        sourceHashes.push({ kind: "operator_asserted_review", id, sha256: reviewRead.hash });
      }
    }
  }
  return {
    schemaVersion: "snipara.companion_controller_bridge_projection.v1",
    bridgeId: String(artifact.artifactId),
    controllerProgress: progress,
    sourceHashes,
    tasks,
    candidate,
    completionEvidence: {
      taskProofs:
        tasks.length > 0 && tasks.every((task) => task.nativeProofSourceVerified)
          ? "verified"
          : "pending",
      objectiveAcceptance: "not_checked",
      reportedObjectiveStatus: progress.reportedStatus,
      authority: "source_bound_local_artifacts",
    },
    authority: "source_bound_local_artifacts",
    identityAuthenticated: false,
    executionAllowed: false,
    taskClosureAllowed: false,
  };
}
export function controllerBridgeProjectCommand(options: ControllerBridgeProjectOptions): void {
  console.log(JSON.stringify(projectControllerBridge(options), null, 2));
}
