export const PROJECT_HEALTH_COCKPIT_STATUSES = ["healthy", "watch", "risk", "unknown"] as const;

export const PROJECT_INTELLIGENCE_ENGINEERING_LEAD_PLAN_VERSION =
  "project-intelligence-engineering-lead-plan-v0" as const;

export const PROJECT_INTELLIGENCE_ENGINEERING_LEAD_CONTRACT_VERSION =
  "engineering-lead-contract-v1" as const;

export const PROJECT_INTELLIGENCE_ENGINEERING_LEAD_POSTURES = [
  "lead_ready",
  "lead_watch",
  "lead_blocked",
  "lead_cold_start",
] as const;

export const PROJECT_INTELLIGENCE_ENGINEERING_LEAD_WORKER_ROLES = [
  "main_agent",
  "coding_worker",
  "test_worker",
  "reviewer",
  "documentation_worker",
  "human_approver",
] as const;

export const PROJECT_INTELLIGENCE_ENGINEERING_LEAD_ROUTING_MODES = [
  "hold",
  "main_agent_execute",
  "explicit_handoff_ready",
  "needs_contract",
] as const;

export const PROJECT_INTELLIGENCE_ENGINEERING_LEAD_WORK_PACKAGE_STATUSES = [
  "contracting",
  "ready_for_handoff",
  "executing",
  "verifying",
  "blocked",
  "closed",
  "unknown",
] as const;

export const PROJECT_INTELLIGENCE_ENGINEERING_LEAD_SUPERVISION_STATUSES = [
  "on_track",
  "needs_review",
  "needs_replan",
  "blocked",
  "cold_start",
  "unknown",
] as const;

export const PROJECT_INTELLIGENCE_ENGINEERING_LEAD_EXECUTION_RECEIPT_STATUSES = [
  "pending_handoff",
  "handoff_ready",
  "executing",
  "verification_required",
  "blocked",
  "closed",
  "unknown",
] as const;

export const PROJECT_INTELLIGENCE_ENGINEERING_LEAD_EXECUTION_RECEIPT_STAGES = [
  "handoff",
  "claim",
  "approval",
  "proof",
  "outcome",
  "brain_update",
] as const;

export type ProjectHealthCockpitStatus = (typeof PROJECT_HEALTH_COCKPIT_STATUSES)[number];

export type ProjectIntelligenceEngineeringLeadPosture =
  (typeof PROJECT_INTELLIGENCE_ENGINEERING_LEAD_POSTURES)[number];

export type ProjectIntelligenceEngineeringLeadWorkerRole =
  (typeof PROJECT_INTELLIGENCE_ENGINEERING_LEAD_WORKER_ROLES)[number];

export type ProjectIntelligenceEngineeringLeadRoutingMode =
  (typeof PROJECT_INTELLIGENCE_ENGINEERING_LEAD_ROUTING_MODES)[number];

export type ProjectIntelligenceEngineeringLeadWorkPackageStatus =
  (typeof PROJECT_INTELLIGENCE_ENGINEERING_LEAD_WORK_PACKAGE_STATUSES)[number];

export type ProjectIntelligenceEngineeringLeadSupervisionStatus =
  (typeof PROJECT_INTELLIGENCE_ENGINEERING_LEAD_SUPERVISION_STATUSES)[number];

export type ProjectIntelligenceEngineeringLeadExecutionReceiptStatus =
  (typeof PROJECT_INTELLIGENCE_ENGINEERING_LEAD_EXECUTION_RECEIPT_STATUSES)[number];

export type ProjectIntelligenceEngineeringLeadExecutionReceiptStage =
  (typeof PROJECT_INTELLIGENCE_ENGINEERING_LEAD_EXECUTION_RECEIPT_STAGES)[number];

export type ProjectIntelligenceEngineeringLeadEvidenceKind =
  | "memory"
  | "project_decision"
  | "shadow_signal"
  | "context_graph"
  | "outcome_signal"
  | "retrieval_event"
  | "workflow"
  | "repository"
  | "manual";

export interface ProjectIntelligenceEngineeringLeadEvidenceRef {
  id: string;
  kind: ProjectIntelligenceEngineeringLeadEvidenceKind;
  label: string;
  sourceRef?: string | null;
  strength?: number | null;
  reviewStatus?: string | null;
  authorityStatus?: string | null;
  freshness?: string | null;
}

export interface ProjectIntelligenceEngineeringLeadWorkerContract<
  EvidenceRef extends ProjectIntelligenceEngineeringLeadEvidenceRef =
    ProjectIntelligenceEngineeringLeadEvidenceRef,
> {
  writeScope: string[];
  contextRefs: EvidenceRef[];
  acceptanceCriteria: string[];
  proofRequired: string[];
  approvalRequired: boolean;
  fallback: "main_agent";
}

export interface ProjectIntelligenceEngineeringLeadWorkerRecommendation<
  EvidenceRef extends ProjectIntelligenceEngineeringLeadEvidenceRef =
    ProjectIntelligenceEngineeringLeadEvidenceRef,
> {
  id: string;
  role: ProjectIntelligenceEngineeringLeadWorkerRole;
  label: string;
  status: ProjectHealthCockpitStatus;
  routingMode: ProjectIntelligenceEngineeringLeadRoutingMode;
  workPackageId: string | null;
  workPackageTitle: string | null;
  owner: string | null;
  rationale: string;
  contract: ProjectIntelligenceEngineeringLeadWorkerContract<EvidenceRef>;
  proofGates: string[];
  brainUpdateCandidates: string[];
  evidence: EvidenceRef[];
  reasonCodes: string[];
}

export interface ProjectIntelligenceEngineeringLeadWorkPackage<
  EvidenceRef extends ProjectIntelligenceEngineeringLeadEvidenceRef =
    ProjectIntelligenceEngineeringLeadEvidenceRef,
> {
  id: string;
  title: string;
  status: ProjectIntelligenceEngineeringLeadWorkPackageStatus;
  health: ProjectHealthCockpitStatus;
  owner: string | null;
  dependencies: string[];
  writeScope: string[];
  acceptanceCriteria: string[];
  proofRequired: string[];
  resultExpectation: string;
  nextAction: string;
  replanTriggers: string[];
  evidence: EvidenceRef[];
  reasonCodes: string[];
}

export interface ProjectIntelligenceEngineeringLeadSupervision {
  status: ProjectIntelligenceEngineeringLeadSupervisionStatus;
  summary: string;
  openWorkPackages: number;
  blockedWorkPackages: number;
  readyWorkPackages: number;
  executingWorkPackages: number;
  verifyingWorkPackages: number;
  closedWorkPackages: number;
  reviewRequired: boolean;
  replanRequired: boolean;
  nextCheck: string;
  replanTriggers: string[];
  receiptsRequired: string[];
  reasonCodes: string[];
}

export interface ProjectIntelligenceEngineeringLeadExecutionReceipt<
  EvidenceRef extends ProjectIntelligenceEngineeringLeadEvidenceRef =
    ProjectIntelligenceEngineeringLeadEvidenceRef,
> {
  id: string;
  workPackageId: string;
  workPackageTitle: string;
  status: ProjectIntelligenceEngineeringLeadExecutionReceiptStatus;
  requiredStages: ProjectIntelligenceEngineeringLeadExecutionReceiptStage[];
  completedStages: ProjectIntelligenceEngineeringLeadExecutionReceiptStage[];
  handoffReceiptId: string | null;
  claimId: string | null;
  htaskId: string | null;
  approvalReceiptId: string | null;
  proofReceiptIds: string[];
  outcomeReceiptId: string | null;
  brainUpdateReceiptId: string | null;
  proofRequired: string[];
  proofExecuted: string[];
  missingRequirements: string[];
  nextAction: string;
  replanTriggers: string[];
  brainUpdateCandidates: string[];
  evidence: EvidenceRef[];
  reasonCodes: string[];
}

export interface ProjectIntelligenceEngineeringLeadPlanSummary<
  EvidenceRef extends ProjectIntelligenceEngineeringLeadEvidenceRef =
    ProjectIntelligenceEngineeringLeadEvidenceRef,
> {
  version: typeof PROJECT_INTELLIGENCE_ENGINEERING_LEAD_PLAN_VERSION;
  contractVersion: typeof PROJECT_INTELLIGENCE_ENGINEERING_LEAD_CONTRACT_VERSION;
  posture: ProjectIntelligenceEngineeringLeadPosture;
  status: ProjectHealthCockpitStatus;
  score: number;
  headline: string;
  operatingMode: "advisory_fail_closed";
  nextAction: string;
  workersSpawned: 0;
  failClosedFallback: "main_agent";
  workPackages: ProjectIntelligenceEngineeringLeadWorkPackage<EvidenceRef>[];
  supervision: ProjectIntelligenceEngineeringLeadSupervision;
  executionReceipts?: ProjectIntelligenceEngineeringLeadExecutionReceipt<EvidenceRef>[];
  workerRecommendations: ProjectIntelligenceEngineeringLeadWorkerRecommendation<EvidenceRef>[];
  proofGates: string[];
  brainUpdateActions: string[];
  metrics: Array<{ label: string; value: string | number }>;
  evidence: EvidenceRef[];
  caveats: string[];
  reasonCodes: string[];
}
