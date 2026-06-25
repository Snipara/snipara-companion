export const PROJECT_HEALTH_COCKPIT_STATUSES = ["healthy", "watch", "risk", "unknown"] as const;

export const PROJECT_INTELLIGENCE_ENGINEERING_LEAD_PLAN_VERSION =
  "project-intelligence-engineering-lead-plan-v0" as const;

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

export type ProjectHealthCockpitStatus = (typeof PROJECT_HEALTH_COCKPIT_STATUSES)[number];

export type ProjectIntelligenceEngineeringLeadPosture =
  (typeof PROJECT_INTELLIGENCE_ENGINEERING_LEAD_POSTURES)[number];

export type ProjectIntelligenceEngineeringLeadWorkerRole =
  (typeof PROJECT_INTELLIGENCE_ENGINEERING_LEAD_WORKER_ROLES)[number];

export type ProjectIntelligenceEngineeringLeadRoutingMode =
  (typeof PROJECT_INTELLIGENCE_ENGINEERING_LEAD_ROUTING_MODES)[number];

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

export interface ProjectIntelligenceEngineeringLeadPlanSummary<
  EvidenceRef extends ProjectIntelligenceEngineeringLeadEvidenceRef =
    ProjectIntelligenceEngineeringLeadEvidenceRef,
> {
  version: typeof PROJECT_INTELLIGENCE_ENGINEERING_LEAD_PLAN_VERSION;
  posture: ProjectIntelligenceEngineeringLeadPosture;
  status: ProjectHealthCockpitStatus;
  score: number;
  headline: string;
  operatingMode: "advisory_fail_closed";
  nextAction: string;
  workersSpawned: 0;
  failClosedFallback: "main_agent";
  workerRecommendations: ProjectIntelligenceEngineeringLeadWorkerRecommendation<EvidenceRef>[];
  proofGates: string[];
  brainUpdateActions: string[];
  metrics: Array<{ label: string; value: string | number }>;
  evidence: EvidenceRef[];
  caveats: string[];
  reasonCodes: string[];
}
