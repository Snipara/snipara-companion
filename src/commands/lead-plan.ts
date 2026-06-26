/**
 * Companion Engineering Lead Plan - local, fail-closed planning artifact.
 *
 * This command gives Companion a visible engineering-lead surface without
 * turning it into an autonomous worker launcher. It can synthesize a plan from
 * local workflow inputs, or normalize an exported Project Health cockpit JSON.
 */
import * as fs from "fs";
import * as path from "path";
import {
  PROJECT_HEALTH_COCKPIT_STATUSES,
  PROJECT_INTELLIGENCE_ENGINEERING_LEAD_CONTRACT_VERSION,
  PROJECT_INTELLIGENCE_ENGINEERING_LEAD_EXECUTION_RECEIPT_STAGES,
  PROJECT_INTELLIGENCE_ENGINEERING_LEAD_EXECUTION_RECEIPT_STATUSES,
  PROJECT_INTELLIGENCE_ENGINEERING_LEAD_PLAN_VERSION,
  PROJECT_INTELLIGENCE_ENGINEERING_LEAD_POSTURES,
  PROJECT_INTELLIGENCE_ENGINEERING_LEAD_ROUTING_MODES,
  PROJECT_INTELLIGENCE_ENGINEERING_LEAD_SUPERVISION_STATUSES,
  PROJECT_INTELLIGENCE_ENGINEERING_LEAD_WORK_PACKAGE_STATUSES,
  PROJECT_INTELLIGENCE_ENGINEERING_LEAD_WORKER_ROLES,
  type ProjectHealthCockpitStatus,
  type ProjectIntelligenceEngineeringLeadEvidenceRef,
  type ProjectIntelligenceEngineeringLeadExecutionReceipt,
  type ProjectIntelligenceEngineeringLeadExecutionReceiptStage,
  type ProjectIntelligenceEngineeringLeadExecutionReceiptStatus,
  type ProjectIntelligenceEngineeringLeadPlanSummary,
  type ProjectIntelligenceEngineeringLeadPosture,
  type ProjectIntelligenceEngineeringLeadRoutingMode,
  type ProjectIntelligenceEngineeringLeadSupervision,
  type ProjectIntelligenceEngineeringLeadSupervisionStatus,
  type ProjectIntelligenceEngineeringLeadWorkPackage,
  type ProjectIntelligenceEngineeringLeadWorkPackageStatus,
  type ProjectIntelligenceEngineeringLeadWorkerContract,
  type ProjectIntelligenceEngineeringLeadWorkerRecommendation,
  type ProjectIntelligenceEngineeringLeadWorkerRole,
} from "../contracts/project-intelligence";
import {
  collectAgentReadinessLocalSignals,
  type AgentReadinessLocalSignals,
  type AgentReadinessTarget,
} from "./agent-readiness";

export const ENGINEERING_LEAD_STATUSES = PROJECT_HEALTH_COCKPIT_STATUSES;
export const ENGINEERING_LEAD_POSTURES = PROJECT_INTELLIGENCE_ENGINEERING_LEAD_POSTURES;
export const ENGINEERING_LEAD_WORKER_ROLES = PROJECT_INTELLIGENCE_ENGINEERING_LEAD_WORKER_ROLES;
export const ENGINEERING_LEAD_ROUTING_MODES = PROJECT_INTELLIGENCE_ENGINEERING_LEAD_ROUTING_MODES;
export const ENGINEERING_LEAD_WORK_PACKAGE_STATUSES =
  PROJECT_INTELLIGENCE_ENGINEERING_LEAD_WORK_PACKAGE_STATUSES;
export const ENGINEERING_LEAD_SUPERVISION_STATUSES =
  PROJECT_INTELLIGENCE_ENGINEERING_LEAD_SUPERVISION_STATUSES;
export const ENGINEERING_LEAD_EXECUTION_RECEIPT_STATUSES =
  PROJECT_INTELLIGENCE_ENGINEERING_LEAD_EXECUTION_RECEIPT_STATUSES;
export const ENGINEERING_LEAD_EXECUTION_RECEIPT_STAGES =
  PROJECT_INTELLIGENCE_ENGINEERING_LEAD_EXECUTION_RECEIPT_STAGES;

export type EngineeringLeadStatus = ProjectHealthCockpitStatus;
export type EngineeringLeadPosture = ProjectIntelligenceEngineeringLeadPosture;
export type EngineeringLeadWorkerRole = ProjectIntelligenceEngineeringLeadWorkerRole;
export type EngineeringLeadRoutingMode = ProjectIntelligenceEngineeringLeadRoutingMode;
export type EngineeringLeadWorkPackageStatus = ProjectIntelligenceEngineeringLeadWorkPackageStatus;
export type EngineeringLeadSupervisionStatus = ProjectIntelligenceEngineeringLeadSupervisionStatus;
export type EngineeringLeadExecutionReceiptStatus =
  ProjectIntelligenceEngineeringLeadExecutionReceiptStatus;
export type EngineeringLeadExecutionReceiptStage =
  ProjectIntelligenceEngineeringLeadExecutionReceiptStage;
export type EngineeringLeadEvidenceRef = ProjectIntelligenceEngineeringLeadEvidenceRef;
export type EngineeringLeadWorkerContract = ProjectIntelligenceEngineeringLeadWorkerContract;
export type EngineeringLeadWorkerRecommendation =
  ProjectIntelligenceEngineeringLeadWorkerRecommendation;
export type EngineeringLeadWorkPackage = ProjectIntelligenceEngineeringLeadWorkPackage;
export type EngineeringLeadSupervision = ProjectIntelligenceEngineeringLeadSupervision;
export type EngineeringLeadExecutionReceipt = ProjectIntelligenceEngineeringLeadExecutionReceipt;
export type EngineeringLeadPlanSummary = ProjectIntelligenceEngineeringLeadPlanSummary;

export interface CompanionEngineeringLeadReconciliation {
  status: "on_track" | "needs_review" | "needs_replan" | "blocked";
  summary: string;
  replanRequired: boolean;
  reviewRequired: boolean;
  changedSignals: string[];
  recommendedActions: string[];
  reasonCodes: string[];
}

export interface CompanionEngineeringLeadPlanReport {
  version: "snipara.companion_engineering_lead_plan.v1";
  generatedAt: string;
  source: "local_companion_inputs" | "project_health_cockpit";
  target: {
    id: AgentReadinessTarget;
    label: string;
  };
  task?: string;
  engineeringLeadPlan: EngineeringLeadPlanSummary;
  explicitInputs: {
    changedFiles: string[];
    contextRefs: string[];
    proofGates: string[];
    acceptanceCriteria: string[];
    declaredRisks: string[];
  };
  localSignals: AgentReadinessLocalSignals;
  reconciliation?: CompanionEngineeringLeadReconciliation;
  suggestedCommands: string[];
  caveats: string[];
}

export interface LeadPlanCommandOptions {
  task?: string;
  target?: string;
  changedFiles?: string[];
  context?: string[];
  proof?: string[];
  acceptance?: string[];
  risk?: string[];
  fromCockpit?: string;
  fromPlan?: string;
  reconcile?: boolean;
  dir?: string;
  output?: string;
  json?: boolean;
}

interface BuildCompanionEngineeringLeadPlanOptions extends LeadPlanCommandOptions {
  cwd?: string;
  now?: Date;
  localSignals?: AgentReadinessLocalSignals;
  cockpit?: Record<string, unknown>;
}

const TARGET_LABELS: Record<AgentReadinessTarget, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  orca: "Orca",
  windsurf: "Windsurf",
  custom: "Custom worker",
};

function normalizeTarget(target: string | undefined): AgentReadinessTarget {
  const normalized = (target ?? "codex").trim().toLowerCase();
  if (normalized === "claude" || normalized === "claude_code") {
    return "claude-code";
  }
  if (normalized in TARGET_LABELS) {
    return normalized as AgentReadinessTarget;
  }
  return "custom";
}

function normalizeTask(task: string | undefined): string | undefined {
  const normalized = task?.trim();
  return normalized ? normalized : undefined;
}

function unique(values: string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? [])
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const normalized = stringValue(item);
    return normalized ? [normalized] : [];
  });
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

interface CockpitEnumValue<T extends string> {
  value: T;
  droppedReasonCode: string | null;
}

function cockpitEnumValue<T extends string>(
  field: string,
  values: readonly T[],
  value: unknown,
  fallback: T
): CockpitEnumValue<T> {
  if (typeof value === "string" && (values as readonly string[]).includes(value)) {
    return { value: value as T, droppedReasonCode: null };
  }
  return {
    value: fallback,
    droppedReasonCode:
      typeof value === "string" && value.trim() ? `companion_dropped_unknown_${field}` : null,
  };
}

function compactReasonCodes(values: Array<string | null>): string[] {
  return values.filter((value): value is string => Boolean(value));
}

function slug(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || fallback;
}

function evidenceRef(
  id: string,
  kind: EngineeringLeadEvidenceRef["kind"],
  label: string,
  sourceRef?: string
): EngineeringLeadEvidenceRef {
  return {
    id,
    kind,
    label,
    ...(sourceRef ? { sourceRef } : {}),
    strength: 0.7,
    freshness: "local",
  };
}

function normalizeEvidence(value: unknown): EngineeringLeadEvidenceRef[] {
  return recordList(value).flatMap((item, index) => {
    const label = stringValue(item.label);
    if (!label) {
      return [];
    }
    return [
      {
        id: stringValue(item.id) ?? `evidence:${index + 1}`,
        kind:
          item.kind === "memory" ||
          item.kind === "project_decision" ||
          item.kind === "shadow_signal" ||
          item.kind === "context_graph" ||
          item.kind === "outcome_signal" ||
          item.kind === "retrieval_event" ||
          item.kind === "workflow" ||
          item.kind === "repository" ||
          item.kind === "manual"
            ? item.kind
            : "manual",
        label,
        sourceRef: stringValue(item.sourceRef) ?? null,
        strength: typeof item.strength === "number" ? item.strength : null,
        reviewStatus: stringValue(item.reviewStatus) ?? null,
        authorityStatus: stringValue(item.authorityStatus) ?? null,
        freshness: stringValue(item.freshness) ?? null,
      },
    ];
  });
}

function localSignalEvidence(
  localSignals: AgentReadinessLocalSignals
): EngineeringLeadEvidenceRef[] {
  const refs: EngineeringLeadEvidenceRef[] = [];
  if (localSignals.workflow.present) {
    refs.push(
      evidenceRef(
        "local:workflow",
        "workflow",
        `Companion workflow ${localSignals.workflow.workflowId ?? "present"} status=${
          localSignals.workflow.status ?? "unknown"
        }`,
        localSignals.workflow.path
      )
    );
  }
  if (localSignals.teamSync.present) {
    refs.push(
      evidenceRef(
        "local:team-sync",
        "workflow",
        `${localSignals.teamSync.activeWorkCount} active Team Sync item(s), ${localSignals.teamSync.handoffCount} handoff(s)`,
        localSignals.teamSync.path
      )
    );
  }
  if (localSignals.projectInstructions.present) {
    refs.push(
      evidenceRef(
        "local:project-instructions",
        "repository",
        "Project instructions are present",
        localSignals.projectInstructions.path
      )
    );
  }
  return refs;
}

function contextEvidence(contextRefs: string[]): EngineeringLeadEvidenceRef[] {
  return contextRefs.map((ref, index) =>
    evidenceRef(`context:${index + 1}`, "manual", ref, ref.includes("/") ? ref : undefined)
  );
}

function statusForScore(score: number): EngineeringLeadStatus {
  if (score >= 80) {
    return "healthy";
  }
  if (score >= 60) {
    return "watch";
  }
  return score > 0 ? "risk" : "unknown";
}

function inferWorkerRole(input: {
  changedFiles: string[];
  proofGates: string[];
  acceptanceCriteria: string[];
}): EngineeringLeadWorkerRole {
  const fileText = input.changedFiles.join(" ").toLowerCase();
  const allText = `${fileText} ${input.proofGates.join(" ")} ${input.acceptanceCriteria.join(
    " "
  )}`.toLowerCase();
  const hasOnlyDocs =
    input.changedFiles.length > 0 &&
    input.changedFiles.every((file) => file.endsWith(".md") || file.includes("/docs/"));
  if (hasOnlyDocs) {
    return "documentation_worker";
  }
  if (/\b(test|spec|vitest|jest|playwright|proof)\b/.test(allText) && /test|spec/.test(fileText)) {
    return "test_worker";
  }
  if (/\b(review|audit|approve|approval)\b/.test(allText)) {
    return "reviewer";
  }
  return "coding_worker";
}

function workerLabel(role: EngineeringLeadWorkerRole): string {
  switch (role) {
    case "main_agent":
      return "Main agent";
    case "coding_worker":
      return "Coding worker";
    case "test_worker":
      return "Test worker";
    case "reviewer":
      return "Reviewer";
    case "documentation_worker":
      return "Documentation worker";
    case "human_approver":
      return "Human approver";
  }
}

function computeScore(input: {
  task?: string;
  changedFiles: string[];
  contextRefs: string[];
  proofGates: string[];
  acceptanceCriteria: string[];
  declaredRisks: string[];
  localSignals: AgentReadinessLocalSignals;
}): number {
  const hasScope = Boolean(input.task) && input.changedFiles.length > 0;
  const hasPartialScope = Boolean(input.task) || input.changedFiles.length > 0;
  const hasContext = input.contextRefs.length > 0 || input.localSignals.projectInstructions.present;
  const hasWorkflow =
    input.localSignals.workflow.present && input.localSignals.workflow.status === "active";
  const hasTeamSync =
    input.localSignals.teamSync.present &&
    (input.localSignals.teamSync.activeWorkCount > 0 ||
      input.localSignals.teamSync.handoffCount > 0);
  const hasProof = input.proofGates.length > 0 && input.acceptanceCriteria.length > 0;
  const score =
    (hasScope ? 18 : hasPartialScope ? 9 : 0) +
    (hasContext ? 14 : 0) +
    (hasWorkflow ? 16 : input.localSignals.workflow.present ? 8 : 0) +
    (hasTeamSync ? 12 : input.localSignals.teamSync.present ? 6 : 0) +
    (hasProof ? 26 : input.proofGates.length > 0 || input.acceptanceCriteria.length > 0 ? 13 : 0) +
    10 +
    (input.declaredRisks.length > 0 ? 4 : 0);

  const capped = !hasPartialScope ? Math.min(score, 42) : !hasProof ? Math.min(score, 58) : score;
  return Math.min(100, Math.max(0, capped));
}

function postureForLocalPlan(input: {
  score: number;
  task?: string;
  changedFiles: string[];
  proofGates: string[];
  acceptanceCriteria: string[];
}): EngineeringLeadPosture {
  if (!input.task && input.changedFiles.length === 0) {
    return "lead_cold_start";
  }
  if (input.proofGates.length === 0 || input.acceptanceCriteria.length === 0) {
    return "lead_blocked";
  }
  if (input.score >= 76) {
    return "lead_ready";
  }
  return "lead_watch";
}

function routingModeForLocalPlan(input: {
  posture: EngineeringLeadPosture;
  hasActiveWorkflow: boolean;
  hasProof: boolean;
}): EngineeringLeadRoutingMode {
  if (input.posture === "lead_cold_start") {
    return "hold";
  }
  if (!input.hasProof) {
    return "needs_contract";
  }
  return input.hasActiveWorkflow ? "explicit_handoff_ready" : "main_agent_execute";
}

function brainUpdateCandidates(input: {
  task?: string;
  proofGates: string[];
  acceptanceCriteria: string[];
  declaredRisks: string[];
}): string[] {
  const candidates = [
    input.task
      ? `Record lead-plan task outcome for "${input.task}" after verification.`
      : undefined,
    input.proofGates.length > 0
      ? "Attach proof receipts to the Project Brain before closing delegated work."
      : undefined,
    input.acceptanceCriteria.length > 0
      ? "Persist accepted acceptance criteria and completion evidence after review."
      : undefined,
    input.declaredRisks.length > 0
      ? "Review declared risks before promoting candidate Brain updates."
      : undefined,
  ];
  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

function suggestedCommands(input: {
  target: AgentReadinessTarget;
  task?: string;
  changedFiles: string[];
  proofGates: string[];
  acceptanceCriteria: string[];
}): string[] {
  const task = input.task ?? "<task>";
  const files = input.changedFiles.length > 0 ? input.changedFiles.join(" ") : "<relevant-files>";
  const commands = [
    `snipara-companion lead-plan --task "${task}" --changed-files ${files} --target ${input.target} --json`,
    `snipara-companion verify --task "${task}" --changed-files ${files} --skip-impact`,
  ];
  if (input.proofGates.length > 0 && input.acceptanceCriteria.length > 0) {
    commands.push(
      `snipara-companion handoff --adapter-pack --target ${input.target} --summary "${task}" --next "execute bounded worker contract" --files ${files}`
    );
  } else {
    commands.push(
      `snipara-companion handoff --summary "${task}" --next "define proof gates before worker handoff" --attention proof --files ${files}`
    );
  }
  return commands;
}

function localWorkPackageStatus(input: {
  posture: EngineeringLeadPosture;
  routingMode: EngineeringLeadRoutingMode;
}): EngineeringLeadWorkPackageStatus {
  if (input.posture === "lead_cold_start") return "unknown";
  if (input.posture === "lead_blocked") return "blocked";
  if (input.routingMode === "explicit_handoff_ready") return "ready_for_handoff";
  return "contracting";
}

function localWorkPackageReplanTriggers(input: {
  task?: string;
  changedFiles: string[];
  proofGates: string[];
  acceptanceCriteria: string[];
  declaredRisks: string[];
  localSignals: AgentReadinessLocalSignals;
}): string[] {
  const triggers = new Set<string>();
  if (!input.task) {
    triggers.add("Define the task before treating this as a work package.");
  }
  if (input.changedFiles.length === 0) {
    triggers.add("Declare the write scope before delegation.");
  }
  if (input.acceptanceCriteria.length === 0) {
    triggers.add("Add acceptance criteria before worker handoff.");
  }
  if (input.proofGates.length === 0) {
    triggers.add("Add proof gates before worker handoff.");
  }
  if (!input.localSignals.workflow.present || input.localSignals.workflow.status !== "active") {
    triggers.add("Start or resume a Companion workflow before delegated execution.");
  }
  if (!input.localSignals.teamSync.present) {
    triggers.add("Record a Team Sync breadcrumb before handing work to another agent.");
  }
  if (input.declaredRisks.length > 0) {
    triggers.add("Review declared risks before promoting Brain update candidates.");
  }
  return Array.from(triggers);
}

function buildLocalWorkPackages(input: {
  workPackageId: string | null;
  workPackageTitle: string;
  status: EngineeringLeadStatus;
  posture: EngineeringLeadPosture;
  routingMode: EngineeringLeadRoutingMode;
  owner: string | null;
  changedFiles: string[];
  acceptanceCriteria: string[];
  proofGates: string[];
  evidence: EngineeringLeadEvidenceRef[];
  declaredRisks: string[];
  localSignals: AgentReadinessLocalSignals;
  task?: string;
}): EngineeringLeadWorkPackage[] {
  if (!input.workPackageId) {
    return [];
  }
  const workPackageStatus = localWorkPackageStatus({
    posture: input.posture,
    routingMode: input.routingMode,
  });
  const replanTriggers = localWorkPackageReplanTriggers(input);
  return [
    {
      id: input.workPackageId,
      title: input.workPackageTitle,
      status: workPackageStatus,
      health: input.status,
      owner: input.owner,
      dependencies: [],
      writeScope: input.changedFiles,
      acceptanceCriteria: input.acceptanceCriteria,
      proofRequired: input.proofGates,
      resultExpectation:
        input.routingMode === "explicit_handoff_ready"
          ? "Return changed files, proof receipts, residual risks, and candidate Project Brain updates."
          : "Return a bounded implementation summary only after the contract is complete.",
      nextAction:
        workPackageStatus === "ready_for_handoff"
          ? "Generate a handoff or adapter pack, then collect proof receipts before closure."
          : (replanTriggers[0] ?? "Tighten the work package contract before handoff."),
      replanTriggers,
      evidence: input.evidence,
      reasonCodes: [
        `engineering_lead_work_package_${workPackageStatus}`,
        `engineering_lead_${input.posture}`,
        `routing_${input.routingMode}`,
      ],
    },
  ];
}

function buildLocalSupervision(input: {
  posture: EngineeringLeadPosture;
  routingMode: EngineeringLeadRoutingMode;
  workPackages: EngineeringLeadWorkPackage[];
  localSignals: AgentReadinessLocalSignals;
}): EngineeringLeadSupervision {
  const replanTriggers = Array.from(
    new Set(input.workPackages.flatMap((workPackage) => workPackage.replanTriggers))
  );
  const reviewRequired =
    input.posture === "lead_watch" ||
    input.routingMode === "main_agent_execute" ||
    input.workPackages.some((workPackage) => workPackage.replanTriggers.length > 0);
  const replanRequired =
    input.posture === "lead_blocked" ||
    input.workPackages.some((workPackage) => workPackage.status === "blocked");
  const status: EngineeringLeadSupervisionStatus =
    input.workPackages.length === 0
      ? "cold_start"
      : replanRequired
        ? "blocked"
        : reviewRequired
          ? "needs_review"
          : "on_track";
  const readyWorkPackages = input.workPackages.filter(
    (workPackage) => workPackage.status === "ready_for_handoff"
  ).length;
  const blockedWorkPackages = input.workPackages.filter(
    (workPackage) => workPackage.status === "blocked"
  ).length;
  const receiptsRequired = new Set<string>();
  if (input.routingMode === "explicit_handoff_ready") {
    receiptsRequired.add("handoff_receipt");
    receiptsRequired.add("proof_receipt");
  }
  if (!input.localSignals.teamSync.present) {
    receiptsRequired.add("team_sync_handoff");
  }

  return {
    status,
    summary:
      status === "cold_start"
        ? "No local work package is available for supervision yet."
        : status === "blocked"
          ? "Local delegation is blocked until the worker contract has scope, acceptance, and proof."
          : status === "needs_review"
            ? "Local work is scoped, but workflow continuity or handoff readiness still needs review."
            : "Local work package is ready for advisory handoff supervision.",
    openWorkPackages: input.workPackages.length,
    blockedWorkPackages,
    readyWorkPackages,
    executingWorkPackages: 0,
    verifyingWorkPackages: 0,
    closedWorkPackages: 0,
    reviewRequired,
    replanRequired,
    nextCheck:
      status === "cold_start"
        ? "Define task scope, files, context refs, and proof gates."
        : status === "blocked"
          ? "Close contract gaps before delegated execution."
          : status === "needs_review"
            ? "Review workflow, Team Sync, risks, and proof gates before handoff."
            : "Collect proof and outcome receipts after handoff.",
    replanTriggers,
    receiptsRequired: Array.from(receiptsRequired),
    reasonCodes: [
      "engineering_lead_contract_v1_supervision",
      `engineering_lead_supervision_${status}`,
      `routing_${input.routingMode}`,
    ],
  };
}

function executionReceiptRequiredStagesForRecommendation(
  recommendation?: EngineeringLeadWorkerRecommendation
): EngineeringLeadExecutionReceiptStage[] {
  const stages = new Set<EngineeringLeadExecutionReceiptStage>(["handoff", "proof", "outcome"]);
  if (recommendation && recommendation.role !== "main_agent") {
    stages.add("claim");
  }
  if (recommendation?.contract.approvalRequired) {
    stages.add("approval");
  }
  if ((recommendation?.brainUpdateCandidates.length ?? 0) > 0) {
    stages.add("brain_update");
  }
  return ENGINEERING_LEAD_EXECUTION_RECEIPT_STAGES.filter((stage) => stages.has(stage));
}

function missingRequirementsForExecutionReceipt(input: {
  workPackage: EngineeringLeadWorkPackage;
  requiredStages: EngineeringLeadExecutionReceiptStage[];
  completedStages: EngineeringLeadExecutionReceiptStage[];
  brainUpdateCandidates: string[];
}): string[] {
  const completed = new Set(input.completedStages);
  const missing = new Set<string>();
  if (!input.workPackage.owner) missing.add("owner");
  if (input.workPackage.writeScope.length === 0) missing.add("write_scope");
  if (input.workPackage.acceptanceCriteria.length === 0) missing.add("acceptance_criteria");
  if (input.workPackage.proofRequired.length === 0) missing.add("proof_gate");
  if (input.requiredStages.includes("handoff") && !completed.has("handoff")) {
    missing.add("handoff_receipt");
  }
  if (input.requiredStages.includes("claim") && !completed.has("claim")) {
    missing.add("claim_id");
  }
  if (input.requiredStages.includes("approval") && !completed.has("approval")) {
    missing.add("approval_receipt");
  }
  if (input.requiredStages.includes("proof") && !completed.has("proof")) {
    missing.add("proof_receipt");
  }
  if (input.requiredStages.includes("outcome") && !completed.has("outcome")) {
    missing.add("outcome_receipt");
  }
  if (
    input.brainUpdateCandidates.length > 0 &&
    input.requiredStages.includes("brain_update") &&
    !completed.has("brain_update")
  ) {
    missing.add("brain_update_receipt");
  }
  return Array.from(missing).sort();
}

function executionReceiptStatusFromWorkPackage(input: {
  workPackage: EngineeringLeadWorkPackage;
  requiredStages: EngineeringLeadExecutionReceiptStage[];
  completedStages: EngineeringLeadExecutionReceiptStage[];
  missingRequirements: string[];
}): EngineeringLeadExecutionReceiptStatus {
  if (input.workPackage.status === "blocked") return "blocked";
  if (
    input.workPackage.status === "closed" &&
    input.requiredStages.every((stage) => input.completedStages.includes(stage))
  ) {
    return "closed";
  }
  if (input.workPackage.status === "executing") return "executing";
  if (input.workPackage.status === "verifying") return "verification_required";
  if (input.workPackage.status === "ready_for_handoff") return "handoff_ready";
  if (input.missingRequirements.length > 0) return "pending_handoff";
  return "handoff_ready";
}

function executionReceiptNextAction(input: {
  status: EngineeringLeadExecutionReceiptStatus;
  missingRequirements: string[];
}): string {
  if (input.status === "blocked") {
    return "Resolve the blocking receipt or proof issue before delegated execution.";
  }
  if (input.missingRequirements.includes("handoff_receipt")) {
    return "Create or attach the handoff receipt before treating this package as delegated.";
  }
  if (input.missingRequirements.includes("approval_receipt")) {
    return "Capture approval before delegated execution can proceed.";
  }
  if (input.missingRequirements.includes("proof_receipt")) {
    return "Attach proof receipts before closure.";
  }
  if (input.missingRequirements.includes("outcome_receipt")) {
    return "Attach an outcome or closure receipt before Brain promotion.";
  }
  if (input.missingRequirements.includes("brain_update_receipt")) {
    return "Record the reviewed Project Brain update receipt.";
  }
  if (input.status === "closed") {
    return "Keep the closed receipt linked for future routing calibration.";
  }
  if (input.status === "executing") {
    return "Monitor liveness and collect proof, outcome, and Brain-update receipts.";
  }
  if (input.status === "verification_required") {
    return "Verify proof and outcome receipts before closure.";
  }
  return "Issue the explicit handoff package and collect the required receipts.";
}

function buildExpectedExecutionReceipts(input: {
  workPackages: EngineeringLeadWorkPackage[];
  workerRecommendations: EngineeringLeadWorkerRecommendation[];
}): EngineeringLeadExecutionReceipt[] {
  const recommendationsByWorkPackageId = new Map(
    input.workerRecommendations
      .filter((recommendation) => recommendation.workPackageId)
      .map((recommendation) => [recommendation.workPackageId as string, recommendation])
  );

  return input.workPackages.map((workPackage) => {
    const recommendation = recommendationsByWorkPackageId.get(workPackage.id);
    const requiredStages = executionReceiptRequiredStagesForRecommendation(recommendation);
    const completedStages: EngineeringLeadExecutionReceiptStage[] = [];
    const brainUpdateCandidates = recommendation?.brainUpdateCandidates ?? [];
    const missingRequirements = missingRequirementsForExecutionReceipt({
      workPackage,
      requiredStages,
      completedStages,
      brainUpdateCandidates,
    });
    const status = executionReceiptStatusFromWorkPackage({
      workPackage,
      requiredStages,
      completedStages,
      missingRequirements,
    });
    return {
      id: `engineering-lead-receipt:${workPackage.id}`,
      workPackageId: workPackage.id,
      workPackageTitle: workPackage.title,
      status,
      requiredStages,
      completedStages,
      handoffReceiptId: null,
      claimId: null,
      htaskId: null,
      approvalReceiptId: null,
      proofReceiptIds: [],
      outcomeReceiptId: null,
      brainUpdateReceiptId: null,
      proofRequired: workPackage.proofRequired,
      proofExecuted: [],
      missingRequirements,
      nextAction: executionReceiptNextAction({ status, missingRequirements }),
      replanTriggers: workPackage.replanTriggers,
      brainUpdateCandidates,
      evidence: workPackage.evidence,
      reasonCodes: [`engineering_lead_execution_receipt_${status}`, ...workPackage.reasonCodes],
    };
  });
}

function buildLocalEngineeringLeadPlan(input: {
  target: AgentReadinessTarget;
  task?: string;
  changedFiles: string[];
  contextRefs: string[];
  proofGates: string[];
  acceptanceCriteria: string[];
  declaredRisks: string[];
  localSignals: AgentReadinessLocalSignals;
}): EngineeringLeadPlanSummary {
  const score = computeScore(input);
  const posture = postureForLocalPlan({ ...input, score });
  const status = statusForScore(score);
  const hasActiveWorkflow =
    input.localSignals.workflow.present && input.localSignals.workflow.status === "active";
  const hasProof = input.proofGates.length > 0 && input.acceptanceCriteria.length > 0;
  const routingMode = routingModeForLocalPlan({ posture, hasActiveWorkflow, hasProof });
  const role =
    posture === "lead_cold_start"
      ? "main_agent"
      : inferWorkerRole({
          changedFiles: input.changedFiles,
          proofGates: input.proofGates,
          acceptanceCriteria: input.acceptanceCriteria,
        });
  const workPackageTitle = input.task ?? "Local Companion work package";
  const evidence = [
    ...localSignalEvidence(input.localSignals),
    ...contextEvidence(input.contextRefs),
  ].slice(0, 10);
  const brainCandidates = brainUpdateCandidates(input);
  const workPackageId =
    posture === "lead_cold_start" ? null : `lead-plan:${slug(workPackageTitle, "work-package")}`;
  const owner = posture === "lead_cold_start" ? "main_agent" : TARGET_LABELS[input.target];
  const worker: EngineeringLeadWorkerRecommendation = {
    id: workPackageId ?? "engineering-lead:cold-start",
    role,
    label: workerLabel(role),
    status,
    routingMode,
    workPackageId,
    workPackageTitle: posture === "lead_cold_start" ? null : workPackageTitle,
    owner,
    rationale:
      routingMode === "explicit_handoff_ready"
        ? "Local scope, workflow continuity, acceptance, and proof gates are present for an explicit handoff."
        : routingMode === "main_agent_execute"
          ? "The contract is usable, but no active Companion workflow is present; keep execution with the main agent."
          : routingMode === "needs_contract"
            ? "Proof gates or acceptance criteria are incomplete; hold worker launch until the contract is explicit."
            : "No bounded work package exists yet; the main agent must define scope before delegation.",
    contract: {
      writeScope: input.changedFiles,
      contextRefs: evidence,
      acceptanceCriteria: input.acceptanceCriteria,
      proofRequired: input.proofGates,
      approvalRequired: routingMode !== "explicit_handoff_ready" || input.declaredRisks.length > 0,
      fallback: "main_agent",
    },
    proofGates: input.proofGates,
    brainUpdateCandidates: brainCandidates,
    evidence,
    reasonCodes: [
      "companion_engineering_lead_plan",
      `engineering_lead_${posture}`,
      `routing_${routingMode}`,
    ],
  };
  const workPackages = buildLocalWorkPackages({
    workPackageId,
    workPackageTitle,
    status,
    posture,
    routingMode,
    owner,
    changedFiles: input.changedFiles,
    acceptanceCriteria: input.acceptanceCriteria,
    proofGates: input.proofGates,
    evidence,
    declaredRisks: input.declaredRisks,
    localSignals: input.localSignals,
    task: input.task,
  });
  const supervision = buildLocalSupervision({
    posture,
    routingMode,
    workPackages,
    localSignals: input.localSignals,
  });
  const executionReceipts = buildExpectedExecutionReceipts({
    workPackages,
    workerRecommendations: [worker],
  });

  return {
    version: PROJECT_INTELLIGENCE_ENGINEERING_LEAD_PLAN_VERSION,
    contractVersion: PROJECT_INTELLIGENCE_ENGINEERING_LEAD_CONTRACT_VERSION,
    posture,
    status,
    score,
    headline:
      posture === "lead_ready"
        ? "Companion can act as an advisory engineering lead for this bounded work package."
        : posture === "lead_watch"
          ? "Companion has a partial lead plan; tighten workflow continuity before delegation."
          : posture === "lead_blocked"
            ? "Companion should hold delegation until the worker contract has proof and acceptance gates."
            : "Companion needs a task and file scope before it can form an engineering lead plan.",
    operatingMode: "advisory_fail_closed",
    nextAction:
      routingMode === "explicit_handoff_ready"
        ? "Generate a handoff or adapter pack, then require proof receipts before closure."
        : routingMode === "main_agent_execute"
          ? "Start or resume a Companion workflow before assigning this to another worker."
          : routingMode === "needs_contract"
            ? "Define proof gates and acceptance criteria before worker handoff."
            : "Define task scope, files, context refs, and proof gates.",
    workersSpawned: 0,
    failClosedFallback: "main_agent",
    workPackages,
    supervision,
    executionReceipts,
    workerRecommendations: [worker],
    proofGates: input.proofGates,
    brainUpdateActions: brainCandidates,
    metrics: [
      { label: "Work packages", value: workPackageId ? 1 : 0 },
      { label: "Ready packages", value: routingMode === "explicit_handoff_ready" ? 1 : 0 },
      { label: "Blocked packages", value: posture === "lead_blocked" ? 1 : 0 },
      { label: "Supervision", value: supervision.status },
      { label: "Context refs", value: input.contextRefs.length },
      { label: "Proof gates", value: input.proofGates.length },
      { label: "Acceptance criteria", value: input.acceptanceCriteria.length },
      { label: "Workers spawned", value: 0 },
    ],
    evidence,
    caveats: [
      "Engineering Lead Plan V0 is advisory and fail-closed; it does not launch, approve, or complete workers.",
      "Worker recommendations require explicit policy, approval, handoff receipts, and proof receipts before delegated execution.",
      "The Project Brain update list is a candidate queue; durable memory and source-truth changes still need review.",
      "Local Companion signals do not prove hosted Project Health, dashboard freshness, or production state.",
    ],
    reasonCodes: [
      "project_intelligence_engineering_lead_plan_v0",
      "companion_local_lead_plan",
      `engineering_lead_${posture}`,
    ],
  };
}

function normalizeWorkerRecommendation(
  value: Record<string, unknown>,
  index: number
): EngineeringLeadWorkerRecommendation {
  const contract = isRecord(value.contract) ? value.contract : {};
  const role = cockpitEnumValue(
    "worker_role",
    ENGINEERING_LEAD_WORKER_ROLES,
    value.role,
    "main_agent"
  );
  const status = cockpitEnumValue(
    "worker_status",
    ENGINEERING_LEAD_STATUSES,
    value.status,
    "unknown"
  );
  const routingMode = cockpitEnumValue(
    "routing_mode",
    ENGINEERING_LEAD_ROUTING_MODES,
    value.routingMode,
    "hold"
  );
  return {
    id: stringValue(value.id) ?? `worker:${index + 1}`,
    role: role.value,
    label: stringValue(value.label) ?? workerLabel(role.value),
    status: status.value,
    routingMode: routingMode.value,
    workPackageId: stringValue(value.workPackageId) ?? null,
    workPackageTitle: stringValue(value.workPackageTitle) ?? null,
    owner: stringValue(value.owner) ?? null,
    rationale: stringValue(value.rationale) ?? "No rationale provided in cockpit export.",
    contract: {
      writeScope: stringList(contract.writeScope),
      contextRefs: normalizeEvidence(contract.contextRefs),
      acceptanceCriteria: stringList(contract.acceptanceCriteria),
      proofRequired: stringList(contract.proofRequired),
      approvalRequired: booleanValue(contract.approvalRequired, true),
      fallback: "main_agent",
    },
    proofGates: stringList(value.proofGates),
    brainUpdateCandidates: stringList(value.brainUpdateCandidates),
    evidence: normalizeEvidence(value.evidence),
    reasonCodes: [
      ...new Set([
        ...stringList(value.reasonCodes),
        ...compactReasonCodes([
          role.droppedReasonCode,
          status.droppedReasonCode,
          routingMode.droppedReasonCode,
        ]),
      ]),
    ],
  };
}

function normalizeWorkPackage(
  value: Record<string, unknown>,
  index: number
): EngineeringLeadWorkPackage {
  const status = cockpitEnumValue(
    "work_package_status",
    ENGINEERING_LEAD_WORK_PACKAGE_STATUSES,
    value.status,
    "unknown"
  );
  const health = cockpitEnumValue(
    "work_package_health",
    ENGINEERING_LEAD_STATUSES,
    value.health,
    "unknown"
  );
  const reasonCodes = [
    ...new Set([
      ...stringList(value.reasonCodes),
      ...compactReasonCodes([status.droppedReasonCode, health.droppedReasonCode]),
    ]),
  ];
  return {
    id: stringValue(value.id) ?? `work-package:${index + 1}`,
    title: stringValue(value.title) ?? `Imported work package ${index + 1}`,
    status: status.value,
    health: health.value,
    owner: stringValue(value.owner) ?? null,
    dependencies: stringList(value.dependencies),
    writeScope: stringList(value.writeScope),
    acceptanceCriteria: stringList(value.acceptanceCriteria),
    proofRequired: stringList(value.proofRequired),
    resultExpectation:
      stringValue(value.resultExpectation) ??
      "Return proof receipts, residual risks, and candidate Project Brain updates.",
    nextAction:
      stringValue(value.nextAction) ?? "Review imported work package before creating handoffs.",
    replanTriggers: stringList(value.replanTriggers),
    evidence: normalizeEvidence(value.evidence),
    reasonCodes,
  };
}

function normalizeReceiptStages(
  field: string,
  value: unknown
): { stages: EngineeringLeadExecutionReceiptStage[]; reasonCodes: string[] } {
  if (!Array.isArray(value)) {
    return { stages: [], reasonCodes: [] };
  }
  const stages: EngineeringLeadExecutionReceiptStage[] = [];
  const reasonCodes = new Set<string>();
  for (const item of value) {
    const stage = cockpitEnumValue(
      field,
      ENGINEERING_LEAD_EXECUTION_RECEIPT_STAGES,
      item,
      "handoff"
    );
    if (stage.droppedReasonCode) {
      reasonCodes.add(stage.droppedReasonCode);
      continue;
    }
    if (!stages.includes(stage.value)) {
      stages.push(stage.value);
    }
  }
  return { stages, reasonCodes: Array.from(reasonCodes) };
}

function normalizeExecutionReceipt(
  value: Record<string, unknown>,
  index: number,
  workPackages: EngineeringLeadWorkPackage[],
  workerRecommendations: EngineeringLeadWorkerRecommendation[]
): EngineeringLeadExecutionReceipt {
  const workPackageId =
    stringValue(value.workPackageId) ?? workPackages[index]?.id ?? `work-package:${index + 1}`;
  const workPackage = workPackages.find((candidate) => candidate.id === workPackageId);
  const recommendation = workerRecommendations.find(
    (candidate) => candidate.workPackageId === workPackageId
  );
  const fallbackRequiredStages = executionReceiptRequiredStagesForRecommendation(recommendation);
  const requiredStages = normalizeReceiptStages("execution_receipt_stage", value.requiredStages);
  const completedStages = normalizeReceiptStages("execution_receipt_stage", value.completedStages);
  const normalizedRequiredStages =
    requiredStages.stages.length > 0 ? requiredStages.stages : fallbackRequiredStages;
  const normalizedCompletedStages = completedStages.stages.filter((stage) =>
    normalizedRequiredStages.includes(stage)
  );
  const brainUpdateCandidates =
    stringList(value.brainUpdateCandidates).length > 0
      ? stringList(value.brainUpdateCandidates)
      : (recommendation?.brainUpdateCandidates ?? []);
  const derivedMissing =
    workPackage &&
    missingRequirementsForExecutionReceipt({
      workPackage,
      requiredStages: normalizedRequiredStages,
      completedStages: normalizedCompletedStages,
      brainUpdateCandidates,
    });
  const missingRequirements =
    stringList(value.missingRequirements).length > 0
      ? stringList(value.missingRequirements)
      : (derivedMissing ?? []);
  const fallbackStatus = workPackage
    ? executionReceiptStatusFromWorkPackage({
        workPackage,
        requiredStages: normalizedRequiredStages,
        completedStages: normalizedCompletedStages,
        missingRequirements,
      })
    : "pending_handoff";
  const status = cockpitEnumValue(
    "execution_receipt_status",
    ENGINEERING_LEAD_EXECUTION_RECEIPT_STATUSES,
    value.status,
    fallbackStatus
  );

  return {
    id: stringValue(value.id) ?? `engineering-lead-receipt:${workPackageId}`,
    workPackageId,
    workPackageTitle:
      stringValue(value.workPackageTitle) ??
      workPackage?.title ??
      `Imported work package ${index + 1}`,
    status: status.value,
    requiredStages: normalizedRequiredStages,
    completedStages: normalizedCompletedStages,
    handoffReceiptId: stringValue(value.handoffReceiptId) ?? null,
    claimId: stringValue(value.claimId) ?? null,
    htaskId: stringValue(value.htaskId) ?? null,
    approvalReceiptId: stringValue(value.approvalReceiptId) ?? null,
    proofReceiptIds: stringList(value.proofReceiptIds),
    outcomeReceiptId: stringValue(value.outcomeReceiptId) ?? null,
    brainUpdateReceiptId: stringValue(value.brainUpdateReceiptId) ?? null,
    proofRequired:
      stringList(value.proofRequired).length > 0
        ? stringList(value.proofRequired)
        : (workPackage?.proofRequired ?? []),
    proofExecuted: stringList(value.proofExecuted),
    missingRequirements,
    nextAction:
      stringValue(value.nextAction) ??
      executionReceiptNextAction({ status: status.value, missingRequirements }),
    replanTriggers:
      stringList(value.replanTriggers).length > 0
        ? stringList(value.replanTriggers)
        : (workPackage?.replanTriggers ?? []),
    brainUpdateCandidates,
    evidence:
      normalizeEvidence(value.evidence).length > 0
        ? normalizeEvidence(value.evidence)
        : (workPackage?.evidence ?? []),
    reasonCodes: [
      ...new Set([
        ...stringList(value.reasonCodes),
        ...compactReasonCodes([status.droppedReasonCode]),
        ...requiredStages.reasonCodes,
        ...completedStages.reasonCodes,
      ]),
    ],
  };
}

function summarizeSupervisionFromWorkPackages(
  workPackages: EngineeringLeadWorkPackage[]
): EngineeringLeadSupervision {
  const blockedWorkPackages = workPackages.filter(
    (workPackage) => workPackage.status === "blocked"
  ).length;
  const readyWorkPackages = workPackages.filter(
    (workPackage) => workPackage.status === "ready_for_handoff"
  ).length;
  const executingWorkPackages = workPackages.filter(
    (workPackage) => workPackage.status === "executing"
  ).length;
  const verifyingWorkPackages = workPackages.filter(
    (workPackage) => workPackage.status === "verifying"
  ).length;
  const closedWorkPackages = workPackages.filter(
    (workPackage) => workPackage.status === "closed"
  ).length;
  const replanTriggers = Array.from(
    new Set(workPackages.flatMap((workPackage) => workPackage.replanTriggers))
  );
  const reviewRequired =
    workPackages.some((workPackage) => workPackage.health === "watch") ||
    workPackages.some((workPackage) => workPackage.replanTriggers.length > 0);
  const replanRequired = blockedWorkPackages > 0;
  const status: EngineeringLeadSupervisionStatus =
    workPackages.length === 0
      ? "cold_start"
      : replanRequired
        ? "needs_replan"
        : reviewRequired
          ? "needs_review"
          : "on_track";
  return {
    status,
    summary:
      workPackages.length === 0
        ? "No imported work packages are available for supervision."
        : replanRequired
          ? `${blockedWorkPackages} imported work package(s) require replan.`
          : reviewRequired
            ? "Imported work packages need review before delegated execution."
            : "Imported work packages are on track for advisory supervision.",
    openWorkPackages: Math.max(0, workPackages.length - closedWorkPackages),
    blockedWorkPackages,
    readyWorkPackages,
    executingWorkPackages,
    verifyingWorkPackages,
    closedWorkPackages,
    reviewRequired,
    replanRequired,
    nextCheck:
      status === "cold_start"
        ? "Import or create bounded work packages."
        : status === "needs_replan"
          ? "Replan blocked imported packages before handoff."
          : status === "needs_review"
            ? "Review imported package contracts and receipts."
            : "Collect proof and outcome receipts after handoff.",
    replanTriggers,
    receiptsRequired: [],
    reasonCodes: [
      "engineering_lead_contract_v1_supervision",
      `engineering_lead_supervision_${status}`,
    ],
  };
}

function normalizeSupervision(
  value: unknown,
  workPackages: EngineeringLeadWorkPackage[]
): EngineeringLeadSupervision {
  if (!isRecord(value)) {
    return summarizeSupervisionFromWorkPackages(workPackages);
  }
  const fallback = summarizeSupervisionFromWorkPackages(workPackages);
  const fallbackStatus: EngineeringLeadSupervisionStatus =
    fallback.status === "on_track" ? "needs_review" : fallback.status;
  const status = cockpitEnumValue(
    "supervision_status",
    ENGINEERING_LEAD_SUPERVISION_STATUSES,
    value.status,
    fallbackStatus
  );
  return {
    status: status.value,
    summary: stringValue(value.summary) ?? fallback.summary,
    openWorkPackages: Math.max(
      0,
      Math.round(numberValue(value.openWorkPackages, fallback.openWorkPackages))
    ),
    blockedWorkPackages: Math.max(
      0,
      Math.round(numberValue(value.blockedWorkPackages, fallback.blockedWorkPackages))
    ),
    readyWorkPackages: Math.max(
      0,
      Math.round(numberValue(value.readyWorkPackages, fallback.readyWorkPackages))
    ),
    executingWorkPackages: Math.max(
      0,
      Math.round(numberValue(value.executingWorkPackages, fallback.executingWorkPackages))
    ),
    verifyingWorkPackages: Math.max(
      0,
      Math.round(numberValue(value.verifyingWorkPackages, fallback.verifyingWorkPackages))
    ),
    closedWorkPackages: Math.max(
      0,
      Math.round(numberValue(value.closedWorkPackages, fallback.closedWorkPackages))
    ),
    reviewRequired: booleanValue(value.reviewRequired, fallback.reviewRequired),
    replanRequired: booleanValue(value.replanRequired, fallback.replanRequired),
    nextCheck: stringValue(value.nextCheck) ?? fallback.nextCheck,
    replanTriggers: stringList(value.replanTriggers),
    receiptsRequired: stringList(value.receiptsRequired),
    reasonCodes: [
      ...new Set([
        ...stringList(value.reasonCodes),
        ...compactReasonCodes([status.droppedReasonCode]),
      ]),
    ],
  };
}

function normalizeCockpitPlan(cockpit: Record<string, unknown>): EngineeringLeadPlanSummary {
  const rawPlan = isRecord(cockpit.engineeringLeadPlan) ? cockpit.engineeringLeadPlan : cockpit;
  const score = Math.round(numberValue(rawPlan.score, 0));
  const workerRecommendations = recordList(rawPlan.workerRecommendations).map(
    normalizeWorkerRecommendation
  );
  const workPackages = recordList(rawPlan.workPackages).map(normalizeWorkPackage);
  const supervision = normalizeSupervision(rawPlan.supervision, workPackages);
  const rawExecutionReceipts = recordList(rawPlan.executionReceipts);
  const executionReceipts =
    rawExecutionReceipts.length > 0
      ? rawExecutionReceipts.map((receipt, index) =>
          normalizeExecutionReceipt(receipt, index, workPackages, workerRecommendations)
        )
      : buildExpectedExecutionReceipts({ workPackages, workerRecommendations });
  const posture = cockpitEnumValue(
    "posture",
    ENGINEERING_LEAD_POSTURES,
    rawPlan.posture,
    "lead_cold_start"
  );
  const status = cockpitEnumValue(
    "status",
    ENGINEERING_LEAD_STATUSES,
    rawPlan.status,
    statusForScore(score)
  );
  const workerDroppedReasonCodes = workerRecommendations.flatMap((worker) =>
    worker.reasonCodes.filter((code) => code.startsWith("companion_dropped_unknown_"))
  );
  const workPackageDroppedReasonCodes = workPackages.flatMap((workPackage) =>
    workPackage.reasonCodes.filter((code) => code.startsWith("companion_dropped_unknown_"))
  );
  const supervisionDroppedReasonCodes = supervision.reasonCodes.filter((code) =>
    code.startsWith("companion_dropped_unknown_")
  );
  const executionReceiptDroppedReasonCodes = executionReceipts.flatMap((receipt) =>
    receipt.reasonCodes.filter((code) => code.startsWith("companion_dropped_unknown_"))
  );
  return {
    version: PROJECT_INTELLIGENCE_ENGINEERING_LEAD_PLAN_VERSION,
    contractVersion: PROJECT_INTELLIGENCE_ENGINEERING_LEAD_CONTRACT_VERSION,
    posture: posture.value,
    status: status.value,
    score,
    headline: stringValue(rawPlan.headline) ?? "Imported Project Health Engineering Lead Plan.",
    operatingMode: "advisory_fail_closed",
    nextAction:
      stringValue(rawPlan.nextAction) ??
      "Review the imported cockpit plan before creating worker handoffs.",
    workersSpawned: 0,
    failClosedFallback: "main_agent",
    workPackages,
    supervision,
    executionReceipts,
    workerRecommendations,
    proofGates: stringList(rawPlan.proofGates),
    brainUpdateActions: stringList(rawPlan.brainUpdateActions),
    metrics: recordList(rawPlan.metrics).flatMap((metric) => {
      const label = stringValue(metric.label);
      const value = stringValue(metric.value) ?? numberValue(metric.value, Number.NaN);
      return label && !(typeof value === "number" && Number.isNaN(value)) ? [{ label, value }] : [];
    }),
    evidence: normalizeEvidence(rawPlan.evidence),
    caveats: [
      ...new Set([
        ...stringList(rawPlan.caveats),
        "Imported cockpit plans remain advisory and fail-closed inside Companion.",
      ]),
    ],
    reasonCodes: [
      ...new Set([
        "companion_imported_project_health_lead_plan",
        ...compactReasonCodes([posture.droppedReasonCode, status.droppedReasonCode]),
        ...stringList(rawPlan.reasonCodes),
        ...workerDroppedReasonCodes,
        ...workPackageDroppedReasonCodes,
        ...supervisionDroppedReasonCodes,
        ...executionReceiptDroppedReasonCodes,
      ]),
    ],
  };
}

function scopeSetForPlan(plan: EngineeringLeadPlanSummary): Set<string> {
  return new Set([
    ...plan.workPackages.flatMap((workPackage) => workPackage.writeScope),
    ...plan.workerRecommendations.flatMap((worker) => worker.contract.writeScope),
  ]);
}

function reconcileEngineeringLeadPlan(input: {
  plan: EngineeringLeadPlanSummary;
  changedFiles: string[];
  proofGates: string[];
  acceptanceCriteria: string[];
  declaredRisks: string[];
  localSignals: AgentReadinessLocalSignals;
}): CompanionEngineeringLeadReconciliation {
  const changedSignals = new Set<string>();
  const recommendedActions = new Set<string>();
  const reasonCodes = new Set<string>(["companion_lead_plan_reconciled"]);
  const plannedScope = scopeSetForPlan(input.plan);
  const outOfScopeFiles = input.changedFiles.filter((file) => !plannedScope.has(file));
  const executionReceipts = input.plan.executionReceipts ?? [];

  if (input.plan.workPackages.length === 0) {
    changedSignals.add("no_imported_work_packages");
    recommendedActions.add("Create or import bounded work packages before delegation.");
    reasonCodes.add("companion_reconcile_no_work_packages");
  }
  if (outOfScopeFiles.length > 0) {
    changedSignals.add(`out_of_scope_files:${outOfScopeFiles.join(",")}`);
    recommendedActions.add(
      "Replan because current changed files are outside the imported write scope."
    );
    reasonCodes.add("companion_reconcile_scope_changed");
  }
  if (!input.localSignals.workflow.present || input.localSignals.workflow.status !== "active") {
    changedSignals.add("workflow_not_active");
    recommendedActions.add("Start or resume a Companion workflow before delegated execution.");
    reasonCodes.add("companion_reconcile_workflow_not_active");
  }
  if (!input.localSignals.teamSync.present) {
    changedSignals.add("team_sync_missing");
    recommendedActions.add(
      "Record Team Sync start-work or handoff before assigning work to another agent."
    );
    reasonCodes.add("companion_reconcile_team_sync_missing");
  }
  if (input.proofGates.length === 0 && input.plan.proofGates.length === 0) {
    changedSignals.add("proof_gates_missing");
    recommendedActions.add("Define proof gates before worker handoff.");
    reasonCodes.add("companion_reconcile_missing_proof");
  }
  if (input.acceptanceCriteria.length === 0) {
    const importedAcceptance = input.plan.workPackages.some(
      (workPackage) => workPackage.acceptanceCriteria.length > 0
    );
    if (!importedAcceptance) {
      changedSignals.add("acceptance_criteria_missing");
      recommendedActions.add("Define acceptance criteria before worker handoff.");
      reasonCodes.add("companion_reconcile_missing_acceptance");
    }
  }
  if (input.declaredRisks.length > 0) {
    changedSignals.add("declared_risks_present");
    recommendedActions.add("Review declared risks before promoting Brain update candidates.");
    reasonCodes.add("companion_reconcile_declared_risks");
  }
  for (const trigger of input.plan.supervision.replanTriggers) {
    recommendedActions.add(trigger);
  }
  for (const receipt of executionReceipts) {
    if (receipt.status === "blocked") {
      changedSignals.add(`blocked_execution_receipt:${receipt.workPackageId}`);
      recommendedActions.add(receipt.nextAction);
      reasonCodes.add("companion_reconcile_execution_receipt_blocked");
    }
    if (receipt.missingRequirements.length > 0) {
      changedSignals.add(
        `execution_receipt_missing:${receipt.workPackageId}:${receipt.missingRequirements.join(",")}`
      );
      recommendedActions.add(
        `Attach missing execution receipt requirement(s) for ${receipt.workPackageTitle}: ${receipt.missingRequirements.join(", ")}.`
      );
      reasonCodes.add("companion_reconcile_execution_receipt_missing_requirements");
    }
  }

  const blocked =
    input.plan.supervision.status === "blocked" ||
    input.plan.workPackages.some((workPackage) => workPackage.status === "blocked") ||
    executionReceipts.some((receipt) => receipt.status === "blocked");
  const replanRequired =
    blocked ||
    input.plan.supervision.replanRequired ||
    outOfScopeFiles.length > 0 ||
    !input.localSignals.workflow.present ||
    input.localSignals.workflow.status !== "active";
  const reviewRequired =
    replanRequired ||
    input.plan.supervision.reviewRequired ||
    executionReceipts.some((receipt) => receipt.missingRequirements.length > 0) ||
    !input.localSignals.teamSync.present ||
    input.declaredRisks.length > 0;
  const status: CompanionEngineeringLeadReconciliation["status"] = blocked
    ? "blocked"
    : replanRequired
      ? "needs_replan"
      : reviewRequired
        ? "needs_review"
        : "on_track";

  return {
    status,
    summary:
      status === "blocked"
        ? "Imported lead plan has blocked work or blocked supervision signals."
        : status === "needs_replan"
          ? "Imported lead plan no longer matches current local execution signals."
          : status === "needs_review"
            ? "Imported lead plan is usable, but local continuity or risk review is required."
            : "Imported lead plan matches current local execution signals.",
    replanRequired,
    reviewRequired,
    changedSignals: Array.from(changedSignals),
    recommendedActions: Array.from(recommendedActions),
    reasonCodes: Array.from(reasonCodes),
  };
}

function applyReconciliationToPlan(
  plan: EngineeringLeadPlanSummary,
  reconciliation: CompanionEngineeringLeadReconciliation
): EngineeringLeadPlanSummary {
  if (!reconciliation.replanRequired && !reconciliation.reviewRequired) {
    return {
      ...plan,
      reasonCodes: [...new Set([...plan.reasonCodes, ...reconciliation.reasonCodes])],
    };
  }
  const supervisionStatus: EngineeringLeadSupervisionStatus =
    reconciliation.status === "blocked"
      ? "blocked"
      : reconciliation.status === "needs_replan"
        ? "needs_replan"
        : "needs_review";
  return {
    ...plan,
    nextAction: reconciliation.recommendedActions[0] ?? plan.nextAction,
    supervision: {
      ...plan.supervision,
      status: supervisionStatus,
      summary: reconciliation.summary,
      reviewRequired: reconciliation.reviewRequired,
      replanRequired: reconciliation.replanRequired,
      replanTriggers: [
        ...new Set([...plan.supervision.replanTriggers, ...reconciliation.recommendedActions]),
      ],
      reasonCodes: [...new Set([...plan.supervision.reasonCodes, ...reconciliation.reasonCodes])],
    },
    caveats: [
      ...new Set([
        ...plan.caveats,
        "This plan was reconciled against current local Companion signals; replan signals are advisory and fail-closed.",
      ]),
    ],
    reasonCodes: [...new Set([...plan.reasonCodes, ...reconciliation.reasonCodes])],
  };
}

function readJsonFile(filePath: string): Record<string, unknown> {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return parsed;
}

export function buildCompanionEngineeringLeadPlanReport(
  options: BuildCompanionEngineeringLeadPlanOptions = {}
): CompanionEngineeringLeadPlanReport {
  const cwd = options.cwd ?? process.cwd();
  const target = normalizeTarget(options.target);
  const localSignals = options.localSignals ?? collectAgentReadinessLocalSignals(cwd);
  const task = normalizeTask(options.task);
  const changedFiles = unique(options.changedFiles);
  const contextRefs = unique(options.context);
  const proofGates = unique(options.proof);
  const acceptanceCriteria = unique(options.acceptance);
  const declaredRisks = unique(options.risk);
  const cockpit =
    options.cockpit ??
    (options.fromCockpit || options.fromPlan
      ? readJsonFile(options.fromCockpit ?? options.fromPlan ?? "")
      : undefined);
  const importedPlan = cockpit
    ? normalizeCockpitPlan(cockpit)
    : buildLocalEngineeringLeadPlan({
        target,
        task,
        changedFiles,
        contextRefs,
        proofGates,
        acceptanceCriteria,
        declaredRisks,
        localSignals,
      });
  const reconciliation =
    options.reconcile && cockpit
      ? reconcileEngineeringLeadPlan({
          plan: importedPlan,
          changedFiles,
          proofGates,
          acceptanceCriteria,
          declaredRisks,
          localSignals,
        })
      : undefined;
  const engineeringLeadPlan = reconciliation
    ? applyReconciliationToPlan(importedPlan, reconciliation)
    : importedPlan;

  return {
    version: "snipara.companion_engineering_lead_plan.v1",
    generatedAt: (options.now ?? new Date()).toISOString(),
    source: cockpit ? "project_health_cockpit" : "local_companion_inputs",
    target: {
      id: target,
      label: TARGET_LABELS[target],
    },
    ...(task ? { task } : {}),
    engineeringLeadPlan,
    explicitInputs: {
      changedFiles,
      contextRefs,
      proofGates,
      acceptanceCriteria,
      declaredRisks,
    },
    localSignals,
    ...(reconciliation ? { reconciliation } : {}),
    suggestedCommands: suggestedCommands({
      target,
      task,
      changedFiles,
      proofGates,
      acceptanceCriteria,
    }),
    caveats: [
      "Companion Engineering Lead Plan does not spawn workers or approve work.",
      "Use this artifact as a contract for handoff, verification, and candidate Project Brain updates.",
      "For autonomous execution, use the orchestrator surface only behind explicit policy and approval gates.",
    ],
  };
}

function formatList(values: string[], empty = "none"): string {
  return values.length > 0 ? values.join(", ") : empty;
}

export function formatCompanionEngineeringLeadPlanReport(
  report: CompanionEngineeringLeadPlanReport
): string {
  const plan = report.engineeringLeadPlan;
  const executionReceipts = plan.executionReceipts ?? [];
  const lines: string[] = [];
  lines.push("Companion Engineering Lead Plan");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Source: ${report.source}`);
  lines.push(`Target: ${report.target.label}`);
  if (report.task) {
    lines.push(`Task: ${report.task}`);
  }
  lines.push(`Score: ${plan.score}/100 (${plan.status})`);
  lines.push(`Posture: ${plan.posture}`);
  lines.push(`Mode: ${plan.operatingMode}`);
  lines.push(`Workers spawned: ${plan.workersSpawned}`);
  lines.push(`Fallback: ${plan.failClosedFallback}`);
  lines.push(`Headline: ${plan.headline}`);
  lines.push(`Next action: ${plan.nextAction}`);
  lines.push("");
  lines.push("Supervision");
  lines.push(`Status: ${plan.supervision.status}`);
  lines.push(`Summary: ${plan.supervision.summary}`);
  lines.push(`Review required: ${plan.supervision.reviewRequired}`);
  lines.push(`Replan required: ${plan.supervision.replanRequired}`);
  lines.push(`Next check: ${plan.supervision.nextCheck}`);
  lines.push(`Replan triggers: ${formatList(plan.supervision.replanTriggers)}`);
  lines.push("");
  if (report.reconciliation) {
    lines.push("Reconciliation");
    lines.push(`Status: ${report.reconciliation.status}`);
    lines.push(`Summary: ${report.reconciliation.summary}`);
    lines.push(`Changed signals: ${formatList(report.reconciliation.changedSignals)}`);
    lines.push(`Recommended actions: ${formatList(report.reconciliation.recommendedActions)}`);
    lines.push("");
  }
  lines.push("Work Packages");
  if (plan.workPackages.length === 0) {
    lines.push("- none");
  } else {
    for (const workPackage of plan.workPackages) {
      lines.push(`- [${workPackage.health}] ${workPackage.title} (${workPackage.status})`);
      if (workPackage.owner) {
        lines.push(`  owner: ${workPackage.owner}`);
      }
      lines.push(`  next: ${workPackage.nextAction}`);
      lines.push(`  scope: ${formatList(workPackage.writeScope)}`);
      lines.push(`  proof: ${formatList(workPackage.proofRequired)}`);
    }
  }
  lines.push("");
  lines.push("Execution Receipts");
  if (executionReceipts.length === 0) {
    lines.push("- none");
  } else {
    for (const receipt of executionReceipts) {
      lines.push(`- [${receipt.status}] ${receipt.workPackageTitle}`);
      lines.push(`  package: ${receipt.workPackageId}`);
      lines.push(`  required stages: ${formatList(receipt.requiredStages)}`);
      lines.push(`  completed stages: ${formatList(receipt.completedStages)}`);
      lines.push(`  handoff receipt: ${receipt.handoffReceiptId ?? "missing"}`);
      lines.push(`  claim: ${receipt.claimId ?? "missing"}`);
      lines.push(`  approval receipt: ${receipt.approvalReceiptId ?? "missing"}`);
      lines.push(`  outcome receipt: ${receipt.outcomeReceiptId ?? "missing"}`);
      lines.push(`  brain update receipt: ${receipt.brainUpdateReceiptId ?? "missing"}`);
      lines.push(`  missing: ${formatList(receipt.missingRequirements)}`);
      lines.push(`  next: ${receipt.nextAction}`);
    }
  }
  lines.push("");
  lines.push("Worker Recommendations");
  for (const worker of plan.workerRecommendations) {
    lines.push(`- [${worker.status}] ${worker.label} (${worker.role}, ${worker.routingMode})`);
    if (worker.workPackageTitle) {
      lines.push(`  package: ${worker.workPackageTitle}`);
    }
    if (worker.owner) {
      lines.push(`  owner: ${worker.owner}`);
    }
    lines.push(`  rationale: ${worker.rationale}`);
    lines.push(`  scope: ${formatList(worker.contract.writeScope)}`);
    lines.push(`  proof: ${formatList(worker.proofGates)}`);
    lines.push(`  acceptance: ${formatList(worker.contract.acceptanceCriteria)}`);
  }
  lines.push("");
  lines.push("Brain Update Candidates");
  if (plan.brainUpdateActions.length === 0) {
    lines.push("- none");
  } else {
    for (const action of plan.brainUpdateActions) {
      lines.push(`- ${action}`);
    }
  }
  lines.push("");
  lines.push("Suggested Commands");
  for (const command of report.suggestedCommands) {
    lines.push(`- ${command}`);
  }
  lines.push("");
  lines.push("Caveats");
  for (const caveat of [...plan.caveats, ...report.caveats]) {
    lines.push(`- ${caveat}`);
  }
  return lines.join("\n");
}

function writeReport(outputPath: string, report: CompanionEngineeringLeadPlanReport): void {
  const absolute = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const content = outputPath.endsWith(".json")
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${formatCompanionEngineeringLeadPlanReport(report)}\n`;
  fs.writeFileSync(absolute, content, "utf8");
}

export async function leadPlanCommand(options: LeadPlanCommandOptions): Promise<void> {
  const cwd = path.resolve(options.dir ?? process.cwd());
  const report = buildCompanionEngineeringLeadPlanReport({
    ...options,
    cwd,
    localSignals: collectAgentReadinessLocalSignals(cwd),
  });

  if (options.output) {
    writeReport(options.output, report);
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(formatCompanionEngineeringLeadPlanReport(report));
}
