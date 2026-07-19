/**
 * `workflow` commands — phase-based workflow continuity engine.
 *
 * Drives the managed workflow lifecycle: start, phase-start / phase-commit,
 * runtime checkpoints, resume, final-commit, timeline, and impact gates. State
 * persists under `.snipara/` (see WORKFLOW_STATE_RELATIVE_PATH and
 * WORKFLOW_PLANS_RELATIVE_DIR) so progress survives context compaction. Phase
 * commits reconcile with Team Sync work items and emit orchestrator handoffs.
 * The many `build*` / `normalize*` helpers here are pure and unit-tested via
 * the re-exports in index.ts.
 */
import * as fs from "fs";
import * as path from "path";
import {
  execFileSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import { createHash } from "node:crypto";
import chalk from "chalk";
import {
  createClient,
  type BusinessCollectionPreset,
  type CodeCallersResult,
  type CodeGraphEdgeResult,
  type CodeGraphNodeResult,
  type CodeImportsResult,
  type CodeNeighborsResult,
  type CodeShortestPathResult,
  normalizeSessionMemoriesResult,
  type ContextQueryResult,
  type ProjectAutomationSettings,
  type RecentAutomationEvent,
  type RecallResult,
  type SharedContextDocumentResult,
  type SharedContextResult,
  type SessionMemoriesResult,
  type SessionMemoryEntry,
  type SyncDocumentInput,
  type TeamSyncResumeResponse,
} from "../api/client";
import { createLocalQueryCache } from "../cache/query-cache";
import { findWorkspaceRoot, isConfigured, loadConfig } from "../config/store";
import {
  detectRuntimeEnvironment,
  formatOrchestratorRecommendationReason,
  getOrchestratorRecommendation,
  type OrchestratorRecommendation,
  shouldSuggestRuntimeForWorkflow,
} from "../runtime/detection";
import {
  buildAdaptiveWorkRoutingRecommendation,
  writeOrchestratorHandoff,
  type AdaptiveRoutingGatewayStatus,
  type AdaptiveRoutingRuntimeCatalog,
  type AdaptiveWorkRoutingRecommendation,
  type WrittenOrchestratorHandoff,
} from "../runtime/orchestrator-handoff";
import {
  buildCanonicalEvent,
  buildLocalContextPackReceipts,
  type LocalContextPackReceiptPayload,
} from "./events";
import {
  appendActivityEvent,
  readActivityTimeline,
  readSessionSnapshot,
  writeSessionSnapshot,
  type ActivityEventSource,
  type SessionSnapshot,
} from "./activity";
import { appendJournalCheckpoint, type JournalWriteResult } from "./journal";
import {
  buildCodingIntelligenceLedger,
  type CodingIntelligenceLedger,
} from "./coding-ledger";
import { buildLocalImpactResult } from "./code";
import {
  buildOutcomeIntelligenceReceipt,
  DECISION_RESPONSE_VERSION,
  buildDecisionRequest,
  stableDecisionJsonStringify,
  type OutcomeIntelligenceEvidence,
  type OutcomeIntelligenceReceipt,
  type DecisionRequest,
} from "../contracts/project-intelligence";
import {
  decisionPendingCount,
  listResolvedDecisionRecords,
  listPendingDecisionRequests,
  resolveDecisionRequest,
  writeDecisionRequest,
} from "./decision-requests";
import {
  buildDecisionApplyReport,
  type DecisionApplyItem,
} from "./decision-apply";
import { memoryGuardCheckCommand } from "./memory-guard";
import {
  workflowCollaborationRelease,
  workflowCollaborationStart,
  type WorkflowCollaborationReceipt,
} from "./collaboration";
import {
  buildMemoryReviewConnector,
  buildMemoryReviewDecisionRequest,
  type MemoryReviewConnectorItem,
} from "./memory";
import {
  autoArchiveTeamSyncState,
  buildTeamSyncHandoffRecord,
  buildTeamSyncSummary,
  completeTeamSyncStateFromEvidence,
  createTeamSyncStartWorkPayload,
  getTeamSyncStatePath,
  loadTeamSyncState,
  saveTeamSyncState,
  type TeamSyncHandoffRecord,
  type TeamSyncSummary,
  type TeamSyncStaleWorkExplanation,
  type TeamSyncWorkRecord,
} from "./team-sync";
import {
  resolveLocalWorkerRoutingDefaults,
  type LocalWorkerRoutingDefaults,
} from "./workers";
import {
  captureCompanionWhy,
  readLatestWorkflowCommands,
  type CompanionWhyCaptureReceipt,
} from "./why-capture";
import {
  buildFinalCommitReport,
  buildWorkflowPhaseCommitReceipt,
  formatFinalCommitReport,
  writeFinalCommitReport,
  type FinalCommitReportArtifact,
  type WorkflowPhaseCommitReceipt,
} from "./final-commit-report";
import {
  buildProjectIntelligenceRun,
  recordFirstPartyAdvisorReceipts,
  type ProjectIntelligenceRunEnvelope,
  type ProjectRunAdvisorReceiptCapture,
} from "./run";
import type { AdvisorInfluenceAgentDecision } from "../api/client";
import type { ProjectIntelligenceBrief } from "./intelligence";
import { formatProjectJudgmentCard, type ProjectIntelligenceJudgmentCard } from "./judgment-card";

const DEFAULT_SESSION_CONTEXT_TOKENS = 1000;
const DEFAULT_FULL_WORKFLOW_CRITICAL_TOKENS = 2000;
const DEFAULT_SHARED_CONTEXT_TOKENS = 2000;
const DEFAULT_WORKFLOW_RUN_TOKENS = 8000;
const MIN_WORKFLOW_SURFACE_TOKENS = 200;
const STALE_BOOTSTRAP_MEMORY_DAYS = 90;
const PROJECT_PROFILE_CATEGORY = "tenant_profile";
const OWNER_OPERATING_PROFILE_CATEGORY = "owner_operating_profile";
const TASK_COMMIT_TIMEOUT_MS = 30_000;
const FINAL_COMMIT_TIMEOUT_MS = 90_000;
const COMPANION_CONTINUITY_CONTRACT_VERSION = "snipara.companion.continuity.v1";
const FINAL_COMMIT_RETRY_TIMEOUT_MS = 45_000;
const FINAL_COMMIT_SUMMARY_MAX_CHARS = 1_200;
const FINAL_COMMIT_RETRY_SUMMARY_MAX_CHARS = 600;
const DEFAULT_ADAPTIVE_ROUTING_CATALOG_LIMIT = 20;
const DEFAULT_LOCAL_ORCHESTRATOR_TIMEOUT_MS = 8_000;
const ADAPTIVE_ROUTING_POLICY_RELATIVE_PATH = path.join(
  ".snipara",
  "adaptive-routing.json",
);
const MEMORY_DECISION_PRODUCER_ACTIONS = new Set([
  "accept",
  "reject",
  "archive",
  "invalidate",
  "merge",
  "supersede",
  "verify",
]);
const SHARED_CONTEXT_INTENT_PATTERN =
  /\b(standard|standards|convention|conventions|guideline|guidelines|best practice|best practices|policy|policies|compliance|compliant|security rules|team rules|style guide|playbook|checklist)\b/i;
type SyncDocumentKind = "DOC" | "BINARY";

const DOCUMENT_SYNC_FORMATS: Record<
  string,
  { kind: SyncDocumentKind; format: string }
> = {
  ".adoc": { kind: "DOC", format: "adoc" },
  ".markdown": { kind: "DOC", format: "markdown" },
  ".md": { kind: "DOC", format: "md" },
  ".mdx": { kind: "DOC", format: "mdx" },
  ".rst": { kind: "DOC", format: "rst" },
  ".txt": { kind: "DOC", format: "txt" },
  ".docx": { kind: "BINARY", format: "docx" },
  ".pdf": { kind: "BINARY", format: "pdf" },
  ".pptx": { kind: "BINARY", format: "pptx" },
  ".svg": { kind: "BINARY", format: "svg" },
  ".vsdx": { kind: "BINARY", format: "vsdx" },
};
const DEFAULT_SYNC_EXTENSIONS = new Set(Object.keys(DOCUMENT_SYNC_FORMATS));
const BUSINESS_ASSET_CLASSES = new Set([
  "BUSINESS_DOCUMENT",
  "PRESENTATION",
  "DIAGRAM",
]);
const BUSINESS_COLLECTION_PRESETS = new Set([
  "business_response_playbook",
  "business_library",
  "offer_templates",
  "company_presentations",
  "reference_diagrams",
]);
const BUSINESS_USAGE_ALIASES: Record<string, string> = {
  ACTIVE: "current_truth",
  CURRENT: "current_truth",
  CURRENT_TRUTH: "current_truth",
  CURRENT_CLIENT: "current_truth",
  HISTORICAL: "historical_reference",
  HISTORICAL_REFERENCE: "historical_reference",
  REFERENCE: "historical_reference",
  CASE_LIBRARY: "historical_reference",
  PAST_DELIVERABLE: "historical_reference",
  TEMPLATE: "template",
  GLOBAL_TEMPLATE: "template",
  GLOBAL: "global_knowledge",
  GLOBAL_KNOWLEDGE: "global_knowledge",
  BUSINESS_KNOWLEDGE: "global_knowledge",
  UNSPECIFIED: "unspecified",
};
const SOURCE_KINDS = new Set([
  "upload",
  "api",
  "mcp",
  "companion",
  "github",
  "google_drive",
  "microsoft_365",
  "llm_connector",
  "chatgpt_connector",
  "claude_connector",
  "codex_connector",
  "local_agent",
  "integrator",
  "unknown",
]);
const REUPLOAD_REASONS = new Set([
  "source_snapshot_expired",
  "source_modified_after_upload",
  "source_hash_changed",
]);

export type WorkflowMode =
  | "lite"
  | "standard"
  | "auto"
  | "full"
  | "orchestrate";
export type OnboardFolderMode =
  | "auto"
  | "business_context"
  | "code_project"
  | "mixed";
export type DetectedOnboardFolderMode =
  | "business_context"
  | "code_project"
  | "mixed"
  | "unknown";
export type ManagedWorkflowStatus = "active" | "completed" | "blocked";
export type ManagedWorkflowPhaseStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked"
  | "skipped";

type ReindexKind = "doc" | "code";
type ReindexMode = "incremental" | "full";
type ManagedWorkflowPlanSource = "file" | "inline";
type TaskCommitOutcome = "completed" | "partial" | "blocked" | "abandoned";
type ManagedWorkflowSchemaVersion =
  | "snipara.workflow.v1"
  | "snipara.workflow.v2";
type AdaptiveRoutingMode = "off" | "recommend" | "catalog";

interface AdaptiveRoutingProjectPolicy {
  source: "hosted_project" | "local_file";
  mode: AdaptiveRoutingMode;
  requireApproval: boolean;
  plannerRetainsReasoning: boolean;
  preferLocalWorkers: boolean;
  allowedEndpointTypes: string[];
  preferredEndpointTypes: string[];
  allowedWorkerClasses: string[];
  fallback: "main_agent";
  dailyBudgetCents: number;
  monthlyBudgetCents: number;
  catalogLimit?: number;
}

interface AdaptiveRoutingPolicyClient extends AdaptiveRoutingCatalogClient {
  getAutomationSettings(): Promise<{ settings: ProjectAutomationSettings }>;
}

interface AdaptiveRoutingIntent {
  shouldBuild: boolean;
  shouldUseHostedCatalog: boolean;
  warnings: string[];
}

export const WORKFLOW_STATE_RELATIVE_PATH = path.join(
  ".snipara",
  "workflow",
  "current.json",
);
export const WORKFLOW_PLANS_RELATIVE_DIR = path.join(
  ".snipara",
  "workflow",
  "plans",
);
export const PRODUCER_LOOP_ARTIFACT_VERSION =
  "snipara.producer_loop_artifact.v0" as const;
export const PRODUCER_LOOP_REPORT_VERSION =
  "snipara.producer_loop_report.v0" as const;
export const PRODUCER_LOOP_RELATIVE_DIR = path.join(
  ".snipara",
  "producer-loop",
);
const PRODUCER_LOOP_MIN_REVIEW_SAMPLE_SIZE = 5;

export type ProducerLoopProducerKind =
  | "workflow_phase_commit"
  | "workflow_final_commit"
  | "pr_answer_pack_decision_capture";

export type ProducerLoopCommand =
  | "workflow phase-commit"
  | "workflow final-commit"
  | "github-pr-answer-pack decision-capture";

export type ProducerLoopSampleReviewStatus =
  | "sample_unreviewed"
  | "sample_reviewed"
  | "sample_rejected";

export type ProducerLoopReviewOutcome =
  | "useful"
  | "false_positive"
  | "missing_context"
  | "unsafe"
  | "duplicate"
  | "other";

export interface ProducerLoopArtifactReview {
  status: Exclude<ProducerLoopSampleReviewStatus, "sample_unreviewed">;
  reviewedAt: string;
  reviewer?: string;
  outcome?: ProducerLoopReviewOutcome;
  notes: string[];
}

export interface ProducerLoopArtifact {
  schemaVersion: typeof PRODUCER_LOOP_ARTIFACT_VERSION;
  artifactId: string;
  generatedAt: string;
  producer: {
    kind: ProducerLoopProducerKind;
    command: ProducerLoopCommand;
    workflowId?: string;
    phaseId?: string;
    phaseTitle?: string;
    repository?: string;
    pullNumber?: number;
    sourceRef?: string;
    category: string;
    outcome?: TaskCommitOutcome | string;
    files: string[];
    candidateCount?: number;
    createdDecisionCount?: number;
    duplicateDecisionCount?: number;
    failedDecisionCount?: number;
  };
  source: {
    goal?: string;
    summary: string;
    status?: ManagedWorkflowStatus;
    sourceRef?: string;
  };
  ledger: CodingIntelligenceLedger | Record<string, unknown>;
  ledgerHash: string;
  localEvidence: {
    durableMemoryAttempted: boolean;
    journalAttempted?: boolean;
    teamSyncCompletionAttempted?: boolean;
    decisionCaptureAttempted?: boolean;
    serverSide?: boolean;
  };
  calibration: {
    status: ProducerLoopSampleReviewStatus;
    sampleSize: 1;
    hardGateReady: false;
    notes: string[];
  };
  review?: ProducerLoopArtifactReview;
  caveats: string[];
}

export interface ProducerLoopArtifactWriteResult {
  status: "written" | "error";
  schemaVersion: typeof PRODUCER_LOOP_ARTIFACT_VERSION;
  artifactId?: string;
  path?: string;
  relativePath?: string;
  artifactHash?: string;
  ledgerHash?: string;
  error?: string;
  caveats: string[];
}

export interface ProducerLoopArtifactReviewResult {
  status: "reviewed";
  schemaVersion: typeof PRODUCER_LOOP_ARTIFACT_VERSION;
  artifactId: string;
  path: string;
  relativePath: string;
  artifactHash: string;
  ledgerHash?: string;
  review: ProducerLoopArtifactReview;
  calibration: {
    status: ProducerLoopSampleReviewStatus;
    hardGateReady: false;
  };
  caveats: string[];
}

export interface ProducerLoopArtifactReportSummary {
  artifactId: string;
  generatedAt: string;
  producerKind: ProducerLoopProducerKind;
  workflowId?: string;
  phaseId?: string;
  phaseTitle?: string;
  outcome?: TaskCommitOutcome;
  summary?: string;
  path: string;
  relativePath: string;
  artifactHash: string;
  ledgerHash?: string;
  reasonCodes: string[];
  files: string[];
  calibrationStatus?: string;
  reviewStatus: ProducerLoopSampleReviewStatus;
  reviewOutcome?: string;
  reviewedAt?: string;
  reviewer?: string;
}

export interface WorkerExecutionReceiptReportSummary {
  receiptId: string;
  schemaVersion: string;
  recordedAt?: string;
  workerId: string;
  workCategory: string;
  routingCardRef?: string;
  workflowFingerprint?: string;
  executionActor: string;
  status?: string;
  reviewStatus: "review_pending" | "accepted" | "blocked";
  executed: boolean;
  receiptFamilyComplete: boolean;
  missingReceiptFamilies: string[];
  path: string;
  relativePath: string;
  reviewPath?: string;
  reviewRelativePath?: string;
}

export interface WorkerTrustReportRow {
  workerId: string;
  workCategory: string;
  state: "probation_supervised";
  sampleSize: number;
  executedSampleSize: number;
  reviewedSampleSize: number;
  verifiedSampleSize: number;
  blockedSampleSize: number;
  incompleteReceiptSampleSize: number;
  workflowFingerprints: string[];
  hardGateReady: false;
  nextRequired: string[];
}

export interface ProducerLoopReport {
  version: typeof PRODUCER_LOOP_REPORT_VERSION;
  generatedAt: string;
  source: {
    directory: string;
    localOnly: true;
  };
  adoption: {
    status: "missing" | "active";
    artifactCount: number;
    producerKinds: ProducerLoopProducerKind[];
    workflowIds: string[];
  };
  artifacts: ProducerLoopArtifactReportSummary[];
  latestArtifact?: ProducerLoopArtifactReportSummary;
  invalidArtifacts: Array<{
    path: string;
    relativePath: string;
    error: string;
  }>;
  reasonCodes: {
    counts: Record<string, number>;
  };
  workerReceipts: {
    sourceDirectories: string[];
    sampleSize: number;
    samples: WorkerExecutionReceiptReportSummary[];
    invalidArtifacts: Array<{
      path: string;
      relativePath: string;
      error: string;
    }>;
  };
  workerTrust: WorkerTrustReportRow[];
  calibration: {
    status: "no_samples" | "insufficient_samples" | "reviewable_sample_set";
    sampleSize: number;
    reviewedSampleSize: number;
    rejectedSampleSize: number;
    unreviewedSampleSize: number;
    minReviewSampleSize: number;
    reviewOutcomes: Record<string, number>;
    hardGateReady: false;
    notes: string[];
  };
  recommendedActions: string[];
  caveats: string[];
}

export type WorkflowPlanPreset =
  | "memory-backend-unification"
  | "project-intelligence-continuity-layer";
export const WORKFLOW_PLAN_PRESET_IDS: WorkflowPlanPreset[] = [
  "memory-backend-unification",
  "project-intelligence-continuity-layer",
];

export interface WorkflowPlanScaffoldDocument {
  preset: WorkflowPlanPreset;
  mode: "full";
  goal: string;
  steps: Array<{
    id: string;
    title: string;
    query: string;
    acceptance?: string;
    files?: string[];
    gates?: string[];
    needs_runtime?: boolean;
  }>;
}

export interface ManagedWorkflowRuntimeCheckpoint {
  summary: string;
  capturedAt: string;
  automationSessionId?: string;
  hostedEventId?: string;
  hostedRecordedAt?: string;
  environment?: string;
  profile?: string;
  bootstrapQuery?: string;
  files?: string[];
  commands?: string[];
  artifacts?: string[];
  contextPackReceipts?: LocalContextPackReceiptPayload[];
  rehydratableState?: Record<string, unknown>;
}

export interface ManagedWorkflowSandboxRuntimeBinding {
  phaseId: string;
  sessionId: string;
  automationSessionId?: string;
  boundAt: string;
  bootstrapQuery: string;
  environment?: string;
  profile?: string;
  artifacts?: string[];
  lastCheckpoint?: ManagedWorkflowRuntimeCheckpoint;
}

export interface ManagedWorkflowRuntimeState {
  sandbox?: {
    provider: "snipara-sandbox";
    bindings: ManagedWorkflowSandboxRuntimeBinding[];
  };
}

export type ManagedWorkflowCoordinationMode =
  | "standard"
  | "full"
  | "orchestrate";

export interface ManagedWorkflowCoordinationState {
  mode: ManagedWorkflowCoordinationMode;
  autoPublish: boolean;
  startedAt?: string;
  lastUpdatedAt?: string;
  workSessionId?: string;
  startReceipt?: WorkflowCollaborationReceipt;
  teamSyncReceipt?: Record<string, unknown>;
  releaseReceipt?: WorkflowCollaborationReceipt;
}

export interface ManagedWorkflowPhase {
  id: string;
  title: string;
  query: string;
  status: ManagedWorkflowPhaseStatus;
  acceptance?: string;
  files?: string[];
  gates?: string[];
  needsRuntime?: boolean;
  startedAt?: string;
  completedAt?: string;
  summary?: string;
  outcome?: TaskCommitOutcome;
}

export interface ManagedWorkflowJudgmentBrief {
  version: "project-intelligence-brief-v1";
  generatedAt: string;
  servedJudgmentId?: string;
  branch?: string;
  task?: string;
  changedFiles: string[];
  recentFiles: string[];
  errors: Array<{ surface: string; message: string }>;
  suggestedCommands: string[];
}

export interface ManagedWorkflowJudgmentResponse {
  recommendationId: string;
  decision: AdvisorInfluenceAgentDecision;
  respondedAt: string;
  planBefore?: string;
  planAfter?: string;
  initialReceipt?: ProjectRunAdvisorReceiptCapture;
  closeoutReceipt?: ProjectRunAdvisorReceiptCapture;
  outcomeReceipts?: OutcomeIntelligenceReceipt[];
}

export interface ManagedWorkflowJudgmentState {
  version: "snipara.workflow.judgment.v1";
  generatedAt: string;
  runEnvelope: ProjectIntelligenceRunEnvelope;
  brief: ManagedWorkflowJudgmentBrief;
  card: ProjectIntelligenceJudgmentCard;
  responses: ManagedWorkflowJudgmentResponse[];
}

export interface ManagedWorkflowState {
  schemaVersion: ManagedWorkflowSchemaVersion;
  workflowId: string;
  goal: string;
  status: ManagedWorkflowStatus;
  currentPhaseId?: string;
  planSource: ManagedWorkflowPlanSource;
  planFile?: string;
  createdAt: string;
  updatedAt: string;
  phases: ManagedWorkflowPhase[];
  runtime?: ManagedWorkflowRuntimeState;
  coordination?: ManagedWorkflowCoordinationState;
  judgment?: ManagedWorkflowJudgmentState;
  phaseCommitReceipts?: WorkflowPhaseCommitReceipt[];
  finalReport?: FinalCommitReportArtifact;
  lastCommit?: {
    category: string;
    outcome: TaskCommitOutcome;
    summary: string;
    committedAt: string;
  };
}

export interface AgenticWorkStatus {
  version: "snipara.agentic_status.v1";
  generatedAt: string;
  branch?: string;
  git: {
    head?: string;
    dirtyFileCount: number;
    statusLines: string[];
    error?: string;
  };
  workflow: {
    id: string;
    goal: string;
    status: ManagedWorkflowStatus;
    currentPhase?: {
      id: string;
      title: string;
      status: ManagedWorkflowPhaseStatus;
    };
    lastPhaseCommit?: {
      phaseId: string;
      title: string;
      summary?: string;
      outcome?: TaskCommitOutcome;
      completedAt?: string;
    };
    resumeCommand: string;
  } | null;
  teamSync: {
    activeWorkCount: number;
    staleWorkCount: number;
    staleWorkExplanation: TeamSyncStaleWorkExplanation;
    archivedWorkCount: number;
    handoffCount: number;
    latestHandoff?: {
      summary: string;
      next?: string;
      attention?: string;
      createdAt: string;
    };
  };
  risks: string[];
  openDecisions: {
    count?: number;
    note: string;
  };
  operationalLoop: {
    status: "clear" | "attention" | "blocked";
    decisionRequestCount: number;
    receiptGapCount: number;
    nextActions: string[];
    receiptActions: string[];
    caveats: string[];
  };
  suggestedNextAction: string;
}

export interface AgenticTimelineEvent {
  time: string;
  kind: string;
  title: string;
  detail?: string;
  source: ActivityEventSource;
  files?: string[];
}

export interface AgenticTimeline {
  version: "snipara.agentic_timeline.v1";
  generatedAt: string;
  events: AgenticTimelineEvent[];
  limit: number;
}

export interface WorkflowImpactGateCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author?: string;
  authoredAt?: string;
}

export interface WorkflowImpactGatePhase {
  id: string;
  title: string;
  summary?: string;
  outcome?: TaskCommitOutcome;
  completedAt?: string;
  files: string[];
  filesInUnpushedDiff: string[];
}

export interface WorkflowImpactGateResult {
  version: "snipara.workflow_impact_gate.v1";
  generatedAt: string;
  gate: {
    status: "pass" | "attention";
    reasonCodes: string[];
  };
  repo: {
    root: string;
    branch?: string;
    upstream: string;
    baseSha?: string;
    headSha?: string;
  };
  unpushed: {
    commitCount: number;
    commits: WorkflowImpactGateCommit[];
    changedFiles: string[];
    codeChangedFiles: string[];
    nonCodeChangedFiles: string[];
  };
  dirtyWorkingTree: {
    fileCount: number;
    statusLines: string[];
    files: string[];
    includedInLocalImpact: false;
  };
  workflow: {
    id?: string;
    goal?: string;
    status?: ManagedWorkflowStatus;
    completedPhases: WorkflowImpactGatePhase[];
    changedFilesWithoutPhase: string[];
    phaseFilesOutsideUnpushedDiff: string[];
  };
  localImpact: Record<string, unknown> | null;
  recommendedActions: string[];
  caveats: string[];
  hostedFollowUpCommand?: string;
}

export interface WorkflowPlanScaffoldResult {
  preset: WorkflowPlanPreset;
  goal: string;
  outputPath: string;
  relativeOutputPath: string;
  plan: WorkflowPlanScaffoldDocument;
}

function parseWorkflowPlanPreset(value: string): WorkflowPlanPreset {
  if (WORKFLOW_PLAN_PRESET_IDS.includes(value as WorkflowPlanPreset)) {
    return value as WorkflowPlanPreset;
  }
  throw new Error(
    `Unknown workflow scaffold preset '${value}'. Supported presets: ${WORKFLOW_PLAN_PRESET_IDS.join(
      ", ",
    )}.`,
  );
}

export interface SyncDocumentsManifestOptions {
  metadataDefaults: Record<string, unknown>;
  deleteMissing?: boolean;
  dryRun?: boolean;
  reindex?: boolean;
  reindexKind?: ReindexKind;
  reindexMode?: ReindexMode;
}

export interface CollectedSyncDocuments {
  documents: SyncDocumentInput[];
  manifestOptions: SyncDocumentsManifestOptions;
}

export interface SyncDocumentsDryRunItem {
  path: string;
  status: "valid" | "invalid_metadata";
  recommended_action: "none" | "reupload" | "review_source_metadata";
  reasons: string[];
  kind?: SyncDocumentKind;
  format?: string;
  size_bytes: number;
  content_hash: string;
  assetClass?: string;
  usageMode?: string;
  sourceKind?: string;
}

export interface SyncDocumentsDryRunSummary {
  dry_run: true;
  remote_diff_available: false;
  total: number;
  would_sync: number;
  invalid_metadata: number;
  stale: number;
  needs_reupload: number;
  needs_metadata_review: number;
  delete_missing: boolean;
  reindex_requested: boolean;
  reindex_kind: ReindexKind;
  reindex_mode: ReindexMode;
  created: null;
  updated: null;
  unchanged: null;
  missing_from_manifest: null;
  note: string;
  documents: SyncDocumentsDryRunItem[];
}

export interface OnboardFolderScannedFile {
  path: string;
  size_bytes: number;
  supported: boolean;
  kind?: SyncDocumentKind;
  format?: string;
}

export interface OnboardFolderClassification {
  mode: DetectedOnboardFolderMode;
  detected_mode: DetectedOnboardFolderMode;
  confidence: number;
  code_score: number;
  business_score: number;
  signals: {
    code: string[];
    business: string[];
  };
}

export interface OnboardFolderManifest {
  schemaVersion: "snipara.onboard-folder.v1";
  source: {
    root: string;
    sourceKind: string;
    sourceProvider: string;
    sourceUri?: string;
    snapshotAt: string;
    recursive: boolean;
  };
  classification: OnboardFolderClassification;
  summary: {
    total_files: number;
    supported_documents: number;
    ignored_files: number;
    unsupported_business_files: number;
  };
  warnings: string[];
  ignored: OnboardFolderScannedFile[];
  sync: {
    dryRun: boolean;
    reindex: boolean;
    reindexKind: ReindexKind;
    reindexMode: ReindexMode;
    deleteMissing: boolean;
    metadata: Record<string, unknown>;
    documents: SyncDocumentInput[];
  };
  dryRun: SyncDocumentsDryRunSummary;
}

function ensureConfigured(): void {
  if (!isConfigured()) {
    console.log(
      "Not configured. Run 'npx -y snipara-companion@latest init' first.",
    );
    process.exit(1);
  }
}

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function printKeyValue(label: string, value: string | number): void {
  console.log(`${chalk.cyan(label)} ${value}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const stringified = String(value).trim();
  return stringified || undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const text = stringValue(value);
  if (!text) {
    return undefined;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function normalizeEnum(value: unknown): string {
  return stringValue(value)?.replace(/[-\s]/g, "_").toUpperCase() ?? "";
}

function parseIsoDate(value: unknown): Date | undefined {
  const text = stringValue(value);
  if (!text) {
    return undefined;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function mergeRecords(
  ...records: Array<Record<string, unknown> | undefined>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const record of records) {
    if (!record) continue;
    for (const [key, value] of Object.entries(record)) {
      if (isRecord(value) && isRecord(merged[key])) {
        merged[key] = mergeRecords(
          merged[key] as Record<string, unknown>,
          value,
        );
      } else {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function parseJsonRecord(
  value: string,
  label: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `${label} must be valid JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function readJsonRecord(file: string, label: string): Record<string, unknown> {
  return parseJsonRecord(fs.readFileSync(file, "utf-8"), label);
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function normalizeBusinessCollectionPreset(
  value: string | undefined,
): BusinessCollectionPreset | undefined {
  const normalized = value?.trim().replace(/[-\s]/g, "_").toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (!BUSINESS_COLLECTION_PRESETS.has(normalized)) {
    throw new Error(
      "Business collection preset must be one of: business_response_playbook, business_library, offer_templates, company_presentations, reference_diagrams",
    );
  }
  return normalized as BusinessCollectionPreset;
}

function collectUploadMetadata(options: {
  metadata?: string;
  metadataFile?: string;
  assetClass?: string;
  usageMode?: string;
  sourceKind?: string;
  clientId?: string;
  sourceModifiedAt?: string;
  sourceSnapshotAt?: string;
}): Record<string, unknown> | undefined {
  const metadata = mergeRecords(
    options.metadataFile
      ? readJsonRecord(options.metadataFile, "--metadata-file")
      : undefined,
    options.metadata
      ? parseJsonRecord(options.metadata, "--metadata")
      : undefined,
    options.assetClass
      ? { assetClass: normalizeEnum(options.assetClass) }
      : undefined,
    options.usageMode ? { usageMode: options.usageMode } : undefined,
    options.sourceKind ? { sourceKind: options.sourceKind } : undefined,
    options.clientId ? { clientId: options.clientId } : undefined,
    options.sourceModifiedAt
      ? { sourceModifiedAt: options.sourceModifiedAt }
      : undefined,
    options.sourceSnapshotAt
      ? { sourceSnapshotAt: options.sourceSnapshotAt }
      : undefined,
  );
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalReindexKind(value: unknown): ReindexKind | undefined {
  return value === "doc" || value === "code" ? value : undefined;
}

function optionalReindexMode(value: unknown): ReindexMode | undefined {
  return value === "incremental" || value === "full" ? value : undefined;
}

function inferDocumentFormat(
  filePath: string,
): { kind: SyncDocumentKind; format: string } | undefined {
  return DOCUMENT_SYNC_FORMATS[path.extname(filePath).toLowerCase()];
}

function normalizeDocumentKind(value: unknown): SyncDocumentKind | undefined {
  const normalized = normalizeEnum(value);
  if (normalized === "DOC" || normalized === "BINARY") {
    return normalized;
  }
  return undefined;
}

function normalizeDocumentFormat(value: unknown): string | undefined {
  return stringValue(value)?.toLowerCase();
}

function isSupportedDocumentFormat(
  kind: SyncDocumentKind | undefined,
  format: string | undefined,
): boolean {
  if (!kind || !format) {
    return false;
  }
  return Object.values(DOCUMENT_SYNC_FORMATS).some(
    (candidate) => candidate.kind === kind && candidate.format === format,
  );
}

function isBinaryPayload(content: string): boolean {
  return (
    content.startsWith("base64:") ||
    (content.startsWith("data:") && content.includes(";base64,"))
  );
}

function contentBufferForHash(content: string): Buffer {
  if (content.startsWith("base64:")) {
    return Buffer.from(content.slice("base64:".length), "base64");
  }
  if (content.startsWith("data:") && content.includes(";base64,")) {
    return Buffer.from(content.split(";base64,", 2)[1] ?? "", "base64");
  }
  return Buffer.from(content, "utf8");
}

function hashContent(content: string): string {
  return createHash("sha256")
    .update(contentBufferForHash(content))
    .digest("hex");
}

function toPreview(value: unknown, maxLength: number = 160): string {
  if (typeof value === "string") {
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length > maxLength
      ? `${compact.slice(0, maxLength - 3)}...`
      : compact;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return `${value.length} item(s)`;
  }

  if (isRecord(value)) {
    const keys = Object.keys(value);
    return keys.length > 0 ? `object(${keys.join(", ")})` : "object";
  }

  return "n/a";
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
  const normalized = compactWhitespace(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  const suffix = " ... [truncated locally for hosted final-commit]";
  return `${normalized.slice(0, Math.max(0, maxLength - suffix.length)).trimEnd()}${suffix}`;
}

function buildHostedFinalCommitSummary(args: {
  workflowId?: string;
  summary: string;
  maxLength: number;
}): string {
  const prefix = args.workflowId
    ? `Workflow ${args.workflowId}\nFinal commit\n`
    : "";
  const budget = Math.max(80, args.maxLength - prefix.length);
  return `${prefix}${truncateText(args.summary, budget)}`;
}

function hostedCommitErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableHostedCommitError(error: unknown): boolean {
  const message = hostedCommitErrorMessage(error).toLowerCase();
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }
  return /abort|timeout|timed out|network|fetch|econn|etimedout|http 5\d\d/.test(
    message,
  );
}

function shouldRetryHostedFinalCommit(error: unknown): boolean {
  return isRetryableHostedCommitError(error);
}

function isFinalCommitCategory(category?: string): boolean {
  return Boolean(category?.toLowerCase().includes("final-commit"));
}

function normalizeFinalCommitCategory(category?: string): string {
  const normalized = compactWhitespace(category ?? "");
  if (!normalized) {
    return "final-commit";
  }
  return isFinalCommitCategory(normalized)
    ? normalized
    : `final-commit:${normalized}`;
}

export function getPlanStepDisplayTitle(
  step: unknown,
  index: number = 0,
): string {
  if (typeof step === "string") {
    return toPreview(step);
  }

  if (!isRecord(step)) {
    return `Step ${index + 1}`;
  }

  return toPreview(
    step.title ?? step.name ?? step.action ?? step.goal ?? `Step ${index + 1}`,
  );
}

export interface PlanQualityReport {
  valid: boolean;
  issues: string[];
  warnings: string[];
  stepCount: number;
  actions: string[];
  planId?: string;
}

export interface WorkflowTokenBudgetReport {
  requested_max_tokens: number;
  allocations: {
    critical_memory_tokens: number;
    session_context_tokens: number;
    context_query_tokens: number;
    shared_context_tokens: number;
    plan_tokens: number;
  };
  estimated_max_tokens: number;
  include_session_context: boolean;
  explicit: {
    max_critical_tokens: boolean;
    max_context_tokens: boolean;
  };
  warnings: string[];
}

export interface SessionBootstrapQualityReport {
  warnings: string[];
  counts: {
    critical_memories: number;
    session_context_memories: number;
    low_confidence_memories: number;
    stale_memories: number;
    test_memories: number;
  };
  total_tokens?: number;
  oldest_memory_age_days?: number;
}

export interface SessionBootstrapBrief {
  entries: SessionMemoryEntry[];
  availableCount: number;
  hiddenCount: number;
  estimatedTokens: number;
  budgetTokens: number;
}

export interface GeneratedWorkflowPlanDocument {
  mode: "full";
  goal: string;
  source: "snipara_plan";
  plan_id?: string;
  generatedAt: string;
  steps: Array<{
    id: string;
    title: string;
    query: string;
    acceptance?: string;
    files?: string[];
    needs_runtime?: boolean;
  }>;
}

export interface WrittenGeneratedPlanFile {
  path: string;
  relativePath: string;
}

function isPlaceholderPlanLabel(value: string, index: number): boolean {
  const normalized = compactWhitespace(value).replace(/[.:]+$/, "");
  return (
    normalized.length === 0 ||
    /^(?:step\s*)?\d+$/i.test(normalized) ||
    normalized.toLowerCase() === `step ${index + 1}`.toLowerCase()
  );
}

function normalizePositiveTokenBudget(
  value: number | undefined,
  fallback: number,
  allowZero: boolean = false,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (!allowZero && value === 0)
  ) {
    return fallback;
  }
  return Math.floor(value);
}

export function resolveFullWorkflowTokenBudget(options: {
  maxTokens?: number;
  includeSessionContext?: boolean;
  includeSharedContext?: boolean;
  maxCriticalTokens?: number;
  maxContextTokens?: number;
}): WorkflowTokenBudgetReport {
  const requestedMaxTokens = normalizePositiveTokenBudget(
    options.maxTokens,
    DEFAULT_WORKFLOW_RUN_TOKENS,
  );
  const explicitCritical = options.maxCriticalTokens !== undefined;
  const explicitContext = options.maxContextTokens !== undefined;
  const criticalMemoryTokens = explicitCritical
    ? normalizePositiveTokenBudget(options.maxCriticalTokens, 0, true)
    : Math.min(
        DEFAULT_FULL_WORKFLOW_CRITICAL_TOKENS,
        Math.max(
          MIN_WORKFLOW_SURFACE_TOKENS,
          Math.floor(requestedMaxTokens * 0.2),
        ),
      );
  const includeSessionContext = Boolean(
    options.includeSessionContext ||
    (explicitContext &&
      normalizePositiveTokenBudget(options.maxContextTokens, 0, true) > 0),
  );
  const sessionContextTokens = explicitContext
    ? normalizePositiveTokenBudget(options.maxContextTokens, 0, true)
    : includeSessionContext
      ? Math.min(
          DEFAULT_SESSION_CONTEXT_TOKENS,
          Math.max(
            Math.floor(MIN_WORKFLOW_SURFACE_TOKENS / 2),
            Math.floor(requestedMaxTokens * 0.1),
          ),
        )
      : 0;
  const warnings: string[] = [];
  const bootstrapTokens = criticalMemoryTokens + sessionContextTokens;
  const minimumRuntimeTokens =
    MIN_WORKFLOW_SURFACE_TOKENS * (options.includeSharedContext ? 3 : 2);
  const runtimeBudget = Math.max(
    requestedMaxTokens - bootstrapTokens,
    minimumRuntimeTokens,
  );
  const sharedContextTokens = options.includeSharedContext
    ? Math.min(
        DEFAULT_SHARED_CONTEXT_TOKENS,
        Math.max(MIN_WORKFLOW_SURFACE_TOKENS, Math.floor(runtimeBudget * 0.15)),
      )
    : 0;
  const remainingRuntimeBudget = Math.max(
    runtimeBudget - sharedContextTokens,
    MIN_WORKFLOW_SURFACE_TOKENS * 2,
  );
  const contextQueryTokens = Math.max(
    MIN_WORKFLOW_SURFACE_TOKENS,
    Math.floor(remainingRuntimeBudget * 0.7),
  );
  const planTokens = Math.max(
    MIN_WORKFLOW_SURFACE_TOKENS,
    remainingRuntimeBudget - contextQueryTokens,
  );
  const estimatedMaxTokens =
    criticalMemoryTokens +
    sessionContextTokens +
    contextQueryTokens +
    sharedContextTokens +
    planTokens;

  if (estimatedMaxTokens > requestedMaxTokens) {
    warnings.push(
      `Minimum viable FULL workflow surfaces require ${estimatedMaxTokens} tokens, above requested max_tokens ${requestedMaxTokens}.`,
    );
  }
  if (explicitCritical && criticalMemoryTokens > requestedMaxTokens * 0.5) {
    warnings.push(
      "Explicit max_critical_tokens consumes more than half of the workflow budget; context and plan quality may degrade.",
    );
  }
  if (
    explicitContext &&
    sessionContextTokens > 0 &&
    !options.includeSessionContext
  ) {
    warnings.push(
      "max_context_tokens was provided, so short-lived session context is included even without --include-session-context.",
    );
  }

  return {
    requested_max_tokens: requestedMaxTokens,
    allocations: {
      critical_memory_tokens: criticalMemoryTokens,
      session_context_tokens: sessionContextTokens,
      context_query_tokens: contextQueryTokens,
      shared_context_tokens: sharedContextTokens,
      plan_tokens: planTokens,
    },
    estimated_max_tokens: estimatedMaxTokens,
    include_session_context: includeSessionContext,
    explicit: {
      max_critical_tokens: explicitCritical,
      max_context_tokens: explicitContext,
    },
    warnings,
  };
}

function normalizePlanTerm(value: string): string {
  return value.endsWith("s") && value.length > 4 ? value.slice(0, -1) : value;
}

function extractPlanTerms(value: string): Set<string> {
  const stopTerms = new Set([
    "and",
    "are",
    "but",
    "for",
    "from",
    "into",
    "the",
    "this",
    "that",
    "with",
    "src",
    "lib",
    "app",
    "apps",
    "packages",
    "test",
    "tests",
  ]);
  const terms = new Set<string>();
  for (const match of value.toLowerCase().matchAll(/[a-z0-9][a-z0-9_-]{2,}/g)) {
    for (const part of match[0].split(/[_-]+/)) {
      const term = normalizePlanTerm(part);
      if (term.length >= 3 && !stopTerms.has(term)) {
        terms.add(term);
      }
    }
  }
  return terms;
}

function collectPlanFileHints(plan: Record<string, unknown>): string[] {
  const hints = new Set<string>();
  const addHints = (value: unknown) => {
    for (const item of normalizeStringArray(value) ?? []) {
      hints.add(item);
    }
  };

  addHints(plan.files);
  addHints(plan.likely_files);
  addHints(plan.files_touched);

  for (const step of Array.isArray(plan.steps) ? plan.steps : []) {
    if (!isRecord(step)) {
      continue;
    }
    const params = isRecord(step.params) ? step.params : undefined;
    addHints(step.files);
    addHints(step.files_touched);
    addHints(step.paths);
    addHints(step.likely_files);
    addHints(params?.files);
    addHints(params?.likely_files);
    addHints(params?.paths);
  }

  return [...hints];
}

function buildPlanRelevanceWarnings(
  plan: Record<string, unknown>,
  options: { query?: string; cwd?: string },
): string[] {
  const warnings: string[] = [];
  const fileHints = collectPlanFileHints(plan);
  const query = compactWhitespace(
    options.query ?? stringValue(plan.query) ?? "",
  );
  if (fileHints.length === 0 || query.length === 0) {
    return warnings;
  }

  const queryTerms = extractPlanTerms(query);
  const weakFileHints = fileHints.filter((fileHint) => {
    const fileTerms = extractPlanTerms(fileHint);
    return ![...fileTerms].some((term) => queryTerms.has(term));
  });
  if (weakFileHints.length === fileHints.length) {
    warnings.push(
      `Plan file hints have no obvious lexical overlap with the request; verify likely_files before starting implementation (${weakFileHints
        .slice(0, 4)
        .join(", ")}).`,
    );
  } else if (weakFileHints.length > 0) {
    warnings.push(
      `Some plan file hints look weakly related to the request: ${weakFileHints
        .slice(0, 4)
        .join(", ")}.`,
    );
  }

  if (options.cwd) {
    const missingHints = fileHints.filter((fileHint) => {
      if (/^(?:https?:)?\/\//i.test(fileHint)) {
        return false;
      }
      return !fs.existsSync(path.resolve(options.cwd as string, fileHint));
    });
    if (missingHints.length > 0) {
      warnings.push(
        `Plan references files not found in the local workspace: ${missingHints
          .slice(0, 4)
          .join(", ")}.`,
      );
    }
  }

  return warnings;
}

export function validatePlanResult(
  plan: unknown,
  options: { query?: string; cwd?: string } = {},
): PlanQualityReport {
  const issues: string[] = [];
  const warnings: string[] = [];
  const actions: string[] = [];

  if (!isRecord(plan)) {
    return {
      valid: false,
      issues: ["Plan result is not an object."],
      warnings,
      stepCount: 0,
      actions,
    };
  }

  if (typeof plan.error === "string" && plan.error.length > 0) {
    issues.push(`Hosted planner returned an error: ${plan.error}`);
  }

  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  if (steps.length === 0) {
    issues.push("Plan result has no executable steps.");
  }

  steps.forEach((step, index) => {
    if (typeof step === "string") {
      if (isPlaceholderPlanLabel(step, index)) {
        issues.push(`Step ${index + 1} has a placeholder label.`);
      }
      return;
    }

    if (!isRecord(step)) {
      issues.push(`Step ${index + 1} is not an object or string.`);
      return;
    }

    const action = stringValue(step.action);
    if (action) {
      actions.push(action);
      if (isPlaceholderPlanLabel(action, index)) {
        issues.push(`Step ${index + 1} has a placeholder action.`);
      }
    }

    const labelSource =
      stringValue(step.title) ??
      stringValue(step.name) ??
      action ??
      stringValue(step.goal) ??
      stringValue(step.query) ??
      stringValue(step.description);
    if (!labelSource || isPlaceholderPlanLabel(labelSource, index)) {
      issues.push(`Step ${index + 1} is missing a useful title or action.`);
    }

    const expectedOutput = stringValue(step.expected_output);
    if (
      !expectedOutput &&
      !stringValue(step.acceptance) &&
      !stringValue(step.verify)
    ) {
      issues.push(
        `Step ${index + 1} is missing expected output or acceptance criteria.`,
      );
    }

    const params = isRecord(step.params) ? step.params : undefined;
    if (params && Object.prototype.hasOwnProperty.call(params, "max_tokens")) {
      const rawMaxTokens = params.max_tokens;
      const maxTokens =
        typeof rawMaxTokens === "number"
          ? rawMaxTokens
          : typeof rawMaxTokens === "string"
            ? Number(rawMaxTokens)
            : Number.NaN;
      if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
        issues.push(`Step ${index + 1} has an invalid max_tokens budget.`);
      }
    }
  });

  warnings.push(...buildPlanRelevanceWarnings(plan, options));

  return {
    valid: issues.length === 0,
    issues,
    warnings,
    stepCount: steps.length,
    actions,
    ...(stringValue(plan.plan_id) ? { planId: stringValue(plan.plan_id) } : {}),
  };
}

function readBootstrapEntryText(entry: SessionMemoryEntry): string {
  return compactWhitespace(
    [entry.text, entry.content, entry.summary, entry.title]
      .filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      )
      .join(" "),
  );
}

function entryAgeDays(
  entry: SessionMemoryEntry,
  now: Date,
): number | undefined {
  if (
    typeof entry.created_at !== "string" ||
    entry.created_at.trim().length === 0
  ) {
    return undefined;
  }
  const createdAt = new Date(entry.created_at);
  if (Number.isNaN(createdAt.getTime())) {
    return undefined;
  }
  return Math.max(
    0,
    Math.floor((now.getTime() - createdAt.getTime()) / 86_400_000),
  );
}

function isLikelyTestMemory(entry: SessionMemoryEntry): boolean {
  const type = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
  const category =
    typeof entry.category === "string" ? entry.category.toLowerCase() : "";
  const text = readBootstrapEntryText(entry).toLowerCase();
  return type === "test" || category === "test" || /^test memory\b/.test(text);
}

function readBootstrapEntryId(entry: SessionMemoryEntry): string {
  return (
    stringValue(entry.id) ??
    stringValue(entry.memory_id) ??
    `${stringValue(entry.type) ?? "memory"}:${readBootstrapEntryText(entry).slice(0, 80)}`
  );
}

function isSessionCarryoverEntry(entry: SessionMemoryEntry): boolean {
  const category =
    typeof entry.category === "string" ? entry.category.toLowerCase() : "";
  const text = readBootstrapEntryText(entry).toLowerCase();
  return (
    category.includes("team_sync_handoff") ||
    category.includes("journal:") ||
    category.includes("workflow-phase") ||
    text.includes("checkpoint: workflow:final-commit") ||
    text.includes("final commit") ||
    text.includes("phase-commit") ||
    text.includes("handoff")
  );
}

function isOwnerOperatingProfileEntry(entry: SessionMemoryEntry): boolean {
  return (
    typeof entry.category === "string" &&
    entry.category.toLowerCase() === OWNER_OPERATING_PROFILE_CATEGORY
  );
}

function isProjectProfileEntry(entry: SessionMemoryEntry): boolean {
  return (
    typeof entry.category === "string" &&
    entry.category.toLowerCase() === PROJECT_PROFILE_CATEGORY
  );
}

function isPinnedBootstrapProfileEntry(entry: SessionMemoryEntry): boolean {
  return isProjectProfileEntry(entry) || isOwnerOperatingProfileEntry(entry);
}

function isLikelyStaleBootstrapEntry(
  entry: SessionMemoryEntry,
  now: Date,
): boolean {
  const age = entryAgeDays(entry, now);
  const text = readBootstrapEntryText(entry).toLowerCase();
  return (
    (typeof age === "number" &&
      age > STALE_BOOTSTRAP_MEMORY_DAYS &&
      !isPinnedBootstrapProfileEntry(entry)) ||
    (typeof entry.confidence === "number" && entry.confidence < 0.5) ||
    text.includes("/users/alopez/devs/snipara/.env") ||
    text.includes("rlm_remember") ||
    text.includes("rlm_recall") ||
    text.includes("railway") ||
    text.includes("vercel") ||
    text.includes("memory injection feature is complete") ||
    text.includes("infotooltip component created") ||
    text.includes("mcp performance optimizations (jan 2026)")
  );
}

function scoreBootstrapBriefEntry(
  entry: SessionMemoryEntry,
  source: "critical" | "daily",
  now: Date,
): number {
  let score = source === "daily" ? 100 : 0;
  const age = entryAgeDays(entry, now);
  const type = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
  const category =
    typeof entry.category === "string" ? entry.category.toLowerCase() : "";
  const text = readBootstrapEntryText(entry).toLowerCase();

  if (isSessionCarryoverEntry(entry)) {
    score += 90;
  }
  if (type === "decision") {
    score += 25;
    const authorityStatus = bootstrapAuthorityStatus(entry);
    if (authorityStatus === "canonical") {
      score += 55;
    } else if (
      authorityStatus === "approved" ||
      authorityStatus === "authoritative"
    ) {
      score += 20;
    }
  } else if (type === "context") {
    score += 20;
  } else if (type === "learning") {
    score += 10;
  }
  if (category.includes("journal:") || category.includes("workflow-phase")) {
    score += 40;
  }
  if (category.includes("team_sync_handoff")) {
    score += 55;
  }
  if (
    text.includes("control plane") ||
    text.includes("control-plane") ||
    text.includes("lite")
  ) {
    score += 35;
  }
  if (
    text.includes("published") ||
    text.includes("deployed") ||
    text.includes("data-dpl-id")
  ) {
    score += 25;
  }
  if (typeof entry.confidence === "number") {
    score += Math.max(0, Math.min(25, entry.confidence * 25));
    if (entry.confidence < 0.5) {
      score -= 90;
    }
  }
  if (typeof age === "number") {
    if (age <= 1) {
      score += 65;
    } else if (age <= 7) {
      score += 45;
    } else if (age <= 30) {
      score += 20;
    } else if (age > STALE_BOOTSTRAP_MEMORY_DAYS) {
      score -= 100;
    }
  }
  if (isLikelyTestMemory(entry)) {
    score -= 120;
  }
  if (isLikelyStaleBootstrapEntry(entry, now)) {
    score -= 80;
  }
  return score;
}

function estimateBootstrapEntryTokens(entry: SessionMemoryEntry): number {
  return Math.max(8, Math.ceil(compactSessionEntryLine(entry).length / 4));
}

function bootstrapEntryType(entry: SessionMemoryEntry): string {
  return typeof entry.type === "string" ? entry.type.toLowerCase() : "";
}

function isBootstrapDecisionEntry(entry: SessionMemoryEntry): boolean {
  return bootstrapEntryType(entry) === "decision";
}

function bootstrapAuthorityStatus(entry: SessionMemoryEntry): string {
  const authority = isRecord(entry.authority) ? entry.authority : undefined;
  return (
    stringValue(entry.authority_status) ??
    stringValue(authority?.authorityStatus) ??
    stringValue(authority?.level) ??
    ""
  ).toLowerCase();
}

function bootstrapSimilarityTokens(entry: SessionMemoryEntry): Set<string> {
  const stopWords = new Set([
    "checkpoint",
    "workflow",
    "final",
    "commit",
    "phase",
    "summary",
    "context",
    "team",
    "sync",
    "handoff",
    "released",
    "release",
  ]);
  const text = readSessionEntryPreview(entry)
    .toLowerCase()
    .replace(/snipara-companion@\d+\.\d+\.\d+/g, "snipara-companion")
    .replace(/[^a-z0-9]+/g, " ");
  return new Set(
    text
      .split(/\s+/)
      .filter((token) => token.length >= 4 && !stopWords.has(token)),
  );
}

function buildBootstrapTopicTokens(
  ranked: Array<{
    entry: SessionMemoryEntry;
    source: "critical" | "daily";
    score: number;
  }>,
): Set<string> {
  const tokens = new Set<string>();
  for (const candidate of ranked) {
    if (tokens.size >= 48) {
      break;
    }
    if (candidate.score <= 0 || !isSessionCarryoverEntry(candidate.entry)) {
      continue;
    }
    for (const token of bootstrapSimilarityTokens(candidate.entry)) {
      tokens.add(token);
    }
  }
  return tokens;
}

function isDecisionRelevantToBootstrap(
  entry: SessionMemoryEntry,
  topicTokens: Set<string>,
  hasCarryoverCandidate: boolean,
): boolean {
  if (!isBootstrapDecisionEntry(entry)) {
    return false;
  }
  if (!hasCarryoverCandidate) {
    return true;
  }
  const text = readBootstrapEntryText(entry).toLowerCase();
  const hasExplicitTopic =
    text.includes("control plane") ||
    text.includes("control-plane") ||
    text.includes("lite") ||
    text.includes("session-bootstrap") ||
    text.includes("bootstrap brief");
  if (hasExplicitTopic) {
    return true;
  }
  const category =
    typeof entry.category === "string" ? entry.category.toLowerCase() : "";
  if (
    category.includes("workflow-phase") ||
    category.includes("final-commit") ||
    category.includes("journal:") ||
    category.includes("team_sync")
  ) {
    return false;
  }
  let overlap = 0;
  for (const token of bootstrapSimilarityTokens(entry)) {
    if (topicTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap >= 3;
}

function areBootstrapEntriesSimilar(
  a: SessionMemoryEntry,
  b: SessionMemoryEntry,
): boolean {
  const aTokens = bootstrapSimilarityTokens(a);
  const bTokens = bootstrapSimilarityTokens(b);
  if (aTokens.size === 0 || bTokens.size === 0) {
    return false;
  }
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) {
      overlap += 1;
    }
  }
  const smaller = Math.min(aTokens.size, bTokens.size);
  const larger = Math.max(aTokens.size, bTokens.size);
  return overlap / smaller >= 0.6 || (overlap >= 8 && overlap / larger >= 0.5);
}

export function buildSessionBootstrapBrief(
  result: SessionMemoriesResult,
  options: {
    includeSessionContext: boolean;
    maxTokens?: number;
    maxEntries?: number;
    now?: Date;
  },
): SessionBootstrapBrief {
  const normalized = normalizeSessionMemoriesResult(result);
  const now = options.now ?? new Date();
  const maxEntries = Math.max(1, Math.min(options.maxEntries ?? 4, 5));
  const budgetTokens = normalizePositiveTokenBudget(
    options.maxTokens,
    600,
    true,
  );
  const candidates = [
    ...normalized.critical.memories.map((entry) => ({
      entry,
      source: "critical" as const,
    })),
    ...(options.includeSessionContext
      ? normalized.daily.memories.map((entry) => ({
          entry,
          source: "daily" as const,
        }))
      : []),
  ];
  const projectProfile = candidates.find(
    (candidate) =>
      (normalized.profiles?.project_memory_id &&
        readBootstrapEntryId(candidate.entry) ===
          normalized.profiles.project_memory_id) ||
      isProjectProfileEntry(candidate.entry),
  )?.entry;
  const ownerProfile = candidates.find(
    (candidate) =>
      (normalized.profiles?.owner_memory_id &&
        readBootstrapEntryId(candidate.entry) ===
          normalized.profiles.owner_memory_id) ||
      isOwnerOperatingProfileEntry(candidate.entry),
  )?.entry;
  const pinnedProfiles = [projectProfile, ownerProfile].filter(
    (entry): entry is SessionMemoryEntry => Boolean(entry),
  );
  const seen = new Set<string>();
  const entries: SessionMemoryEntry[] = [];
  let estimatedTokens = 0;
  for (const profile of pinnedProfiles) {
    const profileTokens = estimateBootstrapEntryTokens(profile);
    const profileId = readBootstrapEntryId(profile);
    const profileText = readBootstrapEntryText(profile)
      .slice(0, 140)
      .toLowerCase();
    const key = profileId || profileText;
    if (
      entries.length < maxEntries &&
      !seen.has(key) &&
      estimatedTokens + profileTokens <= budgetTokens
    ) {
      seen.add(key);
      entries.push(profile);
      estimatedTokens += profileTokens;
    }
  }
  const reservedEntryCount = entries.length;
  const remainingEntrySlots = maxEntries - reservedEntryCount;
  const selectedProjectProfileId = projectProfile
    ? readBootstrapEntryId(projectProfile)
    : undefined;
  const ranked = candidates
    .filter(
      (candidate) =>
        !isOwnerOperatingProfileEntry(candidate.entry) &&
        candidate.entry !== projectProfile &&
        !(
          selectedProjectProfileId &&
          readBootstrapEntryId(candidate.entry) === selectedProjectProfileId
        ),
    )
    .map((candidate, index) => ({
      ...candidate,
      index,
      score: scoreBootstrapBriefEntry(candidate.entry, candidate.source, now),
    }))
    .sort((a, b) => b.score - a.score || b.index - a.index);
  const hasFreshCandidate =
    ranked.some(
      (candidate) =>
        candidate.score > 0 &&
        !isLikelyStaleBootstrapEntry(candidate.entry, now) &&
        !isLikelyTestMemory(candidate.entry),
    ) || reservedEntryCount > 0;
  const topicTokens = buildBootstrapTopicTokens(ranked);
  const hasCarryoverCandidate = ranked.some(
    (candidate) =>
      candidate.score > 0 &&
      isSessionCarryoverEntry(candidate.entry) &&
      !isLikelyStaleBootstrapEntry(candidate.entry, now) &&
      !isLikelyTestMemory(candidate.entry),
  );
  const hasFreshDecisionCandidate =
    maxEntries >= 4 &&
    remainingEntrySlots > 0 &&
    ranked.some(
      (candidate) =>
        candidate.score > 0 &&
        isDecisionRelevantToBootstrap(
          candidate.entry,
          topicTokens,
          hasCarryoverCandidate,
        ) &&
        !isLikelyStaleBootstrapEntry(candidate.entry, now) &&
        !isLikelyTestMemory(candidate.entry),
    );
  let selectedCarryoverCount = 0;
  let selectedDecisionCount = 0;

  for (const candidate of ranked) {
    if (entries.length >= maxEntries) {
      break;
    }
    if (
      hasFreshCandidate &&
      (isLikelyStaleBootstrapEntry(candidate.entry, now) ||
        isLikelyTestMemory(candidate.entry))
    ) {
      continue;
    }
    const id = readBootstrapEntryId(candidate.entry);
    const textKey = readBootstrapEntryText(candidate.entry)
      .slice(0, 140)
      .toLowerCase();
    const key = id || textKey;
    if (seen.has(key)) {
      continue;
    }
    if (
      entries.some((entry) =>
        areBootstrapEntriesSimilar(entry, candidate.entry),
      )
    ) {
      continue;
    }
    const isCarryover = isSessionCarryoverEntry(candidate.entry);
    const isDecision = isBootstrapDecisionEntry(candidate.entry);
    if (
      isDecision &&
      !isDecisionRelevantToBootstrap(
        candidate.entry,
        topicTokens,
        hasCarryoverCandidate,
      )
    ) {
      continue;
    }
    if (
      hasFreshDecisionCandidate &&
      selectedDecisionCount === 0 &&
      isCarryover &&
      selectedCarryoverCount >= Math.max(0, remainingEntrySlots - 1)
    ) {
      continue;
    }
    const entryTokens = estimateBootstrapEntryTokens(candidate.entry);
    if (entries.length > 0 && estimatedTokens + entryTokens > budgetTokens) {
      continue;
    }
    seen.add(key);
    entries.push(candidate.entry);
    estimatedTokens += entryTokens;
    if (isCarryover) {
      selectedCarryoverCount += 1;
    }
    if (isDecision) {
      selectedDecisionCount += 1;
    }
    if (entries.length >= maxEntries) {
      break;
    }
  }

  return {
    entries,
    availableCount: candidates.length,
    hiddenCount: Math.max(0, candidates.length - entries.length),
    estimatedTokens,
    budgetTokens,
  };
}

export function buildSessionBootstrapQuality(
  result: SessionMemoriesResult,
  options: { expectedMaxTokens?: number; now?: Date } = {},
): SessionBootstrapQualityReport {
  const normalized = normalizeSessionMemoriesResult(result);
  const now = options.now ?? new Date();
  const memories = [
    ...normalized.critical.memories,
    ...normalized.daily.memories,
  ];
  const ages = memories
    .map((entry) => entryAgeDays(entry, now))
    .filter((age): age is number => typeof age === "number");
  const lowConfidenceCount = memories.filter(
    (entry) => typeof entry.confidence === "number" && entry.confidence < 0.5,
  ).length;
  const staleCount = ages.filter(
    (age) => age > STALE_BOOTSTRAP_MEMORY_DAYS,
  ).length;
  const testCount = memories.filter((entry) =>
    isLikelyTestMemory(entry),
  ).length;
  const warnings: string[] = [];

  if (
    typeof normalized.total_tokens === "number" &&
    typeof options.expectedMaxTokens === "number" &&
    normalized.total_tokens > options.expectedMaxTokens
  ) {
    warnings.push(
      `Bootstrap returned ${normalized.total_tokens} tokens, above requested bootstrap budget ${options.expectedMaxTokens}.`,
    );
  }
  if (lowConfidenceCount > 0) {
    warnings.push(
      `${lowConfidenceCount} bootstrap memories have confidence below 0.5.`,
    );
  }
  if (staleCount > 0) {
    warnings.push(
      `${staleCount} bootstrap memories are older than ${STALE_BOOTSTRAP_MEMORY_DAYS} days; verify before relying on them.`,
    );
  }
  if (testCount > 0) {
    warnings.push(
      `${testCount} bootstrap memories look like test fixtures and should be ignored.`,
    );
  }

  return {
    warnings,
    counts: {
      critical_memories: normalized.critical.count,
      session_context_memories: normalized.daily.count,
      low_confidence_memories: lowConfidenceCount,
      stale_memories: staleCount,
      test_memories: testCount,
    },
    ...(typeof normalized.total_tokens === "number"
      ? { total_tokens: normalized.total_tokens }
      : {}),
    ...(ages.length > 0 ? { oldest_memory_age_days: Math.max(...ages) } : {}),
  };
}

function normalizeStringArray(value: unknown): string[] | undefined {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : undefined;
  if (!raw) {
    return undefined;
  }

  const items = raw
    .map((item) => stringValue(item))
    .filter((item): item is string => Boolean(item));
  return items.length > 0 ? items : undefined;
}

function isUsableGeneratedStepQuery(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && !trimmed.startsWith("$step");
}

function planStepToWorkflowStep(
  step: unknown,
  index: number,
  fallbackGoal: string,
): GeneratedWorkflowPlanDocument["steps"][number] {
  const title = getPlanStepDisplayTitle(step, index);
  const fallbackQuery = `${fallbackGoal}: ${title}`;

  if (!isRecord(step)) {
    return {
      id: sanitizeWorkflowId(title, `phase-${index + 1}`),
      title,
      query: typeof step === "string" ? step : fallbackQuery,
    };
  }

  const params = isRecord(step.params) ? step.params : undefined;
  const query =
    stringValue(step.query) ??
    stringValue(step.goal) ??
    stringValue(step.description) ??
    (isUsableGeneratedStepQuery(params?.query) ? params.query : undefined) ??
    fallbackQuery;
  const acceptance =
    stringValue(step.acceptance) ??
    stringValue(step.expected_output) ??
    stringValue(step.done_when) ??
    stringValue(step.verify);
  const likelyFiles =
    params && step.action === "implementation_map"
      ? normalizeStringArray(params.likely_files)
      : (normalizeStringArray(step.files) ??
        normalizeStringArray(step.files_touched) ??
        normalizeStringArray(step.paths));

  return {
    id: sanitizeWorkflowId(
      stringValue(step.id) ??
        stringValue(step.phase_id) ??
        stringValue(step.key) ??
        title,
      `phase-${index + 1}`,
    ),
    title,
    query,
    ...(acceptance ? { acceptance } : {}),
    ...(likelyFiles ? { files: likelyFiles } : {}),
    ...(booleanValue(step.needs_runtime ?? step.runtime) !== undefined
      ? {
          needs_runtime: Boolean(
            booleanValue(step.needs_runtime ?? step.runtime),
          ),
        }
      : {}),
  };
}

export function buildGeneratedWorkflowPlanDocument(
  plan: Record<string, unknown>,
  fallbackGoal: string,
): GeneratedWorkflowPlanDocument {
  const goal = stringValue(plan.query) ?? fallbackGoal;
  const steps = findWorkflowSteps(plan).map((step, index) =>
    planStepToWorkflowStep(step, index, goal),
  );

  return {
    mode: "full",
    goal,
    source: "snipara_plan",
    ...(stringValue(plan.plan_id)
      ? { plan_id: stringValue(plan.plan_id) }
      : {}),
    generatedAt: new Date().toISOString(),
    steps,
  };
}

function defaultGeneratedPlanFilePath(query: string): string {
  const filename = `${sanitizeWorkflowId(query, "snipara-plan")}-plan.json`;
  return path.join(process.cwd(), WORKFLOW_PLANS_RELATIVE_DIR, filename);
}

function writeGeneratedWorkflowPlanFile(
  plan: Record<string, unknown>,
  fallbackGoal: string,
  outputFile?: string,
): WrittenGeneratedPlanFile {
  const outputPath = path.resolve(
    outputFile ?? defaultGeneratedPlanFilePath(fallbackGoal),
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    `${JSON.stringify(buildGeneratedWorkflowPlanDocument(plan, fallbackGoal), null, 2)}\n`,
    "utf8",
  );
  return {
    path: outputPath,
    relativePath:
      path.relative(process.cwd(), outputPath) || path.basename(outputPath),
  };
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  const text = stringValue(value)?.toLowerCase();
  if (!text) {
    return undefined;
  }
  if (["true", "yes", "1", "required"].includes(text)) {
    return true;
  }
  if (["false", "no", "0", "optional"].includes(text)) {
    return false;
  }
  return undefined;
}

function uniqueStringList(
  values: Array<string | undefined> | undefined,
): string[] | undefined {
  if (!values) {
    return undefined;
  }
  const unique = Array.from(
    new Set(
      values
        .map((value) => stringValue(value))
        .filter((value): value is string => Boolean(value)),
    ),
  );
  return unique.length > 0 ? unique : undefined;
}

function sanitizeWorkflowId(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || fallback;
}

function uniquePhaseId(
  candidate: string,
  index: number,
  used: Set<string>,
): string {
  const base = sanitizeWorkflowId(candidate, `phase-${index + 1}`);
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(id);
  return id;
}

function findWorkflowSteps(input: unknown): unknown[] {
  if (Array.isArray(input)) {
    return input;
  }
  if (!isRecord(input)) {
    return [];
  }

  for (const key of ["phases", "steps", "tasks", "items"]) {
    if (Array.isArray(input[key])) {
      return input[key] as unknown[];
    }
  }

  if (isRecord(input.plan)) {
    return findWorkflowSteps(input.plan);
  }

  if (Array.isArray(input.plan)) {
    return input.plan;
  }

  return [];
}

function normalizeWorkflowPhase(
  step: unknown,
  index: number,
  usedIds: Set<string>,
  fallbackGoal: string,
): ManagedWorkflowPhase {
  if (typeof step === "string") {
    const title = toPreview(step, 120);
    return {
      id: uniquePhaseId(title, index, usedIds),
      title,
      query: step,
      status: "pending",
    };
  }

  if (!isRecord(step)) {
    const title = `Phase ${index + 1}`;
    return {
      id: uniquePhaseId(title, index, usedIds),
      title,
      query: fallbackGoal,
      status: "pending",
    };
  }

  const title =
    stringValue(step.title) ??
    stringValue(step.name) ??
    stringValue(step.action) ??
    stringValue(step.goal) ??
    `Phase ${index + 1}`;
  const query =
    stringValue(step.query) ??
    stringValue(step.goal) ??
    stringValue(step.description) ??
    stringValue(step.action) ??
    `${fallbackGoal}: ${title}`;
  const id = uniquePhaseId(
    stringValue(step.id) ??
      stringValue(step.phase_id) ??
      stringValue(step.key) ??
      title,
    index,
    usedIds,
  );
  const files =
    normalizeStringArray(step.files) ??
    normalizeStringArray(step.files_touched) ??
    normalizeStringArray(step.paths);
  const acceptance =
    stringValue(step.acceptance) ??
    stringValue(step.expected_output) ??
    stringValue(step.done_when) ??
    stringValue(step.verify);

  return {
    id,
    title,
    query,
    status: "pending",
    ...(acceptance ? { acceptance } : {}),
    ...(files ? { files } : {}),
    ...(normalizeStringArray(step.gates)
      ? { gates: normalizeStringArray(step.gates) }
      : {}),
    ...(booleanValue(step.needs_runtime ?? step.runtime) !== undefined
      ? {
          needsRuntime: Boolean(
            booleanValue(step.needs_runtime ?? step.runtime),
          ),
        }
      : {}),
  };
}

function stripWorkflowMarkdownLine(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^[-*]\s+/, "")
    .trim();
}

function isWorkflowSectionMarker(line: string): boolean {
  return /^(phases|steps|tasks|items)\s*:?\s*$/i.test(
    stripWorkflowMarkdownLine(line),
  );
}

function isWorkflowMetaLine(line: string): boolean {
  return /^(goal|status|mode|date|audience)\s*:/i.test(
    stripWorkflowMarkdownLine(line),
  );
}

function matchWorkflowListItem(
  line: string,
): { indent: number; text: string } | undefined {
  const match = line.match(/^(\s*)(?:\d+[.)]|[-*])\s+(\S.*)$/);
  if (!match) {
    return undefined;
  }
  return {
    indent: match[1]?.length ?? 0,
    text: match[2]?.trim() ?? "",
  };
}

function isIndentedWorkflowDetail(line: string): boolean {
  return /^\s{2,}(?:[-*]|\d+[.)])\s+\S/.test(line);
}

function parseWorkflowPlanText(
  content: string,
  fallbackGoal: string,
): unknown[] {
  const rawLines = content.split(/\r?\n/);
  const lines: string[] = [];
  let inFence = false;

  for (const rawLine of rawLines) {
    if (/^\s*```/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      lines.push(rawLine);
    }
  }

  const explicitSectionIndex = lines.findIndex((line) =>
    isWorkflowSectionMarker(line),
  );
  const phaseStartIndex =
    explicitSectionIndex >= 0 ? explicitSectionIndex + 1 : 0;
  const hasTopLevelList = lines.some((line) =>
    Boolean(matchWorkflowListItem(line)),
  );

  const parsedPhases: Array<{
    title: string;
    query: string;
    acceptance?: string;
  }> = [];
  let currentPhase:
    | {
        title: string;
        details: string[];
      }
    | undefined;
  let phaseIndent: number | undefined;

  const flushCurrentPhase = () => {
    if (!currentPhase) {
      return;
    }

    const details = currentPhase.details.filter(Boolean);
    parsedPhases.push({
      title: currentPhase.title,
      query: [
        currentPhase.title,
        ...details.map((detail) => `- ${detail}`),
      ].join("\n"),
      ...(details.length > 0 ? { acceptance: details.join("; ") } : {}),
    });
    currentPhase = undefined;
  };

  if (explicitSectionIndex >= 0 || hasTopLevelList) {
    for (let index = phaseStartIndex; index < lines.length; index += 1) {
      const line = lines[index];
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      if (isWorkflowMetaLine(line)) {
        continue;
      }
      if (isWorkflowSectionMarker(line)) {
        continue;
      }
      if (/^\s*#{1,6}\s+\S/.test(line) && parsedPhases.length > 0) {
        break;
      }
      const listItem = matchWorkflowListItem(line);
      if (listItem) {
        if (phaseIndent === undefined || listItem.indent === phaseIndent) {
          phaseIndent = phaseIndent ?? listItem.indent;
          flushCurrentPhase();
          currentPhase = {
            title: listItem.text,
            details: [],
          };
          continue;
        }
        if (currentPhase && listItem.indent > phaseIndent) {
          currentPhase.details.push(listItem.text);
          continue;
        }
      }
      if (!currentPhase) {
        continue;
      }
      if (
        (phaseIndent !== undefined &&
          line.match(/^(\s*)\S/) &&
          (line.match(/^(\s*)\S/)?.[1]?.length ?? 0) > phaseIndent) ||
        isIndentedWorkflowDetail(line)
      ) {
        currentPhase.details.push(stripWorkflowMarkdownLine(line));
      }
    }

    flushCurrentPhase();
    if (parsedPhases.length > 0) {
      return parsedPhases;
    }
  }

  const headingPhases: Array<{
    title: string;
    query: string;
    acceptance?: string;
  }> = [];
  let currentHeading:
    | {
        title: string;
        details: string[];
      }
    | undefined;

  const flushCurrentHeading = () => {
    if (!currentHeading) {
      return;
    }
    const details = currentHeading.details.filter(Boolean);
    headingPhases.push({
      title: currentHeading.title,
      query: [currentHeading.title, ...details].join("\n"),
      ...(details.length > 0 ? { acceptance: details.join("; ") } : {}),
    });
    currentHeading = undefined;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || isWorkflowMetaLine(line) || isWorkflowSectionMarker(line)) {
      continue;
    }
    if (/^#{2,6}\s+\S/.test(line)) {
      flushCurrentHeading();
      currentHeading = {
        title: stripWorkflowMarkdownLine(line),
        details: [],
      };
      continue;
    }
    if (currentHeading) {
      currentHeading.details.push(stripWorkflowMarkdownLine(line));
    }
  }

  flushCurrentHeading();
  return headingPhases.length > 0 ? headingPhases : [fallbackGoal];
}

export function normalizeWorkflowPlanInput(
  input: unknown,
  fallbackGoal: string,
): ManagedWorkflowPhase[] {
  const usedIds = new Set<string>();
  const steps =
    typeof input === "string"
      ? parseWorkflowPlanText(input, fallbackGoal)
      : findWorkflowSteps(input);
  const sourceSteps = steps.length > 0 ? steps : [fallbackGoal];
  return sourceSteps.map((step, index) =>
    normalizeWorkflowPhase(step, index, usedIds, fallbackGoal),
  );
}

function defaultWorkflowPlanGoal(preset: WorkflowPlanPreset): string {
  switch (preset) {
    case "memory-backend-unification":
      return "Unify backend memory on Memory V2 with four-phase delivery, sandbox checkpoints, and orchestrator-visible runtime gates";
    case "project-intelligence-continuity-layer":
      return "Ship Project Intelligence and Continuity Layer across memory, code graph, workflow, docs, and release surfaces";
  }
}

function buildWorkflowPlanPresetDocument(
  preset: WorkflowPlanPreset,
  goal?: string,
): WorkflowPlanScaffoldDocument {
  const resolvedGoal = goal ?? defaultWorkflowPlanGoal(preset);

  switch (preset) {
    case "project-intelligence-continuity-layer":
      return {
        preset,
        mode: "full",
        goal: resolvedGoal,
        steps: [
          {
            id: "memory-authority-and-health",
            title: "Memory authority and health",
            query:
              "Add or verify memory provenance, confidence, scopes, decay, conflict detection, canonical authority states, and workspace-level memory health reporting. Keep the contract additive and preserve existing agent recall behavior.",
            acceptance:
              "Agents can distinguish canonical, approved, candidate, stale, conflicting, deprecated, confirmed, and inferred memories with source provenance and visible workspace memory health.",
            files: [
              "apps/web/src/lib/agents/memory-governance.ts",
              "apps/web/src/lib/agents/memory-health.ts",
              "apps/web/src/lib/db/queries/agent-memory.ts",
              "apps/mcp-server/src/services/agent_memory.py",
            ],
            gates: ["snipara_context_query", "snipara_memory_health"],
          },
          {
            id: "code-impact-and-verification",
            title: "Code impact and verification",
            query:
              "Expose advanced symbol cards, multi-hop impact graph traversal, test mapping, config facts, runtime facts, and suggested verification plans through hosted code graph tools and companion-friendly summaries.",
            acceptance:
              "Risk scoring and verification guidance explain impacted symbols, files, tests, issues, decisions, runtime signals, and config dependencies for changed code.",
            files: [
              "apps/mcp-server/src/services/code_context/query.py",
              "apps/mcp-server/src/services/code_graph/query.py",
              "apps/mcp-server/tests",
              "apps/web/src/lib/services/github-pr-answer-pack-generator.ts",
            ],
            gates: [
              "snipara-companion code impact",
              "targeted regression tests",
            ],
          },
          {
            id: "continuity-brief-and-graph-summary",
            title: "Continuity brief and graph summary",
            query:
              "Unify memory, code graph, and workflow state into the next-generation Start Work / What Changed / resume context brief so agents can answer what changed, why it changed, what is active, what is blocked, and what should not be modified.",
            acceptance:
              "Start Work and resume context include decisions, stale assumptions, active work, blockers, impacted files/symbols, recommended tests, and forbidden-change guidance.",
            files: [
              "apps/web/src/lib/services/what-changed.ts",
              "apps/web/src/lib/services/agent-resume-context.ts",
              "apps/web/src/lib/db/queries/what-changed.ts",
              "packages/cli/src/commands/team-sync.ts",
            ],
            gates: [
              "team-sync what-changed",
              "resume context regression tests",
            ],
          },
          {
            id: "release-docs-and-companion-surface",
            title: "Release docs and companion surface",
            query:
              "Document and ship the Project Intelligence surface across companion, create-snipara setup guidance, public docs, package README files, and release verification so agents can use the same workflow from local CLI or hosted MCP.",
            acceptance:
              "Companion exposes a Project Intelligence brief command and scaffold preset; package release surfaces are bumped, packed, published when auth permits, and verified with npx latest help.",
            files: [
              "packages/cli/src/index.ts",
              "packages/cli/src/commands/workflows.ts",
              "packages/cli/README.md",
              "packages/create-snipara/src/index.ts",
              "docs",
            ],
            gates: ["pack smoke", "release surface verification"],
          },
        ],
      };
    case "memory-backend-unification":
      return {
        preset,
        mode: "full",
        goal: resolvedGoal,
        steps: [
          {
            id: "inventory-and-cutover-contract",
            title: "Inventory and cutover contract",
            query:
              "Map every remaining legacy AgentMemory reader, writer, limit counter, and compaction path to its Memory V2 replacement. Freeze the source-of-truth contract for project, agent, team, and user scopes before changing behavior.",
            acceptance:
              "All remaining legacy memory surfaces are inventoried with explicit V2 owners, migration targets, and authority rules.",
            files: [
              "apps/mcp-server/src/services/agent_memory.py",
              "apps/mcp-server/src/services/agent_limits.py",
              "apps/web/src/lib/db/queries/agent-memory.ts",
              "apps/web/src/lib/db/queries/team-sync.ts",
              "apps/web/src/lib/services/github-memory.ts",
              "apps/web/src/lib/db/queries/context-graph.ts",
            ],
            gates: ["snipara_context_query", "snipara-companion code impact"],
          },
          {
            id: "v2-reader-writer-cutover",
            title: "Memory V2 reader and writer cutover",
            query:
              "Migrate web, continuity, Team Sync, and GitHub memory flows away from legacy AgentMemory so every active producer and consumer reads and writes through Memory V2 contracts.",
            acceptance:
              "The active web and continuity memory flows no longer depend on legacy AgentMemory reads or writes.",
            files: [
              "apps/web/src/lib/db/queries/agent-memory.ts",
              "apps/web/src/lib/db/queries/team-sync.ts",
              "apps/web/src/lib/services/github-memory.ts",
              "apps/web/src/lib/db/queries/context-graph.ts",
              "apps/mcp-server/src/services/agent_memory.py",
            ],
            gates: ["type-check", "targeted regression tests"],
          },
          {
            id: "v2-limits-compaction-and-hygiene",
            title: "Memory V2 limits, compaction, and hygiene",
            query:
              "Move quota accounting, auto-compaction, health checks, and memory hygiene off legacy AgentMemory. Use Snipara Sandbox for repeatable health drills and capture a runtime checkpoint before leaving the phase.",
            acceptance:
              "Quota accounting, compaction triggers, and memory health checks operate on Memory V2 and are resumable from a Sandbox checkpoint.",
            files: [
              "apps/mcp-server/src/services/agent_limits.py",
              "apps/mcp-server/src/services/agent_memory.py",
            ],
            gates: ["snipara_memory_health", "targeted sandbox verification"],
            needs_runtime: true,
          },
          {
            id: "multi-scope-recall-and-proof-gated-validation",
            title: "Multi-scope recall and proof-gated validation",
            query:
              "Implement true agent, user, project, and team recall partitioning with explicit ranking budgets. Validate the final cutover through Snipara Sandbox and expose the runtime-bound verification phases through orchestrator handoff metadata.",
            acceptance:
              "Recall is partitioned by scope with explicit ranking behavior, and orchestrator handoffs surface runtime-bound validation phases with checkpoint visibility.",
            files: [
              "apps/mcp-server/src/services/agent_memory.py",
              "packages/cli/src/runtime/orchestrator-handoff.ts",
              "packages/agentic-orchestrator/src/snipara_orchestrator/orchestrator.py",
            ],
            gates: ["snipara-companion code impact", "proof-gated validation"],
            needs_runtime: true,
          },
        ],
      };
  }
}

function defaultWorkflowPlanOutputPath(
  preset: WorkflowPlanPreset,
  cwd: string = process.cwd(),
): string {
  return path.resolve(cwd, WORKFLOW_PLANS_RELATIVE_DIR, `${preset}-plan.json`);
}

function toProjectRelativePath(
  absolutePath: string,
  cwd: string = process.cwd(),
): string {
  const relative = path.relative(cwd, absolutePath);
  return relative && !relative.startsWith("..") ? relative : absolutePath;
}

export function buildWorkflowPlanScaffold(
  preset: WorkflowPlanPreset,
  options: {
    goal?: string;
    outputPath?: string;
    cwd?: string;
  } = {},
): WorkflowPlanScaffoldResult {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const outputPath = path.resolve(
    options.outputPath ?? defaultWorkflowPlanOutputPath(preset, cwd),
  );
  const plan = buildWorkflowPlanPresetDocument(preset, options.goal);
  return {
    preset,
    goal: plan.goal,
    outputPath,
    relativeOutputPath: toProjectRelativePath(outputPath, cwd),
    plan,
  };
}

function readWorkflowPlanFile(
  planFile: string,
  fallbackGoal: string,
): ManagedWorkflowPhase[] {
  const content = fs.readFileSync(planFile, "utf-8");
  if (planFile.toLowerCase().endsWith(".json")) {
    return normalizeWorkflowPlanInput(JSON.parse(content), fallbackGoal);
  }
  return normalizeWorkflowPlanInput(content, fallbackGoal);
}

function readWorkflowPlanMode(
  planFile?: string,
): ManagedWorkflowCoordinationMode | undefined {
  if (
    !planFile ||
    !planFile.toLowerCase().endsWith(".json") ||
    !fs.existsSync(planFile)
  ) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(planFile, "utf-8")) as {
      mode?: unknown;
    };
    return normalizeWorkflowCoordinationMode(parsed.mode);
  } catch {
    return undefined;
  }
}

function normalizeWorkflowCoordinationMode(
  value: unknown,
): ManagedWorkflowCoordinationMode | undefined {
  const normalized =
    typeof value === "string" ? value.toLowerCase().trim() : "";
  if (
    normalized === "standard" ||
    normalized === "full" ||
    normalized === "orchestrate"
  ) {
    return normalized;
  }
  return undefined;
}

function inferWorkflowCoordinationMode(options: {
  planFile?: string;
}): ManagedWorkflowCoordinationMode {
  return (
    readWorkflowPlanMode(options.planFile) ??
    (options.planFile ? "full" : "standard")
  );
}

function getWorkflowStatePath(cwd: string = process.cwd()): string {
  return path.join(cwd, WORKFLOW_STATE_RELATIVE_PATH);
}

function normalizeManagedWorkflowState(
  state: ManagedWorkflowState,
): ManagedWorkflowState {
  if (
    state.schemaVersion !== "snipara.workflow.v1" &&
    state.schemaVersion !== "snipara.workflow.v2"
  ) {
    throw new Error(
      `${WORKFLOW_STATE_RELATIVE_PATH} is not a valid Snipara workflow state file`,
    );
  }

  return {
    ...state,
    runtime: normalizeManagedWorkflowRuntimeState(state.runtime),
    judgment: state.judgment
      ? {
          ...state.judgment,
          responses: Array.isArray(state.judgment.responses) ? state.judgment.responses : [],
        }
      : undefined,
    phaseCommitReceipts: Array.isArray(state.phaseCommitReceipts)
      ? state.phaseCommitReceipts
      : [],
  };
}

function normalizeManagedWorkflowRuntimeState(
  runtime: ManagedWorkflowRuntimeState | undefined,
): ManagedWorkflowRuntimeState | undefined {
  if (!runtime?.sandbox) {
    return runtime;
  }

  const bindings = Array.isArray(runtime.sandbox.bindings)
    ? runtime.sandbox.bindings
        .filter((binding) => binding && typeof binding.phaseId === "string")
        .map((binding) => ({
          ...binding,
          artifacts: uniqueStringList(binding.artifacts) ?? [],
          lastCheckpoint: binding.lastCheckpoint
            ? {
                ...binding.lastCheckpoint,
                files: uniqueStringList(binding.lastCheckpoint.files) ?? [],
                commands:
                  uniqueStringList(binding.lastCheckpoint.commands) ?? [],
                artifacts:
                  uniqueStringList(binding.lastCheckpoint.artifacts) ?? [],
              }
            : undefined,
        }))
    : [];

  return {
    sandbox: {
      provider: "snipara-sandbox",
      bindings,
    },
  };
}

function readWorkflowState(
  cwd: string = process.cwd(),
): ManagedWorkflowState | undefined {
  const statePath = getWorkflowStatePath(cwd);
  if (!fs.existsSync(statePath)) {
    return undefined;
  }
  const parsed = JSON.parse(
    fs.readFileSync(statePath, "utf-8"),
  ) as ManagedWorkflowState;
  if (!Array.isArray(parsed.phases)) {
    throw new Error(
      `${WORKFLOW_STATE_RELATIVE_PATH} is not a valid Snipara workflow state file`,
    );
  }
  return normalizeManagedWorkflowState(parsed);
}

function readRequiredWorkflowState(): ManagedWorkflowState {
  const state = readWorkflowState();
  if (!state) {
    throw new Error(
      `No managed workflow found at ${WORKFLOW_STATE_RELATIVE_PATH}. Run 'snipara-companion workflow start' first.`,
    );
  }
  return state;
}

function writeWorkflowState(state: ManagedWorkflowState): void {
  const statePath = getWorkflowStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const normalized: ManagedWorkflowState = {
    ...state,
    schemaVersion: "snipara.workflow.v2",
    runtime: normalizeManagedWorkflowRuntimeState(state.runtime),
  };
  fs.writeFileSync(
    statePath,
    `${JSON.stringify(normalized, null, 2)}\n`,
    "utf-8",
  );
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((sorted, key) => {
      sorted[key] = sortJsonValue(value[key]);
      return sorted;
    }, {});
}

function stableJsonStringify(value: unknown): string {
  return `${JSON.stringify(sortJsonValue(value), null, 2)}\n`;
}

function hashJsonValue(value: unknown): string {
  return `sha256:${hashContent(stableJsonStringify(value))}`;
}

function getProducerLoopDir(cwd: string = process.cwd()): string {
  return path.join(cwd, PRODUCER_LOOP_RELATIVE_DIR);
}

function buildProducerLoopArtifactId(options: {
  kind: ProducerLoopProducerKind;
  workflowId?: string;
  phaseId?: string;
  generatedAt: string;
  ledgerHash: string;
}): string {
  const source = [
    options.kind,
    options.workflowId ?? "no-workflow",
    options.phaseId ?? "final",
    options.generatedAt,
    options.ledgerHash,
  ].join(":");
  return `producer-${hashContent(source).slice(0, 16)}`;
}

function buildProducerLoopArtifact(options: {
  kind: ProducerLoopProducerKind;
  command: "workflow phase-commit" | "workflow final-commit";
  state?: ManagedWorkflowState;
  phase?: ManagedWorkflowPhase;
  category: string;
  outcome: TaskCommitOutcome;
  summary: string;
  files?: string[];
  journalAttempted: boolean;
  teamSyncCompletionAttempted: boolean;
  now?: Date;
}): ProducerLoopArtifact {
  const generatedAt = (options.now ?? new Date()).toISOString();
  const files =
    uniqueStringList(
      (options.files ?? options.phase?.files ?? []).map(normalizeRepoFilePath),
    ) ?? [];
  const workflowId = options.state?.workflowId;
  const sourceRef = [
    "workflow",
    workflowId ?? "unmanaged",
    options.phase?.id ? `phase:${options.phase.id}` : "final",
  ].join(":");
  const reasonCodes = uniqueStrings([
    "producer_loop_v0",
    options.kind,
    `outcome_${options.outcome}`,
    files.length > 0 ? "files_declared" : "files_not_declared",
    options.state ? "managed_workflow_state" : "no_managed_workflow_state",
  ]);
  const planItems = [
    options.state?.goal ? `Workflow goal: ${options.state.goal}` : undefined,
    options.phase
      ? `Phase ${options.phase.id}: ${options.phase.title}`
      : undefined,
    options.phase?.acceptance
      ? `Acceptance: ${options.phase.acceptance}`
      : undefined,
  ].filter((item): item is string => Boolean(item));
  const outcomeItems = [
    options.summary,
    `Outcome: ${options.outcome}`,
    options.category ? `Category: ${options.category}` : undefined,
  ].filter((item): item is string => Boolean(item));
  const ledger = buildCodingIntelligenceLedger({
    dir: process.cwd(),
    task: options.state?.goal ?? options.summary,
    prompt: options.phase?.query ?? options.summary,
    sourceRef,
    changedFiles: files,
    recentFiles: files,
    plan: planItems,
    outcome: outcomeItems,
    influenceReceipt: [
      `${options.command} advanced local workflow evidence and emitted Producer Loop V0 local review evidence.`,
    ],
    reasonCode: reasonCodes,
    confidence: "unknown",
    calibration: [
      "Producer Loop V0 sample is local review evidence.",
      "Sample is not calibrated advisor-grade confidence.",
      "Review artifacts before any future hard gate uses these signals.",
    ],
  });
  const ledgerHash = hashJsonValue(ledger);
  const artifactId = buildProducerLoopArtifactId({
    kind: options.kind,
    workflowId,
    phaseId: options.phase?.id,
    generatedAt,
    ledgerHash,
  });

  return {
    schemaVersion: PRODUCER_LOOP_ARTIFACT_VERSION,
    artifactId,
    generatedAt,
    producer: {
      kind: options.kind,
      command: options.command,
      ...(workflowId ? { workflowId } : {}),
      ...(options.phase?.id ? { phaseId: options.phase.id } : {}),
      ...(options.phase?.title ? { phaseTitle: options.phase.title } : {}),
      category: options.category,
      outcome: options.outcome,
      files,
    },
    source: {
      ...(options.state?.goal ? { goal: options.state.goal } : {}),
      summary: options.summary,
      ...(options.state?.status ? { status: options.state.status } : {}),
    },
    ledger,
    ledgerHash,
    localEvidence: {
      durableMemoryAttempted: true,
      journalAttempted: options.journalAttempted,
      teamSyncCompletionAttempted: options.teamSyncCompletionAttempted,
    },
    calibration: {
      status: "sample_unreviewed",
      sampleSize: 1,
      hardGateReady: false,
      notes: [
        "This artifact is one local workflow sample.",
        "Confidence remains uncalibrated until reviewed samples accumulate.",
      ],
    },
    caveats: [
      "Local review evidence only; this is not server-side attestation.",
      "The embedded ledger is redacted local context, not canonical durable memory.",
      "Producer Loop V0 does not execute workers or write approved memory automatically.",
    ],
  };
}

export function writeProducerLoopArtifact(options: {
  kind: ProducerLoopProducerKind;
  command: "workflow phase-commit" | "workflow final-commit";
  state?: ManagedWorkflowState;
  phase?: ManagedWorkflowPhase;
  category: string;
  outcome: TaskCommitOutcome;
  summary: string;
  files?: string[];
  journalAttempted: boolean;
  teamSyncCompletionAttempted: boolean;
}): ProducerLoopArtifactWriteResult {
  try {
    const artifact = buildProducerLoopArtifact(options);
    const artifactHash = hashJsonValue(artifact);
    const fileName = `${artifact.generatedAt.replace(/[:.]/g, "-")}-${artifact.artifactId}.json`;
    const outputPath = path.join(getProducerLoopDir(), fileName);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, stableJsonStringify(artifact), "utf-8");
    return {
      status: "written",
      schemaVersion: PRODUCER_LOOP_ARTIFACT_VERSION,
      artifactId: artifact.artifactId,
      path: outputPath,
      relativePath: toProjectRelativePath(outputPath),
      artifactHash,
      ledgerHash: artifact.ledgerHash,
      caveats: artifact.caveats,
    };
  } catch (error) {
    return {
      status: "error",
      schemaVersion: PRODUCER_LOOP_ARTIFACT_VERSION,
      error: error instanceof Error ? error.message : String(error),
      caveats: [
        "Producer Loop artifact write failed; workflow state and hosted memory result should be reviewed separately.",
      ],
    };
  }
}

function countStringOccurrences(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function isProducerLoopProducerKind(
  value: string | undefined,
): value is ProducerLoopProducerKind {
  return (
    value === "workflow_phase_commit" ||
    value === "workflow_final_commit" ||
    value === "pr_answer_pack_decision_capture"
  );
}

function isProducerLoopSampleReviewStatus(
  value: string | undefined,
): value is ProducerLoopSampleReviewStatus {
  return (
    value === "sample_unreviewed" ||
    value === "sample_reviewed" ||
    value === "sample_rejected"
  );
}

function normalizeProducerLoopSampleReviewStatus(
  value: unknown,
): ProducerLoopSampleReviewStatus {
  const status = stringValue(value);
  return isProducerLoopSampleReviewStatus(status)
    ? status
    : "sample_unreviewed";
}

function isProducerLoopReviewOutcome(
  value: string | undefined,
): value is ProducerLoopReviewOutcome {
  return (
    value === "useful" ||
    value === "false_positive" ||
    value === "missing_context" ||
    value === "unsafe" ||
    value === "duplicate" ||
    value === "other"
  );
}

function isTaskCommitOutcome(
  value: string | undefined,
): value is TaskCommitOutcome {
  return ["completed", "partial", "blocked", "abandoned"].includes(value ?? "");
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => stringValue(item))
    .filter((item): item is string => Boolean(item));
}

function summarizeProducerLoopArtifactFile(
  filePath: string,
  cwd: string,
):
  | { artifact: ProducerLoopArtifactReportSummary; invalid?: undefined }
  | {
      artifact?: undefined;
      invalid: ProducerLoopReport["invalidArtifacts"][number];
    } {
  const relativePath = toProjectRelativePath(filePath, cwd);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed)) {
      throw new Error("artifact must be a JSON object");
    }
    if (parsed.schemaVersion !== PRODUCER_LOOP_ARTIFACT_VERSION) {
      throw new Error(
        `unsupported schemaVersion '${stringValue(parsed.schemaVersion) ?? "unknown"}'`,
      );
    }
    const producer = isRecord(parsed.producer) ? parsed.producer : undefined;
    const source = isRecord(parsed.source) ? parsed.source : undefined;
    const ledger = isRecord(parsed.ledger) ? parsed.ledger : undefined;
    const calibration = isRecord(parsed.calibration)
      ? parsed.calibration
      : undefined;
    const review = isRecord(parsed.review) ? parsed.review : undefined;
    if (!producer) {
      throw new Error("artifact is missing producer metadata");
    }
    const producerKind = stringValue(producer.kind);
    if (!isProducerLoopProducerKind(producerKind)) {
      throw new Error(
        `unsupported producer kind '${producerKind ?? "unknown"}'`,
      );
    }
    const artifactId = stringValue(parsed.artifactId);
    const generatedAt = stringValue(parsed.generatedAt);
    if (!artifactId || !generatedAt) {
      throw new Error("artifact is missing artifactId or generatedAt");
    }
    const outcome = stringValue(producer.outcome);
    const reviewStatus = normalizeProducerLoopSampleReviewStatus(
      stringValue(review?.status) ?? stringValue(calibration?.status),
    );

    return {
      artifact: {
        artifactId,
        generatedAt,
        producerKind,
        workflowId: stringValue(producer.workflowId),
        phaseId: stringValue(producer.phaseId),
        phaseTitle: stringValue(producer.phaseTitle),
        outcome: isTaskCommitOutcome(outcome) ? outcome : undefined,
        summary: stringValue(source?.summary),
        path: filePath,
        relativePath,
        artifactHash: `sha256:${hashContent(content)}`,
        ledgerHash: stringValue(parsed.ledgerHash),
        reasonCodes: uniqueStrings(stringArrayValue(ledger?.reasonCodes)),
        files: uniqueStrings(stringArrayValue(producer.files)),
        calibrationStatus: stringValue(calibration?.status),
        reviewStatus,
        reviewOutcome: stringValue(review?.outcome),
        reviewedAt: stringValue(review?.reviewedAt),
        reviewer: stringValue(review?.reviewer),
      },
    };
  } catch (error) {
    return {
      invalid: {
        path: filePath,
        relativePath,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function listProducerLoopArtifactFiles(cwd: string): string[] {
  const dir = getProducerLoopDir(cwd);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => path.join(dir, fileName))
    .sort();
}

function producerLoopCalibrationStatus(
  sampleSize: number,
  reviewedSampleSize: number,
  minReviewSampleSize: number,
) {
  if (sampleSize === 0) {
    return "no_samples" as const;
  }
  if (reviewedSampleSize < minReviewSampleSize) {
    return "insufficient_samples" as const;
  }
  return "reviewable_sample_set" as const;
}

const WORKER_RECEIPT_RELATIVE_DIR = path.join(
  ".snipara",
  "orchestrator",
  "executions",
);
const WORKER_REVIEW_RELATIVE_DIR = path.join(
  ".snipara",
  "orchestrator",
  "reviews",
);
const REQUIRED_WORKER_RECEIPT_FAMILIES = [
  "handoffReceiptId",
  "claimId",
  "proofReceiptIds",
  "outcomeReceiptId",
  "brainUpdateReceiptId",
] as const;

function listJsonFiles(relativeDir: string, cwd: string): string[] {
  const directory = path.join(cwd, relativeDir);
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function readWorkerReviewFiles(cwd: string): {
  reviews: Map<string, { value: Record<string, unknown>; path: string }>;
  invalid: ProducerLoopReport["workerReceipts"]["invalidArtifacts"];
} {
  const reviews = new Map<
    string,
    { value: Record<string, unknown>; path: string }
  >();
  const invalid: ProducerLoopReport["workerReceipts"]["invalidArtifacts"] = [];
  for (const filePath of listJsonFiles(WORKER_REVIEW_RELATIVE_DIR, cwd)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (!isRecord(parsed)) {
        throw new Error("review must be a JSON object");
      }
      const receiptId = stringValue(parsed.receiptId);
      if (!receiptId) {
        throw new Error("review is missing receiptId");
      }
      reviews.set(receiptId, { value: parsed, path: filePath });
    } catch (error) {
      invalid.push({
        path: filePath,
        relativePath: toProjectRelativePath(filePath, cwd),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { reviews, invalid };
}

function missingWorkerReceiptFamilies(
  receipt: Record<string, unknown>,
): string[] {
  const refs = isRecord(receipt.receiptRefs)
    ? receipt.receiptRefs
    : isRecord(receipt.receipt)
      ? receipt.receipt
      : {};
  return REQUIRED_WORKER_RECEIPT_FAMILIES.filter((family) => {
    const value = refs[family];
    return family === "proofReceiptIds"
      ? !Array.isArray(value) ||
          value.filter((item) => Boolean(stringValue(item))).length === 0
      : !stringValue(value);
  });
}

function summarizeWorkerExecutionReceipts(cwd: string): {
  samples: WorkerExecutionReceiptReportSummary[];
  invalid: ProducerLoopReport["workerReceipts"]["invalidArtifacts"];
} {
  const reviewFiles = readWorkerReviewFiles(cwd);
  const invalid = [...reviewFiles.invalid];
  const samples: WorkerExecutionReceiptReportSummary[] = [];
  for (const filePath of listJsonFiles(WORKER_RECEIPT_RELATIVE_DIR, cwd)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (!isRecord(parsed)) {
        throw new Error("receipt must be a JSON object");
      }
      const receiptId = stringValue(parsed.receiptId);
      const schemaVersion = stringValue(parsed.schemaVersion);
      if (!receiptId || !schemaVersion) {
        throw new Error("receipt is missing receiptId or schemaVersion");
      }
      const attribution = isRecord(parsed.workerAttribution)
        ? parsed.workerAttribution
        : {};
      const gate = isRecord(parsed.gate) ? parsed.gate : {};
      const review = reviewFiles.reviews.get(receiptId);
      const reviewStatusValue = stringValue(review?.value.reviewStatus);
      const reviewStatus =
        reviewStatusValue === "accepted"
          ? "accepted"
          : reviewStatusValue === "blocked"
            ? "blocked"
            : "review_pending";
      const workerId =
        stringValue(parsed.workerId) ??
        stringValue(attribution.workerId) ??
        stringValue(parsed.selectedWorkerCandidateId) ??
        stringValue(gate.selectedWorkerCandidateId) ??
        "main_agent";
      const workCategory =
        stringValue(parsed.workCategory) ??
        stringValue(attribution.workCategory) ??
        "unknown";
      const executionActor =
        stringValue(parsed.executionActor) ??
        stringValue(attribution.executionActor) ??
        (Number(parsed.workersSpawned ?? 0) > 0 ? "worker" : "main_agent");
      const missingReceiptFamilies = missingWorkerReceiptFamilies(parsed);
      samples.push({
        receiptId,
        schemaVersion,
        recordedAt: stringValue(parsed.recordedAt),
        workerId,
        workCategory,
        routingCardRef:
          stringValue(parsed.routingCardRef) ??
          stringValue(attribution.routingCardRef),
        workflowFingerprint:
          stringValue(parsed.workflowFingerprint) ??
          stringValue(attribution.workflowFingerprint),
        executionActor,
        status: stringValue(parsed.status),
        reviewStatus,
        executed:
          executionActor === "worker" || Number(parsed.workersSpawned ?? 0) > 0,
        receiptFamilyComplete: missingReceiptFamilies.length === 0,
        missingReceiptFamilies,
        path: filePath,
        relativePath: toProjectRelativePath(filePath, cwd),
        ...(review
          ? {
              reviewPath: review.path,
              reviewRelativePath: toProjectRelativePath(review.path, cwd),
            }
          : {}),
      });
    } catch (error) {
      invalid.push({
        path: filePath,
        relativePath: toProjectRelativePath(filePath, cwd),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  samples.sort((left, right) =>
    (left.recordedAt ?? left.receiptId).localeCompare(
      right.recordedAt ?? right.receiptId,
    ),
  );
  return { samples, invalid };
}

function buildWorkerTrustRows(
  samples: WorkerExecutionReceiptReportSummary[],
  minReviewSampleSize: number,
): WorkerTrustReportRow[] {
  const grouped = new Map<string, WorkerExecutionReceiptReportSummary[]>();
  for (const sample of samples) {
    const key = `${sample.workerId}\u0000${sample.workCategory}`;
    grouped.set(key, [...(grouped.get(key) ?? []), sample]);
  }
  return [...grouped.values()]
    .map((group): WorkerTrustReportRow => {
      const reviewedSampleSize = group.filter(
        (sample) => sample.reviewStatus !== "review_pending",
      ).length;
      const verifiedSampleSize = group.filter(
        (sample) => sample.reviewStatus === "accepted",
      ).length;
      const incompleteReceiptSampleSize = group.filter(
        (sample) => !sample.receiptFamilyComplete,
      ).length;
      const nextRequired = [
        reviewedSampleSize < minReviewSampleSize
          ? `${minReviewSampleSize - reviewedSampleSize} more supervised review sample(s)`
          : undefined,
        verifiedSampleSize < 3
          ? `${3 - verifiedSampleSize} more accepted verified sample(s)`
          : undefined,
        incompleteReceiptSampleSize > 0
          ? `${incompleteReceiptSampleSize} sample(s) need complete receipt families`
          : undefined,
        group[0].workCategory === "unknown"
          ? "classify legacy samples by work category"
          : undefined,
        "Trust Promotion gate implementation remains required",
      ].filter((item): item is string => Boolean(item));
      return {
        workerId: group[0].workerId,
        workCategory: group[0].workCategory,
        state: "probation_supervised",
        sampleSize: group.length,
        executedSampleSize: group.filter((sample) => sample.executed).length,
        reviewedSampleSize,
        verifiedSampleSize,
        blockedSampleSize: group.filter(
          (sample) => sample.reviewStatus === "blocked",
        ).length,
        incompleteReceiptSampleSize,
        workflowFingerprints: uniqueStrings(
          group
            .map((sample) => sample.workflowFingerprint)
            .filter((value): value is string => Boolean(value)),
        ),
        hardGateReady: false,
        nextRequired,
      };
    })
    .sort((left, right) =>
      left.workerId === right.workerId
        ? left.workCategory.localeCompare(right.workCategory)
        : left.workerId.localeCompare(right.workerId),
    );
}

export function buildProducerLoopReport(
  options: {
    cwd?: string;
    minReviewSampleSize?: number;
  } = {},
): ProducerLoopReport {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const minReviewSampleSize = Math.max(
    1,
    Math.floor(
      options.minReviewSampleSize ?? PRODUCER_LOOP_MIN_REVIEW_SAMPLE_SIZE,
    ),
  );
  const summaries = listProducerLoopArtifactFiles(cwd).map((filePath) =>
    summarizeProducerLoopArtifactFile(filePath, cwd),
  );
  const artifacts = summaries
    .map((entry) => entry.artifact)
    .filter((entry): entry is ProducerLoopArtifactReportSummary =>
      Boolean(entry),
    )
    .sort((left, right) =>
      left.generatedAt === right.generatedAt
        ? left.relativePath.localeCompare(right.relativePath)
        : left.generatedAt.localeCompare(right.generatedAt),
    );
  const invalidArtifacts = summaries
    .map((entry) => entry.invalid)
    .filter((entry): entry is ProducerLoopReport["invalidArtifacts"][number] =>
      Boolean(entry),
    );
  const producerKinds = uniqueStrings(
    artifacts.map((artifact) => artifact.producerKind),
  ).filter((kind): kind is ProducerLoopProducerKind =>
    isProducerLoopProducerKind(kind),
  );
  const workflowIds = uniqueStrings(
    artifacts
      .map((artifact) => artifact.workflowId)
      .filter((id): id is string => Boolean(id)),
  );
  const reasonCodeCounts = countStringOccurrences(
    artifacts.flatMap((artifact) => artifact.reasonCodes),
  );
  const latestArtifact = artifacts[artifacts.length - 1];
  const reviewedSampleSize = artifacts.filter(
    (artifact) => artifact.reviewStatus === "sample_reviewed",
  ).length;
  const rejectedSampleSize = artifacts.filter(
    (artifact) => artifact.reviewStatus === "sample_rejected",
  ).length;
  const unreviewedSampleSize = artifacts.filter(
    (artifact) => artifact.reviewStatus === "sample_unreviewed",
  ).length;
  const reviewOutcomes = countStringOccurrences(
    artifacts
      .map((artifact) => artifact.reviewOutcome)
      .filter((outcome): outcome is string => Boolean(outcome)),
  );
  const calibrationStatus = producerLoopCalibrationStatus(
    artifacts.length,
    reviewedSampleSize,
    minReviewSampleSize,
  );
  const workerReceiptReport = summarizeWorkerExecutionReceipts(cwd);
  const workerTrust = buildWorkerTrustRows(
    workerReceiptReport.samples,
    minReviewSampleSize,
  );
  const recommendedActions = [
    artifacts.length === 0
      ? "Run a current Producer Loop producer, such as workflow phase-commit/final-commit or PR Answer Pack decision capture, to create samples."
      : undefined,
    artifacts.length > 0 && reviewedSampleSize < minReviewSampleSize
      ? `Review at least ${minReviewSampleSize} local Producer Loop samples before considering any calibration signal.`
      : undefined,
    unreviewedSampleSize > 0
      ? "Mark local samples with workflow producer-review after checking the embedded evidence."
      : undefined,
    rejectedSampleSize > 0
      ? "Inspect rejected Producer Loop samples for false positives, missing context, or reason-code drift."
      : undefined,
    invalidArtifacts.length > 0
      ? "Inspect invalid Producer Loop artifacts before trusting adoption counts."
      : undefined,
    workerReceiptReport.samples.length === 0
      ? "Run agents execute-gated and persist agents review-gated results to create worker-attributed receipt samples."
      : undefined,
    workerReceiptReport.invalid.length > 0
      ? "Inspect invalid worker execution receipts or reviews before trusting per-worker counts."
      : undefined,
    "Review false positives, missing outcomes, and reason-code drift before any future enforcement.",
  ].filter((item): item is string => Boolean(item));

  return {
    version: PRODUCER_LOOP_REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    source: {
      directory: toProjectRelativePath(getProducerLoopDir(cwd), cwd),
      localOnly: true,
    },
    adoption: {
      status: artifacts.length > 0 ? "active" : "missing",
      artifactCount: artifacts.length,
      producerKinds,
      workflowIds,
    },
    artifacts,
    ...(latestArtifact ? { latestArtifact } : {}),
    invalidArtifacts,
    reasonCodes: {
      counts: reasonCodeCounts,
    },
    workerReceipts: {
      sourceDirectories: [
        WORKER_RECEIPT_RELATIVE_DIR,
        WORKER_REVIEW_RELATIVE_DIR,
      ],
      sampleSize: workerReceiptReport.samples.length,
      samples: workerReceiptReport.samples,
      invalidArtifacts: workerReceiptReport.invalid,
    },
    workerTrust,
    calibration: {
      status: calibrationStatus,
      sampleSize: artifacts.length,
      reviewedSampleSize,
      rejectedSampleSize,
      unreviewedSampleSize,
      minReviewSampleSize,
      reviewOutcomes,
      hardGateReady: false,
      notes: [
        "Producer Loop V0 reports local or exported producer samples only.",
        "Only samples marked sample_reviewed count toward calibration review size.",
        "sample_rejected records operator review but does not count as positive calibration evidence.",
        "hardGateReady remains false in V0 even when enough samples exist.",
      ],
    },
    recommendedActions,
    caveats: [
      "Local report only; this is not server-side compliance attestation.",
      "Reason-code counts describe observed artifacts, not calibrated probabilities.",
      "Producer Loop V0 does not prove command execution beyond the evidence embedded in each artifact.",
    ],
  };
}

function resolveProducerLoopReviewTarget(
  cwd: string,
  selector?: string,
  latest?: boolean,
): string {
  const files = listProducerLoopArtifactFiles(cwd);
  if (files.length === 0) {
    throw new Error(
      `No Producer Loop artifacts found under ${PRODUCER_LOOP_RELATIVE_DIR}.`,
    );
  }
  const normalizedSelector = selector?.trim();
  if (!normalizedSelector) {
    if (!latest) {
      throw new Error("Pass --artifact <path|file|artifactId> or --latest.");
    }
    const summaries = files
      .map(
        (filePath) => summarizeProducerLoopArtifactFile(filePath, cwd).artifact,
      )
      .filter((entry): entry is ProducerLoopArtifactReportSummary =>
        Boolean(entry),
      )
      .sort((left, right) =>
        left.generatedAt === right.generatedAt
          ? left.relativePath.localeCompare(right.relativePath)
          : left.generatedAt.localeCompare(right.generatedAt),
      );
    const latestArtifact = summaries[summaries.length - 1];
    if (!latestArtifact) {
      throw new Error("No valid Producer Loop artifacts found to review.");
    }
    return latestArtifact.path;
  }

  const directCandidates = [
    path.resolve(cwd, normalizedSelector),
    path.resolve(cwd, PRODUCER_LOOP_RELATIVE_DIR, normalizedSelector),
  ];
  const directMatch = directCandidates.find((candidate) =>
    fs.existsSync(candidate),
  );
  if (directMatch) {
    return directMatch;
  }

  const normalizedPathSelector = normalizedSelector
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  const matches = files.filter((filePath) => {
    const relativePath = toProjectRelativePath(filePath, cwd).replace(
      /\\/g,
      "/",
    );
    const basename = path.basename(filePath);
    if (
      basename === normalizedSelector ||
      relativePath === normalizedPathSelector ||
      relativePath.replace(/^\.\//, "") === normalizedPathSelector
    ) {
      return true;
    }
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return (
        isRecord(parsed) &&
        stringValue(parsed.artifactId) === normalizedSelector
      );
    } catch {
      return false;
    }
  });

  if (matches.length === 0) {
    throw new Error(
      `No Producer Loop artifact matched '${normalizedSelector}'.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Producer Loop artifact selector '${normalizedSelector}' matched multiple files: ${matches
        .map((filePath) => toProjectRelativePath(filePath, cwd))
        .join(", ")}`,
    );
  }
  return matches[0];
}

function readProducerLoopArtifactForReview(
  filePath: string,
): ProducerLoopArtifact {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  if (!isRecord(parsed)) {
    throw new Error("artifact must be a JSON object");
  }
  if (parsed.schemaVersion !== PRODUCER_LOOP_ARTIFACT_VERSION) {
    throw new Error(
      `unsupported schemaVersion '${stringValue(parsed.schemaVersion) ?? "unknown"}'`,
    );
  }
  const artifactId = stringValue(parsed.artifactId);
  const generatedAt = stringValue(parsed.generatedAt);
  if (!artifactId || !generatedAt) {
    throw new Error("artifact is missing artifactId or generatedAt");
  }
  if (!isRecord(parsed.producer)) {
    throw new Error("artifact is missing producer metadata");
  }
  const producerKind = stringValue(parsed.producer.kind);
  if (!isProducerLoopProducerKind(producerKind)) {
    throw new Error(`unsupported producer kind '${producerKind ?? "unknown"}'`);
  }
  return parsed as unknown as ProducerLoopArtifact;
}

function applyProducerLoopArtifactReview(
  artifact: ProducerLoopArtifact,
  options: {
    status: Exclude<ProducerLoopSampleReviewStatus, "sample_unreviewed">;
    reviewedAt: string;
    reviewer?: string;
    outcome?: ProducerLoopReviewOutcome;
    notes?: string[];
  },
): ProducerLoopArtifact {
  const reviewNotes = uniqueStrings(options.notes ?? []);
  const reviewNote =
    options.status === "sample_rejected"
      ? "Sample rejected by local operator review."
      : "Sample reviewed by local operator.";
  const existingCalibration = artifact.calibration ?? {
    status: "sample_unreviewed" as const,
    sampleSize: 1 as const,
    hardGateReady: false as const,
    notes: [],
  };
  return {
    ...artifact,
    calibration: {
      ...existingCalibration,
      status: options.status,
      sampleSize: 1,
      hardGateReady: false,
      notes: uniqueStrings([
        ...stringArrayValue(existingCalibration.notes),
        reviewNote,
        ...reviewNotes.map((note) => `Review note: ${note}`),
      ]),
    },
    review: {
      status: options.status,
      reviewedAt: options.reviewedAt,
      ...(options.reviewer ? { reviewer: options.reviewer } : {}),
      ...(options.outcome ? { outcome: options.outcome } : {}),
      notes: reviewNotes,
    },
  };
}

function reviewProducerLoopArtifact(options: {
  cwd?: string;
  artifact?: string;
  latest?: boolean;
  reject?: boolean;
  outcome?: string;
  reviewer?: string;
  notes?: string[];
}): ProducerLoopArtifactReviewResult {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const targetPath = resolveProducerLoopReviewTarget(
    cwd,
    options.artifact,
    options.latest,
  );
  const artifact = readProducerLoopArtifactForReview(targetPath);
  const rawOutcome = stringValue(options.outcome);
  if (rawOutcome && !isProducerLoopReviewOutcome(rawOutcome)) {
    throw new Error(
      `Unsupported producer review outcome '${rawOutcome}'. Use useful, false_positive, missing_context, unsafe, duplicate, or other.`,
    );
  }
  const outcome = rawOutcome as ProducerLoopReviewOutcome | undefined;
  const status = options.reject ? "sample_rejected" : "sample_reviewed";
  const reviewer = stringValue(options.reviewer);
  const reviewedAt = new Date().toISOString();
  const reviewed = applyProducerLoopArtifactReview(artifact, {
    status,
    reviewedAt,
    ...(reviewer ? { reviewer } : {}),
    ...(outcome ? { outcome } : {}),
    notes: options.notes ?? [],
  });
  fs.writeFileSync(targetPath, stableJsonStringify(reviewed), "utf-8");
  const content = fs.readFileSync(targetPath, "utf-8");
  return {
    status: "reviewed",
    schemaVersion: PRODUCER_LOOP_ARTIFACT_VERSION,
    artifactId: reviewed.artifactId,
    path: targetPath,
    relativePath: toProjectRelativePath(targetPath, cwd),
    artifactHash: `sha256:${hashContent(content)}`,
    ledgerHash: reviewed.ledgerHash,
    review: reviewed.review as ProducerLoopArtifactReview,
    calibration: {
      status: reviewed.calibration.status,
      hardGateReady: false,
    },
    caveats: [
      "Local operator review only; this is not server-side attestation.",
      "Producer Loop V0 keeps hardGateReady=false after review.",
    ],
  };
}

function printProducerLoopReviewResult(
  result: ProducerLoopArtifactReviewResult,
): void {
  console.log(chalk.bold("Producer Loop Review"));
  printKeyValue("Artifact:", result.relativePath);
  printKeyValue("Status:", result.review.status);
  if (result.review.outcome) {
    printKeyValue("Outcome:", result.review.outcome);
  }
  printKeyValue(
    "Hard gate ready:",
    result.calibration.hardGateReady ? "yes" : "no",
  );
}

function printProducerLoopReport(report: ProducerLoopReport): void {
  console.log(chalk.bold("Producer Loop Report"));
  printKeyValue("Status:", report.adoption.status);
  printKeyValue("Artifacts:", report.adoption.artifactCount);
  printKeyValue("Calibration:", report.calibration.status);
  printKeyValue("Reviewed:", report.calibration.reviewedSampleSize);
  printKeyValue("Rejected:", report.calibration.rejectedSampleSize);
  printKeyValue("Unreviewed:", report.calibration.unreviewedSampleSize);
  printKeyValue(
    "Hard gate ready:",
    report.calibration.hardGateReady ? "yes" : "no",
  );
  if (report.adoption.producerKinds.length > 0) {
    printKeyValue("Producers:", report.adoption.producerKinds.join(", "));
  }
  if (report.latestArtifact) {
    printKeyValue("Latest:", report.latestArtifact.relativePath);
  }
  if (report.invalidArtifacts.length > 0) {
    printKeyValue("Invalid artifacts:", report.invalidArtifacts.length);
  }
  printKeyValue("Worker receipts:", report.workerReceipts.sampleSize);
  if (report.workerReceipts.invalidArtifacts.length > 0) {
    printKeyValue(
      "Invalid worker evidence:",
      report.workerReceipts.invalidArtifacts.length,
    );
  }
  if (report.workerTrust.length > 0) {
    console.log("");
    console.log(chalk.bold("Worker Trust (supervised probation)"));
    for (const row of report.workerTrust) {
      console.log(
        `- ${row.workerId} / ${row.workCategory}: ${row.verifiedSampleSize} accepted, ${row.blockedSampleSize} blocked, ${row.reviewedSampleSize}/${row.sampleSize} reviewed`,
      );
    }
  }
  if (report.recommendedActions.length > 0) {
    console.log("");
    console.log(chalk.bold("Recommended Actions"));
    for (const action of report.recommendedActions) {
      console.log(`- ${action}`);
    }
  }
}

export async function workflowProducerReportCommand(options: {
  minReviewSamples?: number;
  json?: boolean;
}): Promise<void> {
  const report = buildProducerLoopReport({
    minReviewSampleSize: options.minReviewSamples,
  });
  if (options.json) {
    printJson(report);
    return;
  }
  printProducerLoopReport(report);
}

export async function workflowProducerReviewCommand(options: {
  artifact?: string;
  latest?: boolean;
  reject?: boolean;
  outcome?: string;
  reviewer?: string;
  note?: string[];
  json?: boolean;
}): Promise<void> {
  const result = reviewProducerLoopArtifact({
    artifact: options.artifact,
    latest: Boolean(options.latest),
    reject: Boolean(options.reject),
    outcome: options.outcome,
    reviewer: options.reviewer,
    notes: options.note ?? [],
  });
  if (options.json) {
    printJson(result);
    return;
  }
  printProducerLoopReviewResult(result);
}

function compactDecisionRequest(
  request: DecisionRequest,
  status: "pending" | "expired_pending",
) {
  return {
    requestId: request.requestId,
    fingerprint: request.fingerprint,
    status,
    blocking: request.blocking,
    producer: request.producer,
    decision: request.decision,
    question: request.question,
    options: request.options,
    recommendation: request.recommendation,
    rationale: request.rationale,
    evidence: request.evidence,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  };
}

type PolicyLedgerStatus =
  | "pending"
  | "expired_pending"
  | "approved"
  | "refused"
  | "modified"
  | "deferred";

interface PolicyLedgerEntry {
  requestId: string;
  fingerprint: string;
  status: PolicyLedgerStatus;
  producerKind: DecisionRequest["producer"]["kind"];
  decision: string;
  question: string;
  recommendation?: string;
  humanChoice?: string;
  reviewer?: string;
  note?: string;
  evidenceSummary: string;
  reasonCodes: string[];
  files: string[];
  applyPath?: string;
  applyCommand?: string;
  createdAt: string;
  resolvedAt?: string;
}

function isPolicyDecisionRequest(request: DecisionRequest): boolean {
  return (
    request.producer.kind === "project_policy_review" ||
    request.producer.kind === "policy_suggestion" ||
    request.evidence.reasonCodes.some((code) => /policy/i.test(code)) ||
    /project policy|policy suggestion|policy/i.test(
      [
        request.decision,
        request.question,
        request.evidence.summary,
        request.evidence.applyPath ?? "",
      ].join(" "),
    )
  );
}

function classifyResolvedPolicyDecisionChoice(
  choice: string,
): PolicyLedgerStatus {
  switch (choice) {
    case "approve_once":
    case "accept":
    case "accept_all":
    case "create_policy_suggestion":
    case "keep_advisory":
      return "approved";
    case "reject":
    case "reject_all":
    case "reject_policy_suggestion":
    case "require_changes":
    case "respect_block":
      return "refused";
    case "mark_policy_stale":
    case "request_exception":
      return "modified";
    case "ignore_once":
    case "inspect":
    case "defer":
    default:
      return "deferred";
  }
}

function buildPolicyLedgerEntries(): PolicyLedgerEntry[] {
  const pending = listPendingDecisionRequests()
    .filter((entry) => isPolicyDecisionRequest(entry.request))
    .map((entry): PolicyLedgerEntry => {
      const request = entry.request;
      return {
        requestId: request.requestId,
        fingerprint: request.fingerprint,
        status: entry.status,
        producerKind: request.producer.kind,
        decision: request.decision,
        question: request.question,
        recommendation: request.recommendation,
        evidenceSummary: request.evidence.summary,
        reasonCodes: request.evidence.reasonCodes,
        files: request.evidence.files ?? [],
        applyPath: request.evidence.applyPath,
        applyCommand: request.evidence.applyCommand,
        createdAt: request.createdAt,
      };
    });
  const resolved = listResolvedDecisionRecords()
    .filter((record) => isPolicyDecisionRequest(record.request))
    .map((record): PolicyLedgerEntry => {
      const request = record.request;
      return {
        requestId: request.requestId,
        fingerprint: request.fingerprint,
        status: classifyResolvedPolicyDecisionChoice(record.response.choice),
        producerKind: request.producer.kind,
        decision: request.decision,
        question: request.question,
        recommendation: request.recommendation,
        humanChoice: record.response.choice,
        reviewer: record.response.reviewer,
        note: record.response.note,
        evidenceSummary: request.evidence.summary,
        reasonCodes: request.evidence.reasonCodes,
        files: request.evidence.files ?? [],
        applyPath: request.evidence.applyPath,
        applyCommand: request.evidence.applyCommand,
        createdAt: request.createdAt,
        resolvedAt: record.response.resolvedAt,
      };
    });

  return [...pending, ...resolved].sort((left, right) => {
    const leftTime = left.resolvedAt ?? left.createdAt;
    const rightTime = right.resolvedAt ?? right.createdAt;
    return (
      rightTime.localeCompare(leftTime) ||
      left.requestId.localeCompare(right.requestId)
    );
  });
}

function summarizePolicyLedger(entries: PolicyLedgerEntry[]) {
  const counts: Record<PolicyLedgerStatus, number> = {
    pending: 0,
    expired_pending: 0,
    approved: 0,
    refused: 0,
    modified: 0,
    deferred: 0,
  };
  for (const entry of entries) {
    counts[entry.status] += 1;
  }
  return {
    total: entries.length,
    pending: counts.pending,
    expiredPending: counts.expired_pending,
    approved: counts.approved,
    refused: counts.refused,
    modified: counts.modified,
    deferred: counts.deferred,
  };
}

function buildPolicyLedgerAgentPrompt(entries: PolicyLedgerEntry[]): string[] {
  const active = entries.filter(
    (entry) => entry.status === "pending" || entry.status === "expired_pending",
  );
  if (active.length === 0) {
    return [
      "No pending Project Policy decision needs a human response right now.",
    ];
  }
  return active.slice(0, 5).map((entry) => {
    const options = entry.recommendation
      ? ` Recommended: ${entry.recommendation}.`
      : "";
    return `Ask the user: ${entry.question} Options are recorded in the pending Decision Request.${options} Resolve with snipara-companion workflow decide ${entry.requestId} --choose <human-choice> --reviewer <name>.`;
  });
}

export async function workflowPolicyLedgerCommand(options: {
  json?: boolean;
}): Promise<void> {
  const entries = buildPolicyLedgerEntries();
  const summary = summarizePolicyLedger(entries);
  const payload = {
    version: "snipara.workflow_policy_ledger.v0",
    generatedAt: new Date().toISOString(),
    summary,
    entries,
    agentPrompt: buildPolicyLedgerAgentPrompt(entries),
    caveats: [
      "Policy ledger is observational; it never applies or edits Project Policy automatically.",
      "The LLM agent must ask the user for pending policy decisions and resolve them with workflow decide.",
      "The dashboard is for auditability and administration, not a replacement for explicit human approval.",
    ],
  };
  if (options.json) {
    printJson(payload);
    return;
  }
  console.log(chalk.bold("Project Policy Ledger"));
  printKeyValue("Pending:", String(summary.pending));
  printKeyValue("Approved:", String(summary.approved));
  printKeyValue("Refused:", String(summary.refused));
  printKeyValue("Modified:", String(summary.modified));
  if (entries.length === 0) {
    console.log("No Project Policy decision artifacts found.");
    return;
  }
  for (const entry of entries.slice(0, 20)) {
    const actor = entry.reviewer ? ` by ${entry.reviewer}` : "";
    console.log(
      `- ${entry.requestId} [${entry.status}${actor}] ${entry.question}`,
    );
    if (entry.humanChoice) {
      console.log(`  choice: ${entry.humanChoice}`);
    }
    console.log(`  evidence: ${entry.evidenceSummary}`);
    if (entry.status === "pending" || entry.status === "expired_pending") {
      console.log(
        `  ask: snipara-companion workflow decide ${entry.requestId} --choose <human-choice> --reviewer <name>`,
      );
    }
  }
}

export async function workflowApplyDecisionsCommand(options: {
  dryRun?: boolean;
  json?: boolean;
}): Promise<void> {
  const dryRun = options.dryRun ?? false;
  const report = buildDecisionApplyReport({ dryRun });
  if (options.json) {
    printJson(report);
    return;
  }

  console.log(
    chalk.bold(`Decision Apply Pipeline${dryRun ? " (dry-run)" : ""}`),
  );
  printKeyValue(
    "Resolved policy decisions:",
    report.summary.totalResolvedPolicyDecisions,
  );
  printKeyValue("Needs apply:", report.summary.needsApply);
  printKeyValue("Applied:", report.summary.applied);
  printKeyValue("Manual follow-up:", report.summary.manualFollowUpRequired);
  printKeyValue("No apply:", report.summary.noApply);
  if (!dryRun) {
    printKeyValue("Written:", report.summary.written);
  }
  if (report.items.length === 0) {
    console.log("No resolved Project Policy decisions found.");
    return;
  }
  for (const item of report.items.slice(0, 20)) {
    printDecisionApplyItem(item);
  }
}

function printDecisionApplyItem(item: DecisionApplyItem): void {
  console.log(`- ${item.requestId} [${item.state}] ${item.question}`);
  console.log(
    `  choice: ${item.choice} (${item.choiceClass}) by ${item.reviewer}`,
  );
  if (item.plannedActions.length > 0) {
    console.log(`  actions: ${item.plannedActions.join(", ")}`);
  }
  if (item.policyDraftPath) {
    console.log(`  draft: ${item.policyDraftPath}`);
  }
  if (item.applyCommand && item.state === "manual_follow_up_required") {
    console.log(
      `  manual: ${renderManualApplyCommand(item.applyCommand, item.choice)}`,
    );
  }
  for (const caveat of item.caveats) {
    console.log(`  note: ${caveat}`);
  }
}

function printDecisionRequests(
  entries: ReturnType<typeof listPendingDecisionRequests>,
): void {
  console.log(chalk.bold("Pending Decision Requests"));
  if (entries.length === 0) {
    console.log("No pending decision requests.");
    return;
  }
  for (const entry of entries) {
    const request = entry.request;
    console.log(`- ${request.requestId} [${entry.status}] ${request.question}`);
    console.log(
      `  producer: ${request.producer.kind} via ${request.producer.command}`,
    );
    console.log(`  options: ${request.options.join(", ")}`);
    if (request.recommendation) {
      console.log(`  recommendation: ${request.recommendation}`);
    }
    console.log(`  evidence: ${request.evidence.summary}`);
    if (request.evidence.items?.length) {
      console.log("  items:");
      for (const item of request.evidence.items) {
        console.log(`    - ${item.ref}${item.title ? `: ${item.title}` : ""}`);
        if (item.status || item.kind) {
          console.log(
            `      ${[item.kind, item.status].filter(Boolean).join(" | ")}`,
          );
        }
        if (item.summary) {
          console.log(`      ${item.summary}`);
        }
        if (item.files?.length) {
          console.log(
            `      files: ${item.files.slice(0, 5).join(", ")}${item.files.length > 5 ? ` (+${item.files.length - 5})` : ""}`,
          );
        }
      }
    }
    if (request.evidence.applyCommand) {
      console.log(`  apply: ${request.evidence.applyCommand}`);
    }
  }
}

export async function workflowDecisionsCommand(options: {
  json?: boolean;
}): Promise<void> {
  const entries = listPendingDecisionRequests();
  if (options.json) {
    printJson({
      version: "snipara.workflow_decisions.v0",
      generatedAt: new Date().toISOString(),
      pendingCount: entries.filter((entry) => entry.status === "pending")
        .length,
      expiredPendingCount: entries.filter(
        (entry) => entry.status === "expired_pending",
      ).length,
      requests: entries.map((entry) =>
        compactDecisionRequest(entry.request, entry.status),
      ),
      caveats: [
        "Decision requests never resolve by timeout or default.",
        "The LLM client renders the question; Companion only stores auditable request/response artifacts.",
      ],
    });
    return;
  }
  printDecisionRequests(entries);
}

function shouldApplyProducerReview(choice: string): boolean {
  return ["accept", "accept_all", "reject", "reject_all"].includes(choice);
}

function isRejectChoice(choice: string): boolean {
  return choice === "reject" || choice === "reject_all";
}

function renderManualApplyCommand(command: string, choice: string): string {
  return command.replaceAll("<human-choice>", choice);
}

function applyDecisionRequestLocally(options: {
  request: DecisionRequest;
  choice: string;
  reviewer: string;
  note?: string;
}): string[] {
  const request = options.request;
  if (request.evidence.applyPath !== "workflow producer-review") {
    return request.evidence.applyCommand
      ? [
          `manual_apply_required: ${renderManualApplyCommand(request.evidence.applyCommand, options.choice)}`,
        ]
      : ["manual_apply_required"];
  }
  if (!shouldApplyProducerReview(options.choice)) {
    return ["no_apply: human chose inspection or deferral"];
  }
  const applied: string[] = [];
  for (const ref of request.evidence.refs) {
    const review = reviewProducerLoopArtifact({
      artifact: ref,
      reject: isRejectChoice(options.choice),
      outcome: isRejectChoice(options.choice) ? "false_positive" : "useful",
      reviewer: options.reviewer,
      notes: uniqueStrings([
        `decision_request:${request.requestId}`,
        ...(options.note ? [options.note] : []),
      ]),
    });
    applied.push(
      `workflow producer-review ${review.artifactId} ${review.review.status}${
        review.review.outcome ? ` ${review.review.outcome}` : ""
      }`,
    );
  }
  return applied;
}

function recurringPolicySuggestionKey(record: {
  request: DecisionRequest;
  response: { choice: string; note?: string };
}): string {
  return stableDecisionJsonStringify({
    producer: record.request.producer.kind,
    choice: record.response.choice,
    targetCategory: recurringPolicySuggestionTargetCategory(record.request),
  });
}

function recurringPolicySuggestionTargetCategory(
  request: DecisionRequest,
): string {
  const evidenceCategories =
    request.evidence.items
      ?.map((item) => {
        const metadata = isRecord(item.metadata) ? item.metadata : undefined;
        return (
          stringValue(metadata?.category) ??
          stringValue(metadata?.type) ??
          item.kind
        );
      })
      .filter((value): value is string => Boolean(value)) ?? [];
  return (
    uniqueStrings(evidenceCategories).sort().join("|") ||
    request.evidence.applyPath ||
    request.decision
  );
}

function buildRecurringDecisionPolicySuggestionRequest(
  resolvedRecords: ReturnType<typeof listResolvedDecisionRecords>,
): DecisionRequest | null {
  const grouped = new Map<
    string,
    ReturnType<typeof listResolvedDecisionRecords>
  >();
  for (const record of resolvedRecords) {
    const key = recurringPolicySuggestionKey(record);
    const group = grouped.get(key) ?? [];
    group.push(record);
    grouped.set(key, group);
  }
  const repeated = [...grouped.values()]
    .filter((group) => group.length >= 2)
    .sort((left, right) => right.length - left.length)[0];
  if (!repeated) {
    return null;
  }
  const latest = repeated[repeated.length - 1];
  const refs = repeated.map((record) => record.request.requestId);
  const note = compactWhitespace(latest.response.note ?? "");
  const policyTitle = note
    ? `Never ask twice for: ${note}`
    : `Never ask twice for ${latest.request.decision} -> ${latest.response.choice}`;
  const targetCategory = recurringPolicySuggestionTargetCategory(
    latest.request,
  );

  return buildDecisionRequest({
    producer: {
      kind: "policy_suggestion",
      command: "workflow decide",
      sourceRef: ".snipara/decisions/resolved",
    },
    decision: "promote_recurring_decision_policy",
    question: `Create a reusable triage policy for recurring decision '${latest.request.decision}'?`,
    evidence: {
      summary: `${repeated.length} resolved decision receipts share the same choice and rationale. Suggested policy: ${policyTitle}`,
      refs,
      items: repeated.map((record) => ({
        ref: record.request.requestId,
        title: record.request.question,
        summary: record.response.note ?? record.response.choice,
        kind: record.request.producer.kind,
        status: record.response.choice,
        files: record.request.evidence.files?.slice(0, 12),
      })),
      reasonCodes: uniqueStrings([
        "recurring_decision_receipts",
        "never_ask_twice_candidate",
        ...latest.request.evidence.reasonCodes,
      ]),
      files: uniqueStrings(
        repeated.flatMap((record) => record.request.evidence.files ?? []),
      ),
      applyPath: "manual_context_review",
      applyCommand:
        "Review the suggested rule and add it to the appropriate project policy or AGENTS.md section manually.",
    },
    options: [
      "create_policy_suggestion",
      "ignore_once",
      "reject_policy_suggestion",
    ],
    recommendation: "create_policy_suggestion",
    rationale:
      "Repeated human decisions should become explicit reviewable policy suggestions, never silent auto-applied rules.",
    fingerprintParts: [
      "recurring_decision_policy_suggestion",
      repeated.length,
      latest.request.producer.kind,
      latest.response.choice,
      targetCategory,
    ],
  });
}

export async function workflowDecideCommand(options: {
  requestId: string;
  choice: string;
  reviewer: string;
  note?: string;
  json?: boolean;
}): Promise<void> {
  if (!options.reviewer?.trim()) {
    throw new Error("workflow decide requires --reviewer <name>.");
  }
  const pending = listPendingDecisionRequests().find(
    (entry) =>
      entry.request.requestId === options.requestId ||
      entry.request.fingerprint === options.requestId,
  );
  if (!pending) {
    throw new Error(
      `No pending decision request matched '${options.requestId}'.`,
    );
  }
  if (!pending.request.options.includes(options.choice)) {
    throw new Error(
      `Invalid choice '${options.choice}'. Valid options: ${pending.request.options.join(", ")}.`,
    );
  }
  const appliedActions = applyDecisionRequestLocally({
    request: pending.request,
    choice: options.choice,
    reviewer: options.reviewer,
    note: options.note,
  });
  const resolved = resolveDecisionRequest({
    requestId: pending.request.requestId,
    choice: options.choice,
    reviewer: options.reviewer,
    note: options.note,
    appliedActions,
  });
  const policySuggestionRequest = buildRecurringDecisionPolicySuggestionRequest(
    listResolvedDecisionRecords(),
  );
  const policySuggestionWrite = policySuggestionRequest
    ? writeDecisionRequest(policySuggestionRequest)
    : undefined;
  appendActivityEvent({
    source: "decision",
    kind: "decision-resolved",
    title: resolved.request.question,
    summary: resolved.response.note ?? resolved.response.choice,
    actor: resolved.response.reviewer,
    outcome: resolved.response.choice,
    files: resolved.request.evidence.files,
    refs: [resolved.request.requestId, resolved.request.fingerprint],
    timestamp: resolved.response.resolvedAt,
    metadata: {
      producer: resolved.request.producer.kind,
      decision: resolved.request.decision,
      appliedActions,
      policySuggestionStatus: policySuggestionWrite?.status,
      policySuggestionRequestId: policySuggestionWrite?.requestId,
    },
  });
  if (policySuggestionWrite?.status === "written" && policySuggestionRequest) {
    appendActivityEvent({
      source: "decision",
      kind: "policy-suggestion-created",
      title: policySuggestionRequest.question,
      summary: policySuggestionRequest.evidence.summary,
      files: policySuggestionRequest.evidence.files,
      refs: [
        policySuggestionRequest.requestId,
        policySuggestionRequest.fingerprint,
      ],
      timestamp: policySuggestionRequest.createdAt,
      metadata: {
        recommendation: policySuggestionRequest.recommendation,
        manualApplyRequired: true,
      },
    });
  }
  writeSessionSnapshot();
  const payload = {
    version: DECISION_RESPONSE_VERSION,
    request: resolved.request,
    response: resolved.response,
    resolvedPath: toProjectRelativePath(resolved.resolvedPath),
    policySuggestion: policySuggestionRequest,
    policySuggestionWrite,
  };
  if (options.json) {
    printJson(payload);
    return;
  }
  console.log(chalk.bold("Decision Resolved"));
  printKeyValue("Request:", resolved.request.requestId);
  printKeyValue("Choice:", resolved.response.choice);
  printKeyValue("Reviewer:", resolved.response.reviewer);
  for (const action of resolved.response.appliedActions) {
    console.log(`- ${action}`);
  }
  if (policySuggestionWrite?.status === "written") {
    console.log(`Policy suggestion: ${policySuggestionWrite.relativePath}`);
  }
}

function buildProducerTriageRequest(
  report: ProducerLoopReport,
): DecisionRequest | null {
  const candidates = report.artifacts.filter(
    (artifact) => artifact.reviewStatus === "sample_unreviewed",
  );
  if (candidates.length === 0) {
    return null;
  }
  const refs = candidates.map((artifact) => artifact.artifactId);
  const items = candidates.map((artifact) => ({
    ref: artifact.artifactId,
    title: producerLoopTriageItemTitle(artifact),
    summary: artifact.summary ?? `${artifact.producerKind} sample for review.`,
    kind: artifact.producerKind,
    status: artifact.reviewStatus,
    files: artifact.files.slice(0, 12),
    metadata: {
      generatedAt: artifact.generatedAt,
      workflowId: artifact.workflowId ?? null,
      phaseId: artifact.phaseId ?? null,
      outcome: artifact.outcome ?? null,
      artifactHash: artifact.artifactHash,
      ledgerHash: artifact.ledgerHash ?? null,
      relativePath: artifact.relativePath,
    },
  }));
  return buildDecisionRequest({
    producer: {
      kind: "producer_loop_triage",
      command: "workflow producer-triage",
      sourceRef: PRODUCER_LOOP_RELATIVE_DIR,
    },
    decision: "accept_triage_batch",
    question: `Accept ${candidates.length} Producer Loop samples as reviewed?`,
    evidence: {
      summary: `${candidates.length} unreviewed Producer Loop samples; ${report.invalidArtifacts.length} invalid artifacts; hardGateReady remains false.`,
      refs,
      items,
      reasonCodes: uniqueStrings([
        "triage_rules_v0",
        "producer_loop_report_valid",
        ...(report.invalidArtifacts.length === 0
          ? ["no_invalid_artifacts"]
          : ["invalid_artifacts_present"]),
      ]),
      files: uniqueStrings(candidates.flatMap((artifact) => artifact.files)),
      applyPath: "workflow producer-review",
      applyCommand:
        "snipara-companion workflow decide <request-id> --choose accept_all --reviewer <name>",
    },
    options: ["accept_all", "inspect_each", "reject_all"],
    recommendation:
      report.invalidArtifacts.length === 0 ? "accept_all" : "inspect_each",
    rationale:
      report.invalidArtifacts.length === 0
        ? "All candidate artifacts parsed successfully; review remains an explicit human decision."
        : "Invalid artifacts are present, so inspect before accepting.",
    fingerprintParts: [
      "producer_loop_triage",
      "triage_rules_v0",
      candidates.map((artifact) => [
        artifact.artifactId,
        artifact.artifactHash,
      ]),
    ],
  });
}

function producerLoopTriageItemTitle(
  artifact: ProducerLoopArtifactReportSummary,
): string {
  const workflow = artifact.workflowId ?? "producer-loop";
  const phase = artifact.phaseTitle ?? artifact.phaseId;
  return phase ? `${workflow} / ${phase}` : workflow;
}

export async function workflowProducerTriageCommand(options: {
  minReviewSamples?: number;
  json?: boolean;
}): Promise<void> {
  const report = buildProducerLoopReport({
    minReviewSampleSize: options.minReviewSamples,
  });
  const request = buildProducerTriageRequest(report);
  const write = request ? writeDecisionRequest(request) : undefined;
  const payload = {
    version: "snipara.producer_loop_triage.v0",
    generatedAt: new Date().toISOString(),
    candidateCount: report.artifacts.filter(
      (artifact) => artifact.reviewStatus === "sample_unreviewed",
    ).length,
    request,
    write,
    caveats: [
      "Triage emits a decision request only; it never marks samples reviewed by itself.",
      "Resolve the request with workflow decide so the response receipt records the human choice.",
    ],
  };
  if (options.json) {
    printJson(payload);
    return;
  }
  if (!request || !write) {
    console.log("No unreviewed Producer Loop samples need triage.");
    return;
  }
  console.log(`Decision request ${write.status}: ${write.requestId}`);
  console.log(request.question);
}

export async function workflowDecisionProducerMemoryCommand(options: {
  memoryId: string;
  action: string;
  summary?: string;
  reviewerHint?: string;
  json?: boolean;
}): Promise<void> {
  const action = options.action.trim();
  if (!MEMORY_DECISION_PRODUCER_ACTIONS.has(action)) {
    throw new Error(
      `Invalid memory decision action '${action}'. Use one of: ${[
        ...MEMORY_DECISION_PRODUCER_ACTIONS,
      ].join(
        ", ",
      )}. Internal review item types such as review_queue_item are not human actions.`,
    );
  }
  const reviewItem = await findMemoryReviewConnectorItem(options.memoryId);
  if (reviewItem) {
    const request = buildMemoryReviewDecisionRequest({
      ...reviewItem,
      action,
      recommendation: options.reviewerHint ?? action,
      options:
        action === "verify"
          ? ["verify", "keep_pending", "invalidate"]
          : action === "invalidate"
            ? ["invalidate", "keep", "inspect"]
            : reviewItem.options.includes(action)
              ? reviewItem.options
              : [
                  action,
                  ...reviewItem.options.filter((option) => option !== action),
                ],
    });
    const write = writeDecisionRequest(request);
    if (options.json) {
      printJson({ request, write, inheritedFrom: "memory reviews" });
      return;
    }
    console.log(`Decision request ${write.status}: ${write.requestId}`);
    console.log(request.question);
    return;
  }
  const applyPath =
    action === "verify"
      ? "snipara_memory_verify"
      : action === "invalidate"
        ? "snipara_memory_invalidate"
        : "snipara_memory_resolve_queue_item";
  const request = buildDecisionRequest({
    producer: {
      kind:
        action === "verify"
          ? "memory_verify"
          : action === "invalidate"
            ? "memory_invalidate"
            : "memory_review_queue",
      command: "workflow decision-producer memory",
      sourceRef: `memory:${options.memoryId}`,
    },
    decision: `memory_${action}`,
    question: `${action} memory ${options.memoryId}?`,
    evidence: {
      summary:
        options.summary ??
        `Memory ${options.memoryId} needs human review for action ${action}.`,
      refs: [`memory:${options.memoryId}`],
      reasonCodes: ["memory_human_review", `memory_action_${action}`],
      applyPath,
      applyCommand:
        applyPath === "snipara_memory_verify"
          ? `snipara_memory_verify({ memory_id: "${options.memoryId}" })`
          : applyPath === "snipara_memory_invalidate"
            ? `snipara_memory_invalidate({ memory_id: "${options.memoryId}" })`
            : `snipara_memory_resolve_queue_item({ memory_id: "${options.memoryId}", action: "${action}" })`,
    },
    options:
      action === "verify"
        ? ["verify", "keep_pending", "invalidate"]
        : action === "invalidate"
          ? ["invalidate", "keep", "inspect"]
          : [action, "keep_pending", "reject"],
    recommendation: options.reviewerHint,
    fingerprintParts: ["memory", options.memoryId, action],
  });
  const write = writeDecisionRequest(request);
  if (options.json) {
    printJson({ request, write });
    return;
  }
  console.log(`Decision request ${write.status}: ${write.requestId}`);
}

async function findMemoryReviewConnectorItem(
  memoryId: string,
): Promise<MemoryReviewConnectorItem | null> {
  try {
    const result = await buildMemoryReviewConnector({
      limit: 50,
      includeCleanCandidates: false,
      includeDuplicates: false,
    });
    return (
      result.items.find(
        (item) =>
          item.memoryId === memoryId ||
          item.evidenceItem.ref === memoryId ||
          item.evidenceItem.ref === `memory:${memoryId}`,
      ) ?? null
    );
  } catch {
    return null;
  }
}

export async function workflowDecisionProducerContextRiskCommand(options: {
  ref: string;
  summary?: string;
  kind?: string;
  json?: boolean;
}): Promise<void> {
  const kind =
    options.kind === "document_tombstone"
      ? "document_tombstone"
      : "unknown_registry_risk";
  const request = buildDecisionRequest({
    producer: {
      kind,
      command: "workflow decision-producer context-risk",
      sourceRef: options.ref,
    },
    decision: "validate_context_risk",
    question: `Is this context risk still true: ${options.ref}?`,
    evidence: {
      summary:
        options.summary ??
        `Context risk ${options.ref} needs human validation.`,
      refs: [options.ref],
      reasonCodes: [kind, "stale_context_human_review"],
      applyPath: "manual_context_review",
      applyCommand:
        "Update or invalidate the cited context source after review.",
    },
    options: ["still_true", "invalidate", "needs_rewrite", "ignore"],
    recommendation: "still_true",
    fingerprintParts: ["context-risk", kind, options.ref],
  });
  const write = writeDecisionRequest(request);
  if (options.json) {
    printJson({ request, write });
    return;
  }
  console.log(`Decision request ${write.status}: ${write.requestId}`);
}

export async function workflowScaffoldCommand(options: {
  preset: string;
  goal?: string;
  output?: string;
  json?: boolean;
}): Promise<void> {
  const preset = parseWorkflowPlanPreset(options.preset);
  const scaffold = buildWorkflowPlanScaffold(preset, {
    goal: options.goal,
    outputPath: options.output,
  });
  fs.mkdirSync(path.dirname(scaffold.outputPath), { recursive: true });
  fs.writeFileSync(
    `${scaffold.outputPath}`,
    `${JSON.stringify(scaffold.plan, null, 2)}\n`,
    "utf8",
  );

  if (options.json) {
    printJson({
      preset: scaffold.preset,
      goal: scaffold.goal,
      output_path: scaffold.outputPath,
      relative_output_path: scaffold.relativeOutputPath,
      phase_count: scaffold.plan.steps.length,
      runtime_phase_ids: scaffold.plan.steps
        .filter((step) => step.needs_runtime)
        .map((step) => step.id),
      plan: scaffold.plan,
    });
    return;
  }

  console.log(chalk.bold("Workflow scaffold"));
  console.log(`Preset: ${scaffold.preset}`);
  console.log(`Goal: ${scaffold.goal}`);
  console.log(`Plan file: ${scaffold.relativeOutputPath}`);
  console.log("");
  console.log(chalk.bold("Next commands"));
  console.log(
    `snipara-companion workflow start --goal ${shellQuote(scaffold.goal)} --plan-file ${shellQuote(
      scaffold.relativeOutputPath,
    )}`,
  );
  if (scaffold.plan.steps.some((step) => step.needs_runtime)) {
    console.log(
      "Runtime-bound phases are included; use workflow phase-start and workflow runtime-checkpoint during sandbox-backed validation.",
    );
  }
  console.log("");
}

function findWorkflowPhase(
  state: ManagedWorkflowState,
  phaseId: string,
): ManagedWorkflowPhase {
  const phase = state.phases.find((candidate) => candidate.id === phaseId);
  if (!phase) {
    throw new Error(`Unknown workflow phase '${phaseId}'`);
  }
  return phase;
}

function nextOpenPhase(
  state: ManagedWorkflowState,
): ManagedWorkflowPhase | undefined {
  return state.phases.find(
    (phase) => phase.status === "pending" || phase.status === "blocked",
  );
}

function currentWorkflowPhase(
  state: ManagedWorkflowState,
): ManagedWorkflowPhase | undefined {
  if (state.currentPhaseId) {
    return state.phases.find((phase) => phase.id === state.currentPhaseId);
  }
  return nextOpenPhase(state);
}

function sandboxBindings(
  state: ManagedWorkflowState,
): ManagedWorkflowSandboxRuntimeBinding[] {
  return state.runtime?.sandbox?.bindings ?? [];
}

function findSandboxRuntimeBinding(
  state: ManagedWorkflowState,
  phaseId: string,
): ManagedWorkflowSandboxRuntimeBinding | undefined {
  return sandboxBindings(state).find((binding) => binding.phaseId === phaseId);
}

function defaultSandboxSessionId(
  state: ManagedWorkflowState,
  phase: Pick<ManagedWorkflowPhase, "id">,
): string {
  const workflowSlug = sanitizeWorkflowId(state.workflowId, "workflow").slice(
    0,
    24,
  );
  const phaseSlug = sanitizeWorkflowId(phase.id, "phase").slice(0, 24);
  const digest = createHash("sha1")
    .update(`${state.workflowId}:${phase.id}`)
    .digest("hex")
    .slice(0, 10);
  return `sandbox-${workflowSlug}-${phaseSlug}-${digest}`.slice(0, 96);
}

function ensureSandboxRuntimeBinding(
  state: ManagedWorkflowState,
  phase: ManagedWorkflowPhase,
  now: string,
): ManagedWorkflowSandboxRuntimeBinding {
  if (!state.runtime) {
    state.runtime = {};
  }
  if (!state.runtime.sandbox) {
    state.runtime.sandbox = {
      provider: "snipara-sandbox",
      bindings: [],
    };
  }

  const existing = state.runtime.sandbox.bindings.find(
    (binding) => binding.phaseId === phase.id,
  );
  if (existing) {
    existing.bootstrapQuery =
      existing.bootstrapQuery || phaseQuery(state, phase);
    return existing;
  }

  const config = loadConfig();
  const binding: ManagedWorkflowSandboxRuntimeBinding = {
    phaseId: phase.id,
    sessionId: defaultSandboxSessionId(state, phase),
    automationSessionId: config.sessionId,
    boundAt: now,
    bootstrapQuery: phaseQuery(state, phase),
    artifacts: [],
  };
  state.runtime.sandbox.bindings.push(binding);
  return binding;
}

function rehydratableStateKeys(
  checkpoint: ManagedWorkflowRuntimeCheckpoint | undefined,
): string[] | undefined {
  if (!checkpoint?.rehydratableState) {
    return undefined;
  }
  return uniqueStringList(Object.keys(checkpoint.rehydratableState));
}

function normalizeRuntimeCheckpointRecord(
  checkpoint: ManagedWorkflowRuntimeCheckpoint,
): ManagedWorkflowRuntimeCheckpoint {
  return {
    ...checkpoint,
    files: uniqueStringList(checkpoint.files) ?? [],
    commands: uniqueStringList(checkpoint.commands) ?? [],
    artifacts: uniqueStringList(checkpoint.artifacts) ?? [],
    contextPackReceipts:
      normalizeLocalContextPackReceipts(checkpoint.contextPackReceipts) ?? [],
  };
}

function normalizeLocalContextPackReceipts(
  value: unknown,
): LocalContextPackReceiptPayload[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const receipts = value
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .filter((item) => item.version === "snipara.context_pack.receipt.v1")
    .map((item) => item as unknown as LocalContextPackReceiptPayload)
    .slice(0, 20);
  return receipts.length > 0 ? receipts : undefined;
}

function runtimeCheckpointEventPayload(
  event: RecentAutomationEvent,
): Record<string, unknown> | undefined {
  const payload = isRecord(event.event.payload)
    ? event.event.payload
    : undefined;
  if (!payload) {
    return undefined;
  }
  const toolName = stringValue(
    payload.tool_name ?? payload.toolName ?? payload.tool,
  );
  if (toolName !== "snipara_sandbox_runtime_checkpoint") {
    return undefined;
  }
  return payload;
}

function parseRuntimeCheckpointFromEvent(
  event: RecentAutomationEvent,
  workflowId: string,
  phaseId: string,
): ManagedWorkflowRuntimeCheckpoint | undefined {
  const payload = runtimeCheckpointEventPayload(event);
  if (!payload) {
    return undefined;
  }

  const eventWorkflowId = stringValue(payload.workflow_id);
  const eventPhaseId = stringValue(payload.workflow_phase_id);
  if (eventWorkflowId !== workflowId || eventPhaseId !== phaseId) {
    return undefined;
  }

  const runtimeCheckpoint = recordField(payload, "runtime_checkpoint");
  if (!runtimeCheckpoint) {
    return undefined;
  }

  return normalizeRuntimeCheckpointRecord({
    summary:
      stringValue(runtimeCheckpoint.summary) ??
      stringValue(payload.task) ??
      "Runtime checkpoint captured",
    capturedAt:
      stringValue(runtimeCheckpoint.captured_at) ??
      stringValue(event.event.timestamp) ??
      event.createdAt,
    automationSessionId:
      stringValue(runtimeCheckpoint.automation_session_id) ??
      stringValue(event.event.session_id) ??
      undefined,
    hostedEventId: event.id,
    hostedRecordedAt: event.createdAt,
    environment: stringValue(runtimeCheckpoint.environment),
    profile: stringValue(runtimeCheckpoint.profile),
    bootstrapQuery:
      stringValue(runtimeCheckpoint.bootstrap_query) ??
      stringValue(payload.task) ??
      undefined,
    files:
      normalizeStringArray(runtimeCheckpoint.files) ??
      normalizeStringArray(payload.files) ??
      undefined,
    commands:
      normalizeStringArray(runtimeCheckpoint.commands) ??
      normalizeStringArray(payload.commands) ??
      undefined,
    artifacts: normalizeStringArray(runtimeCheckpoint.artifacts) ?? undefined,
    contextPackReceipts:
      normalizeLocalContextPackReceipts(
        runtimeCheckpoint.context_pack_receipts,
      ) ??
      normalizeLocalContextPackReceipts(payload.local_context_pack_receipts),
    rehydratableState: recordField(runtimeCheckpoint, "rehydratable_state"),
  });
}

function phaseStatusFromOutcome(
  outcome: TaskCommitOutcome,
): ManagedWorkflowPhaseStatus {
  if (outcome === "completed") {
    return "completed";
  }
  if (outcome === "abandoned") {
    return "skipped";
  }
  return "blocked";
}

export function buildWorkflowPhaseCommitSummary(args: {
  workflowId: string;
  phase: Pick<ManagedWorkflowPhase, "id" | "title">;
  summary: string;
}): string {
  return [
    `Workflow ${args.workflowId}`,
    `Phase ${args.phase.id}: ${args.phase.title}`,
    args.summary,
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function phaseQuery(
  state: ManagedWorkflowState,
  phase: ManagedWorkflowPhase,
): string {
  return phase.query || `${state.goal}: ${phase.title}`;
}

export function resolveAutoWorkflowMode(
  query: string,
): Exclude<WorkflowMode, "auto"> {
  const normalized = query.toLowerCase();

  if (
    /\b(orchestrate|swarm|htask|handoff|multi-agent|multi agent|worker|proof gate|proof-gate|drift check|release gate|production gate)\b/.test(
      normalized,
    )
  ) {
    return "orchestrate";
  }

  if (
    /\b(deploy|deployment|release|merge|push|migration|schema|auth|billing|security|architecture|architectural|multi-phase|multiphase|phase commit|final commit|managed workflow|roadmap|plan)\b/.test(
      normalized,
    )
  ) {
    return "full";
  }

  if (
    /\b(why|pourquoi|decision|décision|rationale|positioning|positionnement|strategy|stratégie|cross-session|previous decision|prior decision|historical context)\b/.test(
      normalized,
    )
  ) {
    return "standard";
  }

  if (
    /\b(status|show|list|read|lookup|recall|brief|summarize|summary|what changed|question|docs?|documentation)\b/.test(
      normalized,
    ) &&
    !/\b(implement|change|fix|ship|code|refactor|test|write|create|build)\b/.test(
      normalized,
    )
  ) {
    return "lite";
  }

  if (
    /\b(typo|copy edit|small diff|tiny diff|one-line|one line|known file|obvious fix|quick fix|format|formatting|rename)\b/.test(
      normalized,
    ) &&
    !/\b(architecture|release|deploy|migration|schema|auth|billing|security|multi-file|many files|5\+ files|cross-session|decision|décision)\b/.test(
      normalized,
    )
  ) {
    return "lite";
  }

  return "standard";
}

function effectiveWorkflowMode(
  mode: WorkflowMode,
  query = "",
): Exclude<WorkflowMode, "auto"> {
  return mode === "auto" ? resolveAutoWorkflowMode(query) : mode;
}

function shouldFollowWorkflowRecommendations(
  mode: WorkflowMode,
  query = "",
): boolean {
  const effectiveMode = effectiveWorkflowMode(mode, query);
  return effectiveMode === "standard" || effectiveMode === "full";
}

function printManagedWorkflowState(state: ManagedWorkflowState): void {
  printKeyValue("Workflow:", `${state.workflowId} (${state.status})`);
  printKeyValue("Goal:", state.goal);
  printKeyValue("State file:", WORKFLOW_STATE_RELATIVE_PATH);
  const pendingDecisions = safeDecisionPendingCount();
  if (pendingDecisions > 0) {
    printKeyValue("Pending decisions:", String(pendingDecisions));
  }
  if (state.currentPhaseId) {
    printKeyValue("Current phase:", state.currentPhaseId);
    const runtimeBinding = findSandboxRuntimeBinding(
      state,
      state.currentPhaseId,
    );
    if (runtimeBinding) {
      printKeyValue("Sandbox session:", runtimeBinding.sessionId);
    }
  }
  if (state.judgment) {
    printKeyValue(
      "Judgment:",
      `${state.judgment.card.state} (${state.judgment.responses.length}/${state.judgment.card.advisorRecommendations.length} response(s))`
    );
    printKeyValue(
      "Judgment identity:",
      state.judgment.brief.servedJudgmentId ? "linked" : "missing"
    );
  }
  console.log("");

  console.log(chalk.bold("Phases"));
  for (const phase of state.phases) {
    const marker = phase.id === state.currentPhaseId ? "*" : "-";
    console.log(`${marker} [${phase.status}] ${phase.id}: ${phase.title}`);
    if (phase.acceptance) {
      console.log(`  Acceptance: ${toPreview(phase.acceptance, 180)}`);
    }
    if (phase.files && phase.files.length > 0) {
      console.log(`  Files: ${phase.files.join(", ")}`);
    }
  }
  console.log("");
}

function printManagedWorkflowJudgmentNextCommands(state: ManagedWorkflowState): void {
  const judgment = state.judgment;
  if (!judgment) return;
  console.log("");
  console.log(chalk.bold("Explicit advisor responses"));
  if (!judgment.brief.servedJudgmentId) {
    console.log(
      "No served judgment identity was returned. The card is inspectable, but hosted influence receipts cannot be linked yet."
    );
  }
  if (judgment.card.advisorRecommendations.length === 0) {
    console.log("No Advisor recommendation requires a response for this judgment.");
    console.log("");
    return;
  }
  for (const recommendation of judgment.card.advisorRecommendations) {
    const response = judgment.responses.find((item) => item.recommendationId === recommendation.id);
    console.log(
      `- ${recommendation.id}: ${response ? `${response.decision} (${response.initialReceipt?.status ?? "local"})` : "pending explicit response"}`
    );
    if (!response) {
      console.log(
        `  snipara-companion workflow judgment-respond ${shellQuote(recommendation.id)} --decision accepted`
      );
    }
  }
  console.log(
    "Use --decision modified with distinct --plan-before/--plan-after snapshots when the judgment changed the plan; use ignored or blocked explicitly when applicable."
  );
  console.log("");
}

function safeDecisionPendingCount(): number {
  try {
    return decisionPendingCount(process.cwd());
  } catch {
    return 0;
  }
}

function printManagedWorkflowDiscipline(): void {
  console.log(chalk.bold("Coding workflow mode"));
  console.log(
    "- LITE: small single-phase edits have no mandatory Snipara calls; use local verification and escalate on demand.",
  );
  console.log(
    "- STANDARD: normal coding work uses context or code graph when the task needs source truth or prior rationale.",
  );
  console.log(
    "- FULL: use this managed workflow with phases/chunks for multi-file, risky, release/deploy, architectural, or compaction-prone coding work.",
  );
  console.log(
    "- --mode auto routes by task intent; a nudge is advisory, not a gate.",
  );
  console.log(
    "- FULL + ORCHESTRATED: use explicit snipara-orchestrator handoff only for production gates, drift checks, htasks, or multi-agent coordination.",
  );
  console.log(
    "- Before concluding on routes/services/jobs, risky changes, or what is missing, run the code impact gate.",
  );
  console.log(
    "- For execution/test/debug/finalization that benefits from repeatable isolation, use Snipara Sandbox MCP execute_python or snipara-sandbox run.",
  );
  console.log("");
}

function printManagedWorkflowNextCommands(state: ManagedWorkflowState): void {
  const phase = currentWorkflowPhase(state);
  printManagedWorkflowDiscipline();
  if (!state.judgment) {
    console.log(chalk.bold("Judgment gate"));
    console.log("snipara-companion workflow judgment");
    console.log("");
  } else {
    printManagedWorkflowJudgmentNextCommands(state);
  }
  if (!phase || state.status === "completed") {
    console.log(chalk.bold("Next commands"));
    console.log(
      "snipara-companion final-commit --summary '<final summary>' --files <files...>",
    );
    console.log("");
    return;
  }

  console.log(chalk.bold("Next commands"));
  console.log(`snipara-companion workflow phase-start ${phase.id}`);
  console.log(
    `snipara-companion workflow run --mode full --include-session-context --query ${shellQuote(
      phaseQuery(state, phase),
    )}`,
  );
  if (phase.files && phase.files.length > 0) {
    console.log(
      `snipara-companion code impact --changed-files ${phase.files.map(shellQuote).join(" ")} --diff-summary ${shellQuote(
        phase.title,
      )}`,
    );
  } else {
    console.log(
      "snipara-companion code impact --changed-files <files...> --diff-summary '<change>'",
    );
  }
  if (phase.needsRuntime) {
    printManagedWorkflowRuntimeGuidance();
    console.log(
      `snipara-companion workflow runtime-checkpoint ${phase.id} --summary '<resume-ready runtime state>' --rehydrate-file <state.json>`,
    );
  }
  console.log(
    `snipara-companion workflow phase-commit ${phase.id} --summary '<what changed>' --files <files...>`,
  );
  console.log("");
}

function printManagedWorkflowResumeBoundary(): void {
  console.log(chalk.bold("Resume boundary"));
  console.log(
    "- workflow resume restores local phase state plus hosted memory and Team Sync continuity.",
  );
  console.log(
    "- For runtime-bound phases, it restores the recorded Sandbox binding and prints a reattach or rehydrate plan.",
  );
  console.log(
    "- It does not snapshot or exactly restore a live Snipara Sandbox process.",
  );
  console.log("");
}

function printManagedWorkflowRuntimeGuidance(): void {
  const report = detectRuntimeEnvironment();
  if (report.runtime.cliAvailable) {
    console.log(
      "Use Snipara Sandbox MCP execute_python for execution/test/debug/finalization when repeatable isolated validation helps.",
    );
    if (!report.runtime.mcpConfigured) {
      console.log(
        "Add Snipara Sandbox MCP config with: npx create-snipara repair --with-runtime",
      );
    }
    return;
  }

  console.log(
    "This phase may need sandboxed execution/test/debug/finalization. Add Snipara Sandbox with: npx create-snipara repair --with-runtime",
  );
  console.log(
    "Fresh setup option: npx create-snipara --profile full-stack --advanced",
  );
}

interface WorkflowRuntimeResumePlan {
  binding: ManagedWorkflowSandboxRuntimeBinding;
  checkpoint?: ManagedWorkflowRuntimeCheckpoint;
  reattachSessionId: string;
  caveats: string[];
}

async function loadWorkflowRuntimeResumePlan(
  state: ManagedWorkflowState,
): Promise<{ data?: WorkflowRuntimeResumePlan; error?: string } | null> {
  const currentPhase = currentWorkflowPhase(state);
  if (!currentPhase) {
    return null;
  }

  const binding = findSandboxRuntimeBinding(state, currentPhase.id);
  if (!binding) {
    return null;
  }

  let checkpoint = binding.lastCheckpoint;
  const config = loadConfig();
  if (config.apiKey && config.sessionId) {
    const client = createClient(15000);
    try {
      const recent = await client.getAutomationEvents({
        sessionId: config.sessionId,
        limit: 25,
      });
      for (const item of recent.events) {
        const hostedCheckpoint = parseRuntimeCheckpointFromEvent(
          item,
          state.workflowId,
          currentPhase.id,
        );
        if (hostedCheckpoint) {
          checkpoint = hostedCheckpoint;
          break;
        }
      }
    } catch (error) {
      return {
        data: {
          binding,
          checkpoint,
          reattachSessionId: binding.sessionId,
          caveats: [
            `Hosted runtime checkpoint lookup failed: ${error instanceof Error ? error.message : String(error)}`,
          ],
        },
      };
    }
  }

  const caveats = [
    "Exact Snipara Sandbox process snapshots are not restored in this MVP; resume reattaches to a surviving session or rebuilds a compatible REPL state.",
  ];

  if (!checkpoint) {
    caveats.push(
      "No runtime checkpoint payload was found for the active phase yet; capture one after material Sandbox work with workflow runtime-checkpoint.",
    );
  }

  return {
    data: {
      binding,
      checkpoint,
      reattachSessionId: binding.sessionId,
      caveats,
    },
  };
}

function printWorkflowRuntimeResumePlan(
  result: {
    data?: WorkflowRuntimeResumePlan;
    error?: string;
  } | null,
): void {
  if (!result) {
    return;
  }

  console.log("");
  console.log(chalk.bold("Runtime Resume"));

  if (result.error) {
    console.log(`Unavailable: ${result.error}`);
    return;
  }

  const data = result.data;
  if (!data) {
    console.log("No runtime-bound Snipara Sandbox phase is active.");
    return;
  }

  console.log(`Sandbox session: ${data.binding.sessionId}`);
  if (data.binding.environment) {
    console.log(`Environment: ${data.binding.environment}`);
  }
  if (data.binding.profile) {
    console.log(`Profile: ${data.binding.profile}`);
  }

  if (data.checkpoint) {
    console.log(`Last checkpoint: ${data.checkpoint.summary}`);
    console.log(`Checkpoint time: ${data.checkpoint.capturedAt}`);
    const stateKeys = rehydratableStateKeys(data.checkpoint);
    if (stateKeys?.length) {
      console.log(`Rehydratable keys: ${stateKeys.join(", ")}`);
    }
    if (data.checkpoint.artifacts?.length) {
      console.log(`Artifacts: ${data.checkpoint.artifacts.join(", ")}`);
    }
  }

  console.log("Reattach path:");
  console.log(
    `- In your AI client, call Snipara Sandbox MCP list_sessions and look for session_id='${data.reattachSessionId}'.`,
  );
  console.log(
    `- If it exists, continue execute_python/get_repl_context calls with session_id='${data.reattachSessionId}'.`,
  );

  console.log("Rehydrate path:");
  console.log(
    `- Call snipara_repl_context with the active phase query, then set_repl_context(key='context', value=<context_data>, session_id='${data.binding.sessionId}').`,
  );
  if (
    data.checkpoint?.rehydratableState &&
    Object.keys(data.checkpoint.rehydratableState).length > 0
  ) {
    console.log(
      `- Restore the checkpointed JSON state for keys ${Object.keys(data.checkpoint.rehydratableState).join(", ")} in the same session before execute_python(setup_code).`,
    );
  } else {
    console.log(
      "- Restore any JSON-serializable runtime state you saved for this phase before execute_python(setup_code).",
    );
  }
  if (data.checkpoint?.bootstrapQuery || data.binding.bootstrapQuery) {
    console.log(
      `- Bootstrap query: ${shellQuote(data.checkpoint?.bootstrapQuery ?? data.binding.bootstrapQuery)}`,
    );
  }
  if (data.caveats.length) {
    console.log(`Caveats: ${data.caveats.join("; ")}`);
  }
}

function printCompactObject(
  record: Record<string, unknown>,
  keys: string[],
): void {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) {
      printKeyValue(`${key}:`, toPreview(value));
    }
  }
}

function recordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function recordArrayField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function readLocalGitState(cwd: string = process.cwd()): {
  head?: string;
  statusLines?: string[];
  error?: string;
} {
  try {
    const execOptions: ExecFileSyncOptionsWithStringEncoding = {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    };
    const head = execFileSync("git", ["rev-parse", "HEAD"], execOptions).trim();
    const status = execFileSync(
      "git",
      ["status", "--short"],
      execOptions,
    ).trim();
    return {
      head,
      statusLines: status ? status.split(/\r?\n/).filter(Boolean) : [],
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function readCurrentGitBranch(cwd: string = process.cwd()): string | undefined {
  try {
    const execOptions: ExecFileSyncOptionsWithStringEncoding = {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    };
    const branch = execFileSync(
      "git",
      ["branch", "--show-current"],
      execOptions,
    ).trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

function runGitText(
  args: string[],
  cwd: string = process.cwd(),
  timeout: number = 3000,
): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
    }).trim();
  } catch {
    return undefined;
  }
}

function readGitNulList(args: string[], cwd: string): string[] {
  const output = runGitText(args, cwd);
  if (!output) {
    return [];
  }
  return output
    .split("\0")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readGitRepoRoot(cwd: string = process.cwd()): string {
  return path.resolve(runGitText(["rev-parse", "--show-toplevel"], cwd) ?? cwd);
}

function normalizeRepoFilePath(value: string): string {
  return value.split(path.sep).join("/").replace(/^\/+/, "");
}

function resolveWorkflowImpactBaseRef(repoRoot: string, base?: string): string {
  const explicitBase = base?.trim();
  if (explicitBase) {
    const sha = runGitText(["rev-parse", "--verify", explicitBase], repoRoot);
    if (!sha) {
      throw new Error(
        `Unable to resolve workflow impact base ref '${explicitBase}'.`,
      );
    }
    return explicitBase;
  }

  const upstream = runGitText(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    repoRoot,
  );
  if (upstream) {
    return upstream;
  }

  const branch = readCurrentGitBranch(repoRoot);
  const originBranch = branch ? `origin/${branch}` : undefined;
  if (
    originBranch &&
    runGitText(["rev-parse", "--verify", originBranch], repoRoot)
  ) {
    return originBranch;
  }

  throw new Error(
    "Unable to resolve an upstream branch for workflow impact gate. Pass --base <ref>.",
  );
}

function readUnpushedCommits(
  repoRoot: string,
  baseRef: string,
): WorkflowImpactGateCommit[] {
  const output = runGitText(
    ["log", "--format=%H%x1f%s%x1f%an%x1f%aI%x1e", `${baseRef}..HEAD`],
    repoRoot,
    5000,
  );
  if (!output) {
    return [];
  }

  return output
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = "", subject = "", author, authoredAt] = record.split("\x1f");
      return {
        sha,
        shortSha: shortCommit(sha),
        subject,
        ...(author ? { author } : {}),
        ...(authoredAt ? { authoredAt } : {}),
      };
    });
}

function readUnpushedChangedFiles(repoRoot: string, baseRef: string): string[] {
  return readGitNulList(
    ["diff", "--name-only", "-z", `${baseRef}..HEAD`, "--"],
    repoRoot,
  )
    .map(normalizeRepoFilePath)
    .sort();
}

function parseDirtyFileFromStatusLine(line: string): string | undefined {
  const rawPath = line.slice(2).trim();
  if (!rawPath) {
    return undefined;
  }
  const renamedPath = rawPath.includes(" -> ")
    ? rawPath.split(" -> ").pop()
    : rawPath;
  return renamedPath
    ? normalizeRepoFilePath(renamedPath.replace(/^"|"$/g, ""))
    : undefined;
}

function isLocalImpactCodeFile(filePath: string): boolean {
  return [".ts", ".tsx", ".mts", ".cts", ".py", ".pyi", ".go"].includes(
    path.extname(filePath),
  );
}

function completedWorkflowPhasesForImpact(
  state: ManagedWorkflowState | undefined,
  changedFiles: string[],
): WorkflowImpactGatePhase[] {
  const changedFileSet = new Set(changedFiles);
  return (state?.phases ?? [])
    .filter((phase) => phase.status === "completed" && phase.completedAt)
    .map((phase) => {
      const files =
        uniqueStringList((phase.files ?? []).map(normalizeRepoFilePath)) ?? [];
      return {
        id: phase.id,
        title: phase.title,
        summary: phase.summary,
        outcome: phase.outcome,
        completedAt: phase.completedAt,
        files,
        filesInUnpushedDiff: files.filter((file) => changedFileSet.has(file)),
      };
    })
    .sort((left, right) =>
      String(left.completedAt ?? "").localeCompare(
        String(right.completedAt ?? ""),
      ),
    );
}

function buildHostedImpactFollowUpCommand(
  changedFiles: string[],
): string | undefined {
  if (changedFiles.length === 0) {
    return undefined;
  }
  const files = changedFiles.map(shellQuote).join(" ");
  return `snipara-companion code impact --changed-files ${files} --diff-summary 'unpushed workflow phases after push/index'`;
}

function compactLocalImpactForWorkflowGate(
  impact: Record<string, unknown>,
): Record<string, unknown> {
  const symbols = Array.isArray(impact.symbols) ? impact.symbols : [];
  const incoming = Array.isArray(impact.incoming) ? impact.incoming : [];
  const outgoing = Array.isArray(impact.outgoing) ? impact.outgoing : [];
  const impactedFiles = Array.isArray(impact.impactedFiles)
    ? impact.impactedFiles
    : [];
  return {
    title: impact.title,
    caveat: impact.caveat,
    scope: impact.scope,
    target: impact.target,
    changedFiles: impact.changedFiles,
    missingTargetFiles: impact.missingTargetFiles,
    warnings: impact.warnings,
    counts: {
      symbols: symbols.length,
      incoming: incoming.length,
      outgoing: outgoing.length,
      impactedFiles: impactedFiles.length,
    },
    symbols: symbols.slice(0, 40),
    incoming: incoming.slice(0, 40),
    outgoing: outgoing.slice(0, 40),
    impactedFiles,
    truncated: {
      symbols: Math.max(0, symbols.length - 40),
      incoming: Math.max(0, incoming.length - 40),
      outgoing: Math.max(0, outgoing.length - 40),
    },
  };
}

/**
 * Compute the impact gate for committed-but-unpushed workflow phases.
 *
 * Compares `upstream..HEAD`, separates unpushed code changes from non-code and
 * dirty working-tree files, runs local code-overlay impact on the committed
 * code files, and maps the result back to completed workflow phases. Surfaces
 * reason codes such as `dirty_working_tree_not_included` and phase files that
 * fall outside the unpushed diff, so a phase is not treated as verified on
 * stale or partial evidence.
 *
 * @returns A `WorkflowImpactGateResult` with changed files, local impact,
 *   matched phases, and reason codes.
 */
export function buildWorkflowImpactGate(
  options: {
    cwd?: string;
    base?: string;
    maxFiles?: number;
  } = {},
): WorkflowImpactGateResult {
  const repoRoot = readGitRepoRoot(options.cwd);
  const branch = readCurrentGitBranch(repoRoot);
  const upstream = resolveWorkflowImpactBaseRef(repoRoot, options.base);
  const baseSha = runGitText(["rev-parse", "--verify", upstream], repoRoot);
  const headSha = runGitText(["rev-parse", "--verify", "HEAD"], repoRoot);
  const changedFiles = readUnpushedChangedFiles(repoRoot, upstream);
  const codeChangedFiles = changedFiles.filter(isLocalImpactCodeFile);
  const nonCodeChangedFiles = changedFiles.filter(
    (file) => !isLocalImpactCodeFile(file),
  );
  const commits = readUnpushedCommits(repoRoot, upstream);
  const dirtyStatusLines = readLocalGitState(repoRoot).statusLines ?? [];
  const dirtyFiles = dirtyStatusLines
    .map(parseDirtyFileFromStatusLine)
    .filter((file): file is string => Boolean(file));
  const state = readWorkflowState(repoRoot);
  const completedPhases = completedWorkflowPhasesForImpact(state, changedFiles);
  const phaseFileSet = new Set(completedPhases.flatMap((phase) => phase.files));
  const changedFilesWithoutPhase = changedFiles.filter(
    (file) => !phaseFileSet.has(file),
  );
  const changedFileSet = new Set(changedFiles);
  const phaseFilesOutsideUnpushedDiff = [...phaseFileSet]
    .filter((file) => !changedFileSet.has(file))
    .sort();
  const localImpact =
    codeChangedFiles.length > 0
      ? compactLocalImpactForWorkflowGate(
          buildLocalImpactResult({
            dir: repoRoot,
            mode: "local_commit",
            commit: "HEAD",
            changedFiles: codeChangedFiles,
            maxFiles: options.maxFiles,
          }),
        )
      : null;
  const reasonCodes = [
    dirtyFiles.length > 0 ? "dirty_working_tree_not_included" : undefined,
    commits.length === 0 ? "no_unpushed_commits" : undefined,
    changedFilesWithoutPhase.length > 0
      ? "changed_files_without_phase_commit"
      : undefined,
    phaseFilesOutsideUnpushedDiff.length > 0
      ? "phase_files_outside_unpushed_diff"
      : undefined,
  ].filter((item): item is string => Boolean(item));
  const recommendedActions = [
    dirtyFiles.length > 0
      ? "Review dirty working-tree files separately; they are not included in this committed-phase impact gate."
      : undefined,
    changedFilesWithoutPhase.length > 0
      ? "Check changed files without matching completed workflow phase metadata before final commit."
      : undefined,
    codeChangedFiles.length > 0
      ? "Run the targeted tests for the changed code files listed by the local impact result."
      : undefined,
    commits.length > 0
      ? "After push and hosted code reindex, run hosted snipara_code_impact for the canonical graph-backed impact model."
      : undefined,
  ].filter((item): item is string => Boolean(item));

  return {
    version: "snipara.workflow_impact_gate.v1",
    generatedAt: new Date().toISOString(),
    gate: {
      status: reasonCodes.length > 0 ? "attention" : "pass",
      reasonCodes,
    },
    repo: {
      root: repoRoot,
      ...(branch ? { branch } : {}),
      upstream,
      ...(baseSha ? { baseSha } : {}),
      ...(headSha ? { headSha } : {}),
    },
    unpushed: {
      commitCount: commits.length,
      commits,
      changedFiles,
      codeChangedFiles,
      nonCodeChangedFiles,
    },
    dirtyWorkingTree: {
      fileCount: dirtyFiles.length,
      statusLines: dirtyStatusLines,
      files: dirtyFiles,
      includedInLocalImpact: false,
    },
    workflow: {
      ...(state
        ? {
            id: state.workflowId,
            goal: state.goal,
            status: state.status,
          }
        : {}),
      completedPhases,
      changedFilesWithoutPhase,
      phaseFilesOutsideUnpushedDiff,
    },
    localImpact,
    recommendedActions,
    caveats: [
      "This is a local committed-phase gate for upstream..HEAD; it does not push and does not update hosted code graph state.",
      "Workflow phase commits are local workflow checkpoints, not Git commit SHAs, so phase-to-Git mapping is file-based.",
      "Local impact is file-level import analysis from the selected local commit; hosted snipara_code_impact remains canonical after push/index.",
    ],
    ...(buildHostedImpactFollowUpCommand(changedFiles)
      ? {
          hostedFollowUpCommand: buildHostedImpactFollowUpCommand(changedFiles),
        }
      : {}),
  };
}

function printWorkflowImpactGate(result: WorkflowImpactGateResult): void {
  console.log(chalk.bold("Workflow Impact Gate"));
  printKeyValue("Status:", result.gate.status);
  printKeyValue("Branch:", result.repo.branch ?? "unknown");
  printKeyValue("Upstream:", result.repo.upstream);
  printKeyValue("Unpushed commits:", result.unpushed.commitCount);
  printKeyValue("Changed files:", result.unpushed.changedFiles.length);
  printKeyValue("Code files:", result.unpushed.codeChangedFiles.length);
  printKeyValue("Dirty files not included:", result.dirtyWorkingTree.fileCount);
  console.log("");

  if (result.unpushed.commits.length > 0) {
    console.log(chalk.bold("Unpushed Commits"));
    for (const commit of result.unpushed.commits.slice(0, 12)) {
      console.log(`- ${commit.shortSha} ${commit.subject}`);
    }
    if (result.unpushed.commits.length > 12) {
      console.log(
        chalk.gray(`... ${result.unpushed.commits.length - 12} more`),
      );
    }
    console.log("");
  }

  if (result.workflow.completedPhases.length > 0) {
    console.log(chalk.bold("Completed Workflow Phases"));
    for (const phase of result.workflow.completedPhases) {
      const fileText =
        phase.filesInUnpushedDiff.length > 0
          ? `${phase.filesInUnpushedDiff.length} file(s) in unpushed diff`
          : "no files in unpushed diff";
      console.log(`- ${phase.id}: ${phase.title} (${fileText})`);
      if (phase.summary) {
        console.log(`  ${toPreview(phase.summary, 140)}`);
      }
    }
    console.log("");
  }

  const localImpact = result.localImpact;
  if (isRecord(localImpact)) {
    const impactedFiles = Array.isArray(localImpact.impactedFiles)
      ? localImpact.impactedFiles
      : [];
    const incoming = Array.isArray(localImpact.incoming)
      ? localImpact.incoming
      : [];
    const outgoing = Array.isArray(localImpact.outgoing)
      ? localImpact.outgoing
      : [];
    console.log(chalk.bold("Local Impact"));
    printKeyValue("Impacted files:", impactedFiles.length);
    printKeyValue("Incoming edges:", incoming.length);
    printKeyValue("Outgoing edges:", outgoing.length);
    const warnings = recordArrayField(localImpact, "warnings");
    if (warnings.length > 0) {
      console.log(
        `Warnings: ${warnings.map((warning) => toPreview(warning.code)).join(", ")}`,
      );
    }
    console.log("");
  }

  if (result.dirtyWorkingTree.statusLines.length > 0) {
    console.log(chalk.bold("Dirty Working Tree"));
    for (const line of result.dirtyWorkingTree.statusLines.slice(0, 8)) {
      console.log(`- ${line}`);
    }
    if (result.dirtyWorkingTree.statusLines.length > 8) {
      console.log(
        chalk.gray(
          `... ${result.dirtyWorkingTree.statusLines.length - 8} more`,
        ),
      );
    }
    console.log("");
  }

  if (result.gate.reasonCodes.length > 0) {
    console.log(chalk.bold("Reason Codes"));
    for (const code of result.gate.reasonCodes) {
      console.log(`- ${code}`);
    }
    console.log("");
  }

  if (result.recommendedActions.length > 0) {
    console.log(chalk.bold("Recommended Actions"));
    for (const action of result.recommendedActions) {
      console.log(`- ${action}`);
    }
    console.log("");
  }

  if (result.hostedFollowUpCommand) {
    printKeyValue("Hosted follow-up:", result.hostedFollowUpCommand);
    console.log("");
  }
}

export async function workflowImpactGateCommand(options: {
  base?: string;
  maxFiles?: number;
  json?: boolean;
}): Promise<void> {
  const result = buildWorkflowImpactGate({
    base: options.base,
    maxFiles: options.maxFiles,
  });
  if (options.json) {
    printJson(result);
    return;
  }
  printWorkflowImpactGate(result);
}

function shortCommit(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}

function commitsMatch(left: string, right: string): boolean {
  const normalizedLeft = left.trim().toLowerCase();
  const normalizedRight = right.trim().toLowerCase();
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(normalizedRight) ||
    normalizedRight.startsWith(normalizedLeft)
  );
}

function stringArrayField(
  record: Record<string, unknown>,
  key: string,
): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value
        .map((item) => stringValue(item))
        .filter((item): item is string => Boolean(item))
    : [];
}

function printCodeIndexFreshness(record: Record<string, unknown>): void {
  const freshness = recordField(record, "index_freshness");
  if (!freshness) {
    return;
  }

  const coverage = recordField(freshness, "coverage");
  const indexedCommit = stringValue(freshness.indexed_commit_sha);
  const sourceCommit = stringValue(freshness.source_commit_sha);
  const commit = indexedCommit ?? sourceCommit;
  const coverageText =
    coverage && coverage.coverage_percent !== undefined
      ? `${coverage.coverage_percent}%`
      : undefined;
  const localGit = readLocalGitState();

  console.log(chalk.bold("Code Graph Health"));
  console.log(
    "Document/context health is separate; this section only describes indexed code graph freshness.",
  );
  printCompactObject(freshness, ["status", "indexed_at", "age_hours"]);
  if (indexedCommit) {
    printKeyValue("indexed commit:", indexedCommit);
  }
  if (sourceCommit && sourceCommit !== indexedCommit) {
    printKeyValue("source commit:", sourceCommit);
  }
  if (localGit.head) {
    printKeyValue("local HEAD:", localGit.head);
  }
  if (commit && localGit.head) {
    const matches = commitsMatch(commit, localGit.head);
    printKeyValue(
      "commit match:",
      matches
        ? "yes (indexed code matches local committed base)"
        : `no (indexed ${shortCommit(commit)} vs local ${shortCommit(localGit.head)})`,
    );
  } else if (localGit.error) {
    printKeyValue("local git:", "unavailable");
  }
  if (coverageText) {
    printKeyValue("coverage:", coverageText);
  }
  if (localGit.statusLines) {
    printKeyValue(
      "working tree:",
      localGit.statusLines.length === 0
        ? "clean"
        : `dirty (${localGit.statusLines.length} entries; uncommitted edits are outside hosted graph)`,
    );
  }
  const sync = recordField(freshness, "sync");
  if (sync?.recommendation) {
    printKeyValue("sync:", toPreview(sync.recommendation, 220));
  }
  console.log("");
}

function formatAction(record: Record<string, unknown>): string {
  const label =
    stringValue(record.action) ??
    stringValue(record.code) ??
    stringValue(record.tool) ??
    stringValue(record.name) ??
    "action";
  const priority = stringValue(record.priority ?? record.severity);
  const reason = stringValue(record.reason ?? record.message);
  const targets = stringArrayField(record, "targets");
  const suffix = [
    priority ? `[${priority}]` : undefined,
    reason,
    targets.length > 0
      ? `targets: ${targets.slice(0, 4).join(", ")}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" - ");
  return suffix ? `${label} - ${suffix}` : label;
}

function printActionList(
  title: string,
  records: Record<string, unknown>[],
  maxItems = 8,
): void {
  if (records.length === 0) {
    return;
  }
  console.log(chalk.bold(title));
  for (const record of records.slice(0, maxItems)) {
    console.log(`- ${formatAction(record)}`);
  }
  if (records.length > maxItems) {
    console.log(chalk.gray(`... ${records.length - maxItems} more`));
  }
  console.log("");
}

function printWarningList(record: Record<string, unknown>): void {
  printActionList("Warnings", recordArrayField(record, "warnings"), 6);
}

function printSuggestedToolList(record: Record<string, unknown>): void {
  const suggestions = recordArrayField(record, "suggested_tools");
  if (suggestions.length === 0) {
    return;
  }
  console.log(chalk.bold("Suggested MCP Follow-ups"));
  for (const suggestion of suggestions.slice(0, 5)) {
    const tool = stringValue(suggestion.tool) ?? "snipara_code_*";
    const args = recordField(suggestion, "arguments") ?? {};
    const reason = stringValue(suggestion.reason);
    console.log(
      `- ${tool}(${JSON.stringify(args)})${reason ? ` - ${reason}` : ""}`,
    );
  }
  console.log("");
}

function printAgentVerificationReminder(): void {
  console.log(chalk.bold("Agent Use"));
  console.log(
    "- Treat this as indexed repository context, then verify exact files locally.",
  );
  console.log(
    "- If degraded or stale, use the suggested lightweight code tools and local tests.",
  );
  console.log("");
}

function printImpactCounts(impact: Record<string, unknown>): void {
  const categories = [
    "symbols",
    "tests",
    "docs",
    "routes",
    "config",
    "mcp_tools",
    "structural_edges",
  ];
  const counts = categories
    .map((category) => {
      const value = impact[category];
      return Array.isArray(value) ? `${category}:${value.length}` : undefined;
    })
    .filter(Boolean);
  if (counts.length > 0) {
    printKeyValue("Impact counts:", counts.join(" "));
  }
}

function displaySniparaToolName(toolName: string): string {
  return toolName.startsWith("rlm_")
    ? `snipara_${toolName.slice("rlm_".length)}`
    : toolName;
}

function printQueryResult(result: ContextQueryResult): void {
  printKeyValue("Query:", result.query);
  printKeyValue("Sections:", result.sections.length);
  printKeyValue("Tokens:", result.total_tokens);
  if (result.recommended_tool) {
    printKeyValue(
      "Suggested tool:",
      displaySniparaToolName(result.recommended_tool),
    );
  }
  console.log("");

  if (result.sections.length === 0) {
    if (result.recommended_tool) {
      console.log(chalk.cyan("Structural query detected."));
      console.log(
        chalk.gray(
          JSON.stringify(result.recommended_tool_arguments || {}, null, 2),
        ),
      );
      console.log("");
      return;
    }
    console.log(chalk.yellow("No relevant sections found."));
    return;
  }

  for (const section of result.sections) {
    console.log(chalk.bold(section.title));
    if (section.file) {
      console.log(
        chalk.gray(`${section.file}:${section.lines[0]}-${section.lines[1]}`),
      );
    }
    if (section.content) {
      console.log(section.content.trim());
    }
    console.log("");
  }
}

function formatNodeLabel(node: CodeGraphNodeResult): string {
  const location = node.file_path
    ? ` (${node.file_path}:${node.start_line})`
    : "";
  return `${node.qualified_name}${location}`;
}

function printNodeList(
  label: string,
  nodes: CodeGraphNodeResult[],
  maxItems: number = 8,
): void {
  if (nodes.length === 0) {
    return;
  }

  console.log(chalk.bold(label));
  for (const node of nodes.slice(0, maxItems)) {
    console.log(`- ${formatNodeLabel(node)}`);
  }
  if (nodes.length > maxItems) {
    console.log(chalk.gray(`… ${nodes.length - maxItems} more`));
  }
  console.log("");
}

function printSharedContextDocument(doc: SharedContextDocumentResult): void {
  const tags = doc.tags.length > 0 ? ` [${doc.tags.join(", ")}]` : "";
  const mandatory = doc.is_mandatory ? " mandatory" : "";
  const source = doc.source_type === "TEAM_CONTEXT" ? "team" : "linked";
  console.log(
    `- ${doc.title} (${doc.collection_name} · ${source} · ${doc.category}${mandatory} · ${doc.token_count} tokens)${tags}`,
  );
}

function printSharedContextResult(result: SharedContextResult): void {
  printKeyValue("Tool:", "snipara_shared_context");
  printKeyValue(
    "Linked collections:",
    result.linked_collections_loaded ?? result.collections_loaded,
  );
  printKeyValue(
    "Team context docs:",
    result.team_context_documents_loaded ?? 0,
  );
  printKeyValue(
    "Linked collection docs:",
    result.linked_collection_documents_loaded ?? result.documents.length,
  );
  printKeyValue("Documents:", result.documents.length);
  printKeyValue("Tokens:", result.total_tokens);
  console.log("");

  if (result.documents.length > 0) {
    console.log(chalk.bold("Project-linked Shared Context"));
    for (const doc of result.documents.slice(0, 8)) {
      printSharedContextDocument(doc);
    }
    if (result.documents.length > 8) {
      console.log(chalk.gray(`… ${result.documents.length - 8} more`));
    }
    console.log("");
  }

  if (result.merged_content) {
    console.log(chalk.bold("Merged Shared Context"));
    console.log(result.merged_content.trim());
    console.log("");
  }
}

function formatEdge(edge: CodeGraphEdgeResult): string {
  const from = edge.from_qualified_name || edge.from_symbol_key;
  const to = edge.to_qualified_name || edge.to_symbol_key;
  return `${from} -[${edge.kind}/${edge.source}/${edge.confidence}]-> ${to}`;
}

function printCodeCallersResult(result: CodeCallersResult): void {
  printKeyValue("Tool:", "snipara_code_callers");
  printKeyValue("Matched targets:", result.matched_targets.length);
  printKeyValue("Callers:", result.total_callers);
  printKeyValue("Depth:", result.depth);
  console.log("");
  printNodeList("Targets", result.matched_targets);
  printNodeList("Callers", result.callers);
}

function printCodeImportsResult(result: CodeImportsResult): void {
  printKeyValue("Tool:", "snipara_code_imports");
  printKeyValue("Matched targets:", result.matched_target_count);
  printKeyValue("Scanned targets:", result.scanned_target_count);
  printKeyValue("Direction:", result.direction);
  printKeyValue("Imports:", result.total_imports);
  if (result.compacted) {
    printKeyValue("Compacted:", "true");
  }
  console.log("");
  printNodeList("Targets", result.matched_targets);
  printNodeList("Imports", result.imports);
}

function printCodeNeighborsResult(result: CodeNeighborsResult): void {
  printKeyValue("Tool:", "snipara_code_neighbors");
  printKeyValue("Matched targets:", result.matched_targets.length);
  printKeyValue("Nodes:", result.nodes.length);
  printKeyValue("Edges:", result.edges.length);
  printKeyValue("Depth:", result.depth);
  console.log("");
  printNodeList("Targets", result.matched_targets);
  printNodeList("Neighbor Nodes", result.nodes);
  if (result.edges.length > 0) {
    console.log(chalk.bold("Edges"));
    for (const edge of result.edges.slice(0, 8)) {
      console.log(`- ${formatEdge(edge)}`);
    }
    if (result.edges.length > 8) {
      console.log(chalk.gray(`… ${result.edges.length - 8} more`));
    }
    console.log("");
  }
}

function printCodeShortestPathResult(result: CodeShortestPathResult): void {
  printKeyValue("Tool:", "snipara_code_shortest_path");
  printKeyValue("Found:", result.found ? "true" : "false");
  printKeyValue("Hops:", result.hops);
  console.log("");
  printNodeList("Sources", result.matched_sources);
  printNodeList("Targets", result.matched_targets);
  if (result.path.length > 0) {
    console.log(chalk.bold("Path"));
    for (const node of result.path) {
      console.log(`- ${formatNodeLabel(node)}`);
    }
    console.log("");
  }
  if (result.edges.length > 0) {
    console.log(chalk.bold("Traversed Edges"));
    for (const edge of result.edges) {
      console.log(`- ${formatEdge(edge)}`);
    }
    console.log("");
  }
}

function printCodeSymbolCardResult(result: Record<string, unknown>): void {
  printKeyValue("Tool:", "snipara_code_symbol_card");
  printCompactObject(result, [
    "message",
    "match_strategy",
    "degraded",
    "recommendation",
  ]);
  console.log("");

  printCodeIndexFreshness(result);
  const targets = recordArrayField(result, "matched_targets");
  printNodeList(
    "Matched Targets",
    targets as unknown as CodeGraphNodeResult[],
    5,
  );

  const cards = recordArrayField(result, "cards");
  if (cards.length > 0) {
    console.log(chalk.bold("Symbol Cards"));
    for (const card of cards.slice(0, 5)) {
      const context = recordField(card, "context") ?? {};
      const relations = recordField(card, "relations") ?? {};
      const relationCounts = [
        "tests",
        "docs",
        "routes",
        "config",
        "mcp_tools",
        "symbols",
      ]
        .map((key) => {
          const value = relations[key];
          return Array.isArray(value) && value.length > 0
            ? `${key}:${value.length}`
            : undefined;
        })
        .filter(Boolean)
        .join(" ");
      console.log(
        `- ${toPreview(context.qualified_name ?? card.symbol_key, 140)}`,
      );
      if (context.summary) {
        console.log(`  Summary: ${toPreview(context.summary, 180)}`);
      }
      console.log(
        `  Role: ${toPreview(context.role)} | Layer: ${toPreview(
          context.layer,
        )} | Risk: ${toPreview(context.risk_level ?? context.riskLevel)}`,
      );
      if (relationCounts) {
        console.log(`  Relations: ${relationCounts}`);
      }
    }
    if (cards.length > 5) {
      console.log(chalk.gray(`... ${cards.length - 5} more`));
    }
    console.log("");
  }

  printActionList("Agent Guidance", recordArrayField(result, "guidance"));
  printWarningList(result);
  printSuggestedToolList(result);
  printAgentVerificationReminder();

  console.log(chalk.bold("Raw JSON"));
  printJson(result);
}

function printCodeImpactResult(result: Record<string, unknown>): void {
  printKeyValue("Tool:", "snipara_code_impact");
  printCompactObject(result, [
    "message",
    "degraded",
    "retryable",
    "recommendation",
  ]);
  const risk = recordField(result, "risk");
  if (risk) {
    printKeyValue(
      "Risk:",
      `${toPreview(risk.level)} (${toPreview(risk.score)})`,
    );
  }
  const evidence = recordField(result, "evidence_summary");
  if (evidence?.matched_target_count !== undefined) {
    printKeyValue("Matched targets:", toPreview(evidence.matched_target_count));
  } else {
    printKeyValue(
      "Matched targets:",
      recordArrayField(result, "matched_targets").length,
    );
  }
  const changedFiles = stringArrayField(result, "changed_files");
  if (changedFiles.length > 0) {
    printKeyValue("Changed files:", changedFiles.slice(0, 6).join(", "));
  }
  console.log("");

  printCodeIndexFreshness(result);
  const targets = recordArrayField(result, "matched_targets");
  printNodeList(
    "Matched Targets",
    targets as unknown as CodeGraphNodeResult[],
    5,
  );

  const impact = recordField(result, "impact");
  if (impact) {
    printImpactCounts(impact);
    console.log("");
  }

  printActionList(
    "Recommended Actions",
    recordArrayField(result, "recommended_actions"),
  );
  printActionList("Coverage Gaps", recordArrayField(result, "coverage_gaps"));
  printWarningList(result);
  printSuggestedToolList(result);
  printAgentVerificationReminder();

  console.log(chalk.bold("Raw JSON"));
  printJson(result);
}

function printStructuredToolResult(toolName: string, result: unknown): void {
  switch (displaySniparaToolName(toolName)) {
    case "snipara_shared_context":
      printSharedContextResult(result as SharedContextResult);
      return;
    case "snipara_code_callers":
      printCodeCallersResult(result as CodeCallersResult);
      return;
    case "snipara_code_imports":
      printCodeImportsResult(result as CodeImportsResult);
      return;
    case "snipara_code_neighbors":
      printCodeNeighborsResult(result as CodeNeighborsResult);
      return;
    case "snipara_code_shortest_path":
      printCodeShortestPathResult(result as CodeShortestPathResult);
      return;
    case "snipara_code_symbol_card":
      printCodeSymbolCardResult(result as Record<string, unknown>);
      return;
    case "snipara_code_impact":
      printCodeImpactResult(result as Record<string, unknown>);
      return;
    default:
      printJson(result);
  }
}

function hasSharedContextIntent(query: string): boolean {
  return SHARED_CONTEXT_INTENT_PATTERN.test(query);
}

function inferSharedContextCategories(query: string): string[] | undefined {
  const categories = new Set<string>();
  const lower = query.toLowerCase();

  if (
    lower.includes("mandatory") ||
    lower.includes("security") ||
    lower.includes("compliance") ||
    lower.includes("policy") ||
    lower.includes("policies")
  ) {
    categories.add("MANDATORY");
  }

  if (
    lower.includes("best practice") ||
    lower.includes("best practices") ||
    lower.includes("standard") ||
    lower.includes("standards") ||
    lower.includes("convention") ||
    lower.includes("conventions")
  ) {
    categories.add("BEST_PRACTICES");
  }

  if (
    lower.includes("guideline") ||
    lower.includes("guidelines") ||
    lower.includes("style guide") ||
    lower.includes("playbook") ||
    lower.includes("checklist")
  ) {
    categories.add("GUIDELINES");
  }

  return categories.size > 0 ? Array.from(categories) : undefined;
}

async function runRecommendedTool(queryResult: ContextQueryResult): Promise<
  | {
      toolName: string;
      args: Record<string, unknown>;
      result: unknown;
    }
  | undefined
> {
  if (
    !queryResult.recommended_tool ||
    !queryResult.recommended_tool_arguments
  ) {
    return undefined;
  }

  const client = createClient(20000);
  const result = await client.callTool<unknown>(
    queryResult.recommended_tool,
    queryResult.recommended_tool_arguments,
  );
  return {
    toolName: queryResult.recommended_tool,
    args: queryResult.recommended_tool_arguments,
    result,
  };
}

function printRecommendedToolExecution(execution: {
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
}): void {
  console.log(chalk.bold("Auto-followed Recommendation"));
  printKeyValue("Tool:", displaySniparaToolName(execution.toolName));
  if (Object.keys(execution.args).length > 0) {
    printKeyValue("Args:", toPreview(execution.args, 220));
  }
  console.log("");
  printStructuredToolResult(execution.toolName, execution.result);
}

function printPlanResult(result: Record<string, unknown>): void {
  printKeyValue("Tool:", "snipara_plan");
  const steps = Array.isArray(result.steps) ? result.steps : [];
  const summary = result.summary;
  const strategy = result.strategy;
  const quality = validatePlanResult(result);

  if (typeof summary === "string" && summary.length > 0) {
    printKeyValue("Summary:", summary);
  }
  if (typeof result.error === "string" && result.error.length > 0) {
    printKeyValue("Error:", result.error);
  }
  if (typeof strategy === "string" && strategy.length > 0) {
    printKeyValue("Strategy:", strategy);
  }
  printKeyValue("Steps:", steps.length);
  printKeyValue("Quality:", quality.valid ? "valid" : "needs review");
  console.log("");

  if (!quality.valid) {
    console.log(chalk.yellow("Plan quality diagnostics"));
    for (const issue of quality.issues) {
      console.log(`- ${issue}`);
    }
    console.log("");
  }

  if (steps.length > 0) {
    steps.forEach((step, index) => {
      if (typeof step === "string") {
        console.log(`${index + 1}. ${step}`);
        return;
      }
      if (isRecord(step)) {
        const title = getPlanStepDisplayTitle(step, index);
        console.log(`${index + 1}. ${title}`);
        const detail = step.description ?? step.reason ?? step.goal;
        if (detail !== undefined) {
          console.log(`   ${toPreview(detail, 220)}`);
        }
        const expected = step.expected_output;
        if (typeof expected === "string" && expected.length > 0) {
          console.log(`   Expected: ${expected}`);
        }
      }
    });
    console.log("");
    return;
  }

  printJson(result);
}

function printGeneratedPlanFile(file: WrittenGeneratedPlanFile): void {
  printKeyValue("Plan file:", file.relativePath);
}

function printManagedWorkflowStarted(state: ManagedWorkflowState): void {
  printKeyValue("Managed workflow:", state.workflowId);
  if (state.currentPhaseId) {
    printKeyValue("Current phase:", state.currentPhaseId);
  }
}

function printRuntimeHint(query: string, mode: WorkflowMode): void {
  if (!shouldSuggestRuntimeForWorkflow(query, mode)) {
    return;
  }

  const report = detectRuntimeEnvironment();
  console.log("");
  console.log(chalk.bold("Snipara Sandbox hint"));

  if (report.runtime.cliAvailable) {
    const runtimeLabel = runtimeHintVersionLabel(report);
    console.log(`Snipara Sandbox is installed${runtimeLabel}.`);
    if (report.runtime.mcpConfigured) {
      console.log(
        "Use MCP execute_python from your AI client for sandboxed validation.",
      );
    } else {
      console.log(
        "For MCP execute_python, add Snipara Sandbox MCP config with: npx create-snipara repair --with-runtime",
      );
    }
    console.log(
      `For standalone execution: snipara-sandbox run ${JSON.stringify(query)}`,
    );
    if (!report.providerKeys.any) {
      console.log(
        "Standalone snipara-sandbox run / snipara-sandbox agent needs OPENAI_API_KEY or ANTHROPIC_API_KEY.",
      );
    } else if (
      report.providerKeys.sources.openai === "env-file" ||
      report.providerKeys.sources.anthropic === "env-file"
    ) {
      console.log(
        "Provider key was found in a local .env file; export it first if standalone snipara-sandbox run does not load .env in your shell.",
      );
    }
    if (!report.docker.available) {
      console.log(
        "Docker was not detected; use local/sandbox mode or install Docker for isolation.",
      );
    }
    return;
  }

  console.log("Need sandboxed execution or autonomous Sandbox jobs?");
  console.log("Existing project: npx create-snipara repair --with-runtime");
  console.log(
    "Fresh setup: npx create-snipara --profile full-stack --advanced",
  );
  console.log(
    'Manual install: python -m pip install "snipara-sandbox[all]" (`[all]` is the pip extra, not a separate argument).',
  );
}

function printLiteWorkflowRun(
  query: string,
  requestedMode: WorkflowMode,
): void {
  console.log(chalk.bold("Workflow Lite"));
  printKeyValue("Requested mode:", requestedMode);
  printKeyValue("Effective mode:", "lite");
  printKeyValue("Task:", query);
  console.log("No Snipara recall, context query, or bootstrap call was run.");
  console.log(
    "Escalate with recall, context_query, code impact, or task-commit only when the task creates that need.",
  );
  console.log("");
}

function runtimeHintVersionLabel(
  report: ReturnType<typeof detectRuntimeEnvironment>,
): string {
  if (!report.runtime.cliVersion) {
    return report.runtime.version ? ` (${report.runtime.version})` : "";
  }

  if (!report.runtime.installedPackageVersion) {
    return ` (CLI ${report.runtime.cliVersion})`;
  }

  if (report.runtime.versionMismatch) {
    return ` (CLI ${report.runtime.cliVersion}, package metadata ${report.runtime.installedPackageVersion}; mismatch)`;
  }

  return ` (CLI ${report.runtime.cliVersion})`;
}

function printOrchestratorHandoffHint(
  query: string,
  mode: WorkflowMode,
  recommendation: OrchestratorRecommendation | null = getOrchestratorRecommendation(
    query,
    mode,
  ),
): void {
  if (!recommendation) {
    return;
  }

  const report = detectRuntimeEnvironment();
  console.log("");
  console.log(chalk.bold("Snipara Orchestrator hint"));
  console.log(`Routing level: ${recommendation.level}`);
  if (recommendation.policySource) {
    console.log(`Policy source: ${recommendation.policySource}`);
  }
  console.log(
    `Reasons: ${recommendation.reasons.map((reason) => formatOrchestratorRecommendationReason(reason)).join("; ")}`,
  );

  if (report.orchestrator.cliAvailable) {
    const versionLabel = report.orchestrator.version
      ? ` (${report.orchestrator.version})`
      : "";
    console.log(`snipara-orchestrator is installed${versionLabel}.`);
    if (recommendation.level === "auto") {
      console.log(
        "Policy auto-route marked this task for orchestrator handling and prepared the handoff automatically.",
      );
    } else if (recommendation.orchestratorRequired) {
      console.log(
        "Companion recommends an explicit orchestrator handoff for production proof gates, drift checks, htask queues, or multi-agent coordination.",
      );
    } else {
      console.log(
        "Companion can keep this local for now, but orchestrator is likely to help once proof gates or shared coordination become explicit.",
      );
    }
    if (recommendation.reasons.includes("htask_or_swarm_intent")) {
      console.log(
        "Preferred multi-agent path: snipara-orchestrator swarm-create | swarm-join | htask-create-feature | htask-create | htask-next | htask-tree | htask-complete.",
      );
      console.log(
        "Companion may retain legacy direct hosted passthrough commands, but htasks belong to the orchestrator workflow surface.",
      );
    }
  } else {
    console.log(
      "For production proof gates, drift checks, htasks, or multi-agent coordination, install explicitly with: npx create-snipara repair --with-orchestrator",
    );
    console.log("Manual install: pip install snipara-orchestrator");
    if (recommendation.reasons.includes("htask_or_swarm_intent")) {
      console.log(
        "Install orchestrator before using hosted htasks or swarm coordination as a workflow surface.",
      );
    }
  }

  console.log(
    "Companion keeps workflow state and phase commits; it does not spawn orchestrator workers automatically.",
  );
}

function printPreparedOrchestratorHandoff(
  handoff: WrittenOrchestratorHandoff,
): void {
  console.log("");
  console.log(chalk.bold("Prepared Orchestrator Handoff"));
  console.log(`Path: ${handoff.relativePath}`);
  console.log(`Command: ${handoff.command}`);
}

function printAdaptiveRoutingRecommendation(
  routing: AdaptiveWorkRoutingRecommendation,
): void {
  console.log("");
  console.log(chalk.bold("Adaptive Work Routing"));
  printKeyValue("Mode:", routing.routingCard.mode);
  printKeyValue("Task type:", routing.workProfile.taskType);
  printKeyValue("Risk:", routing.workProfile.risk);
  printKeyValue("Worker role:", routing.requirements.workerRole);
  printKeyValue("Fallback:", routing.requirements.fallback);
  if (routing.requirements.preferredEndpointTypes?.length) {
    printKeyValue(
      "Preferred endpoints:",
      routing.requirements.preferredEndpointTypes.join(", "),
    );
  }
  if (routing.requirements.allowedEndpointTypes?.length) {
    printKeyValue(
      "Allowed endpoints:",
      routing.requirements.allowedEndpointTypes.join(", "),
    );
  }
  if (routing.requirements.plannerRetainsReasoning) {
    printKeyValue("Planner retains reasoning:", "yes");
  }
  if (routing.strongRepair?.enabled) {
    printKeyValue(
      "Strong repair:",
      "one bounded attempt after proof/output failure",
    );
    printKeyValue("Repair authority:", routing.strongRepair.finalAuthority);
  }
  if (routing.gateway) {
    printKeyValue(
      routing.gateway.source === "local_orchestrator"
        ? "Local route:"
        : "Hosted catalog:",
      routing.gateway.success
        ? `${routing.gateway.candidateCount} candidate(s), ${routing.gateway.resolutionStatus ?? "ready"}`
        : "unavailable",
    );
  }
  const selectedCandidate = adaptiveRoutingSelectedCandidate(
    routing.resolution,
  );
  if (selectedCandidate) {
    printKeyValue("Selected candidate:", selectedCandidate.candidateId);
    if (selectedCandidate.endpointType) {
      printKeyValue("Selected endpoint:", selectedCandidate.endpointType);
    }
  }
  const selectedWorkerEndpoint =
    selectedCandidate && routing.runtimeCatalog?.workerEndpoints
      ? routing.runtimeCatalog.workerEndpoints[selectedCandidate.candidateId]
      : undefined;
  if (selectedWorkerEndpoint?.model) {
    printKeyValue("Selected model:", String(selectedWorkerEndpoint.model));
  }
  if (routing.routingCard.reasons.length > 0) {
    console.log("Reasons:");
    for (const reason of routing.routingCard.reasons) {
      console.log(`- ${reason}`);
    }
  }
  if (routing.routingCard.warnings.length > 0) {
    console.log("Warnings:");
    for (const warning of routing.routingCard.warnings) {
      console.log(`- ${warning}`);
    }
  }
  if (routing.routingCard.rejectedReasons) {
    const entries = Object.entries(routing.routingCard.rejectedReasons);
    if (entries.length > 0) {
      console.log("Rejected candidates:");
      for (const [candidateId, reasons] of entries) {
        console.log(`- ${candidateId}`);
        for (const reason of reasons) {
          console.log(`    - ${reason}`);
        }
      }
    }
  }
}

interface AdaptiveRoutingCatalogGatewayResult {
  success?: boolean;
  fallback?: string;
  catalog?: AdaptiveRoutingRuntimeCatalog;
  resolution?: {
    status?: string;
    candidate_count?: number;
    candidateCount?: number;
    fallback?: string;
  };
  warnings?: unknown[];
}

interface AdaptiveRoutingCatalogClient {
  callTool<T>(toolName: string, args: Record<string, unknown>): Promise<T>;
}

function policyValue(
  settings: ProjectAutomationSettings | Record<string, unknown>,
  hostedKey: keyof ProjectAutomationSettings,
  localKey: string,
): unknown {
  const record = settings as Record<string, unknown>;
  return record[hostedKey] ?? record[localKey];
}

function readLocalAdaptiveRoutingProjectPolicy(): AdaptiveRoutingProjectPolicy | null {
  const workspaceRoot = findWorkspaceRoot(process.cwd(), true);
  if (!workspaceRoot) {
    return null;
  }

  const policyPath = path.join(
    workspaceRoot,
    ADAPTIVE_ROUTING_POLICY_RELATIVE_PATH,
  );
  if (!fs.existsSync(policyPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(policyPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    return normalizeAdaptiveRoutingProjectPolicy(parsed, "local_file");
  } catch {
    return null;
  }
}

async function loadAdaptiveRoutingProjectPolicy(
  client: AdaptiveRoutingPolicyClient | null,
  fallbackPolicy: AdaptiveRoutingProjectPolicy | null = null,
): Promise<AdaptiveRoutingProjectPolicy | null> {
  try {
    if (!client) {
      return fallbackPolicy;
    }
    const result = await client.getAutomationSettings();
    return (
      normalizeAdaptiveRoutingProjectPolicy(
        result.settings,
        "hosted_project",
      ) ?? fallbackPolicy
    );
  } catch {
    return fallbackPolicy;
  }
}

function normalizeAdaptiveRoutingProjectPolicy(
  settings: ProjectAutomationSettings | Record<string, unknown>,
  source: AdaptiveRoutingProjectPolicy["source"],
): AdaptiveRoutingProjectPolicy | null {
  const mode = normalizeAdaptiveRoutingMode(
    policyValue(settings, "adaptiveRoutingMode", "mode"),
  );
  if (!mode) {
    return null;
  }

  const allowedEndpointTypes = normalizeRoutingEndpointTypes(
    normalizeStringArray(
      policyValue(
        settings,
        "adaptiveRoutingAllowedEndpointTypes",
        "allowedEndpointTypes",
      ),
    ),
  );
  const preferredEndpointTypes = normalizeRoutingEndpointTypes(
    normalizeStringArray(
      policyValue(
        settings,
        "adaptiveRoutingPreferredEndpointTypes",
        "preferredEndpointTypes",
      ),
    ),
  );
  const allowedWorkerClasses = normalizeAdaptiveWorkerClasses(
    normalizeStringArray(
      policyValue(
        settings,
        "adaptiveRoutingAllowedWorkerClasses",
        "allowedWorkerClasses",
      ),
    ),
  );

  return {
    source,
    mode,
    requireApproval:
      policyValue(
        settings,
        "adaptiveRoutingRequireApproval",
        "requireApproval",
      ) !== false,
    plannerRetainsReasoning:
      policyValue(
        settings,
        "adaptiveRoutingPlannerRetainsReasoning",
        "plannerRetainsReasoning",
      ) !== false,
    preferLocalWorkers:
      policyValue(
        settings,
        "adaptiveRoutingPreferLocalWorkers",
        "preferLocalWorkers",
      ) === true,
    allowedEndpointTypes:
      allowedEndpointTypes.length > 0 ? allowedEndpointTypes : ["cloud"],
    preferredEndpointTypes,
    allowedWorkerClasses:
      allowedWorkerClasses.length > 0
        ? allowedWorkerClasses
        : ["documentation", "tests", "review"],
    fallback: "main_agent",
    dailyBudgetCents: normalizeCents(
      policyValue(
        settings,
        "adaptiveRoutingDailyBudgetCents",
        "dailyBudgetCents",
      ),
    ),
    monthlyBudgetCents: normalizeCents(
      policyValue(
        settings,
        "adaptiveRoutingMonthlyBudgetCents",
        "monthlyBudgetCents",
      ),
    ),
    catalogLimit: normalizeAdaptiveRoutingCatalogLimit(
      policyValue(settings, "adaptiveRoutingCatalogLimit", "catalogLimit"),
    ),
  };
}

function resolveAdaptiveRoutingIntent(
  options: {
    adaptiveRoutingDryRun?: boolean;
    routeLocalWorkers?: boolean;
    routingLocalTransport?: "openai_http" | "cli";
    routingLocalAdapter?: "codex_app_server" | "claude_cli";
    routingLocalCommand?: string;
    routingLocalWorker?: string;
    routingWorkerRole?: string;
    routingPreferredEndpoints?: string[];
    routingAllowedEndpoints?: string[];
    plannerRetainsReasoning?: boolean;
    strongRepair?: boolean;
  },
  policy: AdaptiveRoutingProjectPolicy | null,
  hostedConfigured: boolean,
): AdaptiveRoutingIntent {
  const cliRequested = shouldBuildAdaptiveRouting(options);
  if (!policy) {
    return {
      shouldBuild: cliRequested,
      shouldUseHostedCatalog: cliRequested,
      warnings: [],
    };
  }

  if (options.routingLocalWorker) {
    return {
      shouldBuild: true,
      shouldUseHostedCatalog: false,
      warnings: [
        `Declared local worker ${options.routingLocalWorker} selected; hosted adaptive catalog lookup is disabled for this run.`,
      ],
    };
  }

  if (policy.mode === "off") {
    return {
      shouldBuild: cliRequested,
      shouldUseHostedCatalog: false,
      warnings: cliRequested
        ? [
            "Project Adaptive Work Routing policy is off; keeping recommendation metadata local.",
          ]
        : [],
    };
  }

  return {
    shouldBuild: true,
    shouldUseHostedCatalog: hostedConfigured && policy.mode === "catalog",
    warnings: [
      ...(policy.mode === "recommend"
        ? [
            "Project Adaptive Work Routing policy is recommendation-only; hosted catalog lookup is disabled.",
          ]
        : []),
      ...(!hostedConfigured && policy.mode === "catalog"
        ? [
            "Local Adaptive Work Routing policy requested catalog mode; hosted catalog lookup is skipped without Snipara configuration.",
          ]
        : []),
    ],
  };
}

async function enrichAdaptiveRoutingWithHostedCatalog(
  client: AdaptiveRoutingCatalogClient,
  routing: AdaptiveWorkRoutingRecommendation,
): Promise<AdaptiveWorkRoutingRecommendation> {
  try {
    const result = await client.callTool<AdaptiveRoutingCatalogGatewayResult>(
      "snipara_adaptive_routing_catalog",
      {
        work_profile: routing.workProfile,
        model_requirements: routing.requirements,
        limit:
          routing.requirements.catalogLimit ??
          DEFAULT_ADAPTIVE_ROUTING_CATALOG_LIMIT,
      },
    );
    const catalog = normalizeAdaptiveRoutingCatalog(result.catalog);
    const gatewaySucceeded = result.success === true;
    const warnings = normalizeStringArray(result.warnings) ?? [];
    const gatewayWarnings = gatewaySucceeded
      ? warnings
      : [
          ...warnings,
          "Hosted adaptive routing catalog did not return success=true; treating gateway as failed closed.",
        ];
    const candidateCount =
      numberValue(result.resolution?.candidate_count) ??
      numberValue(result.resolution?.candidateCount) ??
      catalog.candidates.length;
    const gateway: AdaptiveRoutingGatewayStatus = {
      source: "hosted_mcp",
      success: gatewaySucceeded,
      resolutionStatus: stringValue(result.resolution?.status),
      candidateCount,
      fallback:
        stringValue(result.fallback) ??
        stringValue(result.resolution?.fallback) ??
        "main_agent",
      warnings: gatewayWarnings,
    };
    const reasons = [
      ...routing.routingCard.reasons,
      gatewaySucceeded
        ? candidateCount > 0
          ? `hosted adaptive routing catalog returned ${candidateCount} candidate(s)`
          : "hosted adaptive routing catalog returned no candidates and will fail closed"
        : "hosted adaptive routing catalog did not report explicit success and will fail closed",
    ];

    return {
      ...routing,
      gateway,
      runtimeCatalog: catalog,
      routingCard: {
        ...routing.routingCard,
        reasons: uniqueStrings(reasons),
        warnings: uniqueStrings([
          ...routing.routingCard.warnings,
          ...gatewayWarnings,
        ]),
      },
    };
  } catch (error) {
    const warning = `Hosted adaptive routing catalog unavailable; keeping local dry-run metadata (${toPreview(error)}).`;
    return {
      ...routing,
      gateway: {
        source: "hosted_mcp",
        success: false,
        resolutionStatus: "unavailable",
        candidateCount: 0,
        fallback: "main_agent",
        warnings: [warning],
      },
      routingCard: {
        ...routing.routingCard,
        warnings: uniqueStrings([...routing.routingCard.warnings, warning]),
      },
    };
  }
}

function normalizeAdaptiveRoutingCatalog(
  value: unknown,
): AdaptiveRoutingRuntimeCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { candidates: [] };
  }
  const record = value as Record<string, unknown>;
  const candidates = Array.isArray(record.candidates)
    ? record.candidates.filter(
        (candidate): candidate is Record<string, unknown> =>
          Boolean(candidate) &&
          typeof candidate === "object" &&
          !Array.isArray(candidate),
      )
    : [];
  const models = Array.isArray(record.models)
    ? record.models
        .map((item) => stringValue(item))
        .filter((item): item is string => Boolean(item))
    : undefined;
  const workerEndpoints = isRecord(record.workerEndpoints)
    ? (Object.fromEntries(
        Object.entries(record.workerEndpoints).filter(
          ([key, value]) => Boolean(stringValue(key)) && isRecord(value),
        ),
      ) as Record<string, Record<string, unknown>>)
    : undefined;
  const workerProfiles = isRecord(record.workerProfiles)
    ? (Object.fromEntries(
        Object.entries(record.workerProfiles).filter(
          ([key, value]) => Boolean(stringValue(key)) && isRecord(value),
        ),
      ) as Record<string, Record<string, unknown>>)
    : undefined;
  return {
    version: stringValue(record.version),
    source: stringValue(record.source),
    provider: stringValue(record.provider),
    baseUrl: stringValue(record.baseUrl),
    ...(models && models.length > 0 ? { models } : {}),
    ...(isRecord(record.apiPaths) ? { apiPaths: record.apiPaths } : {}),
    ...(workerEndpoints ? { workerEndpoints } : {}),
    ...(workerProfiles ? { workerProfiles } : {}),
    candidates,
  };
}

interface AdaptiveRoutingSelectedCandidateRecord {
  candidateId: string;
  workerClass?: string;
  endpointType?: string;
  catalogSource?: string;
}

function adaptiveRoutingSelectedCandidate(
  resolution: AdaptiveWorkRoutingRecommendation["resolution"],
): AdaptiveRoutingSelectedCandidateRecord | undefined {
  if (!resolution || !isRecord(resolution.selected)) {
    return undefined;
  }
  const candidate = isRecord(resolution.selected.candidate)
    ? resolution.selected.candidate
    : undefined;
  const candidateId = stringValue(candidate?.candidateId);
  if (!candidateId) {
    return undefined;
  }
  return {
    candidateId,
    workerClass: stringValue(candidate?.workerClass),
    endpointType: stringValue(candidate?.endpointType),
    catalogSource: stringValue(candidate?.catalogSource),
  };
}

function normalizeAdaptiveRoutingResolution(
  value: unknown,
): AdaptiveWorkRoutingRecommendation["resolution"] {
  if (!isRecord(value)) {
    return undefined;
  }
  const selected = isRecord(value.selected) ? value.selected : undefined;
  const candidate =
    selected && isRecord(selected.candidate) ? selected.candidate : undefined;
  const rejectedReasons = normalizeStringArrayRecord(
    value.rejectedReasons ?? value.rejected_reasons,
  );
  const selectedPayload =
    selected && candidate
      ? {
          candidate,
          ...(numberValue(selected.score) !== undefined
            ? { score: numberValue(selected.score) }
            : {}),
          ...(isRecord(selected.scoreBreakdown)
            ? { scoreBreakdown: selected.scoreBreakdown }
            : {}),
          ...(normalizeStringArray(selected.reasons)
            ? { reasons: normalizeStringArray(selected.reasons) }
            : {}),
        }
      : undefined;
  const reasons = normalizeStringArray(value.reasons);
  const warnings = normalizeStringArray(value.warnings);
  return {
    status: stringValue(value.status),
    ...(selectedPayload ? { selected: selectedPayload } : {}),
    ...(isRecord(value.policyDecision)
      ? { policyDecision: value.policyDecision }
      : {}),
    ...(numberValue(value.evaluatedCount) !== undefined
      ? { evaluatedCount: numberValue(value.evaluatedCount) }
      : {}),
    ...(numberValue(value.rejectedCount) !== undefined
      ? { rejectedCount: numberValue(value.rejectedCount) }
      : {}),
    ...(stringValue(value.fallback)
      ? { fallback: stringValue(value.fallback) }
      : {}),
    ...(reasons ? { reasons } : {}),
    ...(warnings ? { warnings } : {}),
    ...(rejectedReasons ? { rejectedReasons } : {}),
  };
}

function normalizeStringArrayRecord(
  value: unknown,
): Record<string, string[]> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const output: Record<string, string[]> = {};
  for (const [candidateId, candidateReasons] of Object.entries(value)) {
    const normalizedReasons = normalizeStringArray(candidateReasons);
    const candidateIdValue = stringValue(candidateId);
    if (
      !candidateIdValue ||
      !normalizedReasons ||
      normalizedReasons.length === 0
    ) {
      continue;
    }
    output[candidateIdValue] = normalizedReasons;
  }

  if (Object.keys(output).length === 0) {
    return undefined;
  }

  return output;
}

function shouldResolveAdaptiveRoutingLocally(
  options: {
    routeLocalWorkers?: boolean;
    routingLocalTransport?: "openai_http" | "cli";
    routingLocalAdapter?: "codex_app_server" | "claude_cli";
    routingLocalCommand?: string;
    routingLocalWorker?: string;
    routingPreferredEndpoints?: string[];
    routingAllowedEndpoints?: string[];
    routingLocalBaseUrl?: string;
    routingLocalModel?: string;
    routingLocalPreferModel?: string;
    routingLocalProvider?: string;
    routingLocalApiKeyEnv?: string;
    routingLocalApiKeyHeader?: "authorization" | "x-api-key";
  },
  routing: AdaptiveWorkRoutingRecommendation | null,
): boolean {
  if (!routing) {
    return false;
  }
  if (
    !options.routeLocalWorkers &&
    !options.routingLocalWorker &&
    !options.routingLocalBaseUrl &&
    !options.routingLocalModel &&
    !options.routingLocalPreferModel &&
    !options.routingLocalProvider
  ) {
    return false;
  }
  const preferred = routing.requirements.preferredEndpointTypes ?? [];
  const allowed = routing.requirements.allowedEndpointTypes ?? [];
  return (
    preferred.includes("local") ||
    allowed.length === 0 ||
    allowed.includes("local")
  );
}

function hasLocalRoutingRequest(options: {
  routeLocalWorkers?: boolean;
  routingLocalWorker?: string;
  routingPreferredEndpoints?: string[];
  routingAllowedEndpoints?: string[];
  routingLocalBaseUrl?: string;
  routingLocalModel?: string;
  routingLocalPreferModel?: string;
  routingLocalProvider?: string;
  routingLocalApiKeyEnv?: string;
  routingLocalApiKeyHeader?: "authorization" | "x-api-key";
}): boolean {
  return (
    options.routeLocalWorkers === true ||
    Boolean(options.routingLocalWorker) ||
    Boolean(options.routingLocalBaseUrl) ||
    Boolean(options.routingLocalModel) ||
    Boolean(options.routingLocalPreferModel) ||
    Boolean(options.routingLocalProvider) ||
    Boolean(options.routingLocalApiKeyEnv) ||
    normalizeRoutingEndpointTypes(options.routingPreferredEndpoints).includes(
      "local",
    ) ||
    normalizeRoutingEndpointTypes(options.routingAllowedEndpoints).includes(
      "local",
    )
  );
}

function applyLocalWorkerRoutingDefaults<
  T extends {
    routeLocalWorkers?: boolean;
    routingLocalTransport?: "openai_http" | "cli";
    routingLocalAdapter?: "codex_app_server" | "claude_cli";
    routingLocalCommand?: string;
    routingLocalWorker?: string;
    routingWorkerRole?: string;
    routingPreferredEndpoints?: string[];
    routingAllowedEndpoints?: string[];
    routingLocalBaseUrl?: string;
    routingLocalModel?: string;
    routingLocalPreferModel?: string;
    routingLocalProvider?: string;
    routingLocalApiKeyEnv?: string;
    routingLocalApiKeyHeader?: "authorization" | "x-api-key";
    plannerRetainsReasoning?: boolean;
  },
>(options: T, defaults: LocalWorkerRoutingDefaults | null): T {
  if (!defaults) {
    return options;
  }

  return {
    ...options,
    routeLocalWorkers: options.routeLocalWorkers ?? defaults.routeLocalWorkers,
    routingLocalTransport:
      options.routingLocalTransport ?? defaults.routingLocalTransport,
    routingLocalAdapter:
      options.routingLocalAdapter ?? defaults.routingLocalAdapter,
    routingLocalCommand:
      options.routingLocalCommand ?? defaults.routingLocalCommand,
    routingWorkerRole: options.routingWorkerRole ?? defaults.routingWorkerRole,
    routingPreferredEndpoints:
      options.routingPreferredEndpoints &&
      options.routingPreferredEndpoints.length > 0
        ? options.routingPreferredEndpoints
        : defaults.routingPreferredEndpoints,
    routingAllowedEndpoints:
      options.routingAllowedEndpoints &&
      options.routingAllowedEndpoints.length > 0
        ? options.routingAllowedEndpoints
        : defaults.routingAllowedEndpoints,
    routingLocalBaseUrl:
      options.routingLocalBaseUrl ?? defaults.routingLocalBaseUrl,
    routingLocalModel: options.routingLocalModel ?? defaults.routingLocalModel,
    routingLocalPreferModel:
      options.routingLocalPreferModel ?? defaults.routingLocalPreferModel,
    routingLocalProvider:
      options.routingLocalProvider ?? defaults.routingLocalProvider,
    routingLocalApiKeyEnv:
      options.routingLocalApiKeyEnv ?? defaults.routingLocalApiKeyEnv,
    routingLocalApiKeyHeader:
      options.routingLocalApiKeyHeader ?? defaults.routingLocalApiKeyHeader,
    plannerRetainsReasoning:
      options.plannerRetainsReasoning ?? defaults.plannerRetainsReasoning,
  };
}

function runOrchestratorJsonCommand(
  args: string[],
  cwd: string = process.cwd(),
): Record<string, unknown> {
  const output = execFileSync("snipara-orchestrator", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: DEFAULT_LOCAL_ORCHESTRATOR_TIMEOUT_MS,
  }).trim();
  return output
    ? parseJsonRecord(output, "snipara-orchestrator JSON output")
    : {};
}

function enrichAdaptiveRoutingWithLocalOrchestrator(
  routing: AdaptiveWorkRoutingRecommendation,
  options: {
    routeLocalWorkers?: boolean;
    routingLocalTransport?: "openai_http" | "cli";
    routingLocalAdapter?: "codex_app_server" | "claude_cli";
    routingLocalCommand?: string;
    routingLocalBaseUrl?: string;
    routingLocalModel?: string;
    routingLocalPreferModel?: string;
    routingLocalProvider?: string;
    routingLocalApiKeyEnv?: string;
    routingLocalApiKeyHeader?: "authorization" | "x-api-key";
  },
  cwd: string = process.cwd(),
): AdaptiveWorkRoutingRecommendation {
  try {
    if (options.routingLocalTransport === "cli") {
      const candidateId =
        options.routingLocalAdapter ??
        options.routingLocalCommand ??
        "declared-cli";
      const candidate = {
        candidateId,
        workerClass: routing.requirements.workerRole,
        catalogSource: "declared_cli_worker",
        endpointType: "local",
        workerRoles: [routing.requirements.workerRole],
        capabilities: routing.requirements.capabilities ?? [],
        writeScope: routing.requirements.writeScope ?? [],
        reasoning: routing.requirements.reasoning,
        speed: "normal",
        cost: "balanced",
        contextBudget: routing.requirements.contextBudget,
        qualityScore: null,
        isAvailable: true,
        requiresApiKey: false,
        metadata: {
          adapter: options.routingLocalAdapter,
          command: options.routingLocalCommand,
        },
      };
      const resolution = normalizeAdaptiveRoutingResolution(
        runOrchestratorJsonCommand(
          [
            "route",
            "--dry-run",
            "--json",
            "--work-profile-json",
            JSON.stringify(routing.workProfile),
            "--requirements-json",
            JSON.stringify(routing.requirements),
            "--candidate-json",
            JSON.stringify(candidate),
          ],
          cwd,
        ),
      );
      return {
        ...routing,
        gateway: {
          source: "local_orchestrator",
          success: true,
          resolutionStatus: resolution?.status ?? "resolved",
          candidateCount: 1,
          fallback: "main_agent",
          warnings: [],
        },
        runtimeCatalog: {
          source: "declared_cli_worker",
          candidates: [candidate],
          workerEndpoints: {
            [candidateId]: {
              adapter: options.routingLocalAdapter,
              command: options.routingLocalCommand,
            },
          },
        },
        resolution,
      };
    }
    const catalogArgs = [
      "local-model-catalog",
      "--json",
      "--worker-role",
      routing.requirements.workerRole,
    ];
    for (const writeScope of routing.requirements.writeScope ?? []) {
      catalogArgs.push("--write-scope", writeScope);
    }
    if (options.routingLocalBaseUrl) {
      catalogArgs.push("--base-url", options.routingLocalBaseUrl);
    }
    if (options.routingLocalModel) {
      catalogArgs.push("--model", options.routingLocalModel);
    } else if (options.routingLocalPreferModel) {
      catalogArgs.push("--prefer-model", options.routingLocalPreferModel);
    } else if (options.routeLocalWorkers) {
      catalogArgs.push("--all-models");
    }
    if (options.routingLocalProvider) {
      catalogArgs.push("--provider", options.routingLocalProvider);
    }
    if (options.routingLocalApiKeyEnv) {
      catalogArgs.push("--api-key-env", options.routingLocalApiKeyEnv);
    }
    if (options.routingLocalApiKeyHeader) {
      catalogArgs.push("--api-key-header", options.routingLocalApiKeyHeader);
    }

    const runtimeCatalog = normalizeAdaptiveRoutingCatalog(
      runOrchestratorJsonCommand(catalogArgs, cwd),
    );
    const routeArgs = [
      "route",
      "--dry-run",
      "--json",
      "--work-profile-json",
      JSON.stringify(routing.workProfile),
      "--requirements-json",
      JSON.stringify(routing.requirements),
    ];
    for (const candidate of runtimeCatalog.candidates) {
      routeArgs.push("--candidate-json", JSON.stringify(candidate));
    }

    const resolution = normalizeAdaptiveRoutingResolution(
      runOrchestratorJsonCommand(routeArgs, cwd),
    );
    const selectedCandidate = adaptiveRoutingSelectedCandidate(resolution);
    const selectedEndpoint =
      selectedCandidate && runtimeCatalog.workerEndpoints
        ? runtimeCatalog.workerEndpoints[selectedCandidate.candidateId]
        : undefined;
    const resolutionWarnings = normalizeStringArray(resolution?.warnings) ?? [];
    const resolutionReasons = normalizeStringArray(resolution?.reasons) ?? [];
    const resolutionRejectedReasons = normalizeStringArrayRecord(
      (resolution as { rejectedReasons?: Record<string, string[]> })
        ?.rejectedReasons,
    );
    const approvalRequired = booleanValue(
      isRecord(resolution?.policyDecision)
        ? resolution.policyDecision.approvalRequired
        : undefined,
    );
    const gatewayWarnings = uniqueStrings([
      ...resolutionWarnings,
      ...(selectedCandidate
        ? []
        : [
            "Local orchestrator did not select a worker candidate and will fail closed.",
          ]),
    ]);
    const gateway: AdaptiveRoutingGatewayStatus = {
      source: "local_orchestrator",
      success: stringValue(resolution?.status) === "resolved",
      resolutionStatus: stringValue(resolution?.status),
      candidateCount: runtimeCatalog.candidates.length,
      fallback:
        stringValue(resolution?.fallback) ?? routing.requirements.fallback,
      warnings: gatewayWarnings,
    };

    return {
      ...routing,
      gateway,
      runtimeCatalog,
      ...(resolution ? { resolution } : {}),
      routingCard: {
        ...routing.routingCard,
        ...(selectedCandidate?.workerClass
          ? { recommendedWorkerClass: selectedCandidate.workerClass }
          : {}),
        ...(resolutionRejectedReasons
          ? { rejectedReasons: resolutionRejectedReasons }
          : {}),
        ...(approvalRequired !== undefined
          ? { humanApprovalRequired: approvalRequired }
          : {}),
        reasons: uniqueStrings([
          ...routing.routingCard.reasons,
          ...resolutionReasons,
          ...(selectedCandidate
            ? [
                `local orchestrator resolved worker candidate ${selectedCandidate.candidateId}`,
                ...(selectedCandidate.endpointType
                  ? [
                      `selected worker endpoint is ${selectedCandidate.endpointType}`,
                    ]
                  : []),
                ...(stringValue(selectedEndpoint?.model)
                  ? [`selected local model ${String(selectedEndpoint?.model)}`]
                  : []),
              ]
            : [
                "local orchestrator could not resolve a concrete worker candidate",
              ]),
        ]),
        warnings: uniqueStrings([
          ...routing.routingCard.warnings,
          ...gatewayWarnings,
        ]),
      },
    };
  } catch (error) {
    const warning = `Local orchestrator routing unavailable; keeping current routing metadata (${toPreview(error)}).`;
    return {
      ...routing,
      gateway: {
        source: "local_orchestrator",
        success: false,
        resolutionStatus: "unavailable",
        candidateCount: 0,
        fallback: routing.requirements.fallback,
        warnings: [warning],
      },
      routingCard: {
        ...routing.routingCard,
        warnings: uniqueStrings([...routing.routingCard.warnings, warning]),
      },
    };
  }
}

function printUploadResult(
  path: string,
  result: Record<string, unknown>,
): void {
  printKeyValue("Uploaded:", path);
  printCompactObject(result, [
    "message",
    "document_id",
    "documentId",
    "version",
    "status",
  ]);
  console.log("");
  printJson(result);
}

function printSyncDocumentsResult(result: Record<string, unknown>): void {
  printKeyValue("Tool:", "snipara_sync_documents");
  printCompactObject(result, [
    "message",
    "created",
    "updated",
    "unchanged",
    "deleted",
    "total",
    "status",
  ]);
  console.log("");
  printJson(result);
}

function printSyncDocumentsDryRun(result: SyncDocumentsDryRunSummary): void {
  printKeyValue("Dry run:", "true");
  printKeyValue("Documents:", result.total);
  printKeyValue("Would sync:", result.would_sync);
  printKeyValue("Invalid metadata:", result.invalid_metadata);
  printKeyValue("Stale:", result.stale);
  printKeyValue("Needs reupload:", result.needs_reupload);
  printKeyValue("Needs metadata review:", result.needs_metadata_review);
  if (result.reindex_requested) {
    printKeyValue("Reindex:", `${result.reindex_kind}/${result.reindex_mode}`);
  }
  console.log("");

  const attention = result.documents.filter(
    (item) => item.recommended_action !== "none",
  );
  if (attention.length > 0) {
    console.log(chalk.bold("Attention"));
    for (const item of attention.slice(0, 10)) {
      console.log(
        `- ${item.path}: ${item.recommended_action} (${item.reasons.join(", ")})`,
      );
    }
    if (attention.length > 10) {
      console.log(chalk.gray(`… ${attention.length - 10} more`));
    }
    console.log("");
  }

  console.log(chalk.gray(result.note));
  console.log("");
  printJson(result);
}

function printOnboardFolderManifest(result: OnboardFolderManifest): void {
  printKeyValue("Onboard folder:", result.source.root);
  printKeyValue(
    "Classification:",
    `${result.classification.mode} (${Math.round(result.classification.confidence * 100)}%)`,
  );
  printKeyValue("Supported documents:", result.summary.supported_documents);
  printKeyValue("Ignored files:", result.summary.ignored_files);
  if (result.summary.unsupported_business_files > 0) {
    printKeyValue(
      "Unsupported business-looking files:",
      result.summary.unsupported_business_files,
    );
  }
  printKeyValue("Would sync:", result.dryRun.would_sync);
  printKeyValue("Invalid metadata:", result.dryRun.invalid_metadata);
  if (result.sync.reindex) {
    printKeyValue(
      "Reindex:",
      `${result.sync.reindexKind}/${result.sync.reindexMode}`,
    );
  }
  console.log("");

  if (result.classification.signals.code.length > 0) {
    console.log(chalk.bold("Code signals"));
    for (const signal of result.classification.signals.code.slice(0, 8)) {
      console.log(`- ${signal}`);
    }
    if (result.classification.signals.code.length > 8) {
      console.log(
        chalk.gray(`... ${result.classification.signals.code.length - 8} more`),
      );
    }
    console.log("");
  }

  if (result.classification.signals.business.length > 0) {
    console.log(chalk.bold("Business signals"));
    for (const signal of result.classification.signals.business.slice(0, 8)) {
      console.log(`- ${signal}`);
    }
    if (result.classification.signals.business.length > 8) {
      console.log(
        chalk.gray(
          `... ${result.classification.signals.business.length - 8} more`,
        ),
      );
    }
    console.log("");
  }

  if (result.warnings.length > 0) {
    console.log(chalk.bold("Warnings"));
    for (const warning of result.warnings) {
      console.log(`- ${warning}`);
    }
    console.log("");
  }

  console.log(
    chalk.gray(
      "Preview only. Re-run with --apply to upload, or --write-manifest to save JSON.",
    ),
  );
  console.log("");
  printJson(result);
}

function printReindexResult(result: Record<string, unknown>): void {
  printKeyValue("Tool:", "snipara_reindex");
  printCompactObject(result, [
    "message",
    "job_id",
    "jobId",
    "status",
    "kind",
    "mode",
    "progress",
  ]);
  console.log("");
  printJson(result);
}

function printBusinessHealthResult(result: Record<string, unknown>): void {
  printKeyValue("Tool:", "snipara_index_health");
  printCompactObject(result, [
    "health_score",
    "health_status",
    "coverage_percent",
    "stale_count",
    "needs_attention",
  ]);

  const businessContext = isRecord(result.business_context)
    ? result.business_context
    : null;
  if (businessContext) {
    console.log("");
    console.log(chalk.bold("Business Context"));
    printCompactObject(businessContext, [
      "tracked_documents",
      "unclassified_documents",
      "needs_attention",
      "needs_reupload",
      "needs_reindex",
      "needs_metadata_review",
      "needs_quality_review",
    ]);

    const signals = Array.isArray(businessContext.signals)
      ? businessContext.signals
      : [];
    if (signals.length > 0) {
      console.log("");
      console.log(chalk.bold("Top Signals"));
      for (const signal of signals.slice(0, 8)) {
        if (!isRecord(signal)) continue;
        const pathValue = toPreview(signal.path, 80);
        const action = toPreview(signal.action, 40);
        const reason = toPreview(signal.reason, 80);
        console.log(`- ${pathValue}: ${action} (${reason})`);
      }
    }
  }

  console.log("");
  printJson(result);
}

function printChunkResult(
  chunkId: string,
  result: Record<string, unknown>,
): void {
  printKeyValue("Chunk:", chunkId);
  printCompactObject(result, [
    "title",
    "file_path",
    "path",
    "line_start",
    "line_end",
    "tokens",
  ]);
  console.log("");

  const content = result.content;
  if (typeof content === "string") {
    console.log(content.trim());
    return;
  }

  printJson(result);
}

function readSessionEntryPreview(entry: SessionMemoryEntry): string {
  for (const value of [entry.summary, entry.text, entry.content, entry.title]) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isRecord(parsed)) {
          const summary = stringValue(parsed.summary);
          const nextStep = stringValue(parsed.nextStep);
          const task = stringValue(parsed.task);
          const readable = [
            summary,
            nextStep ? `Next: ${nextStep}` : undefined,
            task,
          ]
            .filter((item): item is string => Boolean(item))
            .join(" ");
          if (readable.length > 0) {
            return toPreview(readable, 220);
          }
        }
      } catch {
        // Fall back to the raw preview below.
      }
    }
    if (trimmed.length > 0) {
      return toPreview(trimmed, 220);
    }
  }
  return toPreview(
    entry.text ?? entry.content ?? entry.summary ?? entry.title,
    220,
  );
}

function compactSessionEntryLine(entry: SessionMemoryEntry): string {
  const label =
    typeof entry.type === "string" && entry.type.trim().length > 0
      ? entry.type.trim()
      : typeof entry.category === "string" && entry.category.trim().length > 0
        ? entry.category.trim()
        : "memory";
  return `- ${label}: ${readSessionEntryPreview(entry)}`;
}

function printSessionBootstrap(
  result: SessionMemoriesResult,
  options: { includeSessionContext: boolean; maxTokens?: number },
): SessionBootstrapBrief | null {
  const brief = buildSessionBootstrapBrief(result, {
    includeSessionContext: options.includeSessionContext,
    maxTokens: options.maxTokens,
  });
  const entries = brief.entries;

  if (entries.length === 0) {
    return null;
  }

  console.log(chalk.bold("Snipara Bootstrap Brief"));
  for (const entry of entries) {
    console.log(compactSessionEntryLine(entry));
  }
  console.log("");
  return brief;
}

function buildPrintedBootstrapQuality(
  brief: SessionBootstrapBrief,
  now?: Date,
): SessionBootstrapQualityReport {
  return buildSessionBootstrapQuality(
    {
      critical: {
        memories: brief.entries,
        count: brief.entries.length,
        tokens: brief.estimatedTokens,
      },
      daily: { memories: [], count: 0, tokens: 0 },
      total_tokens: brief.estimatedTokens,
    },
    { expectedMaxTokens: brief.budgetTokens, now },
  );
}

function printSessionBootstrapQuality(
  report: SessionBootstrapQualityReport,
): void {
  if (report.warnings.length === 0) {
    return;
  }

  console.log(chalk.bold("Bootstrap Quality Warnings"));
  for (const warning of report.warnings) {
    console.log(`- ${warning}`);
  }
  console.log("");
}

function printPlanQualityWarnings(report: PlanQualityReport): void {
  if (report.warnings.length === 0) {
    return;
  }

  console.log(chalk.bold("Plan Quality Warnings"));
  for (const warning of report.warnings) {
    console.log(`- ${warning}`);
  }
  console.log("");
}

function printTaskCommitResult(result: Record<string, unknown>): void {
  printKeyValue("Tool:", "snipara_end_of_task_commit");
  printCompactObject(result, ["stored", "skipped", "status", "message"]);
  const handoff = isRecord(result.team_sync_handoff)
    ? result.team_sync_handoff
    : null;
  if (handoff) {
    const status =
      typeof handoff.status === "string" ? handoff.status : "unknown";
    const memoryId =
      typeof handoff.memory_id === "string" ? ` (${handoff.memory_id})` : "";
    printKeyValue("Team Sync handoff:", `${status}${memoryId}`);
  }
  console.log("");
  printJson(result);
}

function printFinalCommitHandoffResult(result: Record<string, unknown>): void {
  printKeyValue("Tool:", "snipara_end_of_task_commit");
  printCompactObject(result, ["stored", "skipped", "status", "message"]);
  const handoff = isRecord(result.team_sync_handoff)
    ? result.team_sync_handoff
    : null;
  if (handoff) {
    const status =
      typeof handoff.status === "string" ? handoff.status : "unknown";
    const memoryId =
      typeof handoff.memory_id === "string" ? ` (${handoff.memory_id})` : "";
    printKeyValue("Team Sync handoff:", `${status}${memoryId}`);
  }
  console.log("");
}

function printMultiQueryResult(result: unknown, queries: string[]): void {
  printKeyValue("Tool:", "snipara_multi_query");
  printKeyValue("Queries:", queries.length);
  console.log("");

  if (Array.isArray(result)) {
    result.forEach((entry, index) => {
      console.log(chalk.bold(`Query ${index + 1}`));
      printKeyValue("Input:", queries[index] || "n/a");
      if (isRecord(entry)) {
        printCompactObject(entry, [
          "query",
          "total_tokens",
          "max_tokens",
          "answer",
          "summary",
        ]);
        const sections = entry.sections;
        if (Array.isArray(sections)) {
          printKeyValue("Sections:", sections.length);
        }
      } else {
        printKeyValue("Result:", toPreview(entry));
      }
      console.log("");
    });
    return;
  }

  if (isRecord(result)) {
    const responses = Array.isArray(result.responses)
      ? result.responses
      : Array.isArray(result.results)
        ? result.results
        : null;

    if (responses) {
      responses.forEach((entry, index) => {
        console.log(chalk.bold(`Query ${index + 1}`));
        printKeyValue("Input:", queries[index] || "n/a");
        if (isRecord(entry)) {
          printCompactObject(entry, [
            "query",
            "total_tokens",
            "max_tokens",
            "answer",
            "summary",
          ]);
          const sections = entry.sections;
          if (Array.isArray(sections)) {
            printKeyValue("Sections:", sections.length);
          }
        } else {
          printKeyValue("Result:", toPreview(entry));
        }
        console.log("");
      });
      return;
    }

    printCompactObject(result, ["query_count", "total_tokens", "summary"]);
  }

  printJson(result);
}

function printOrchestrateResult(result: unknown): void {
  printKeyValue("Tool:", "snipara_orchestrate");
  console.log("");

  if (!isRecord(result)) {
    printJson(result);
    return;
  }

  printCompactObject(result, ["query", "summary", "total_tokens"]);

  const files = Array.isArray(result.files) ? result.files : [];
  const sections = Array.isArray(result.sections) ? result.sections : [];
  if (files.length > 0) {
    printKeyValue("Files:", files.length);
  }
  if (sections.length > 0) {
    printKeyValue("Sections:", sections.length);
  }
  console.log("");

  if (files.length > 0) {
    console.log(chalk.bold("Selected Files"));
    for (const file of files.slice(0, 8)) {
      if (typeof file === "string") {
        console.log(file);
        continue;
      }
      if (isRecord(file)) {
        console.log(toPreview(file.path ?? file.file ?? file.title));
      }
    }
    console.log("");
  }

  if (sections.length > 0) {
    console.log(chalk.bold("Top Sections"));
    for (const section of sections.slice(0, 5)) {
      if (!isRecord(section)) continue;
      console.log(chalk.bold(toPreview(section.title ?? "Untitled")));
      printCompactObject(section, [
        "file",
        "file_path",
        "score",
        "relevance_score",
      ]);
      const content = section.content;
      if (content !== undefined) {
        console.log(toPreview(content, 220));
      }
      console.log("");
    }
    return;
  }

  printJson(result);
}

function printLoadDocumentResult(path: string, result: unknown): void {
  printKeyValue("Tool:", "snipara_load_document");
  printKeyValue("Path:", path);
  console.log("");

  if (typeof result === "string") {
    console.log(result.trim());
    return;
  }

  if (!isRecord(result)) {
    printJson(result);
    return;
  }

  printCompactObject(result, ["path", "title", "token_count", "line_count"]);
  console.log("");

  const content = result.content;
  if (typeof content === "string") {
    console.log(content.trim());
    return;
  }

  printJson(result);
}

function printRecallResult(result: RecallResult): void {
  printKeyValue("Tool:", "snipara_recall");
  printKeyValue("Query:", result.query);
  printKeyValue("Memories:", result.memories.length);
  printKeyValue("Searched:", result.total_searched);
  printKeyValue("Timing:", `${result.timing_ms}ms`);
  console.log("");

  if (result.memories.length > 0) {
    console.log(chalk.bold("Durable Memory Matches"));
    for (const memory of result.memories.slice(0, 8)) {
      const meta = [memory.type, memory.scope, memory.category]
        .filter(Boolean)
        .join(" · ");
      console.log(chalk.bold(toPreview(memory.content, 180)));
      if (meta.length > 0) {
        printKeyValue("Meta:", meta);
      }
      printKeyValue(
        "Scores:",
        `relevance ${memory.relevance.toFixed(2)} · confidence ${memory.confidence.toFixed(2)}`,
      );
      if (memory.status !== "ACTIVE") {
        printKeyValue("Status:", memory.status);
      }
      console.log("");
    }
  }

  if (result.warnings.length > 0) {
    console.log(chalk.bold("Lifecycle Warnings"));
    for (const warning of result.warnings.slice(0, 5)) {
      const reason = warning.reason ? ` (${warning.reason})` : "";
      console.log(
        `- ${warning.status}: ${toPreview(warning.content, 140)}${reason}`,
      );
    }
    console.log("");
  }

  if (result.memories.length === 0 && result.warnings.length === 0) {
    printJson(result);
  }
}

export async function queryCommand(options: {
  query: string;
  maxTokens?: number;
  searchMode?: string;
  includeAnswerPack?: boolean;
  autoDecompose?: boolean;
  includeSharedContext?: boolean;
  timeoutMs?: number;
  json?: boolean;
  followRecommendation?: boolean;
}): Promise<void> {
  ensureConfigured();

  const searchMode = options.searchMode ?? "hybrid";
  if (!( ["keyword", "semantic", "hybrid"] as const).includes(searchMode as never)) {
    throw new Error("--search-mode must be keyword, semantic, or hybrid");
  }
  const timeoutMs = Math.max(
    1_000,
    Math.min(options.timeoutMs ?? 30_000, 120_000),
  );
  const client = createClient(timeoutMs);
  const result = await client.queryContext(
    options.query,
    options.maxTokens || 8000,
    {
      searchMode: searchMode as "keyword" | "semantic" | "hybrid",
      includeAnswerPack: options.includeAnswerPack,
      autoDecompose: options.autoDecompose,
      includeSharedContext: options.includeSharedContext,
    },
  );
  const recommendedExecution =
    options.followRecommendation && result.recommended_tool
      ? await runRecommendedTool(result)
      : null;
  if (options.json) {
    printJson(
      recommendedExecution
        ? {
            ...result,
            executed_recommended_tool: recommendedExecution.toolName,
            executed_recommended_tool_arguments: recommendedExecution.args,
            executed_recommended_tool_result: recommendedExecution.result,
          }
        : result,
    );
    return;
  }
  printQueryResult(result);
  if (recommendedExecution) {
    printRecommendedToolExecution(recommendedExecution);
  }
}

export async function planCommand(options: {
  query: string;
  maxTokens?: number;
  writePlanFile?: string;
  startWorkflow?: boolean;
  workflowId?: string;
  force?: boolean;
  json?: boolean;
}): Promise<void> {
  ensureConfigured();

  const client = createClient(15000);
  const result = await client.plan(options.query, options.maxTokens);
  const quality = validatePlanResult(result);
  const payload: Record<string, unknown> = {
    plan: result,
    plan_quality: quality,
  };

  if (quality.valid) {
    if (options.writePlanFile || options.startWorkflow) {
      const planFile = writeGeneratedWorkflowPlanFile(
        result,
        options.query,
        options.writePlanFile,
      );
      payload.generated_plan_file = planFile;
      if (options.startWorkflow) {
        const state = await publishWorkflowStartCoordination(
          startManagedWorkflowState({
            goal: options.query,
            planFile: planFile.path,
            id: options.workflowId,
            force: options.force,
          }),
          inferWorkflowCoordinationMode({ planFile: planFile.path }),
        );
        payload.managed_workflow = state;
      }
    }
  } else {
    payload.plan_error = {
      code: "invalid_plan",
      retryable: true,
      message: "Hosted planner returned an invalid or incomplete plan.",
      issues: quality.issues,
    };
  }

  if (options.json) {
    printJson(
      options.writePlanFile || options.startWorkflow ? payload : result,
    );
    return;
  }
  printPlanResult(result);
  if (payload.generated_plan_file) {
    printGeneratedPlanFile(
      payload.generated_plan_file as WrittenGeneratedPlanFile,
    );
  }
  if (payload.managed_workflow) {
    printManagedWorkflowStarted(
      payload.managed_workflow as ManagedWorkflowState,
    );
  }
}

export async function uploadCommand(options: {
  path: string;
  file?: string;
  content?: string;
  kind?: string;
  format?: string;
  language?: string;
  metadata?: string;
  metadataFile?: string;
  assetClass?: string;
  usageMode?: string;
  sourceKind?: string;
  clientId?: string;
  sourceModifiedAt?: string;
  sourceSnapshotAt?: string;
  reindex?: boolean;
  reindexKind?: "doc" | "code";
  reindexMode?: "incremental" | "full";
  json?: boolean;
}): Promise<void> {
  ensureConfigured();

  const inferred =
    inferDocumentFormat(options.path) ??
    (options.file ? inferDocumentFormat(options.file) : undefined);
  const kind = normalizeDocumentKind(options.kind) ?? inferred?.kind;
  const format = normalizeDocumentFormat(options.format) ?? inferred?.format;
  const content =
    options.content ??
    (options.file
      ? kind === "BINARY"
        ? `base64:${fs.readFileSync(options.file).toString("base64")}`
        : fs.readFileSync(options.file, "utf-8")
      : undefined);

  if (!content) {
    throw new Error("Provide either --content or --file");
  }

  const metadata = collectUploadMetadata(options);
  const client = createClient(30000);
  const result = await client.uploadDocument(options.path, content, {
    ...(kind ? { kind } : {}),
    ...(format ? { format } : {}),
    ...(options.language ? { language: options.language } : {}),
    ...(metadata ? { metadata } : {}),
  });
  const reindexResult = options.reindex
    ? await client.reindex({
        kind: options.reindexKind ?? "doc",
        mode: options.reindexMode ?? "incremental",
      })
    : undefined;

  if (options.json) {
    printJson(
      reindexResult ? { upload: result, reindex: reindexResult } : result,
    );
    return;
  }
  printUploadResult(options.path, result);
  if (reindexResult) {
    printReindexResult(reindexResult);
  }
}

export async function businessCollectionsListCommand(options: {
  includeCustom?: boolean;
  noMissingPresets?: boolean;
  json?: boolean;
}): Promise<void> {
  ensureConfigured();

  const client = createClient(15000);
  const result = await client.listBusinessCollections({
    includeCustom: Boolean(options.includeCustom),
    includeMissingPresets: !options.noMissingPresets,
  });
  if (options.json) {
    printJson(result);
    return;
  }
  printKeyValue("Tool:", "snipara_list_business_collections");
  const collections = Array.isArray(result.collections)
    ? result.collections
    : [];
  printKeyValue("Collections:", collections.length);
  for (const collection of collections) {
    if (!isRecord(collection)) continue;
    console.log(
      `- ${collection.name ?? collection.slug} (${collection.slug}) · ${
        collection.document_count ?? 0
      } docs`,
    );
  }
  const missing = Array.isArray(result.missing_presets)
    ? result.missing_presets
    : [];
  if (missing.length > 0) {
    console.log("");
    printKeyValue("Missing presets:", missing.length);
    for (const preset of missing) {
      if (isRecord(preset)) {
        console.log(`- ${preset.preset ?? preset.slug} (${preset.slug})`);
      }
    }
  }
}

export async function businessCollectionEnsureCommand(options: {
  preset?: string;
  name?: string;
  slug?: string;
  description?: string;
  json?: boolean;
}): Promise<void> {
  ensureConfigured();

  const client = createClient(20000);
  const result = await client.ensureBusinessCollection({
    preset: normalizeBusinessCollectionPreset(options.preset),
    name: options.name,
    slug: options.slug,
    description: options.description,
  });
  if (options.json) {
    printJson(result);
    return;
  }
  printKeyValue("Tool:", "snipara_ensure_business_collection");
  printCompactObject(result, [
    "message",
    "action",
    "name",
    "slug",
    "collection_id",
  ]);
  console.log("");
  printJson(result);
}

export async function businessCollectionUploadCommand(options: {
  collectionId?: string;
  preset?: string;
  collectionSlug?: string;
  title: string;
  file?: string;
  content?: string;
  category?: "MANDATORY" | "BEST_PRACTICES" | "GUIDELINES" | "REFERENCE";
  tags?: string;
  priority?: number;
  allowCustomCollection?: boolean;
  json?: boolean;
}): Promise<void> {
  ensureConfigured();

  const content =
    options.content ??
    (options.file ? fs.readFileSync(options.file, "utf-8") : undefined);
  if (!content) {
    throw new Error("Provide either --content or --file");
  }

  const client = createClient(30000);
  const result = await client.uploadBusinessDocument({
    collectionId: options.collectionId,
    preset: normalizeBusinessCollectionPreset(options.preset),
    collectionSlug: options.collectionSlug,
    title: options.title,
    content,
    category: options.category,
    tags: parseCsv(options.tags),
    priority: options.priority,
    allowCustomCollection: options.allowCustomCollection,
  });

  if (options.json) {
    printJson(result);
    return;
  }
  printKeyValue("Tool:", "snipara_upload_business_document");
  printCompactObject(result, [
    "message",
    "action",
    "collection_name",
    "document_id",
    "slug",
    "token_count",
  ]);
  console.log("");
  printJson(result);
}

export async function clientProjectsListCommand(options: {
  includeInternal?: boolean;
  limit?: number;
  json?: boolean;
}): Promise<void> {
  ensureConfigured();

  const client = createClient(15000);
  const result = await client.listClientProjects({
    includeInternal: options.includeInternal,
    limit: options.limit,
  });
  if (options.json) {
    printJson(result);
    return;
  }
  printKeyValue("Tool:", "snipara_list_client_projects");
  const projects = Array.isArray(result.projects) ? result.projects : [];
  printKeyValue("Projects:", projects.length);
  for (const project of projects) {
    if (!isRecord(project)) continue;
    console.log(
      `- ${project.name ?? project.slug} (${project.slug}) · ${project.scope}`,
    );
  }
}

export async function clientProjectCreateCommand(options: {
  name: string;
  slug?: string;
  description?: string;
  externalClientId?: string;
  json?: boolean;
}): Promise<void> {
  ensureConfigured();

  const client = createClient(20000);
  const result = await client.createClientProject({
    name: options.name,
    slug: options.slug,
    description: options.description,
    externalClientId: options.externalClientId,
  });
  if (options.json) {
    printJson(result);
    return;
  }
  printKeyValue("Tool:", "snipara_create_client_project");
  printCompactObject(result, [
    "message",
    "action",
    "name",
    "slug",
    "project_id",
  ]);
  console.log("");
  printJson(result);
}

function normalizeSyncDocumentsPayload(
  payload: unknown,
): CollectedSyncDocuments {
  const rawDocuments = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.documents)
      ? payload.documents
      : undefined;

  if (!rawDocuments) {
    throw new Error(
      "Sync payload must be an array or an object with a documents array",
    );
  }

  const manifestRecord =
    isRecord(payload) && !Array.isArray(payload) ? payload : {};
  const defaults = isRecord(manifestRecord.defaults)
    ? manifestRecord.defaults
    : {};
  const metadataDefaults = mergeRecords(
    isRecord(defaults.metadata) ? defaults.metadata : undefined,
    isRecord(manifestRecord.metadataDefaults)
      ? manifestRecord.metadataDefaults
      : undefined,
    isRecord(manifestRecord.metadata) ? manifestRecord.metadata : undefined,
  );

  const documents = rawDocuments.map((item, index) => {
    if (
      !isRecord(item) ||
      typeof item.path !== "string" ||
      typeof item.content !== "string"
    ) {
      throw new Error(
        `Invalid document at index ${index}: expected { path, content }`,
      );
    }
    const metadata = mergeRecords(
      metadataDefaults,
      isRecord(item.metadata) ? item.metadata : {},
    );
    const inferred = inferDocumentFormat(item.path);
    const kind = normalizeDocumentKind(item.kind) ?? inferred?.kind;
    const format = normalizeDocumentFormat(item.format) ?? inferred?.format;
    const language = stringValue(item.language) ?? undefined;
    return {
      path: item.path,
      content: item.content,
      ...(kind ? { kind } : {}),
      ...(format ? { format } : {}),
      ...(language ? { language } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
  });

  return {
    documents,
    manifestOptions: {
      metadataDefaults,
      deleteMissing: optionalBoolean(
        manifestRecord.deleteMissing ?? manifestRecord.delete_missing,
      ),
      dryRun: optionalBoolean(manifestRecord.dryRun ?? manifestRecord.dry_run),
      reindex: optionalBoolean(manifestRecord.reindex),
      reindexKind: optionalReindexKind(
        manifestRecord.reindexKind ?? manifestRecord.reindex_kind,
      ),
      reindexMode: optionalReindexMode(
        manifestRecord.reindexMode ?? manifestRecord.reindex_mode,
      ),
    },
  };
}

function toUploadPath(
  filePath: string,
  rootDir: string,
  prefix?: string,
): string {
  const relative = path.relative(rootDir, filePath).split(path.sep).join("/");
  const trimmedPrefix = prefix?.replace(/^\/+|\/+$/g, "");
  return trimmedPrefix ? `${trimmedPrefix}/${relative}` : relative;
}

function collectDirectoryDocuments(options: {
  dir: string;
  prefix?: string;
  recursive?: boolean;
}): SyncDocumentInput[] {
  const rootDir = path.resolve(options.dir);
  const documents: SyncDocumentInput[] = [];

  function visit(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (options.recursive) {
          visit(entryPath);
        }
        continue;
      }
      if (
        !entry.isFile() ||
        !DEFAULT_SYNC_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        continue;
      }
      const documentFormat = inferDocumentFormat(entry.name);
      if (!documentFormat) {
        continue;
      }
      const rawContent = fs.readFileSync(entryPath);
      const content =
        documentFormat.kind === "BINARY"
          ? `base64:${rawContent.toString("base64")}`
          : rawContent.toString("utf-8");
      documents.push({
        path: toUploadPath(entryPath, rootDir, options.prefix),
        content,
        kind: documentFormat.kind,
        format: documentFormat.format,
      });
    }
  }

  visit(rootDir);
  documents.sort((a, b) => a.path.localeCompare(b.path));
  return documents;
}

export function collectSyncDocuments(options: {
  file?: string;
  dir?: string;
  prefix?: string;
  recursive?: boolean;
}): SyncDocumentInput[] {
  return collectSyncDocumentsInput(options).documents;
}

export function collectSyncDocumentsInput(options: {
  file?: string;
  dir?: string;
  prefix?: string;
  recursive?: boolean;
}): CollectedSyncDocuments {
  if (options.file && options.dir) {
    throw new Error("Use either --file or --dir, not both");
  }
  if (!options.file && !options.dir) {
    throw new Error("Provide either --file or --dir");
  }

  if (options.file) {
    const payload = JSON.parse(
      fs.readFileSync(options.file, "utf-8"),
    ) as unknown;
    return normalizeSyncDocumentsPayload(payload);
  }

  return {
    documents: collectDirectoryDocuments({
      dir: options.dir!,
      prefix: options.prefix,
      recursive: options.recursive,
    }),
    manifestOptions: {
      metadataDefaults: {},
    },
  };
}

const ONBOARD_IGNORED_DIRS = new Set([
  ".cache",
  ".git",
  ".hg",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".pnpm-store",
  ".pytest_cache",
  ".ruff_cache",
  ".svn",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "venv",
]);

const CODE_MARKER_FILES = new Set([
  "Cargo.toml",
  "Dockerfile",
  "Gemfile",
  "go.mod",
  "mix.exs",
  "package.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "pom.xml",
  "pyproject.toml",
  "requirements.txt",
  "tsconfig.json",
  "uv.lock",
  "yarn.lock",
]);

const CODE_MARKER_DIRS = new Set([
  "__tests__",
  "app",
  "apps",
  "components",
  "lib",
  "migrations",
  "packages",
  "prisma",
  "src",
  "test",
  "tests",
]);

const CODE_SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".swift",
  ".tsx",
  ".ts",
]);

const BUSINESS_MARKER_EXTENSIONS = new Set([
  ".adoc",
  ".csv",
  ".doc",
  ".docx",
  ".key",
  ".markdown",
  ".md",
  ".mdx",
  ".numbers",
  ".pdf",
  ".ppt",
  ".pptx",
  ".rst",
  ".svg",
  ".tsv",
  ".txt",
  ".vsdx",
  ".xls",
  ".xlsx",
]);

const BUSINESS_PATH_KEYWORDS = [
  "brief",
  "business",
  "case-study",
  "case_study",
  "client",
  "contract",
  "customer",
  "deliverable",
  "discovery",
  "meeting",
  "notes",
  "offer",
  "proposal",
  "reference",
  "sales",
  "sow",
  "strategy",
  "template",
];

const REPO_DOC_FILES = new Set([
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE.md",
  "README.md",
  "SECURITY.md",
]);

interface OnboardFolderFile extends OnboardFolderScannedFile {
  absolutePath: string;
  modifiedAt: string;
}

export interface OnboardFolderOptions {
  dir: string;
  recursive?: boolean;
  mode?: OnboardFolderMode;
  prefix?: string;
  usageMode?: string;
  sourceKind?: string;
  sourceProvider?: string;
  sourceUri?: string;
  clientId?: string;
  snapshotAt?: string;
  deleteMissing?: boolean;
  reindex?: boolean;
  reindexKind?: ReindexKind;
  reindexMode?: ReindexMode;
}

function normalizeOnboardFolderMode(value: unknown): OnboardFolderMode {
  const normalized =
    stringValue(value)?.replace(/[-\s]/g, "_").toLowerCase() ?? "auto";
  if (
    normalized === "auto" ||
    normalized === "business_context" ||
    normalized === "code_project" ||
    normalized === "mixed"
  ) {
    return normalized;
  }
  throw new Error(
    "Onboard mode must be one of: auto, business_context, code_project, mixed",
  );
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function firstPathSegment(filePath: string): string {
  return filePath.split("/")[0]?.toLowerCase() ?? "";
}

function hasBusinessKeyword(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return BUSINESS_PATH_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function isBusinessLookingFile(file: OnboardFolderScannedFile): boolean {
  return (
    BUSINESS_MARKER_EXTENSIONS.has(path.extname(file.path).toLowerCase()) ||
    hasBusinessKeyword(file.path)
  );
}

function scanOnboardFolder(options: {
  dir: string;
  recursive: boolean;
}): OnboardFolderFile[] {
  const rootDir = path.resolve(options.dir);
  if (!fs.existsSync(rootDir)) {
    throw new Error(`Directory does not exist: ${options.dir}`);
  }
  if (!fs.statSync(rootDir).isDirectory()) {
    throw new Error(`Expected a directory: ${options.dir}`);
  }

  const files: OnboardFolderFile[] = [];
  function visit(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (options.recursive && !ONBOARD_IGNORED_DIRS.has(entry.name)) {
          visit(path.join(directory, entry.name));
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const absolutePath = path.join(directory, entry.name);
      const stat = fs.statSync(absolutePath);
      const relativePath = toPosixPath(path.relative(rootDir, absolutePath));
      const format = inferDocumentFormat(entry.name);
      files.push({
        absolutePath,
        path: relativePath,
        size_bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        supported: Boolean(format),
        ...(format ? { kind: format.kind, format: format.format } : {}),
      });
    }
  }

  visit(rootDir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function addSignal(signals: string[], signal: string): void {
  if (!signals.includes(signal)) {
    signals.push(signal);
  }
}

function classifyOnboardFolder(
  rootDir: string,
  files: OnboardFolderFile[],
  overrideMode: OnboardFolderMode = "auto",
): OnboardFolderClassification {
  const codeSignals: string[] = [];
  const businessSignals: string[] = [];
  let codeScore = 0;
  let businessScore = 0;
  let codeSourceFiles = 0;
  let supportedPlainDocuments = 0;

  if (fs.existsSync(path.join(rootDir, ".git"))) {
    codeScore += 4;
    addSignal(codeSignals, ".git directory");
  }

  for (const file of files) {
    const base = path.basename(file.path);
    const ext = path.extname(file.path).toLowerCase();
    const firstSegment = firstPathSegment(file.path);

    if (CODE_MARKER_FILES.has(base)) {
      codeScore += 3;
      addSignal(codeSignals, base);
    }
    if (CODE_MARKER_DIRS.has(firstSegment)) {
      codeScore += 1.5;
      addSignal(codeSignals, `${firstSegment}/ directory`);
    }
    if (CODE_SOURCE_EXTENSIONS.has(ext)) {
      codeSourceFiles += 1;
    }

    if (
      [
        ".docx",
        ".pdf",
        ".pptx",
        ".vsdx",
        ".xlsx",
        ".xls",
        ".csv",
        ".tsv",
      ].includes(ext)
    ) {
      businessScore += 2;
      addSignal(businessSignals, `${ext} documents`);
    }
    if (hasBusinessKeyword(file.path)) {
      businessScore += 2;
      addSignal(businessSignals, `business keyword in ${file.path}`);
    }
    if (
      file.supported &&
      [".md", ".markdown", ".mdx", ".txt", ".rst", ".adoc"].includes(ext)
    ) {
      supportedPlainDocuments += 1;
    }
  }

  codeScore += Math.min(5, codeSourceFiles * 0.25);
  businessScore += Math.min(3, supportedPlainDocuments * 0.35);
  if (codeSourceFiles > 0) {
    addSignal(codeSignals, `${codeSourceFiles} source-looking files`);
  }
  if (supportedPlainDocuments > 0) {
    addSignal(
      businessSignals,
      `${supportedPlainDocuments} supported text documents`,
    );
  }

  const codeStrong = codeScore >= 3;
  const businessStrong =
    businessScore >= 2.5 ||
    (!codeStrong && files.some((file) => file.supported));
  let detectedMode: DetectedOnboardFolderMode = "unknown";
  if (codeStrong && businessStrong) {
    detectedMode = "mixed";
  } else if (codeStrong) {
    detectedMode = "code_project";
  } else if (businessStrong) {
    detectedMode = "business_context";
  }

  const totalScore = codeScore + businessScore;
  const confidence =
    detectedMode === "unknown"
      ? 0.25
      : detectedMode === "mixed"
        ? Math.min(
            0.92,
            0.58 + Math.min(codeScore, businessScore) / Math.max(totalScore, 1),
          )
        : Math.min(
            0.95,
            0.55 +
              Math.max(codeScore, businessScore) / Math.max(totalScore + 4, 1),
          );
  const mode = overrideMode === "auto" ? detectedMode : overrideMode;

  return {
    mode: mode as DetectedOnboardFolderMode,
    detected_mode: detectedMode,
    confidence: Number(confidence.toFixed(2)),
    code_score: Number(codeScore.toFixed(2)),
    business_score: Number(businessScore.toFixed(2)),
    signals: {
      code: codeSignals,
      business: businessSignals,
    },
  };
}

function inferBusinessAssetClass(file: OnboardFolderScannedFile): string {
  if (file.format === "pptx") {
    return "PRESENTATION";
  }
  if (file.format === "svg" || file.format === "vsdx") {
    return "DIAGRAM";
  }
  return "BUSINESS_DOCUMENT";
}

function inferOnboardContextLane(
  file: OnboardFolderScannedFile,
  mode: DetectedOnboardFolderMode,
): "business_context" | "repo_docs" {
  if (mode === "business_context") {
    return "business_context";
  }
  if (mode === "code_project") {
    return "repo_docs";
  }
  if (hasBusinessKeyword(file.path)) {
    return "business_context";
  }
  if (REPO_DOC_FILES.has(path.basename(file.path))) {
    return "repo_docs";
  }
  const ext = path.extname(file.path).toLowerCase();
  if ([".docx", ".pdf", ".pptx", ".vsdx"].includes(ext)) {
    return "business_context";
  }
  if (CODE_MARKER_DIRS.has(firstPathSegment(file.path))) {
    return "repo_docs";
  }
  return "business_context";
}

function buildOnboardSyncManifestPayload(
  result: OnboardFolderManifest,
): Record<string, unknown> {
  return {
    dryRun: true,
    reindex: result.sync.reindex,
    reindexKind: result.sync.reindexKind,
    reindexMode: result.sync.reindexMode,
    deleteMissing: result.sync.deleteMissing,
    metadata: result.sync.metadata,
    documents: result.sync.documents,
    onboarding: {
      schemaVersion: result.schemaVersion,
      source: result.source,
      classification: result.classification,
      summary: result.summary,
      warnings: result.warnings,
    },
  };
}

export function buildOnboardFolderManifest(
  options: OnboardFolderOptions,
): OnboardFolderManifest {
  const rootDir = path.resolve(options.dir);
  const recursive = options.recursive ?? true;
  const files = scanOnboardFolder({ dir: rootDir, recursive });
  const modeOverride = normalizeOnboardFolderMode(options.mode);
  const classification = classifyOnboardFolder(rootDir, files, modeOverride);
  const sourceKind = options.sourceKind ?? "local_agent";
  const sourceProvider = options.sourceProvider ?? "local_folder";
  const snapshotDate = options.snapshotAt
    ? parseIsoDate(options.snapshotAt)
    : new Date();
  if (!snapshotDate) {
    throw new Error("--snapshot-at must be a valid ISO date");
  }
  const snapshotAt = snapshotDate.toISOString();
  const usageMode =
    normalizeUsageMode(options.usageMode ?? "current_truth") ?? "current_truth";
  const supportedFiles = files.filter((file) => file.supported);
  const ignoredFiles = files.filter((file) => !file.supported);
  const unsupportedBusinessFiles = ignoredFiles.filter(isBusinessLookingFile);
  const extractionMethod =
    sourceProvider === "local_folder"
      ? "local_folder_scan"
      : "llm_client_connector";

  const metadataDefaults = mergeRecords(
    {
      sourceKind,
      sourceProvider,
      sourceSnapshotAt: snapshotAt,
      extractionMethod,
      onboardedBy: "snipara-companion",
      detectedContextMode: classification.mode,
      detectedContextConfidence: classification.confidence,
    },
    options.sourceUri ? { sourceUri: options.sourceUri } : undefined,
    options.clientId ? { clientId: options.clientId } : undefined,
  );

  const documents = supportedFiles.map((file) => {
    const rawContent = fs.readFileSync(file.absolutePath);
    const content =
      file.kind === "BINARY"
        ? `base64:${rawContent.toString("base64")}`
        : rawContent.toString("utf-8");
    const lane = inferOnboardContextLane(file, classification.mode);
    const metadata = mergeRecords(metadataDefaults, {
      contextLane: lane,
      sourcePath: file.path,
      sourceModifiedAt: file.modifiedAt,
      sourceContentHash: `sha256:${hashContent(content)}`,
      sourceSizeBytes: file.size_bytes,
      ...(lane === "business_context"
        ? {
            assetClass: inferBusinessAssetClass(file),
            usageMode,
          }
        : {}),
    });

    return {
      path: toUploadPath(file.absolutePath, rootDir, options.prefix),
      content,
      ...(file.kind ? { kind: file.kind } : {}),
      ...(file.format ? { format: file.format } : {}),
      metadata,
    };
  });

  const warnings: string[] = [];
  if (classification.mode === "unknown") {
    warnings.push(
      "Could not confidently classify this folder; review the manifest before applying.",
    );
  }
  if (classification.detected_mode !== classification.mode) {
    warnings.push(
      `Mode override applied: detected ${classification.detected_mode}, using ${classification.mode}.`,
    );
  }
  if (classification.mode === "code_project") {
    warnings.push(
      "This looks like a code project. onboard-folder is business-first and only uploads supported documents; use the GitHub OAuth/code onboarding flow for source-code indexing.",
    );
  }
  if (classification.mode === "mixed") {
    warnings.push(
      "This folder looks mixed. Review per-document contextLane metadata before applying.",
    );
  }
  if (unsupportedBusinessFiles.length > 0) {
    warnings.push(
      `${unsupportedBusinessFiles.length} business-looking files are ignored because their formats are not supported by snipara_sync_documents yet.`,
    );
  }
  if (documents.length === 0) {
    warnings.push("No supported Snipara documents were found to sync.");
  }

  const deleteMissing = options.deleteMissing ?? false;
  const reindex = options.reindex ?? true;
  const reindexKind = options.reindexKind ?? "doc";
  const reindexMode = options.reindexMode ?? "incremental";
  const dryRun = buildSyncDocumentsDryRun(documents, {
    deleteMissing,
    reindex,
    reindexKind,
    reindexMode,
  });

  return {
    schemaVersion: "snipara.onboard-folder.v1",
    source: {
      root: rootDir,
      sourceKind,
      sourceProvider,
      ...(options.sourceUri ? { sourceUri: options.sourceUri } : {}),
      snapshotAt,
      recursive,
    },
    classification,
    summary: {
      total_files: files.length,
      supported_documents: documents.length,
      ignored_files: ignoredFiles.length,
      unsupported_business_files: unsupportedBusinessFiles.length,
    },
    warnings,
    ignored: ignoredFiles.map((file) => ({
      path: file.path,
      size_bytes: file.size_bytes,
      supported: file.supported,
      ...(file.kind ? { kind: file.kind } : {}),
      ...(file.format ? { format: file.format } : {}),
    })),
    sync: {
      dryRun: true,
      reindex,
      reindexKind,
      reindexMode,
      deleteMissing,
      metadata: metadataDefaults,
      documents,
    },
    dryRun,
  };
}

function normalizeUsageMode(value: unknown): string | undefined {
  const normalized = normalizeEnum(value);
  if (!normalized) {
    return undefined;
  }
  return BUSINESS_USAGE_ALIASES[normalized];
}

function hasReferenceProvenance(metadata: Record<string, unknown>): boolean {
  const referenceProvenance =
    metadata.referenceProvenance ?? metadata.reference_provenance;
  if (isRecord(referenceProvenance)) {
    return Object.values(referenceProvenance).some((value) =>
      Boolean(stringValue(value)),
    );
  }
  return [
    metadata.clientId,
    metadata.client_id,
    metadata.sourceClientId,
    metadata.source_client_id,
    metadata.derivedFrom,
    metadata.derived_from,
  ].some(Boolean);
}

function validateFreshnessPolicy(
  metadata: Record<string, unknown>,
  reasons: string[],
): {
  maxAgeDays: number | undefined;
} {
  const policyValue = metadata.freshnessPolicy ?? metadata.freshness_policy;
  if (policyValue === undefined) {
    return { maxAgeDays: undefined };
  }
  if (!isRecord(policyValue)) {
    reasons.push("invalid_freshness_policy");
    return { maxAgeDays: undefined };
  }

  const maxAge = policyValue.maxAgeDays ?? policyValue.max_age_days;
  if (maxAge === undefined) {
    return { maxAgeDays: undefined };
  }
  const parsed = typeof maxAge === "number" ? maxAge : Number(maxAge);
  if (!Number.isInteger(parsed) || parsed < 1) {
    reasons.push("invalid_freshness_policy_max_age_days");
    return { maxAgeDays: undefined };
  }
  return { maxAgeDays: parsed };
}

function validateDocumentForDryRun(
  document: SyncDocumentInput,
  now: Date,
): SyncDocumentsDryRunItem {
  const metadata = isRecord(document.metadata) ? document.metadata : {};
  const inferred = inferDocumentFormat(document.path);
  const kind = document.kind ?? inferred?.kind;
  const format = document.format ?? inferred?.format;
  const reasons: string[] = [];
  const reviewReasons: string[] = [];
  const reuploadReasons: string[] = [];

  const assetClass = stringValue(metadata.assetClass ?? metadata.asset_class);
  if (!isSupportedDocumentFormat(kind, format)) {
    reasons.push("invalid_document_format");
  }
  if (kind === "BINARY" && !isBinaryPayload(document.content)) {
    reasons.push("binary_content_must_be_base64");
  }
  if (assetClass && !BUSINESS_ASSET_CLASSES.has(normalizeEnum(assetClass))) {
    reasons.push("invalid_asset_class");
  }

  const usageModeRaw =
    metadata.usageMode ?? metadata.usage_mode ?? metadata.contextRole;
  const usageMode = normalizeUsageMode(usageModeRaw);
  if (usageModeRaw !== undefined && !usageMode) {
    reasons.push("invalid_usage_mode");
  }

  const sourceKind = stringValue(metadata.sourceKind ?? metadata.source_kind);
  if (sourceKind && !SOURCE_KINDS.has(sourceKind)) {
    reasons.push("invalid_source_kind");
  }

  const { maxAgeDays } = validateFreshnessPolicy(metadata, reasons);
  const sourceModifiedAtRaw =
    metadata.sourceModifiedAt ?? metadata.source_modified_at;
  const sourceSnapshotAtRaw =
    metadata.sourceSnapshotAt ?? metadata.source_snapshot_at;
  const sourceModifiedAt = parseIsoDate(sourceModifiedAtRaw);
  const sourceSnapshotAt = parseIsoDate(sourceSnapshotAtRaw);
  const sourceHash = stringValue(
    metadata.sourceContentHash ?? metadata.source_content_hash,
  );
  const latestHash = stringValue(
    metadata.latestSourceContentHash ??
      metadata.currentSourceContentHash ??
      metadata.manifestSourceContentHash,
  );

  if (sourceModifiedAtRaw !== undefined && !sourceModifiedAt) {
    reasons.push("invalid_source_modified_at");
  }
  if (sourceSnapshotAtRaw !== undefined && !sourceSnapshotAt) {
    reasons.push("invalid_source_snapshot_at");
  }

  if (
    usageMode === "current_truth" &&
    !sourceModifiedAt &&
    !sourceSnapshotAt &&
    !sourceHash
  ) {
    reviewReasons.push("missing_source_metadata");
  }

  if (
    usageMode === "historical_reference" &&
    !hasReferenceProvenance(metadata)
  ) {
    reviewReasons.push("missing_reference_provenance");
  }

  const effectiveMaxAgeDays =
    maxAgeDays ?? (usageMode === "current_truth" ? 30 : undefined);
  if (sourceSnapshotAt && effectiveMaxAgeDays !== undefined) {
    const daysSinceSnapshot = Math.max(
      0,
      Math.floor(
        (now.getTime() - sourceSnapshotAt.getTime()) / (1000 * 60 * 60 * 24),
      ),
    );
    if (daysSinceSnapshot > effectiveMaxAgeDays) {
      reuploadReasons.push("source_snapshot_expired");
    }
  }
  if (
    sourceModifiedAt &&
    sourceSnapshotAt &&
    sourceModifiedAt > sourceSnapshotAt
  ) {
    reuploadReasons.push("source_modified_after_upload");
  }
  if (sourceHash && latestHash && sourceHash !== latestHash) {
    reuploadReasons.push("source_hash_changed");
  }

  const allReasons = [...reasons, ...reuploadReasons, ...reviewReasons];
  const recommendedAction =
    reuploadReasons.length > 0
      ? "reupload"
      : reviewReasons.length > 0
        ? "review_source_metadata"
        : "none";

  return {
    path: document.path,
    status: reasons.length > 0 ? "invalid_metadata" : "valid",
    recommended_action: recommendedAction,
    reasons: allReasons,
    ...(kind ? { kind } : {}),
    ...(format ? { format } : {}),
    size_bytes: contentBufferForHash(document.content).byteLength,
    content_hash: hashContent(document.content),
    ...(assetClass ? { assetClass: normalizeEnum(assetClass) } : {}),
    ...(usageMode ? { usageMode } : {}),
    ...(sourceKind ? { sourceKind } : {}),
  };
}

export function buildSyncDocumentsDryRun(
  documents: SyncDocumentInput[],
  options: {
    deleteMissing?: boolean;
    reindex?: boolean;
    reindexKind?: ReindexKind;
    reindexMode?: ReindexMode;
    now?: Date;
  } = {},
): SyncDocumentsDryRunSummary {
  const now = options.now ?? new Date();
  const items = documents.map((document) =>
    validateDocumentForDryRun(document, now),
  );
  const invalidMetadata = items.filter(
    (item) => item.status === "invalid_metadata",
  ).length;
  const needsReupload = items.filter(
    (item) => item.recommended_action === "reupload",
  ).length;
  const needsMetadataReview = items.filter(
    (item) => item.recommended_action === "review_source_metadata",
  ).length;
  const stale = items.filter((item) =>
    item.reasons.some((reason) => REUPLOAD_REASONS.has(reason)),
  ).length;

  return {
    dry_run: true,
    remote_diff_available: false,
    total: documents.length,
    would_sync: documents.length - invalidMetadata,
    invalid_metadata: invalidMetadata,
    stale,
    needs_reupload: needsReupload,
    needs_metadata_review: needsMetadataReview,
    delete_missing: Boolean(options.deleteMissing),
    reindex_requested: Boolean(options.reindex),
    reindex_kind: options.reindexKind ?? "doc",
    reindex_mode: options.reindexMode ?? "incremental",
    created: null,
    updated: null,
    unchanged: null,
    missing_from_manifest: null,
    note: "Local dry-run validates payload shape and business-context freshness metadata only. Remote created/updated/unchanged diff is unavailable without syncing.",
    documents: items,
  };
}

export async function syncDocumentsCommand(options: {
  file?: string;
  dir?: string;
  prefix?: string;
  recursive?: boolean;
  deleteMissing?: boolean;
  dryRun?: boolean;
  reindex?: boolean;
  reindexKind?: ReindexKind;
  reindexMode?: ReindexMode;
  json?: boolean;
}): Promise<void> {
  const collected = collectSyncDocumentsInput(options);
  const documents = collected.documents;
  if (documents.length === 0) {
    throw new Error(
      `No supported documents found to sync (${[...DEFAULT_SYNC_EXTENSIONS].sort().join(", ")})`,
    );
  }

  const deleteMissing =
    options.deleteMissing ?? collected.manifestOptions.deleteMissing ?? false;
  const dryRun = options.dryRun ?? collected.manifestOptions.dryRun ?? false;
  const reindex = options.reindex ?? collected.manifestOptions.reindex ?? false;
  const reindexKind =
    options.reindexKind ?? collected.manifestOptions.reindexKind ?? "doc";
  const reindexMode =
    options.reindexMode ??
    collected.manifestOptions.reindexMode ??
    "incremental";

  if (dryRun) {
    const result = buildSyncDocumentsDryRun(documents, {
      deleteMissing,
      reindex,
      reindexKind,
      reindexMode,
    });
    if (options.json) {
      printJson(result);
      return;
    }
    printSyncDocumentsDryRun(result);
    return;
  }

  ensureConfigured();

  const client = createClient(30000);
  const result = await client.syncDocuments(documents, deleteMissing);
  const reindexResult = reindex
    ? await client.reindex({
        kind: reindexKind,
        mode: reindexMode,
      })
    : undefined;

  if (options.json) {
    printJson({
      sync: result,
      ...(reindexResult ? { reindex: reindexResult } : {}),
    });
    return;
  }

  printKeyValue("Documents:", documents.length);
  printSyncDocumentsResult(result);
  if (reindexResult) {
    printReindexResult(reindexResult);
  }
}

export async function onboardFolderCommand(
  options: OnboardFolderOptions & {
    apply?: boolean;
    writeManifest?: string;
    json?: boolean;
  },
): Promise<void> {
  const manifest = buildOnboardFolderManifest(options);
  if (options.writeManifest) {
    fs.writeFileSync(
      options.writeManifest,
      `${JSON.stringify(buildOnboardSyncManifestPayload(manifest), null, 2)}\n`,
      "utf-8",
    );
  }

  if (!options.apply) {
    if (options.json) {
      printJson(manifest);
      return;
    }
    if (options.writeManifest) {
      printKeyValue("Manifest written:", options.writeManifest);
      console.log("");
    }
    printOnboardFolderManifest(manifest);
    return;
  }

  if (manifest.sync.documents.length === 0) {
    throw new Error("No supported documents found to apply");
  }
  if (manifest.dryRun.invalid_metadata > 0) {
    throw new Error(
      "Onboarding manifest has invalid metadata; run without --apply and review JSON.",
    );
  }

  ensureConfigured();

  const client = createClient(30000);
  const syncResult = await client.syncDocuments(
    manifest.sync.documents,
    manifest.sync.deleteMissing,
  );
  const reindexResult = manifest.sync.reindex
    ? await client.reindex({
        kind: manifest.sync.reindexKind,
        mode: manifest.sync.reindexMode,
      })
    : undefined;

  if (options.json) {
    printJson({
      onboarding: {
        source: manifest.source,
        classification: manifest.classification,
        summary: manifest.summary,
        warnings: manifest.warnings,
      },
      sync: syncResult,
      ...(reindexResult ? { reindex: reindexResult } : {}),
    });
    return;
  }

  printKeyValue("Onboard folder:", manifest.source.root);
  printKeyValue(
    "Classification:",
    `${manifest.classification.mode} (${Math.round(manifest.classification.confidence * 100)}%)`,
  );
  printKeyValue("Documents:", manifest.sync.documents.length);
  printSyncDocumentsResult(syncResult);
  if (reindexResult) {
    printReindexResult(reindexResult);
  }
}

export async function reindexCommand(options: {
  kind?: ReindexKind;
  mode?: ReindexMode;
  jobId?: string;
  json?: boolean;
}): Promise<void> {
  ensureConfigured();

  const client = createClient(30000);
  const result = await client.reindex(
    options.jobId
      ? { jobId: options.jobId }
      : {
          kind: options.kind ?? "doc",
          mode: options.mode ?? "incremental",
        },
  );

  if (options.json) {
    printJson(result);
    return;
  }
  printReindexResult(result);
}

export async function businessHealthCommand(options: {
  staleThresholdDays?: number;
  json?: boolean;
}): Promise<void> {
  ensureConfigured();

  const client = createClient(30000);
  const result = await client.indexHealth(options.staleThresholdDays);

  if (options.json) {
    printJson(result);
    return;
  }
  printBusinessHealthResult(result);
}

export async function chunkGetCommand(options: {
  chunkId: string;
  json?: boolean;
}): Promise<void> {
  ensureConfigured();

  const client = createClient(15000);
  const result = await client.getChunk(options.chunkId);
  if (options.json) {
    printJson(result);
    return;
  }
  printChunkResult(options.chunkId, result);
}

export async function multiQueryCommand(options: {
  queries: string[];
  maxTokens?: number;
  json?: boolean;
}): Promise<void> {
  ensureConfigured();

  const client = createClient(20000);
  const result = await client.multiQuery(
    options.queries.map((query) => ({ query })),
    options.maxTokens,
  );
  if (options.json) {
    printJson(result);
    return;
  }
  printMultiQueryResult(result, options.queries);
}

export async function orchestrateCommand(options: {
  query: string;
  maxTokens?: number;
  json?: boolean;
}): Promise<void> {
  ensureConfigured();

  const client = createClient(20000);
  const result = await client.orchestrate(options.query, options.maxTokens);
  if (options.json) {
    printJson(result);
    return;
  }
  printOrchestrateResult(result);
}

export async function codeCallersCommand(options: {
  qualifiedName: string;
  depth?: number;
  limit?: number;
  json?: boolean;
}): Promise<void> {
  ensureConfigured();

  const client = createClient(15000);
  const result = await client.codeCallers(options.qualifiedName, {
    depth: options.depth,
    limit: options.limit,
  });
  if (options.json) {
    printJson(result);
    return;
  }
  printCodeCallersResult(result);
}

export async function codeImportsCommand(options: {
  qualifiedName?: string;
  filePath?: string;
  direction?: "in" | "out";
  includeFileNodes?: boolean;
  limit?: number;
  json?: boolean;
}): Promise<void> {
  ensureConfigured();

  if (!options.qualifiedName && !options.filePath) {
    throw new Error("Provide either --qualified-name or --file-path");
  }

  const client = createClient(15000);
  const result = await client.codeImports({
    qualifiedName: options.qualifiedName,
    filePath: options.filePath,
    direction: options.direction,
    includeFileNodes: options.includeFileNodes,
    limit: options.limit,
  });
  if (options.json) {
    printJson(result);
    return;
  }
  printCodeImportsResult(result);
}

export async function codeNeighborsCommand(options: {
  qualifiedName: string;
  depth?: number;
  edgeKinds?: string[];
  limit?: number;
  json?: boolean;
}): Promise<void> {
  ensureConfigured();

  const client = createClient(15000);
  const result = await client.codeNeighbors(options.qualifiedName, {
    depth: options.depth,
    edgeKinds: options.edgeKinds,
    limit: options.limit,
  });
  if (options.json) {
    printJson(result);
    return;
  }
  printCodeNeighborsResult(result);
}

export async function codeShortestPathCommand(options: {
  from: string;
  to: string;
  edgeKinds?: string[];
  maxHops?: number;
  json?: boolean;
}): Promise<void> {
  ensureConfigured();

  const client = createClient(15000);
  const result = await client.codeShortestPath(options.from, options.to, {
    edgeKinds: options.edgeKinds,
    maxHops: options.maxHops,
  });
  if (options.json) {
    printJson(result);
    return;
  }
  printCodeShortestPathResult(result);
}

export async function codeSymbolCardCommand(options: {
  qualifiedName?: string;
  symbolKey?: string;
  limit?: number;
  json?: boolean;
}): Promise<void> {
  ensureConfigured();

  if (!options.qualifiedName && !options.symbolKey) {
    throw new Error("Provide either --qualified-name or --symbol-key");
  }

  const client = createClient(20000);
  const result = await client.codeSymbolCard({
    qualifiedName: options.qualifiedName,
    symbolKey: options.symbolKey,
    limit: options.limit,
  });
  if (options.json) {
    printJson(result);
    return;
  }
  printCodeSymbolCardResult(result);
}

export async function codeImpactCommand(options: {
  qualifiedName?: string;
  symbolKey?: string;
  filePath?: string;
  changedFiles?: string[];
  diffSummary?: string;
  limit?: number;
  json?: boolean;
}): Promise<void> {
  ensureConfigured();

  if (
    !options.qualifiedName &&
    !options.symbolKey &&
    !options.filePath &&
    (!options.changedFiles || options.changedFiles.length === 0)
  ) {
    throw new Error(
      "Provide --qualified-name, --symbol-key, --file-path, or --changed-files",
    );
  }

  const client = createClient(30000);
  const result = await client.codeImpact({
    qualifiedName: options.qualifiedName,
    symbolKey: options.symbolKey,
    filePath: options.filePath,
    changedFiles: options.changedFiles,
    diffSummary: options.diffSummary,
    limit: options.limit,
  });
  if (options.json) {
    printJson(result);
    return;
  }
  printCodeImpactResult(result);
}

export async function sharedContextCommand(options: {
  maxTokens?: number;
  categories?: string[];
  includeContent?: boolean;
  json?: boolean;
}): Promise<void> {
  ensureConfigured();

  const client = createClient(15000);
  const result = await client.sharedContext({
    maxTokens: options.maxTokens ?? DEFAULT_SHARED_CONTEXT_TOKENS,
    categories: options.categories,
    includeContent: options.includeContent ?? true,
  });
  if (options.json) {
    printJson(result);
    return;
  }
  printSharedContextResult(result);
}

export async function workflowRunCommand(options: {
  query: string;
  mode: WorkflowMode;
  maxTokens?: number;
  includeSessionContext?: boolean;
  maxCriticalTokens?: number;
  maxContextTokens?: number;
  runtimeHint?: boolean;
  emitOrchestratorHandoff?: boolean;
  autoRouteOrchestrator?: boolean;
  orchestratorPolicySource?: string;
  adaptiveRoutingDryRun?: boolean;
  routeLocalWorkers?: boolean;
  routingLocalWorker?: string;
  routingWorkerRole?: string;
  routingPreferredEndpoints?: string[];
  routingAllowedEndpoints?: string[];
  routingLocalBaseUrl?: string;
  routingLocalModel?: string;
  routingLocalPreferModel?: string;
  routingLocalProvider?: string;
  routingLocalApiKeyEnv?: string;
  routingLocalApiKeyHeader?: "authorization" | "x-api-key";
  plannerRetainsReasoning?: boolean;
  strongRepair?: boolean;
  writePlanFile?: string;
  startWorkflowFromPlan?: boolean;
  workflowId?: string;
  force?: boolean;
  json?: boolean;
}): Promise<void> {
  const hostedConfigured = isConfigured();
  const effectiveMode = effectiveWorkflowMode(options.mode, options.query);
  const localAdaptiveRoutingPolicy = readLocalAdaptiveRoutingProjectPolicy();
  const localAdaptiveRoutingRequested = shouldBuildAdaptiveRouting(options);
  const canRunLocalAdaptiveRouting =
    !hostedConfigured &&
    effectiveMode !== "orchestrate" &&
    (localAdaptiveRoutingRequested ||
      (localAdaptiveRoutingPolicy !== null &&
        localAdaptiveRoutingPolicy.mode !== "off"));

  if (
    !hostedConfigured &&
    !canRunLocalAdaptiveRouting &&
    effectiveMode !== "lite"
  ) {
    ensureConfigured();
  }

  const client = hostedConfigured ? createClient(20000) : null;
  const loadedAdaptiveRoutingPolicy = hostedConfigured
    ? await loadAdaptiveRoutingProjectPolicy(client, localAdaptiveRoutingPolicy)
    : localAdaptiveRoutingPolicy;
  const adaptiveRoutingPolicy =
    options.routingLocalWorker && localAdaptiveRoutingPolicy
      ? localAdaptiveRoutingPolicy
      : loadedAdaptiveRoutingPolicy;
  const adaptiveRoutingIntent = resolveAdaptiveRoutingIntent(
    options,
    adaptiveRoutingPolicy,
    hostedConfigured,
  );
  const localWorkerRoutingDefaults = adaptiveRoutingIntent.shouldBuild
    ? resolveLocalWorkerRoutingDefaults({
        workerId: options.routingLocalWorker,
        workerRole: options.routingWorkerRole,
      })
    : null;
  const routingOptions = applyLocalWorkerRoutingDefaults(
    options,
    localWorkerRoutingDefaults,
  );
  const adaptiveRoutingDryRun = adaptiveRoutingIntent.shouldBuild
    ? buildWorkflowAdaptiveRouting(
        routingOptions,
        adaptiveRoutingPolicy,
        adaptiveRoutingIntent.warnings,
      )
    : null;
  const adaptiveRoutingWithCatalog =
    adaptiveRoutingDryRun &&
    adaptiveRoutingIntent.shouldUseHostedCatalog &&
    client
      ? await enrichAdaptiveRoutingWithHostedCatalog(
          client,
          adaptiveRoutingDryRun,
        )
      : adaptiveRoutingDryRun;
  const adaptiveRouting = shouldResolveAdaptiveRoutingLocally(
    routingOptions,
    adaptiveRoutingWithCatalog,
  )
    ? enrichAdaptiveRoutingWithLocalOrchestrator(
        adaptiveRoutingWithCatalog!,
        routingOptions,
      )
    : adaptiveRoutingWithCatalog;
  const orchestratorRecommendation = getOrchestratorRecommendation(
    options.query,
    effectiveMode,
    {
      policyAutoRoute: options.autoRouteOrchestrator,
      policySource: options.orchestratorPolicySource,
      adaptiveRoutingDryRun: Boolean(adaptiveRouting),
    },
  );
  const shouldEmitOrchestratorHandoff =
    options.emitOrchestratorHandoff || options.autoRouteOrchestrator;
  const preparedHandoff =
    shouldEmitOrchestratorHandoff && orchestratorRecommendation
      ? writeOrchestratorHandoff({
          sourceCommand: "workflow run",
          recommendation: orchestratorRecommendation,
          query: options.query,
          summary: options.query,
          title: options.query,
          mode: effectiveMode,
          adaptiveRouting,
        })
      : null;

  if (!hostedConfigured) {
    const payload = {
      mode: options.mode,
      effective_mode: effectiveMode,
      local_only: true,
      local_policy_path: localAdaptiveRoutingPolicy
        ? ADAPTIVE_ROUTING_POLICY_RELATIVE_PATH
        : null,
      retrieval_policy:
        effectiveMode === "lite"
          ? {
              mandatory_calls: [],
              escalation:
                "Run recall, context_query, or code impact only when the task needs them.",
              persistence:
                "Use task-commit only when reusable durable knowledge was learned.",
            }
          : undefined,
      orchestrator_recommendation: orchestratorRecommendation,
      orchestrator_handoff: preparedHandoff,
      adaptive_routing: adaptiveRouting,
      local_worker: localWorkerRoutingDefaults?.worker,
      warnings:
        effectiveMode === "lite"
          ? []
          : [
              "Hosted Snipara is not configured; workflow run is limited to local Adaptive Work Routing metadata.",
            ],
    };

    if (options.json) {
      printJson(payload);
      return;
    }

    if (effectiveMode === "lite") {
      printLiteWorkflowRun(options.query, options.mode);
    } else {
      console.log(chalk.bold("Local Adaptive Work Routing"));
      console.log(
        "Hosted Snipara is not configured; no context query, hosted catalog, or planner call ran.",
      );
    }
    if (adaptiveRouting) {
      printAdaptiveRoutingRecommendation(adaptiveRouting);
    }
    if (preparedHandoff) {
      printPreparedOrchestratorHandoff(preparedHandoff);
    }
    return;
  }

  if (effectiveMode === "lite") {
    const payload = {
      mode: options.mode,
      effective_mode: effectiveMode,
      retrieval_policy: {
        mandatory_calls: [],
        escalation:
          "Run recall, context_query, or code impact only when the task needs them.",
        persistence:
          "Use task-commit only when reusable durable knowledge was learned.",
      },
      orchestrator_recommendation: orchestratorRecommendation,
      orchestrator_handoff: preparedHandoff,
      adaptive_routing: adaptiveRouting,
      local_worker: localWorkerRoutingDefaults?.worker,
    };

    if (options.json) {
      printJson(payload);
      return;
    }

    printLiteWorkflowRun(options.query, options.mode);
    if (options.runtimeHint !== false) {
      printRuntimeHint(options.query, effectiveMode);
    }
    if (adaptiveRouting) {
      printAdaptiveRoutingRecommendation(adaptiveRouting);
    }
    if (preparedHandoff) {
      printPreparedOrchestratorHandoff(preparedHandoff);
    }
    return;
  }

  if (!client) {
    throw new Error(
      "Hosted Snipara client unavailable after configuration check.",
    );
  }

  if (effectiveMode === "orchestrate") {
    const result = await client.orchestrate(options.query, options.maxTokens);
    if (options.json) {
      printJson({
        mode: options.mode,
        orchestrate: result,
        orchestrator_recommendation: orchestratorRecommendation,
        orchestrator_handoff: preparedHandoff,
        adaptive_routing: adaptiveRouting,
        local_worker: localWorkerRoutingDefaults?.worker,
      });
      return;
    }
    printOrchestrateResult(result);
    if (options.runtimeHint !== false) {
      printRuntimeHint(options.query, effectiveMode);
      printOrchestratorHandoffHint(
        options.query,
        effectiveMode,
        orchestratorRecommendation,
      );
    }
    if (adaptiveRouting) {
      printAdaptiveRoutingRecommendation(adaptiveRouting);
    }
    if (preparedHandoff) {
      printPreparedOrchestratorHandoff(preparedHandoff);
    }
    return;
  }

  const shouldRequestSharedContext =
    shouldFollowWorkflowRecommendations(options.mode, options.query) &&
    hasSharedContextIntent(options.query);
  const workflowBudget =
    effectiveMode === "full"
      ? resolveFullWorkflowTokenBudget({
          maxTokens: options.maxTokens,
          includeSessionContext: options.includeSessionContext,
          includeSharedContext: shouldRequestSharedContext,
          maxCriticalTokens: options.maxCriticalTokens,
          maxContextTokens: options.maxContextTokens,
        })
      : null;
  const payload: Record<string, unknown> = {
    mode: options.mode,
    effective_mode: effectiveMode,
    orchestrator_recommendation: orchestratorRecommendation,
    orchestrator_handoff: preparedHandoff,
    adaptive_routing: adaptiveRouting,
    local_worker: localWorkerRoutingDefaults?.worker,
  };
  if (workflowBudget) {
    payload.workflow_budget = workflowBudget;
  }

  if (effectiveMode === "full") {
    const bootstrap = await client.getSessionMemories(
      workflowBudget?.allocations.critical_memory_tokens ??
        DEFAULT_FULL_WORKFLOW_CRITICAL_TOKENS,
      workflowBudget?.allocations.session_context_tokens ?? 0,
    );
    payload.session_bootstrap = bootstrap;
    payload.session_bootstrap_quality = buildSessionBootstrapQuality(
      bootstrap,
      {
        expectedMaxTokens:
          (workflowBudget?.allocations.critical_memory_tokens ??
            DEFAULT_FULL_WORKFLOW_CRITICAL_TOKENS) +
          (workflowBudget?.allocations.session_context_tokens ?? 0),
      },
    );
  }

  const context = await client.queryContext(
    options.query,
    workflowBudget?.allocations.context_query_tokens ||
      options.maxTokens ||
      DEFAULT_WORKFLOW_RUN_TOKENS,
  );
  payload.context = context;

  if (shouldRequestSharedContext) {
    payload.shared_context = await client.sharedContext({
      maxTokens:
        workflowBudget?.allocations.shared_context_tokens ||
        Math.min(
          DEFAULT_SHARED_CONTEXT_TOKENS,
          Math.max(
            500,
            Math.floor(
              (options.maxTokens || DEFAULT_WORKFLOW_RUN_TOKENS) * 0.3,
            ),
          ),
        ),
      categories: inferSharedContextCategories(options.query),
      includeContent: true,
    });
  }

  if (
    context.recommended_tool &&
    shouldFollowWorkflowRecommendations(options.mode, options.query)
  ) {
    payload.executed_recommended_tool = await runRecommendedTool(context);
  }

  if (effectiveMode === "full") {
    try {
      const plan = await client.plan(
        options.query,
        workflowBudget?.allocations.plan_tokens ?? options.maxTokens,
      );
      const quality = validatePlanResult(plan, {
        query: options.query,
        cwd: process.cwd(),
      });
      payload.plan = plan;
      payload.plan_quality = quality;
      if (
        quality.valid &&
        (options.writePlanFile || options.startWorkflowFromPlan)
      ) {
        const planFile = writeGeneratedWorkflowPlanFile(
          plan,
          options.query,
          options.writePlanFile,
        );
        payload.generated_plan_file = planFile;
        if (options.startWorkflowFromPlan) {
          payload.managed_workflow = await publishWorkflowStartCoordination(
            startManagedWorkflowState({
              goal: options.query,
              planFile: planFile.path,
              id: options.workflowId,
              force: options.force,
            }),
            inferWorkflowCoordinationMode({ planFile: planFile.path }),
          );
        }
      } else if (!quality.valid) {
        payload.plan_error = {
          code: "invalid_plan",
          retryable: true,
          message: "Hosted planner returned an invalid or incomplete plan.",
          issues: quality.issues,
        };
      }
    } catch (error) {
      payload.plan_error = {
        code: "planner_call_failed",
        retryable: isRetryableHostedCommitError(error),
        message: hostedCommitErrorMessage(error),
      };
    }
  }

  if (options.json) {
    printJson(payload);
    return;
  }

  if (effectiveMode === "full" && payload.session_bootstrap) {
    const printedBootstrap = printSessionBootstrap(
      payload.session_bootstrap as SessionMemoriesResult,
      {
        includeSessionContext: Boolean(workflowBudget?.include_session_context),
        maxTokens:
          (workflowBudget?.allocations.critical_memory_tokens ??
            DEFAULT_FULL_WORKFLOW_CRITICAL_TOKENS) +
          (workflowBudget?.allocations.session_context_tokens ?? 0),
      },
    );
    if (
      printedBootstrap &&
      payload.session_bootstrap_quality &&
      typeof payload.session_bootstrap_quality === "object"
    ) {
      printSessionBootstrapQuality(
        buildPrintedBootstrapQuality(printedBootstrap),
      );
    }
    if (workflowBudget?.warnings.length) {
      console.log(chalk.bold("Workflow Budget Warnings"));
      workflowBudget.warnings.forEach((warning) => console.log(`- ${warning}`));
      console.log("");
    }
  }

  printQueryResult(context);

  if (payload.shared_context && typeof payload.shared_context === "object") {
    printSharedContextResult(payload.shared_context as SharedContextResult);
  }

  if (
    payload.executed_recommended_tool &&
    typeof payload.executed_recommended_tool === "object"
  ) {
    printRecommendedToolExecution(
      payload.executed_recommended_tool as {
        toolName: string;
        args: Record<string, unknown>;
        result: unknown;
      },
    );
  }

  if (
    effectiveMode === "full" &&
    payload.plan &&
    typeof payload.plan === "object"
  ) {
    console.log(chalk.bold("Generated Plan"));
    printPlanResult(payload.plan as Record<string, unknown>);
    if (payload.plan_quality && typeof payload.plan_quality === "object") {
      printPlanQualityWarnings(payload.plan_quality as PlanQualityReport);
    }
  }
  if (
    effectiveMode === "full" &&
    payload.plan_error &&
    typeof payload.plan_error === "object"
  ) {
    console.log(chalk.bold("Plan fallback"));
    const error = payload.plan_error as Record<string, unknown>;
    if (typeof error.message === "string") {
      printKeyValue("Reason:", error.message);
    }
    if (Array.isArray(error.issues)) {
      for (const issue of error.issues) {
        console.log(`- ${toPreview(issue)}`);
      }
    }
  }
  if (payload.generated_plan_file) {
    printGeneratedPlanFile(
      payload.generated_plan_file as WrittenGeneratedPlanFile,
    );
  }
  if (payload.managed_workflow) {
    printManagedWorkflowStarted(
      payload.managed_workflow as ManagedWorkflowState,
    );
  }

  if (options.runtimeHint !== false) {
    printRuntimeHint(options.query, effectiveMode);
    printOrchestratorHandoffHint(
      options.query,
      effectiveMode,
      orchestratorRecommendation,
    );
  }
  if (adaptiveRouting) {
    printAdaptiveRoutingRecommendation(adaptiveRouting);
  }
  if (preparedHandoff) {
    printPreparedOrchestratorHandoff(preparedHandoff);
  }
}

function shouldBuildAdaptiveRouting(options: {
  adaptiveRoutingDryRun?: boolean;
  routeLocalWorkers?: boolean;
  routingLocalWorker?: string;
  routingWorkerRole?: string;
  routingPreferredEndpoints?: string[];
  routingAllowedEndpoints?: string[];
  routingLocalBaseUrl?: string;
  routingLocalModel?: string;
  routingLocalPreferModel?: string;
  routingLocalProvider?: string;
  routingLocalApiKeyEnv?: string;
  routingLocalApiKeyHeader?: "authorization" | "x-api-key";
  plannerRetainsReasoning?: boolean;
  strongRepair?: boolean;
}): boolean {
  return Boolean(
    options.adaptiveRoutingDryRun ||
    options.routeLocalWorkers ||
    options.routingLocalWorker ||
    options.routingWorkerRole ||
    options.routingPreferredEndpoints?.length ||
    options.routingAllowedEndpoints?.length ||
    options.routingLocalBaseUrl ||
    options.routingLocalModel ||
    options.routingLocalPreferModel ||
    options.routingLocalProvider ||
    options.routingLocalApiKeyEnv ||
    options.plannerRetainsReasoning ||
    options.strongRepair,
  );
}

function buildWorkflowAdaptiveRouting(
  options: {
    query: string;
    mode: WorkflowMode;
    routeLocalWorkers?: boolean;
    routingLocalWorker?: string;
    routingWorkerRole?: string;
    routingPreferredEndpoints?: string[];
    routingAllowedEndpoints?: string[];
    routingLocalBaseUrl?: string;
    routingLocalModel?: string;
    routingLocalPreferModel?: string;
    routingLocalProvider?: string;
    plannerRetainsReasoning?: boolean;
    strongRepair?: boolean;
  },
  policy: AdaptiveRoutingProjectPolicy | null = null,
  intentWarnings: string[] = [],
): AdaptiveWorkRoutingRecommendation {
  const state = readWorkflowState();
  const currentPhase = state ? currentWorkflowPhase(state) : undefined;
  const initialPreferredEndpointTypes = normalizeRoutingEndpointTypes([
    ...(options.routingPreferredEndpoints ?? []),
    ...(options.routeLocalWorkers ? ["local"] : []),
    ...(policy?.preferredEndpointTypes ?? []),
    ...(policy?.preferLocalWorkers ? ["local"] : []),
  ]);
  const policyAllowedEndpointTypes = policy?.allowedEndpointTypes ?? [];
  const requestedAllowedEndpointTypes = normalizeRoutingEndpointTypes(
    options.routingAllowedEndpoints,
  );
  const requestedPolicyEndpointIntersection =
    policyAllowedEndpointTypes.length > 0 &&
    requestedAllowedEndpointTypes.length > 0
      ? intersectStrings(
          requestedAllowedEndpointTypes,
          policyAllowedEndpointTypes,
        )
      : [];
  const allowedEndpointTypes =
    policyAllowedEndpointTypes.length > 0
      ? requestedAllowedEndpointTypes.length > 0
        ? requestedPolicyEndpointIntersection.length > 0
          ? requestedPolicyEndpointIntersection
          : policyAllowedEndpointTypes
        : policyAllowedEndpointTypes
      : requestedAllowedEndpointTypes;
  const preferredEndpointTypes =
    allowedEndpointTypes.length > 0
      ? initialPreferredEndpointTypes.filter((type) =>
          allowedEndpointTypes.includes(type),
        )
      : initialPreferredEndpointTypes;
  const removedPreferredEndpointTypes = initialPreferredEndpointTypes.filter(
    (type) => !preferredEndpointTypes.includes(type),
  );
  const localRoutingRequested = hasLocalRoutingRequest(options);
  const localRoutingAllowed =
    allowedEndpointTypes.length === 0 || allowedEndpointTypes.includes("local");
  const policyWarnings = [
    ...intentWarnings,
    ...(localRoutingRequested && !localRoutingAllowed
      ? [
          "Local worker routing was requested, but the effective Adaptive Work Routing policy does not allow local endpoints; Companion skipped local orchestrator routing and will use fallback main_agent.",
        ]
      : []),
    ...(requestedAllowedEndpointTypes.length > 0 &&
    policyAllowedEndpointTypes.length > 0 &&
    requestedPolicyEndpointIntersection.length === 0
      ? [
          `Project Adaptive Work Routing policy rejected requested allowed endpoint(s): ${requestedAllowedEndpointTypes.join(", ")}.`,
        ]
      : []),
    ...(removedPreferredEndpointTypes.length > 0
      ? [
          `Project Adaptive Work Routing policy removed unsupported preferred endpoint(s): ${removedPreferredEndpointTypes.join(", ")}.`,
        ]
      : []),
  ];
  const buildRecommendation = (workerRole?: string) =>
    buildAdaptiveWorkRoutingRecommendation({
      query: options.query,
      mode: options.mode,
      changedFiles: currentPhase?.files ?? [],
      preferredEndpointTypes,
      allowedEndpointTypes,
      workerRole,
      plannerRetainsReasoning:
        options.plannerRetainsReasoning ??
        policy?.plannerRetainsReasoning ??
        (options.routeLocalWorkers ? true : undefined),
      strongRepair: options.strongRepair,
      catalogLimit:
        policy?.catalogLimit ?? DEFAULT_ADAPTIVE_ROUTING_CATALOG_LIMIT,
      dailyBudgetCents: policy?.dailyBudgetCents,
      monthlyBudgetCents: policy?.monthlyBudgetCents,
    });

  const requestedWorkerRole = stringValue(options.routingWorkerRole);
  let routing = buildRecommendation(requestedWorkerRole);
  const allowedWorkerClasses = policy?.allowedWorkerClasses ?? [];
  if (
    allowedWorkerClasses.length > 0 &&
    !isAdaptiveWorkerClassAllowed(
      routing.requirements.workerRole,
      allowedWorkerClasses,
    )
  ) {
    const disallowedWorkerClass = canonicalAdaptiveWorkerClass(
      routing.requirements.workerRole,
    );
    const fallbackWorkerRole = selectAdaptiveWorkerRoleForPolicy(
      routing.workProfile.taskType,
      allowedWorkerClasses,
    );
    routing = buildRecommendation(fallbackWorkerRole);
    policyWarnings.push(
      `Project Adaptive Work Routing policy does not allow worker class ${disallowedWorkerClass}; using ${canonicalAdaptiveWorkerClass(
        fallbackWorkerRole,
      )}.`,
    );
  }

  const policyReasons = policy
    ? [
        `project adaptive routing policy mode is ${policy.mode}`,
        `project adaptive routing allows endpoint type(s): ${policy.allowedEndpointTypes.join(", ")}`,
      ]
    : [];

  return {
    ...routing,
    routingCard: {
      ...routing.routingCard,
      reasons: uniqueStrings([
        ...routing.routingCard.reasons,
        ...policyReasons,
      ]),
      warnings: uniqueStrings([
        ...routing.routingCard.warnings,
        ...policyWarnings,
      ]),
    },
  };
}

function normalizeRoutingEndpointTypes(values: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (values ?? [])
        .map((value) => stringValue(value)?.toLowerCase())
        .filter((value): value is string => Boolean(value)),
    ),
  ).sort();
}

function normalizeAdaptiveRoutingMode(
  value: unknown,
): AdaptiveRoutingMode | null {
  const normalized = stringValue(value)?.toLowerCase();
  return normalized === "off" ||
    normalized === "recommend" ||
    normalized === "catalog"
    ? normalized
    : null;
}

function normalizeAdaptiveWorkerClasses(
  values: string[] | undefined,
): string[] {
  return uniqueStrings((values ?? []).map(canonicalAdaptiveWorkerClass)).filter(
    (value) => ["documentation", "tests", "review", "coding"].includes(value),
  );
}

function normalizeCents(value: unknown): number {
  const parsed = numberValue(value);
  if (parsed === undefined || parsed < 0) {
    return 0;
  }
  return Math.floor(parsed);
}

function normalizeAdaptiveRoutingCatalogLimit(
  value: unknown,
): number | undefined {
  const parsed = numberValue(value);
  if (parsed === undefined || parsed < 1) {
    return undefined;
  }
  return Math.min(Math.floor(parsed), 100);
}

function intersectStrings(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function canonicalAdaptiveWorkerClass(value: string | undefined): string {
  const normalized =
    stringValue(value)?.toLowerCase().replace(/[-\s]/g, "_") ?? "execution";
  if (normalized === "docs" || normalized === "doc") {
    return "documentation";
  }
  if (normalized === "test" || normalized === "testing") {
    return "tests";
  }
  if (normalized === "validation" || normalized === "reviewer") {
    return "review";
  }
  if (
    normalized === "code" ||
    normalized === "coder" ||
    normalized === "implementation"
  ) {
    return "coding";
  }
  return normalized;
}

function isAdaptiveWorkerClassAllowed(
  workerRole: string,
  allowedWorkerClasses: string[],
): boolean {
  return allowedWorkerClasses.includes(
    canonicalAdaptiveWorkerClass(workerRole),
  );
}

function selectAdaptiveWorkerRoleForPolicy(
  taskType: string,
  allowedWorkerClasses: string[],
): string {
  const preferences =
    taskType === "documentation"
      ? ["documentation", "review", "coding", "tests"]
      : taskType === "tests"
        ? ["tests", "review", "coding", "documentation"]
        : taskType === "coding" || taskType === "critical_code"
          ? ["coding", "review", "tests", "documentation"]
          : ["review", "coding", "documentation", "tests"];
  const selected = preferences.find((workerClass) =>
    allowedWorkerClasses.includes(workerClass),
  );
  return workerRoleFromAdaptiveClass(
    selected ?? allowedWorkerClasses[0] ?? "review",
  );
}

function workerRoleFromAdaptiveClass(workerClass: string): string {
  return workerClass === "tests" ? "testing" : workerClass;
}

function startManagedWorkflowState(options: {
  goal?: string;
  planFile?: string;
  id?: string;
  force?: boolean;
}): ManagedWorkflowState {
  const existing = readWorkflowState();
  if (existing && existing.status === "active" && !options.force) {
    throw new Error(
      `Active workflow '${existing.workflowId}' already exists. Use --force to replace ${WORKFLOW_STATE_RELATIVE_PATH}.`,
    );
  }

  const goal =
    options.goal ??
    (options.planFile
      ? `Workflow from ${path.basename(options.planFile)}`
      : undefined);
  if (!goal) {
    throw new Error("Provide --goal or --plan-file");
  }

  const phases = options.planFile
    ? readWorkflowPlanFile(options.planFile, goal)
    : normalizeWorkflowPlanInput(goal, goal);
  const now = new Date().toISOString();
  const workflowId =
    options.id ??
    sanitizeWorkflowId(goal, `workflow-${now.slice(0, 10).replace(/-/g, "")}`);
  const state: ManagedWorkflowState = {
    schemaVersion: "snipara.workflow.v2",
    workflowId,
    goal,
    status: "active",
    currentPhaseId: phases[0]?.id,
    planSource: options.planFile ? "file" : "inline",
    ...(options.planFile ? { planFile: path.resolve(options.planFile) } : {}),
    createdAt: now,
    updatedAt: now,
    phases,
  };

  writeWorkflowState(state);
  return state;
}

function plannedWorkflowFiles(state: ManagedWorkflowState): string[] {
  return (
    uniqueStringList(
      state.phases
        .flatMap((phase) => phase.files ?? [])
        .map(normalizeRepoFilePath),
    ) ?? []
  );
}

function managedWorkflowJudgmentFiles(state: ManagedWorkflowState): string[] {
  const planned = plannedWorkflowFiles(state);
  try {
    const repoRoot = readGitRepoRoot();
    const dirty = (readLocalGitState(repoRoot).statusLines ?? [])
      .map(parseDirtyFileFromStatusLine)
      .filter((file): file is string => Boolean(file));
    return uniqueStrings([...planned, ...dirty]);
  } catch {
    return planned;
  }
}

function managedWorkflowJudgmentBrief(
  brief: ProjectIntelligenceBrief
): ManagedWorkflowJudgmentBrief {
  return {
    version: brief.version,
    generatedAt: brief.generatedAt,
    ...(brief.servedJudgmentId ? { servedJudgmentId: brief.servedJudgmentId } : {}),
    ...(brief.branch ? { branch: brief.branch } : {}),
    ...(brief.task ? { task: brief.task } : {}),
    changedFiles: brief.changedFiles,
    recentFiles: brief.recentFiles,
    errors: brief.errors,
    suggestedCommands: brief.suggestedCommands,
  };
}

function projectIntelligenceBriefFromManagedJudgment(
  judgment: ManagedWorkflowJudgmentState
): ProjectIntelligenceBrief {
  return { ...judgment.brief };
}

function normalizeWorkflowAdvisorDecision(value: string): AdvisorInfluenceAgentDecision {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "accepted" ||
    normalized === "modified" ||
    normalized === "ignored" ||
    normalized === "blocked"
  ) {
    return normalized;
  }
  throw new Error("Advisor decision must be accepted, modified, ignored, or blocked.");
}

function normalizeWorkflowPlanSnapshot(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > 4_000) {
    throw new Error("Advisor plan snapshots must be at most 4000 characters.");
  }
  return normalized;
}

function comparableWorkflowPlan(value: string | undefined): string | undefined {
  return value
    ?.replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function validateWorkflowJudgmentResponse(args: {
  decision: AdvisorInfluenceAgentDecision;
  planBefore?: string;
  planAfter?: string;
}): void {
  const before = comparableWorkflowPlan(args.planBefore);
  const after = comparableWorkflowPlan(args.planAfter);
  const hasCompletePair = Boolean(before && after);
  const changed = hasCompletePair && before !== after;

  if (args.decision === "modified" && (!hasCompletePair || !changed)) {
    throw new Error(
      "A modified judgment response requires distinct --plan-before and --plan-after snapshots."
    );
  }
  if (args.decision === "accepted" && changed) {
    throw new Error(
      "Changed plan snapshots require --decision modified; accepted cannot claim a plan adaptation."
    );
  }
  if ((args.decision === "ignored" || args.decision === "blocked") && (before || after)) {
    throw new Error(
      `${args.decision} judgment responses cannot include plan snapshots because no applied adaptation is claimed.`
    );
  }
}

async function captureManagedWorkflowJudgmentResponse(args: {
  state: ManagedWorkflowState;
  response: ManagedWorkflowJudgmentResponse;
  outcomeReceipts?: OutcomeIntelligenceReceipt[];
  trigger: string;
}): Promise<ProjectRunAdvisorReceiptCapture | undefined> {
  const judgment = args.state.judgment;
  if (!judgment) return undefined;
  return recordFirstPartyAdvisorReceipts({
    options: {
      task: judgment.brief.task ?? args.state.goal,
      branch: judgment.brief.branch,
      changedFiles: judgment.brief.changedFiles,
      servedJudgmentId: judgment.brief.servedJudgmentId,
      advisorRecommendationId: args.response.recommendationId,
      advisorDecision: args.response.decision,
      advisorPlanBefore: args.response.planBefore,
      advisorPlanAfter: args.response.planAfter,
      advisorReceiptScope: "selected",
      advisorReceiptSource: "snipara-companion:workflow",
      advisorReceiptTrigger: args.trigger,
    },
    brief: projectIntelligenceBriefFromManagedJudgment(judgment),
    judgmentCard: judgment.card,
    outcomeReceipts: args.outcomeReceipts,
    runEnvelope: judgment.runEnvelope,
  });
}

function workflowOutcomeEvidence(values: string[] | undefined): OutcomeIntelligenceEvidence[] {
  return (values ?? []).flatMap((value): OutcomeIntelligenceEvidence[] => {
    const text = value.trim();
    if (!text) return [];
    const matched = text.match(
      /^(passed|pass|ok|success|failed|fail|error|not[-_ ]?run|skipped|unknown)\s*:\s*(.+)$/i
    );
    const rawStatus = matched?.[1]?.toLowerCase() ?? "unknown";
    const detail = (matched?.[2] ?? text).trim();
    const status: OutcomeIntelligenceEvidence["status"] =
      rawStatus === "passed" ||
      rawStatus === "pass" ||
      rawStatus === "ok" ||
      rawStatus === "success"
        ? "passed"
        : rawStatus === "failed" || rawStatus === "fail" || rawStatus === "error"
          ? "failed"
          : "skipped";
    const normalizedDetail = detail.toLowerCase();
    const source: OutcomeIntelligenceEvidence["source"] = normalizedDetail.includes("typecheck")
      ? "typecheck"
      : normalizedDetail.includes("lint")
        ? "lint"
        : normalizedDetail.includes("build")
          ? "build"
          : normalizedDetail.includes("deploy") || normalizedDetail.includes("health")
            ? "deploy_health"
            : normalizedDetail.includes("publish") || normalizedDetail.includes("npm")
              ? "package_publish"
              : normalizedDetail.includes("guard")
                ? "guard"
                : normalizedDetail.includes("test") || normalizedDetail.includes("smoke")
                  ? "test"
                  : "manual";
    return [
      {
        source,
        label: detail.slice(0, 900),
        status,
        ...(detail ? { command: detail.slice(0, 900) } : {}),
      },
    ];
  });
}

function workflowOutcomeSurfaces(
  files: string[]
): Array<"web" | "backend" | "database" | "package" | "docs" | "workflow" | "memory" | "unknown"> {
  const surfaces = new Set<
    "web" | "backend" | "database" | "package" | "docs" | "workflow" | "memory" | "unknown"
  >(["workflow"]);
  for (const file of files) {
    if (file.startsWith("packages/")) surfaces.add("package");
    if (file.startsWith("apps/web/")) surfaces.add("web");
    if (file.startsWith("apps/mcp-server/")) surfaces.add("backend");
    if (file.includes("prisma") || file.includes("migration")) surfaces.add("database");
    if (file.startsWith("docs/") || file.endsWith(".md")) surfaces.add("docs");
    if (file.includes("memory")) surfaces.add("memory");
  }
  return [...surfaces];
}

function workflowOutcomeStatus(
  outcome: TaskCommitOutcome
): "success" | "failure" | "blocked" | "partial" {
  if (outcome === "completed") return "success";
  if (outcome === "partial") return "partial";
  if (outcome === "blocked") return "blocked";
  return "failure";
}

function buildManagedWorkflowOutcomeReceipt(args: {
  state: ManagedWorkflowState;
  response: ManagedWorkflowJudgmentResponse;
  summary: string;
  outcome: TaskCommitOutcome;
  files?: string[];
  evidence?: string[];
  sourceRef: string;
}): OutcomeIntelligenceReceipt {
  const judgment = args.state.judgment;
  if (!judgment) {
    throw new Error("Managed workflow judgment is missing.");
  }
  const recommendation = judgment.card.advisorRecommendations.find(
    (item) => item.id === args.response.recommendationId
  );
  const files = uniqueStringList(args.files ?? judgment.brief.changedFiles) ?? [];
  const releaseLike = /\b(release|deploy|production|publish|promotion)\b/i.test(args.state.goal);
  return buildOutcomeIntelligenceReceipt({
    sourceRef: args.sourceRef,
    taskProfile: {
      kind: releaseLike ? "release" : "unknown",
      risk: releaseLike ? "high" : "medium",
      surfaces: workflowOutcomeSurfaces(files),
      changedFiles: files,
      workflowFingerprint: args.state.workflowId,
    },
    decision: {
      summary: `${args.response.decision} advisor recommendation: ${recommendation?.title ?? args.response.recommendationId}`,
      reasonCodes: recommendation?.reasonCodes ?? ["managed_workflow_judgment"],
      advisorRecommendationIds: [args.response.recommendationId],
    },
    evidence: workflowOutcomeEvidence(args.evidence),
    outcome: {
      status: workflowOutcomeStatus(args.outcome),
      summary: args.summary,
    },
  });
}

async function closeManagedWorkflowJudgment(args: {
  state: ManagedWorkflowState | undefined;
  summary: string;
  outcome: TaskCommitOutcome;
  files?: string[];
  evidence?: string[];
  sourceRef: string;
  trigger: string;
  requireEvidence?: boolean;
}): Promise<ProjectRunAdvisorReceiptCapture[]> {
  if (!args.state?.judgment || args.state.judgment.responses.length === 0) return [];
  if (args.requireEvidence && workflowOutcomeEvidence(args.evidence).length === 0) return [];

  const captures: ProjectRunAdvisorReceiptCapture[] = [];
  for (const response of args.state.judgment.responses) {
    const outcomeReceipt = buildManagedWorkflowOutcomeReceipt({
      state: args.state,
      response,
      summary: args.summary,
      outcome: args.outcome,
      files: args.files,
      evidence: args.evidence,
      sourceRef: args.sourceRef,
    });
    response.outcomeReceipts = [
      ...(response.outcomeReceipts ?? []).filter(
        (receipt) => receipt.receiptId !== outcomeReceipt.receiptId
      ),
      outcomeReceipt,
    ];
    const capture = await captureManagedWorkflowJudgmentResponse({
      state: args.state,
      response,
      outcomeReceipts: response.outcomeReceipts,
      trigger: args.trigger,
    });
    if (capture) {
      response.closeoutReceipt = capture;
      captures.push(capture);
    }
  }
  args.state.updatedAt = new Date().toISOString();
  writeWorkflowState(args.state);
  return captures;
}

async function publishWorkflowStartCoordination(
  state: ManagedWorkflowState,
  mode: ManagedWorkflowCoordinationMode,
): Promise<ManagedWorkflowState> {
  const files = mode === "standard" ? [] : plannedWorkflowFiles(state);
  const startReceipt = await workflowCollaborationStart({
    workflowId: state.workflowId,
    goal: state.goal,
    files,
    mode,
  });
  const teamSyncReceipt =
    mode === "full" || mode === "orchestrate"
      ? await createTeamSyncStartWorkPayload(process.cwd(), {
          summary: state.goal,
          files,
        })
      : undefined;
  const now = new Date().toISOString();

  state.coordination = {
    mode,
    autoPublish: true,
    startedAt: state.coordination?.startedAt ?? now,
    lastUpdatedAt: now,
    workSessionId: startReceipt.workSessionId,
    startReceipt,
    ...(teamSyncReceipt
      ? { teamSyncReceipt: readHostedStatus(teamSyncReceipt) }
      : {}),
  };
  state.updatedAt = now;
  writeWorkflowState(state);
  appendActivityEvent({
    source: "workflow",
    kind: "workflow-start-coordination",
    title: `Workflow coordination: ${state.goal}`,
    workflowId: state.workflowId,
    files,
    refs: [startReceipt.workSessionId].filter(Boolean) as string[],
    metadata: {
      mode,
      hostedSessionStatus: startReceipt.hostedSessionStatus,
      hostedClaimStatus: startReceipt.hostedClaimStatus,
      teamSyncHostedStatus: readHostedStatus(teamSyncReceipt)?.hostedStatus,
    },
    timestamp: now,
  });
  writeSessionSnapshot();
  return state;
}

async function releaseWorkflowCoordination(
  state: ManagedWorkflowState,
  reason: string,
): Promise<WorkflowCollaborationReceipt | undefined> {
  if (!state.coordination?.workSessionId || state.coordination.releaseReceipt) {
    return state.coordination?.releaseReceipt;
  }
  const releaseReceipt = await workflowCollaborationRelease({
    workflowId: state.workflowId,
    reason,
  });
  state.coordination = {
    ...state.coordination,
    releaseReceipt,
    lastUpdatedAt: releaseReceipt.recordedAt,
  };
  state.updatedAt = releaseReceipt.recordedAt;
  writeWorkflowState(state);
  return releaseReceipt;
}

function readHostedStatus(
  payload: unknown,
): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const hosted = (payload as { hosted?: { status?: string; error?: string } })
    .hosted;
  return {
    action: (payload as { action?: string }).action,
    hostedStatus: hosted?.status ?? "skipped",
    hostedError: hosted?.error,
  };
}

export async function workflowStartCommand(options: {
  goal?: string;
  planFile?: string;
  id?: string;
  force?: boolean;
  json?: boolean;
}): Promise<void> {
  const state = await publishWorkflowStartCoordination(
    startManagedWorkflowState({
      goal: options.goal,
      planFile: options.planFile,
      id: options.id,
      force: options.force,
    }),
    inferWorkflowCoordinationMode({ planFile: options.planFile }),
  );
  appendActivityEvent({
    source: "workflow",
    kind: "workflow-start",
    title: state.goal,
    workflowId: state.workflowId,
    refs: [state.planFile].filter(Boolean) as string[],
    metadata: {
      planSource: state.planSource,
      phaseCount: state.phases.length,
      status: state.status,
    },
    timestamp: state.createdAt,
  });
  writeSessionSnapshot();

  if (options.json) {
    printJson(state);
    return;
  }
  printManagedWorkflowState(state);
  printManagedWorkflowNextCommands(state);
}

export async function workflowJudgmentCommand(options: {
  refresh?: boolean;
  json?: boolean;
}): Promise<void> {
  const state = readRequiredWorkflowState();
  if (state.judgment && !options.refresh) {
    if (options.json) {
      printJson({ workflowId: state.workflowId, judgment: state.judgment });
      return;
    }
    console.log(formatProjectJudgmentCard(state.judgment.card));
    printManagedWorkflowJudgmentNextCommands(state);
    return;
  }
  if (state.judgment?.responses.length) {
    throw new Error(
      "Cannot refresh a managed judgment after responses were recorded; start a new workflow for a new served judgment."
    );
  }

  const result = await buildProjectIntelligenceRun({
    task: state.goal,
    changedFiles: managedWorkflowJudgmentFiles(state),
    diffSummary: state.goal,
    skipGuard: true,
    skipAdvisorReceipts: true,
  });
  state.judgment = {
    version: "snipara.workflow.judgment.v1",
    generatedAt: result.generatedAt,
    runEnvelope: result.runEnvelope,
    brief: managedWorkflowJudgmentBrief(result.brief),
    card: result.judgmentCard,
    responses: [],
  };
  state.updatedAt = new Date().toISOString();
  writeWorkflowState(state);
  appendActivityEvent({
    source: "workflow",
    kind: "workflow-judgment",
    title: state.judgment.card.summary,
    summary: `${state.judgment.card.advisorRecommendations.length} advisor recommendation(s) served for explicit response.`,
    workflowId: state.workflowId,
    files: state.judgment.brief.changedFiles,
    refs: [state.judgment.brief.servedJudgmentId].filter(Boolean) as string[],
    timestamp: state.judgment.generatedAt,
    metadata: {
      state: state.judgment.card.state,
      canProceed: state.judgment.card.canProceed,
      recommendationCount: state.judgment.card.advisorRecommendations.length,
      identityStatus: state.judgment.brief.servedJudgmentId ? "linked" : "missing",
    },
  });
  writeSessionSnapshot();

  if (options.json) {
    printJson({ workflowId: state.workflowId, judgment: state.judgment });
    return;
  }
  console.log(formatProjectJudgmentCard(state.judgment.card));
  printManagedWorkflowJudgmentNextCommands(state);
}

export async function workflowJudgmentRespondCommand(options: {
  recommendationId: string;
  decision: string;
  planBefore?: string;
  planAfter?: string;
  json?: boolean;
}): Promise<void> {
  const state = readRequiredWorkflowState();
  const judgment = state.judgment;
  if (!judgment) {
    throw new Error("No managed judgment found. Run 'snipara-companion workflow judgment' first.");
  }
  const recommendation = judgment.card.advisorRecommendations.find(
    (item) => item.id === options.recommendationId
  );
  if (!recommendation) {
    throw new Error(
      `Advisor recommendation '${options.recommendationId}' was not served by this workflow judgment.`
    );
  }
  const decision = normalizeWorkflowAdvisorDecision(options.decision);
  const planBefore = normalizeWorkflowPlanSnapshot(options.planBefore);
  const planAfter = normalizeWorkflowPlanSnapshot(options.planAfter);
  validateWorkflowJudgmentResponse({ decision, planBefore, planAfter });
  const response: ManagedWorkflowJudgmentResponse = {
    recommendationId: recommendation.id,
    decision,
    respondedAt: new Date().toISOString(),
    ...(planBefore ? { planBefore } : {}),
    ...(planAfter ? { planAfter } : {}),
  };
  response.initialReceipt = await captureManagedWorkflowJudgmentResponse({
    state,
    response,
    trigger: "snipara-companion workflow judgment-respond",
  });
  judgment.responses = [
    ...judgment.responses.filter((item) => item.recommendationId !== recommendation.id),
    response,
  ];
  state.updatedAt = response.respondedAt;
  writeWorkflowState(state);
  appendActivityEvent({
    source: "workflow",
    kind: "workflow-judgment-response",
    title: recommendation.title,
    summary: `Agent explicitly ${decision} recommendation ${recommendation.id}.`,
    workflowId: state.workflowId,
    files: judgment.brief.changedFiles,
    refs: [judgment.brief.servedJudgmentId, recommendation.id].filter(Boolean) as string[],
    timestamp: response.respondedAt,
    metadata: {
      decision,
      receiptStatus: response.initialReceipt?.status ?? "unavailable",
      recordedCount: response.initialReceipt?.recordedCount ?? 0,
    },
  });
  writeSessionSnapshot();

  if (options.json) {
    printJson({ workflowId: state.workflowId, recommendation, response });
    return;
  }
  console.log(chalk.bold("Workflow judgment response"));
  printKeyValue("Recommendation:", recommendation.id);
  printKeyValue("Decision:", decision);
  printKeyValue("Receipt:", response.initialReceipt?.status ?? "unavailable");
  if (response.initialReceipt?.reason) {
    printKeyValue("Reason:", response.initialReceipt.reason);
  }
  console.log("");
}

export async function workflowStatusCommand(options: {
  json?: boolean;
}): Promise<void> {
  const state = readRequiredWorkflowState();
  if (options.json) {
    printJson({
      ...state,
      pendingDecisionCount: safeDecisionPendingCount(),
    });
    return;
  }
  printManagedWorkflowState(state);
  printManagedWorkflowNextCommands(state);
}

function lastCompletedWorkflowPhase(
  state: ManagedWorkflowState | undefined,
): ManagedWorkflowPhase | undefined {
  return state?.phases
    .filter((phase) => phase.status === "completed" && phase.completedAt)
    .sort((left, right) =>
      String(right.completedAt).localeCompare(String(left.completedAt)),
    )[0];
}

function latestTeamSyncHandoff(
  handoffs: TeamSyncHandoffRecord[],
): TeamSyncHandoffRecord | undefined {
  return [...handoffs].sort((left, right) =>
    String(right.createdAt).localeCompare(String(left.createdAt)),
  )[0];
}

function buildAgenticStatusRisks(args: {
  state?: ManagedWorkflowState;
  dirtyFileCount: number;
  staleWorkCount: number;
  staleWorkExplanation: TeamSyncStaleWorkExplanation;
  latestHandoff?: TeamSyncHandoffRecord;
}): string[] {
  const risks: string[] = [];
  const currentPhase = args.state
    ? currentWorkflowPhase(args.state)
    : undefined;

  if (!args.state) {
    risks.push("No active managed workflow state found locally.");
  }
  if (args.dirtyFileCount > 0) {
    risks.push(
      `${args.dirtyFileCount} dirty git file(s) need review before handoff or commit.`,
    );
  }
  if (args.staleWorkCount > 0) {
    risks.push(args.staleWorkExplanation.message);
  }
  if (currentPhase?.status === "blocked") {
    risks.push(`Current phase '${currentPhase.id}' is blocked.`);
  }
  if (
    args.latestHandoff?.attention &&
    args.latestHandoff.attention !== "note"
  ) {
    risks.push(`Latest handoff attention: ${args.latestHandoff.attention}.`);
  }

  return risks;
}

function buildSuggestedAgenticNextAction(
  state: ManagedWorkflowState | undefined,
  risks: string[],
): string {
  const phase = state ? currentWorkflowPhase(state) : undefined;
  if (!state) {
    return "Run snipara-companion brief --task '<task>' or start a managed workflow.";
  }
  if (state.status === "completed") {
    return "Run snipara-companion timeline or start the next managed workflow.";
  }
  if (risks.some((risk) => risk.includes("dirty git file"))) {
    return "Review the dirty git state, then run the relevant checks before phase-commit.";
  }
  if (phase) {
    return `Continue phase '${phase.id}' and commit it with snipara-companion workflow phase-commit ${phase.id}.`;
  }
  return "Run snipara-companion workflow status to inspect the managed workflow.";
}

function buildAgenticOperationalLoop(args: {
  state?: ManagedWorkflowState;
  dirtyFileCount: number;
  risks: string[];
  pendingDecisionCount: number;
  teamSyncSummary: TeamSyncSummary;
  latestHandoff?: TeamSyncHandoffRecord;
}): AgenticWorkStatus["operationalLoop"] {
  const phase = args.state ? currentWorkflowPhase(args.state) : undefined;
  const nextActions: string[] = [];
  const receiptActions: string[] = [];
  const caveats = [
    "Operational Loop is local and advisory; it does not edit Project Policy, approve memory, or bypass verification.",
  ];
  let receiptGapCount = 0;

  if (args.pendingDecisionCount > 0) {
    nextActions.push(
      `Resolve ${args.pendingDecisionCount} local Decision Request${args.pendingDecisionCount === 1 ? "" : "s"} with snipara-companion workflow decisions and workflow decide.`,
    );
  }
  if (args.teamSyncSummary.staleWorkCount > 0) {
    nextActions.push(
      "Review stale Team Sync work with snipara-companion team-sync sweep --dry-run before continuing.",
    );
  }
  if (args.dirtyFileCount > 0) {
    nextActions.push(
      "Review dirty git state and run the relevant checks before phase-commit.",
    );
  }
  if (args.latestHandoff?.next) {
    nextActions.push(
      `Continue latest handoff next step: ${toPreview(args.latestHandoff.next, 160)}`,
    );
  }
  if (phase?.status === "blocked") {
    nextActions.push(
      `Unblock current phase '${phase.id}' before new implementation work.`,
    );
  } else if (phase) {
    nextActions.push(
      `Continue phase '${phase.id}' and close it with snipara-companion workflow phase-commit ${phase.id}.`,
    );
  } else if (!args.state) {
    nextActions.push(
      "Start a managed workflow before multi-step implementation work.",
    );
  }

  if (args.state && args.state.status !== "completed") {
    receiptGapCount += 1;
    receiptActions.push(
      "Before closing the phase, capture why/outcome evidence with snipara-companion outcome-capture preview --emit-outcome-receipt.",
    );
  }
  if (args.latestHandoff && args.latestHandoff.attention !== "note") {
    receiptGapCount += 1;
    receiptActions.push(
      "Treat the latest Team Sync handoff as needing proof/review evidence before final-commit.",
    );
  }
  if (args.pendingDecisionCount > 0) {
    receiptActions.push(
      "Decision Request resolution records the human choice; follow-up policy edits remain explicit.",
    );
  }

  const status =
    phase?.status === "blocked"
      ? "blocked"
      : args.risks.length > 0 ||
          args.pendingDecisionCount > 0 ||
          receiptGapCount > 0
        ? "attention"
        : "clear";

  return {
    status,
    decisionRequestCount: args.pendingDecisionCount,
    receiptGapCount,
    nextActions: uniqueStrings(nextActions).slice(0, 6),
    receiptActions: uniqueStrings(receiptActions).slice(0, 4),
    caveats,
  };
}

export function buildAgenticWorkStatus(
  cwd: string = process.cwd(),
): AgenticWorkStatus {
  const state = readWorkflowState(cwd);
  const git = readLocalGitState(cwd);
  autoArchiveTeamSyncState(cwd);
  const teamSyncState = loadTeamSyncState(cwd);
  const teamSyncSummary = buildTeamSyncSummary(teamSyncState);
  const latestHandoff = latestTeamSyncHandoff(teamSyncState.handoffs);
  const currentPhase = state ? currentWorkflowPhase(state) : undefined;
  const lastPhaseCommit = lastCompletedWorkflowPhase(state);
  const dirtyFileCount = git.statusLines?.length ?? 0;
  const pendingDecisionCount = decisionPendingCount(cwd);
  const risks = buildAgenticStatusRisks({
    state,
    dirtyFileCount,
    staleWorkCount: teamSyncSummary.staleWorkCount,
    staleWorkExplanation: teamSyncSummary.staleWorkExplanation,
    latestHandoff,
  });

  return {
    version: "snipara.agentic_status.v1",
    generatedAt: new Date().toISOString(),
    ...(readCurrentGitBranch(cwd) ? { branch: readCurrentGitBranch(cwd) } : {}),
    git: {
      ...(git.head ? { head: shortCommit(git.head) } : {}),
      dirtyFileCount,
      statusLines: git.statusLines ?? [],
      ...(git.error ? { error: git.error } : {}),
    },
    workflow: state
      ? {
          id: state.workflowId,
          goal: state.goal,
          status: state.status,
          ...(currentPhase
            ? {
                currentPhase: {
                  id: currentPhase.id,
                  title: currentPhase.title,
                  status: currentPhase.status,
                },
              }
            : {}),
          ...(lastPhaseCommit
            ? {
                lastPhaseCommit: {
                  phaseId: lastPhaseCommit.id,
                  title: lastPhaseCommit.title,
                  summary: lastPhaseCommit.summary,
                  outcome: lastPhaseCommit.outcome,
                  completedAt: lastPhaseCommit.completedAt,
                },
              }
            : {}),
          resumeCommand:
            "snipara-companion workflow resume --include-session-context",
        }
      : null,
    teamSync: {
      activeWorkCount: teamSyncSummary.activeWorkCount,
      staleWorkCount: teamSyncSummary.staleWorkCount,
      staleWorkExplanation: teamSyncSummary.staleWorkExplanation,
      archivedWorkCount: teamSyncSummary.archivedWorkCount,
      handoffCount: teamSyncSummary.handoffCount,
      ...(latestHandoff
        ? {
            latestHandoff: {
              summary: latestHandoff.summary,
              next: latestHandoff.next,
              attention: latestHandoff.attention,
              createdAt: latestHandoff.createdAt,
            },
          }
        : {}),
    },
    risks,
    openDecisions: {
      count: pendingDecisionCount,
      note: "Run snipara-companion brief for hosted decisions and memory authority signals.",
    },
    operationalLoop: buildAgenticOperationalLoop({
      state,
      dirtyFileCount,
      risks,
      pendingDecisionCount,
      teamSyncSummary,
      latestHandoff,
    }),
    suggestedNextAction: buildSuggestedAgenticNextAction(state, risks),
  };
}

function printAgenticWorkStatus(status: AgenticWorkStatus): void {
  console.log(chalk.bold("Agentic Work Status"));
  if (status.branch) {
    printKeyValue("Branch:", status.branch);
  }
  if (status.git.head) {
    printKeyValue("HEAD:", status.git.head);
  }
  printKeyValue("Dirty files:", status.git.dirtyFileCount);
  console.log("");

  if (status.workflow) {
    printKeyValue("Goal:", status.workflow.goal);
    printKeyValue(
      "Workflow:",
      `${status.workflow.id} (${status.workflow.status})`,
    );
    if (status.workflow.currentPhase) {
      printKeyValue(
        "Current phase:",
        `${status.workflow.currentPhase.id} (${status.workflow.currentPhase.status})`,
      );
    }
    if (status.workflow.lastPhaseCommit) {
      const lastCommit = status.workflow.lastPhaseCommit;
      printKeyValue(
        "Last phase commit:",
        `${lastCommit.phaseId}${lastCommit.summary ? ` - ${toPreview(lastCommit.summary, 100)}` : ""}`,
      );
    }
  } else {
    console.log("No active managed workflow state found locally.");
  }

  console.log("");
  console.log(chalk.bold("Team Sync"));
  console.log(`Active work: ${status.teamSync.activeWorkCount}`);
  console.log(`Stale work: ${status.teamSync.staleWorkCount}`);
  console.log(`Archived work: ${status.teamSync.archivedWorkCount}`);
  console.log(`Handoffs: ${status.teamSync.handoffCount}`);
  if (status.teamSync.staleWorkCount > 0) {
    console.log(
      `Stale detail: ${status.teamSync.staleWorkExplanation.message}`,
    );
  }
  if (status.teamSync.latestHandoff) {
    console.log(
      `Latest handoff: ${toPreview(status.teamSync.latestHandoff.summary, 120)}`,
    );
    if (status.teamSync.latestHandoff.next) {
      console.log(
        `Next from handoff: ${toPreview(status.teamSync.latestHandoff.next, 120)}`,
      );
    }
  }

  console.log("");
  console.log(chalk.bold("Risks"));
  if (status.risks.length > 0) {
    for (const risk of status.risks) {
      console.log(`- ${risk}`);
    }
  } else {
    console.log("- None recorded locally.");
  }

  console.log("");
  console.log(chalk.bold("Open Decisions"));
  if (typeof status.openDecisions.count === "number") {
    console.log(
      `Local pending Decision Requests: ${status.openDecisions.count}`,
    );
  }
  console.log(status.openDecisions.note);

  console.log("");
  console.log(chalk.bold("Operational Loop"));
  console.log(`Status: ${status.operationalLoop.status}`);
  console.log(`Receipt gaps: ${status.operationalLoop.receiptGapCount}`);
  for (const action of status.operationalLoop.nextActions) {
    console.log(`- ${action}`);
  }
  for (const action of status.operationalLoop.receiptActions) {
    console.log(`- ${action}`);
  }
  for (const caveat of status.operationalLoop.caveats) {
    console.log(`- ${caveat}`);
  }

  console.log("");
  printKeyValue("Next suggested action:", status.suggestedNextAction);
  if (status.workflow) {
    printKeyValue("Resume:", status.workflow.resumeCommand);
  }
  console.log("");
}

export async function agenticStatusCommand(options: {
  json?: boolean;
}): Promise<void> {
  const status = buildAgenticWorkStatus();
  if (options.json) {
    printJson(status);
    return;
  }
  printAgenticWorkStatus(status);
}

function pushTimelineEvent(
  events: AgenticTimelineEvent[],
  event: AgenticTimelineEvent | undefined,
): void {
  if (event?.time) {
    events.push(event);
  }
}

function workflowTimelineEvents(
  state: ManagedWorkflowState | undefined,
): AgenticTimelineEvent[] {
  if (!state) {
    return [];
  }

  const events: AgenticTimelineEvent[] = [];
  pushTimelineEvent(events, {
    time: state.createdAt,
    kind: "workflow-start",
    title: state.goal,
    detail: state.workflowId,
    source: "workflow",
  });

  for (const phase of state.phases) {
    if (phase.startedAt) {
      pushTimelineEvent(events, {
        time: phase.startedAt,
        kind: "phase-start",
        title: phase.title,
        detail: phase.id,
        source: "workflow",
        files: phase.files,
      });
    }
    if (phase.completedAt) {
      pushTimelineEvent(events, {
        time: phase.completedAt,
        kind: "phase-commit",
        title: phase.title,
        detail: phase.summary,
        source: "workflow",
        files: phase.files,
      });
    }
  }

  if (state.lastCommit?.committedAt) {
    pushTimelineEvent(events, {
      time: state.lastCommit.committedAt,
      kind: "final-commit",
      title: state.lastCommit.summary,
      detail: state.lastCommit.outcome,
      source: "workflow",
    });
  }

  return events;
}

function teamSyncWorkEvents(work: TeamSyncWorkRecord): AgenticTimelineEvent[] {
  const events: AgenticTimelineEvent[] = [
    {
      time: work.createdAt,
      kind: "team-sync-start",
      title: work.summary,
      detail: work.status,
      source: "team-sync",
      files: work.files,
    },
  ];

  if (work.completedAt) {
    events.push({
      time: work.completedAt,
      kind: "team-sync-complete",
      title: work.summary,
      detail: work.completionReason,
      source: "team-sync",
      files: work.files,
    });
  }

  return events;
}

function teamSyncHandoffEvent(
  handoff: TeamSyncHandoffRecord,
): AgenticTimelineEvent {
  return {
    time: handoff.createdAt,
    kind: "team-sync-handoff",
    title: handoff.summary,
    detail: handoff.next,
    source: "team-sync",
    files: handoff.files,
  };
}

export function buildAgenticTimeline(
  options: {
    limit?: number;
    cwd?: string;
  } = {},
): AgenticTimeline {
  const limit = options.limit && options.limit > 0 ? options.limit : 20;
  const state = readWorkflowState(options.cwd);
  const teamSyncState = loadTeamSyncState(options.cwd ?? process.cwd());
  const activityEvents = readActivityTimeline({ cwd: options.cwd }).map(
    (event) => ({
      time: event.timestamp,
      kind: event.kind,
      title: event.title,
      detail: event.summary ?? event.outcome,
      source: event.source,
      files: event.files,
    }),
  );
  const seen = new Set<string>();
  const events = [
    ...activityEvents,
    ...workflowTimelineEvents(state),
    ...teamSyncState.work.flatMap(teamSyncWorkEvents),
    ...teamSyncState.handoffs.map(teamSyncHandoffEvent),
  ]
    .sort((left, right) => String(right.time).localeCompare(String(left.time)))
    .filter((event) => {
      const key = [event.time, event.kind, event.title, event.source].join(
        "\u0000",
      );
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, limit);

  return {
    version: "snipara.agentic_timeline.v1",
    generatedAt: new Date().toISOString(),
    events,
    limit,
  };
}

function printAgenticTimeline(timeline: AgenticTimeline): void {
  console.log(chalk.bold("Agentic Timeline"));
  if (timeline.events.length === 0) {
    console.log("No workflow or Team Sync events found locally.");
    console.log("");
    return;
  }

  for (const event of timeline.events) {
    const detail = event.detail ? ` - ${toPreview(event.detail, 120)}` : "";
    console.log(`${event.time}  ${event.kind}  ${event.title}${detail}`);
    if (event.files?.length) {
      console.log(`  Files: ${event.files.slice(0, 6).join(", ")}`);
    }
  }
  console.log("");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function localWorkspacePathAliases(): string[] {
  const cwd = process.cwd();
  const aliases = new Set([cwd]);
  try {
    aliases.add(fs.realpathSync(cwd));
  } catch {
    // Best-effort redaction only.
  }
  for (const alias of [...aliases]) {
    if (alias.startsWith("/private/var/"))
      aliases.add(alias.replace(/^\/private/, ""));
    else if (alias.startsWith("/var/")) aliases.add(`/private${alias}`);
  }
  return [...aliases]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
}

function redactTimelineText(value: unknown, maxLength = 180): string {
  let text = toPreview(value, maxLength);
  for (const alias of localWorkspacePathAliases()) {
    text = text.replace(new RegExp(escapeRegExp(alias), "g"), "[workspace]");
  }
  return text
    .replace(/\/Users\/[^/\s)]+/g, "[home]")
    .replace(/\.snipara\/[^\s,)]+/g, "[local-state]")
    .replace(/\b(api[_-]?key|token|secret|password)=\S+/gi, "$1=[redacted]");
}

function redactTimelineFile(file: string): string {
  const workspaceAlias = localWorkspacePathAliases().find(
    (alias) => path.isAbsolute(file) && file.startsWith(alias),
  );
  const relative = workspaceAlias ? path.relative(workspaceAlias, file) : file;
  if (relative.startsWith(".snipara/") || relative === ".snipara") {
    return "[local-state]";
  }
  return redactTimelineText(relative, 120);
}

function formatAgenticTimelineMarkdown(timeline: AgenticTimeline): string {
  const lines = [
    "# Workflow Timeline",
    "",
    `Generated: ${timeline.generatedAt}`,
    `Events: ${timeline.events.length}`,
    "",
    "> Redacted local export. Absolute paths, local state paths, and secret-like fragments are removed.",
    "",
  ];

  for (const event of timeline.events) {
    lines.push(
      `## ${redactTimelineText(event.time, 40)} - ${redactTimelineText(event.kind, 80)}`,
    );
    lines.push("");
    lines.push(`- Source: ${redactTimelineText(event.source, 80)}`);
    lines.push(`- Title: ${redactTimelineText(event.title, 180)}`);
    if (event.detail) {
      lines.push(`- Summary: ${redactTimelineText(event.detail, 220)}`);
    }
    if (event.files?.length) {
      lines.push(
        `- Files: ${event.files
          .slice(0, 6)
          .map(redactTimelineFile)
          .join(
            ", ",
          )}${event.files.length > 6 ? ` (+${event.files.length - 6})` : ""}`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export async function workflowTimelineCommand(options: {
  limit?: number;
  exportFormat?: string;
  json?: boolean;
}): Promise<void> {
  const timeline = buildAgenticTimeline({ limit: options.limit });
  if (options.json) {
    printJson(timeline);
    return;
  }
  if (options.exportFormat) {
    if (options.exportFormat !== "md") {
      throw new Error(
        "Unsupported workflow timeline export format. Use --export md.",
      );
    }
    process.stdout.write(formatAgenticTimelineMarkdown(timeline));
    return;
  }
  printAgenticTimeline(timeline);
}

export async function workflowSessionCommand(options: {
  limit?: number;
  json?: boolean;
}): Promise<void> {
  const snapshot = writeSessionSnapshot({ limit: options.limit });
  if (options.json) {
    printJson(snapshot);
    return;
  }
  console.log(chalk.bold("Workflow Session Snapshot"));
  if (snapshot.workflow) {
    printKeyValue(
      "Workflow:",
      `${snapshot.workflow.id ?? "unknown"} (${snapshot.workflow.status ?? "unknown"})`,
    );
    if (snapshot.workflow.currentPhaseId) {
      printKeyValue(
        "Current phase:",
        `${snapshot.workflow.currentPhaseId}${
          snapshot.workflow.currentPhaseTitle
            ? ` - ${snapshot.workflow.currentPhaseTitle}`
            : ""
        }`,
      );
    }
  } else {
    console.log("No local workflow state found.");
  }
  printKeyValue("Activity events:", snapshot.activity.totalEvents);
  if (snapshot.activity.latestEventAt) {
    printKeyValue("Latest event:", snapshot.activity.latestEventAt);
  }
  printKeyValue("Pending decisions:", snapshot.decisions.pendingCount);
  printKeyValue("Resolved decisions:", snapshot.decisions.resolvedCount);
  printKeyValue("Producer artifacts:", snapshot.producerLoop.artifactCount);
  printKeyValue("Team Sync active work:", snapshot.teamSync.activeWorkCount);
  printKeyValue(
    "Intent:",
    `${snapshot.intentDetection.intent} (${snapshot.intentDetection.confidence})`,
  );
  printKeyValue(
    "Suggested mode:",
    `${snapshot.intentDetection.advisoryRouting.suggestedWorkflowMode} (advisory)`,
  );
  if (snapshot.intentDetection.signals.length > 0) {
    console.log(
      `Intent signals: ${snapshot.intentDetection.signals.slice(0, 5).join(", ")}`,
    );
  }
  printKeyValue(
    "Hard routing allowed:",
    String(snapshot.routing.hardRoutingAllowed),
  );
  console.log(`Reason: ${snapshot.routing.reason}`);
  printKeyValue("Snapshot:", snapshot.source.snapshotPath);
  printKeyValue("Build time:", `${snapshot.performance.buildMs}ms`);
}

export async function workflowPhaseStartCommand(options: {
  phaseId: string;
  json?: boolean;
}): Promise<void> {
  const state = readRequiredWorkflowState();
  const phase = findWorkflowPhase(state, options.phaseId);
  const now = new Date().toISOString();
  phase.status = "in_progress";
  phase.startedAt = phase.startedAt ?? now;
  state.status = "active";
  state.currentPhaseId = phase.id;
  const runtimeBinding = phase.needsRuntime
    ? ensureSandboxRuntimeBinding(state, phase, now)
    : undefined;
  state.updatedAt = now;
  writeWorkflowState(state);
  appendActivityEvent({
    source: "workflow",
    kind: "phase-start",
    title: phase.title,
    workflowId: state.workflowId,
    phaseId: phase.id,
    files: phase.files,
    timestamp: phase.startedAt,
    metadata: {
      status: phase.status,
      needsRuntime: Boolean(phase.needsRuntime),
    },
  });
  writeSessionSnapshot();

  if (options.json) {
    printJson({ workflow: state, current_phase: phase });
    return;
  }

  printManagedWorkflowState(state);
  printManagedWorkflowDiscipline();
  console.log(chalk.bold("Phase context gate"));
  console.log(
    "snipara-companion session-bootstrap --include-session-context --max-context-tokens 1000",
  );
  console.log(
    `snipara-companion workflow run --mode full --include-session-context --query ${shellQuote(
      phaseQuery(state, phase),
    )}`,
  );
  if (phase.files && phase.files.length > 0) {
    console.log(
      `snipara-companion code impact --changed-files ${phase.files.map(shellQuote).join(" ")} --diff-summary ${shellQuote(
        phase.title,
      )}`,
    );
  } else {
    console.log(
      "snipara-companion code impact --changed-files <files...> --diff-summary '<change>'",
    );
  }
  console.log(
    "For a named class/function/method in this phase, run: snipara-companion code symbol-card --qualified-name '<symbol>'",
  );
  if (runtimeBinding) {
    console.log(
      `Runtime binding: Snipara Sandbox session ${runtimeBinding.sessionId}`,
    );
    console.log(
      `Checkpoint runtime progress with: snipara-companion workflow runtime-checkpoint ${phase.id} --summary '<resume-ready runtime state>' --rehydrate-file <state.json>`,
    );
  }
  console.log("");
}

export async function workflowRuntimeCheckpointCommand(options: {
  phaseId: string;
  summary: string;
  environment?: string;
  profile?: string;
  files?: string[];
  commands?: string[];
  artifacts?: string[];
  contextPackIds?: string[];
  bootstrapQuery?: string;
  sandboxSessionId?: string;
  rehydrateJson?: string;
  rehydrateFile?: string;
  json?: boolean;
}): Promise<void> {
  const state = readRequiredWorkflowState();
  const phase = findWorkflowPhase(state, options.phaseId);
  const now = new Date().toISOString();
  const binding = ensureSandboxRuntimeBinding(state, phase, now);
  if (options.sandboxSessionId) {
    binding.sessionId = options.sandboxSessionId;
  }

  const rehydratableState = options.rehydrateFile
    ? readJsonRecord(options.rehydrateFile, "--rehydrate-file")
    : options.rehydrateJson
      ? parseJsonRecord(options.rehydrateJson, "--rehydrate-json")
      : undefined;
  if (rehydratableState) {
    const serialized = JSON.stringify(rehydratableState);
    if (serialized.length > 20_000) {
      throw new Error(
        "Rehydratable runtime state is too large for workflow runtime-checkpoint; store bulky data as artifacts and pass only compact JSON here.",
      );
    }
  }
  const contextPackReceipts = buildLocalContextPackReceipts({
    ids: options.contextPackIds ?? [],
    operation: "reference",
  });
  const contextPackArtifacts = contextPackReceipts.map(
    (receipt) => `context-pack:${receipt.pack_id}`,
  );

  const checkpoint = normalizeRuntimeCheckpointRecord({
    summary: options.summary,
    capturedAt: now,
    automationSessionId: loadConfig().sessionId,
    environment: stringValue(options.environment) ?? binding.environment,
    profile: stringValue(options.profile) ?? binding.profile,
    bootstrapQuery:
      stringValue(options.bootstrapQuery) ?? binding.bootstrapQuery,
    files: uniqueStringList(options.files) ?? phase.files ?? [],
    commands: uniqueStringList(options.commands) ?? [],
    artifacts:
      uniqueStringList([
        ...(options.artifacts ?? []),
        ...contextPackArtifacts,
      ]) ??
      binding.artifacts ??
      [],
    contextPackReceipts,
    ...(rehydratableState ? { rehydratableState } : {}),
  });

  binding.automationSessionId =
    checkpoint.automationSessionId ?? binding.automationSessionId;
  binding.environment = checkpoint.environment ?? binding.environment;
  binding.profile = checkpoint.profile ?? binding.profile;
  binding.bootstrapQuery = checkpoint.bootstrapQuery ?? binding.bootstrapQuery;
  binding.artifacts = checkpoint.artifacts ?? binding.artifacts;

  let hostedEvent:
    | {
        id?: string;
        createdAt?: string;
      }
    | undefined;
  let hostedError: string | undefined;

  if (isConfigured()) {
    try {
      const client = createClient(10000);
      const event = buildCanonicalEvent({
        eventType: "tool_result",
        payload: {
          tool_name: "snipara_sandbox_runtime_checkpoint",
          command: "workflow runtime-checkpoint",
          task: phase.title,
          files: checkpoint.files ?? [],
          commands: checkpoint.commands ?? [],
          workflow_id: state.workflowId,
          workflow_phase_id: phase.id,
          runtime_checkpoint: {
            summary: checkpoint.summary,
            captured_at: checkpoint.capturedAt,
            automation_session_id: checkpoint.automationSessionId,
            sandbox_session_id: binding.sessionId,
            environment: checkpoint.environment,
            profile: checkpoint.profile,
            bootstrap_query: checkpoint.bootstrapQuery,
            files: checkpoint.files ?? [],
            commands: checkpoint.commands ?? [],
            artifacts: checkpoint.artifacts ?? [],
            context_pack_receipts: checkpoint.contextPackReceipts ?? [],
            ...(checkpoint.rehydratableState
              ? { rehydratable_state: checkpoint.rehydratableState }
              : {}),
          },
        },
        contextPackReceipts,
      });
      const result = await client.emitEvent(event);
      hostedEvent = result.events[0]
        ? {
            id: result.events[0].id,
            createdAt: result.events[0].createdAt,
          }
        : undefined;
    } catch (error) {
      hostedError = error instanceof Error ? error.message : String(error);
    }
  }

  checkpoint.hostedEventId = hostedEvent?.id;
  checkpoint.hostedRecordedAt = hostedEvent?.createdAt;
  binding.lastCheckpoint = checkpoint;
  state.updatedAt = now;
  writeWorkflowState(state);
  appendActivityEvent({
    source: "workflow",
    kind: "runtime-checkpoint",
    title: phase.title,
    summary: checkpoint.summary,
    workflowId: state.workflowId,
    phaseId: phase.id,
    files: checkpoint.files,
    refs: [binding.sessionId, hostedEvent?.id].filter(Boolean) as string[],
    timestamp: checkpoint.capturedAt,
    metadata: {
      sandboxSessionId: binding.sessionId,
      hostedEventId: hostedEvent?.id,
      environment: checkpoint.environment,
      profile: checkpoint.profile,
      artifactCount: checkpoint.artifacts?.length ?? 0,
    },
  });
  writeSessionSnapshot();

  if (options.json) {
    printJson({
      workflow: state,
      runtime_binding: binding,
      runtime_checkpoint: checkpoint,
      hosted_event: hostedEvent ?? null,
      hosted_error: hostedError ?? null,
    });
    return;
  }

  console.log(chalk.bold("Runtime checkpoint"));
  console.log(`Phase: ${phase.id}`);
  console.log(`Sandbox session: ${binding.sessionId}`);
  console.log(`Summary: ${checkpoint.summary}`);
  if (checkpoint.environment) {
    console.log(`Environment: ${checkpoint.environment}`);
  }
  if (checkpoint.profile) {
    console.log(`Profile: ${checkpoint.profile}`);
  }
  const stateKeys = rehydratableStateKeys(checkpoint);
  if (stateKeys?.length) {
    console.log(`Rehydratable keys: ${stateKeys.join(", ")}`);
  }
  if (checkpoint.artifacts?.length) {
    console.log(`Artifacts: ${checkpoint.artifacts.join(", ")}`);
  }
  if (checkpoint.contextPackReceipts?.length) {
    console.log(
      `Context packs: ${checkpoint.contextPackReceipts
        .map((receipt) => receipt.pack_id)
        .join(", ")}`,
    );
  }
  if (hostedEvent?.id) {
    console.log(`Hosted runtime event: ${hostedEvent.id}`);
  } else if (hostedError) {
    console.log(`Hosted runtime event unavailable: ${hostedError}`);
  }
  console.log("");
  console.log(
    `Resume with: snipara-companion workflow resume --include-session-context`,
  );
}

export async function workflowResumeCommand(options: {
  maxCriticalTokens?: number;
  maxContextTokens?: number;
  includeSessionContext?: boolean;
  json?: boolean;
}): Promise<void> {
  const state = readRequiredWorkflowState();
  ensureConfigured();

  const resolvedContextTokens =
    options.maxContextTokens !== undefined
      ? options.maxContextTokens
      : options.includeSessionContext
        ? DEFAULT_SESSION_CONTEXT_TOKENS
        : 0;
  const client = createClient(15000);
  const resolvedCriticalTokens =
    options.maxCriticalTokens ?? DEFAULT_FULL_WORKFLOW_CRITICAL_TOKENS;
  const bootstrap = await client.getSessionMemories(
    resolvedCriticalTokens,
    resolvedContextTokens,
  );
  const bootstrapQuality = buildSessionBootstrapQuality(bootstrap, {
    expectedMaxTokens: resolvedCriticalTokens + resolvedContextTokens,
  });
  const teamSyncResume = await loadWorkflowTeamSyncResume(state);
  const runtimeResume = await loadWorkflowRuntimeResumePlan(state);
  const localSessionSnapshot = writeSessionSnapshot({ limit: 8 });

  if (options.json) {
    printJson({
      workflow: state,
      pending_decision_count: safeDecisionPendingCount(),
      local_session_snapshot: localSessionSnapshot,
      session_bootstrap: bootstrap,
      session_bootstrap_quality: bootstrapQuality,
      team_sync_resume: teamSyncResume?.data ?? null,
      team_sync_resume_error: teamSyncResume?.error,
      runtime_resume: runtimeResume?.data ?? null,
      runtime_resume_error: runtimeResume?.error,
      session_context: {
        included: resolvedContextTokens > 0,
        max_tokens: resolvedContextTokens,
      },
    });
    return;
  }

  console.log(chalk.bold("Workflow Resume"));
  printManagedWorkflowState(state);
  const printedBootstrap = printSessionBootstrap(bootstrap, {
    includeSessionContext: resolvedContextTokens > 0,
    maxTokens: resolvedCriticalTokens + resolvedContextTokens,
  });
  if (printedBootstrap) {
    printSessionBootstrapQuality(
      buildPrintedBootstrapQuality(printedBootstrap),
    );
  }
  printWorkflowLocalSessionSnapshot(localSessionSnapshot);
  printWorkflowTeamSyncResume(teamSyncResume);
  printWorkflowRuntimeResumePlan(runtimeResume);
  printManagedWorkflowResumeBoundary();
  printManagedWorkflowNextCommands(state);
}

async function loadWorkflowTeamSyncResume(
  state: ManagedWorkflowState,
): Promise<{ data?: TeamSyncResumeResponse; error?: string } | null> {
  const config = loadConfig();
  if (!config.apiKey) {
    return null;
  }

  const currentPhase =
    state.phases.find((phase) => phase.id === state.currentPhaseId) ??
    nextOpenPhase(state);
  const client = createClient(15000);

  try {
    return {
      data: await client.getLatestTeamSyncHandoff({
        sessionId: config.sessionId,
        branch: readCurrentGitBranch(),
        task: currentPhase?.title ?? state.goal,
        recentFiles: currentPhase?.files?.slice(0, 12) ?? [],
      }),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function printWorkflowLocalSessionSnapshot(snapshot: SessionSnapshot): void {
  console.log("");
  console.log(chalk.bold("Local Session Snapshot"));
  if (snapshot.summary.latestActivityAt) {
    printKeyValue("Latest activity:", snapshot.summary.latestActivityAt);
  }
  if (snapshot.summary.latestActivityTitle) {
    printKeyValue(
      "Latest title:",
      toPreview(snapshot.summary.latestActivityTitle, 160),
    );
  }
  printKeyValue("Risk:", snapshot.summary.risk);
  if (snapshot.summary.riskReasons.length > 0) {
    console.log(
      `Risk reasons: ${snapshot.summary.riskReasons.slice(0, 3).join("; ")}`,
    );
  }
  if (snapshot.summary.touchedFiles.length > 0) {
    console.log(
      `Touched files: ${snapshot.summary.touchedFiles.slice(0, 8).join(", ")}`,
    );
  }
  printKeyValue(
    "Intent:",
    `${snapshot.intentDetection.intent} (${snapshot.intentDetection.confidence})`,
  );
  printKeyValue(
    "Suggested mode:",
    `${snapshot.intentDetection.advisoryRouting.suggestedWorkflowMode} (advisory)`,
  );
  if (snapshot.intentDetection.signals.length > 0) {
    console.log(
      `Intent signals: ${snapshot.intentDetection.signals.slice(0, 5).join(", ")}`,
    );
  }
  printKeyValue(
    "Hard routing allowed:",
    String(snapshot.intentDetection.hardRoutingAllowed),
  );
  printKeyValue("Next action:", snapshot.summary.recommendedNextAction);
  printKeyValue("Snapshot:", snapshot.source.snapshotPath);
}

function printWorkflowTeamSyncResume(
  result: { data?: TeamSyncResumeResponse; error?: string } | null,
): void {
  if (!result) {
    return;
  }

  console.log("");
  console.log(chalk.bold("Hosted Team Sync"));

  if (result.error) {
    console.log(`Unavailable: ${result.error}`);
    return;
  }

  const data = result.data;
  if (!data) {
    console.log("No hosted Team Sync context was returned.");
    return;
  }

  if (data.handoff) {
    console.log(`Latest handoff: ${data.handoff.summary}`);
    console.log(`Match score: ${data.match.score}`);
    if (data.handoff.nextStep) {
      console.log(`Next step: ${data.handoff.nextStep}`);
    }
  } else {
    console.log("No hosted handoff matched the current workflow filters.");
  }

  if (data.sessionContext?.checkpoints.length) {
    console.log(`Checkpoints: ${data.sessionContext.checkpoints.length}`);
  }
  if (data.recommendedActions.length) {
    console.log(
      `Recommended actions: ${data.recommendedActions.slice(0, 3).join("; ")}`,
    );
  }
  if (data.caveats.length) {
    console.log(`Caveats: ${data.caveats.slice(0, 2).join("; ")}`);
  }
}

async function commitTaskMemory(options: {
  summary: string;
  category?: string;
  outcome?: TaskCommitOutcome;
  files?: string[];
}): Promise<Record<string, unknown>> {
  ensureConfigured();

  const client = createClient(TASK_COMMIT_TIMEOUT_MS);
  return client.endOfTaskCommit({
    summary: options.summary,
    category: options.category,
    outcome: options.outcome,
    filesTouched: options.files,
  });
}

async function commitPhaseTaskMemory(options: {
  summary: string;
  category?: string;
  outcome: TaskCommitOutcome;
  files?: string[];
}): Promise<Record<string, unknown>> {
  try {
    return await commitTaskMemory(options);
  } catch (error) {
    if (!isRetryableHostedCommitError(error)) {
      throw error;
    }

    return {
      stored_count: 0,
      skipped_count: 0,
      candidates: [],
      stored_candidates: [],
      skipped_candidates: [],
      hosted_phase_commit: {
        status: "error",
        error: hostedCommitErrorMessage(error),
        message:
          "Hosted snipara_end_of_task_commit failed; local workflow state and journal checkpoint were preserved.",
      },
      local_phase_commit: {
        status: "local_fallback",
        category: options.category,
        outcome: options.outcome,
        files: options.files ?? [],
      },
      message: "Hosted phase-commit failed; local workflow state was advanced",
    };
  }
}

function recordLocalFinalCommitHandoff(options: {
  summary: string;
  outcome: TaskCommitOutcome;
  files?: string[];
  error: string;
}): Record<string, unknown> {
  const rootDir = process.cwd();
  autoArchiveTeamSyncState(rootDir);
  const state = loadTeamSyncState(rootDir);
  const record = buildTeamSyncHandoffRecord({
    summary: truncateText(options.summary, FINAL_COMMIT_SUMMARY_MAX_CHARS),
    files: options.files,
    attention: options.outcome === "completed" ? "watch" : "proof",
    next:
      options.outcome === "completed"
        ? "Review this local fallback handoff before starting follow-up work."
        : "Resolve the blocker captured in this local fallback handoff.",
  });
  state.handoffs.push(record);
  state.updatedAt = record.createdAt;
  saveTeamSyncState(state, rootDir);

  return {
    status: "local_fallback",
    record_id: record.id,
    state_path: getTeamSyncStatePath(rootDir),
    category: "team_sync_handoff",
    source_session_id: "local-companion-fallback",
    files: record.files,
    error: options.error,
  };
}

async function commitFinalTaskMemory(options: {
  workflowId?: string;
  summary: string;
  category?: string;
  outcome: TaskCommitOutcome;
  files?: string[];
}): Promise<Record<string, unknown>> {
  ensureConfigured();

  const category = normalizeFinalCommitCategory(options.category);
  const attempts: Array<{ summary_chars: number; error?: string }> = [];
  const primarySummary = buildHostedFinalCommitSummary({
    workflowId: options.workflowId,
    summary: options.summary,
    maxLength: FINAL_COMMIT_SUMMARY_MAX_CHARS,
  });
  const retrySummary = buildHostedFinalCommitSummary({
    workflowId: options.workflowId,
    summary: options.summary,
    maxLength: FINAL_COMMIT_RETRY_SUMMARY_MAX_CHARS,
  });

  const callHosted = async (
    summary: string,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> => {
    const client = createClient(timeoutMs);
    const handoffOnly = isFinalCommitCategory(category);
    return client.endOfTaskCommit({
      summary,
      category,
      outcome: options.outcome,
      filesTouched: options.files,
      persistTypes: handoffOnly ? [] : ["decision", "learning", "workflow"],
      handoffOnly,
    });
  };

  try {
    return await callHosted(
      primarySummary,
      positiveIntegerEnv(
        "SNIPARA_FINAL_COMMIT_TIMEOUT_MS",
        FINAL_COMMIT_TIMEOUT_MS,
      ),
    );
  } catch (error) {
    attempts.push({
      summary_chars: primarySummary.length,
      error: hostedCommitErrorMessage(error),
    });
    if (shouldRetryHostedFinalCommit(error)) {
      try {
        return await callHosted(
          retrySummary,
          positiveIntegerEnv(
            "SNIPARA_FINAL_COMMIT_RETRY_TIMEOUT_MS",
            FINAL_COMMIT_RETRY_TIMEOUT_MS,
          ),
        );
      } catch (retryError) {
        attempts.push({
          summary_chars: retrySummary.length,
          error: hostedCommitErrorMessage(retryError),
        });
      }
    }
  }

  const lastError =
    attempts[attempts.length - 1]?.error ?? "hosted final-commit failed";
  const localHandoff = recordLocalFinalCommitHandoff({
    summary: options.summary,
    outcome: options.outcome,
    files: options.files,
    error: lastError,
  });

  return {
    stored_count: 0,
    skipped_count: 0,
    candidates: [],
    stored_candidates: [],
    skipped_candidates: [],
    team_sync_handoff: localHandoff,
    hosted_final_commit: {
      status: "error",
      attempts,
      message:
        "Hosted snipara_end_of_task_commit failed; local workflow state and Team Sync fallback handoff were preserved.",
    },
    message: "Hosted final-commit failed; local fallback handoff created",
  };
}

function printJournalWarning(result?: JournalWriteResult): void {
  if (result?.status === "error" && result.error) {
    console.log(`Journal checkpoint: ${result.error}`);
  }
}

function printTeamSyncCompletionNotice(
  completedWork: TeamSyncWorkRecord[],
): void {
  if (completedWork.length === 0) {
    return;
  }
  console.log(
    `Team Sync completed work: ${completedWork.map((item) => item.summary).join(", ")}`,
  );
}

function printProducerLoopArtifactNotice(
  result: ProducerLoopArtifactWriteResult,
): void {
  if (result.status === "written" && result.relativePath) {
    console.log(`Producer Loop artifact: ${result.relativePath}`);
    return;
  }
  if (result.status === "error" && result.error) {
    console.log(chalk.yellow(`Producer Loop artifact failed: ${result.error}`));
  }
}

function printWhyCaptureNotice(result: CompanionWhyCaptureReceipt): void {
  if (result.status === "captured") {
    console.log(
      `Why Capture: ${result.capturedCount} candidate(s) filed for review`,
    );
    return;
  }
  if (result.status === "error" && result.error) {
    console.log(
      chalk.yellow(
        `Why Capture failed without blocking the commit: ${result.error}`,
      ),
    );
  }
}

export async function workflowPhaseCommitCommand(options: {
  phaseId: string;
  summary: string;
  category?: string;
  outcome?: TaskCommitOutcome;
  files?: string[];
  evidence?: string[];
  json?: boolean;
}): Promise<void> {
  const state = readRequiredWorkflowState();
  const phase = findWorkflowPhase(state, options.phaseId);
  const outcome = options.outcome ?? "completed";
  const category = options.category ?? "workflow-phase";
  const files =
    options.files && options.files.length > 0 ? options.files : phase.files;

  await memoryGuardCheckCommand({
    trigger: "commit",
    files,
    strict: true,
  });

  const durableSummary = buildWorkflowPhaseCommitSummary({
    workflowId: state.workflowId,
    phase,
    summary: options.summary,
  });
  const result = await commitPhaseTaskMemory({
    summary: durableSummary,
    category,
    outcome,
    files,
  });

  const now = new Date().toISOString();
  phase.status = phaseStatusFromOutcome(outcome);
  phase.completedAt = now;
  phase.summary = options.summary;
  phase.outcome = outcome;
  if (files && files.length > 0) {
    phase.files = files;
  }
  const phaseCommitReceipt = buildWorkflowPhaseCommitReceipt({
    phaseId: phase.id,
    category,
    outcome,
    result,
    capturedAt: now,
  });
  state.phaseCommitReceipts = [
    ...(state.phaseCommitReceipts ?? []).filter(
      (receipt) => receipt.phaseId !== phase.id,
    ),
    phaseCommitReceipt,
  ];

  const next = nextOpenPhase(state);
  state.currentPhaseId = next?.id;
  state.status = state.phases.every((candidate) =>
    ["completed", "skipped"].includes(candidate.status),
  )
    ? "completed"
    : phase.status === "blocked"
      ? "blocked"
      : "active";
  state.updatedAt = now;
  state.lastCommit = {
    category,
    outcome,
    summary: options.summary,
    committedAt: now,
  };
  writeWorkflowState(state);
  const judgmentReceipts = await closeManagedWorkflowJudgment({
    state,
    summary: options.summary,
    outcome,
    files,
    evidence: options.evidence,
    sourceRef: `workflow:${state.workflowId}:phase:${phase.id}`,
    trigger: "snipara-companion workflow phase-commit",
    requireEvidence: true,
  });
  const shouldCompleteTeamSyncWork =
    outcome === "completed" && state.status === "completed";
  const completedTeamSyncWork = shouldCompleteTeamSyncWork
    ? completeTeamSyncStateFromEvidence(process.cwd(), {
        workflowGoal: state.goal,
        summary: options.summary,
        files,
        reason: `Workflow ${state.workflowId} completed after phase ${phase.id} phase-commit.`,
      })
    : [];
  const journal = await appendJournalCheckpoint({
    action: "workflow:phase-commit",
    summary: options.summary,
    outcome,
    workflowId: state.workflowId,
    phaseId: phase.id,
    phaseTitle: phase.title,
    files,
  });
  const producerLoopArtifact = writeProducerLoopArtifact({
    kind: "workflow_phase_commit",
    command: "workflow phase-commit",
    state,
    phase,
    category,
    outcome,
    summary: options.summary,
    files,
    journalAttempted: true,
    teamSyncCompletionAttempted: shouldCompleteTeamSyncWork,
  });
  const whyCapture = await captureCompanionWhy({
    sourceKind: "phase_commit",
    sourceSessionId: state.workflowId,
    task: `${state.goal} / ${phase.title}`,
    summary: options.summary,
    files,
    commands: readLatestWorkflowCommands(process.cwd()),
  });
  phaseCommitReceipt.whyCapture = whyCapture;
  writeWorkflowState(state);
  const coordinationRelease = await releaseWorkflowCoordination(
    state,
    `Workflow ${state.workflowId} phase ${phase.id} phase-commit.`,
  );
  appendActivityEvent({
    source: "workflow",
    kind: "phase-commit",
    title: phase.title,
    summary: options.summary,
    workflowId: state.workflowId,
    phaseId: phase.id,
    outcome,
    files,
    refs: [
      producerLoopArtifact.artifactId,
      producerLoopArtifact.relativePath,
    ].filter(Boolean) as string[],
    timestamp: now,
    metadata: {
      category,
      workflowStatus: state.status,
      producerLoopStatus: producerLoopArtifact.status,
      whyCaptureStatus: whyCapture.status,
      whyCaptureCandidateCount: whyCapture.capturedCount,
      retainedMemoryCount: phaseCommitReceipt.stored.length,
      skippedMemoryCount: phaseCommitReceipt.skipped.length,
      journalStatus: journal.status,
      teamSyncCompletedCount: completedTeamSyncWork.length,
      coordinationReleaseStatus: coordinationRelease?.hostedReleaseStatus,
      judgmentReceiptCount: judgmentReceipts.length,
    },
  });
  if (producerLoopArtifact.status === "written") {
    appendActivityEvent({
      source: "producer-loop",
      kind: "producer-loop-artifact",
      title: producerLoopArtifact.artifactId ?? "producer-loop-artifact",
      summary: options.summary,
      workflowId: state.workflowId,
      phaseId: phase.id,
      outcome,
      files,
      refs: [producerLoopArtifact.relativePath].filter(Boolean) as string[],
      timestamp: now,
      metadata: {
        artifactHash: producerLoopArtifact.artifactHash,
        ledgerHash: producerLoopArtifact.ledgerHash,
      },
    });
  }
  writeSessionSnapshot();

  if (options.json) {
    printJson({
      workflow: state,
      commit: result,
      journal,
      teamSyncCompletedWork: completedTeamSyncWork,
      producerLoopArtifact,
      whyCapture,
      coordinationRelease,
      judgmentReceipts,
    });
    return;
  }
  printTaskCommitResult(result);
  printJournalWarning(journal);
  printTeamSyncCompletionNotice(completedTeamSyncWork);
  printProducerLoopArtifactNotice(producerLoopArtifact);
  printWhyCaptureNotice(whyCapture);
  if (judgmentReceipts.length > 0) {
    console.log(
      `Judgment receipts: ${judgmentReceipts.filter((receipt) => receipt.status === "recorded").length}/${judgmentReceipts.length} recorded`
    );
  }
  printManagedWorkflowState(state);
  printManagedWorkflowNextCommands(state);
}

export async function finalCommitCommand(options: {
  summary: string;
  why?: string;
  category?: string;
  outcome?: TaskCommitOutcome;
  files?: string[];
  evidence?: string[];
  risks?: string[];
  nextStep?: string;
  json?: boolean;
}): Promise<void> {
  const state = readWorkflowState();
  const pendingJudgmentResponses = state?.judgment?.card.advisorRecommendations.filter(
    (recommendation) =>
      !state.judgment?.responses.some((response) => response.recommendationId === recommendation.id)
  );
  if (pendingJudgmentResponses && pendingJudgmentResponses.length > 0) {
    throw new Error(
      `Managed workflow judgment has ${pendingJudgmentResponses.length} unanswered recommendation(s): ${pendingJudgmentResponses
        .map((item) => item.id)
        .join(
          ", "
        )}. Record accepted, modified, ignored, or blocked explicitly before final-commit.`
    );
  }
  await memoryGuardCheckCommand({
    trigger: "pre-final",
    files: options.files,
    strict: true,
  });

  const outcome = options.outcome ?? "completed";
  const category = normalizeFinalCommitCategory(options.category);
  const result = await commitFinalTaskMemory({
    workflowId: state?.workflowId,
    summary: options.summary,
    category,
    outcome,
    files: options.files,
  });

  if (state) {
    const now = new Date().toISOString();
    state.status = outcome === "completed" ? "completed" : "blocked";
    state.currentPhaseId =
      outcome === "completed" ? undefined : state.currentPhaseId;
    state.updatedAt = now;
    state.lastCommit = {
      category,
      outcome,
      summary: options.summary,
      committedAt: now,
    };
    writeWorkflowState(state);
  }
  const judgmentReceipts = await closeManagedWorkflowJudgment({
    state,
    summary: options.summary,
    outcome,
    files: options.files,
    evidence: options.evidence,
    sourceRef: `workflow:${state?.workflowId ?? "unmanaged"}:final`,
    trigger: "snipara-companion workflow final-commit",
  });
  const completedTeamSyncWork =
    outcome === "completed"
      ? completeTeamSyncStateFromEvidence(process.cwd(), {
          workflowGoal: state?.goal,
          summary: options.summary,
          files: options.files,
          reason: state?.workflowId
            ? `Workflow ${state.workflowId} completed by final-commit.`
            : "Completed by final-commit.",
        })
      : [];
  const journal = await appendJournalCheckpoint({
    action: "workflow:final-commit",
    summary: options.summary,
    outcome,
    workflowId: state?.workflowId,
    files: options.files,
  });
  const producerLoopArtifact = writeProducerLoopArtifact({
    kind: "workflow_final_commit",
    command: "workflow final-commit",
    state,
    category,
    outcome,
    summary: options.summary,
    files: options.files,
    journalAttempted: true,
    teamSyncCompletionAttempted: outcome === "completed",
  });
  const whyCapture = await captureCompanionWhy({
    sourceKind: "final_commit",
    sourceSessionId: state?.workflowId ?? loadConfig().sessionId,
    task: state?.goal,
    summary: options.summary,
    why: options.why,
    files: options.files,
    commands: readLatestWorkflowCommands(process.cwd()),
  });
  const coordinationRelease = state
    ? await releaseWorkflowCoordination(
        state,
        `Workflow ${state.workflowId} final-commit.`,
      )
    : undefined;
  const report = buildFinalCommitReport({
    state,
    summary: options.summary,
    why: options.why,
    outcome,
    files: options.files,
    evidence: options.evidence,
    risks: options.risks,
    nextStep: options.nextStep,
    whyCapture,
    finalCommitResult: result,
  });
  const reportArtifact = writeFinalCommitReport(report);
  if (state) {
    state.finalReport = reportArtifact;
    writeWorkflowState(state);
  }
  const now = state?.lastCommit?.committedAt ?? new Date().toISOString();
  appendActivityEvent({
    source: "workflow",
    kind: "final-commit",
    title: state?.goal ?? "final-commit",
    summary: options.summary,
    workflowId: state?.workflowId,
    outcome,
    files: options.files,
    refs: [
      producerLoopArtifact.artifactId,
      producerLoopArtifact.relativePath,
      reportArtifact.status === "written"
        ? reportArtifact.relativePath
        : undefined,
    ].filter(Boolean) as string[],
    timestamp: now,
    metadata: {
      category,
      producerLoopStatus: producerLoopArtifact.status,
      whyCaptureStatus: whyCapture.status,
      whyCaptureCandidateCount: whyCapture.capturedCount,
      finalReportStatus: reportArtifact.status,
      retainedDecisionCount: report.retainedDecisions.items.length,
      pendingDecisionCount: report.pendingDecisions.items.length,
      journalStatus: journal.status,
      teamSyncCompletedCount: completedTeamSyncWork.length,
      coordinationReleaseStatus: coordinationRelease?.hostedReleaseStatus,
      judgmentReceiptCount: judgmentReceipts.length,
    },
  });
  if (producerLoopArtifact.status === "written") {
    appendActivityEvent({
      source: "producer-loop",
      kind: "producer-loop-artifact",
      title: producerLoopArtifact.artifactId ?? "producer-loop-artifact",
      summary: options.summary,
      workflowId: state?.workflowId,
      outcome,
      files: options.files,
      refs: [producerLoopArtifact.relativePath].filter(Boolean) as string[],
      timestamp: now,
      metadata: {
        artifactHash: producerLoopArtifact.artifactHash,
        ledgerHash: producerLoopArtifact.ledgerHash,
      },
    });
  }
  writeSessionSnapshot();

  if (options.json) {
    printJson({
      workflow: state,
      commit: result,
      journal,
      teamSyncCompletedWork: completedTeamSyncWork,
      producerLoopArtifact,
      whyCapture,
      coordinationRelease,
      report,
      reportArtifact,
      judgmentReceipts,
    });
    return;
  }
  console.log(formatFinalCommitReport(report));
  console.log("");
  printFinalCommitHandoffResult(result);
  if (reportArtifact.status === "written") {
    printKeyValue("Final report:", reportArtifact.relativePath);
  } else if (reportArtifact.error) {
    console.log(
      chalk.yellow(`Final report write failed: ${reportArtifact.error}`),
    );
  }
  printJournalWarning(journal);
  printTeamSyncCompletionNotice(completedTeamSyncWork);
  printProducerLoopArtifactNotice(producerLoopArtifact);
  printWhyCaptureNotice(whyCapture);
  if (judgmentReceipts.length > 0) {
    console.log(
      `Judgment receipts: ${judgmentReceipts.filter((receipt) => receipt.status === "recorded").length}/${judgmentReceipts.length} recorded`
    );
  }
  if (state) {
    printManagedWorkflowState(state);
  }
}

export async function loadDocumentCommand(options: {
  path: string;
  json?: boolean;
}): Promise<void> {
  ensureConfigured();

  const client = createClient(15000);
  const result = await client.loadDocument(options.path);
  if (options.json) {
    printJson(result);
    return;
  }
  printLoadDocumentResult(options.path, result);
}

export async function sessionBootstrapCommand(options: {
  maxCriticalTokens?: number;
  maxContextTokens?: number;
  includeSessionContext?: boolean;
  json?: boolean;
}): Promise<void> {
  if (!isConfigured()) {
    if (options.json) {
      printJson({
        critical: { memories: [], count: 0, tokens: 0 },
        daily: { memories: [], count: 0, tokens: 0 },
        total_tokens: 0,
        session_context: {
          included: Boolean(options.includeSessionContext),
          max_tokens: options.includeSessionContext
            ? DEFAULT_SESSION_CONTEXT_TOKENS
            : 0,
        },
        session_bootstrap_quality: buildSessionBootstrapQuality({
          critical: { memories: [], count: 0, tokens: 0 },
          daily: { memories: [], count: 0, tokens: 0 },
          total_tokens: 0,
        }),
      });
    }
    return;
  }

  const resolvedContextTokens =
    options.maxContextTokens !== undefined
      ? options.maxContextTokens
      : options.includeSessionContext
        ? DEFAULT_SESSION_CONTEXT_TOKENS
        : 0;
  const client = createClient(15000);
  const result = await client.getSessionMemories(
    options.maxCriticalTokens,
    resolvedContextTokens,
  );
  const bootstrapQuality = buildSessionBootstrapQuality(result, {
    expectedMaxTokens:
      (options.maxCriticalTokens ?? DEFAULT_FULL_WORKFLOW_CRITICAL_TOKENS) +
      resolvedContextTokens,
  });
  const config = loadConfig();
  const warmSnapshot = createLocalQueryCache({
    cwd: process.cwd(),
    projectId: config.projectId,
    sessionId: config.sessionId,
  }).storeWarmSnapshot(result);

  if (options.json) {
    printJson({
      ...result,
      local_warm_snapshot: {
        stored_entries: warmSnapshot.storedEntries,
      },
      session_context: {
        included: resolvedContextTokens > 0,
        max_tokens: resolvedContextTokens,
      },
      session_bootstrap_quality: bootstrapQuality,
    });
    return;
  }
  const printedBootstrap = printSessionBootstrap(result, {
    includeSessionContext: resolvedContextTokens > 0,
    maxTokens:
      (options.maxCriticalTokens ?? DEFAULT_FULL_WORKFLOW_CRITICAL_TOKENS) +
      resolvedContextTokens,
  });
  if (printedBootstrap) {
    printSessionBootstrapQuality(
      buildPrintedBootstrapQuality(printedBootstrap),
    );
  }
}

function emptySessionMemoriesResult(): SessionMemoriesResult {
  return {
    critical: { memories: [], count: 0, tokens: 0 },
    daily: { memories: [], count: 0, tokens: 0 },
    total_tokens: 0,
  };
}

function readLocalJsonFile(
  relativePath: string,
): Record<string, unknown> | null {
  const absolutePath = path.join(process.cwd(), relativePath);
  if (!fs.existsSync(absolutePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      fs.readFileSync(absolutePath, "utf-8"),
    ) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function summarizeSourceSnapshot(
  snapshot: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!snapshot) {
    return {
      status: "missing",
      snapshotPath: path.join(".snipara", "source", "latest.json"),
      nextAction:
        "Run snipara-companion source sync --json after meaningful local code or docs movement.",
    };
  }

  const summary =
    snapshot.summary &&
    typeof snapshot.summary === "object" &&
    !Array.isArray(snapshot.summary)
      ? (snapshot.summary as Record<string, unknown>)
      : {};
  return {
    status: "present",
    snapshotPath: path.join(".snipara", "source", "latest.json"),
    generatedAt: snapshot.generatedAt,
    revision: snapshot.revision,
    totalFiles: summary.totalFiles,
    totalBytes: summary.totalBytes,
    skipped: summary.skipped,
  };
}

function summarizeWorkflowStateForContinuity(
  workflow: ManagedWorkflowState | undefined,
): Record<string, unknown> {
  if (!workflow) {
    return {
      status: "missing",
      statePath: WORKFLOW_STATE_RELATIVE_PATH,
      nextAction: "Run snipara-companion workflow start for multi-phase work.",
    };
  }

  return {
    status: workflow.status,
    workflowId: workflow.workflowId,
    goal: workflow.goal,
    currentPhaseId: workflow.currentPhaseId,
    statePath: WORKFLOW_STATE_RELATIVE_PATH,
    phases: workflow.phases.map((phase) => ({
      id: phase.id,
      title: phase.title,
      status: phase.status,
    })),
  };
}

function summarizeTeamSyncForContinuity(): Record<string, unknown> {
  const state = loadTeamSyncState();
  const summary = buildTeamSyncSummary(state);
  const latestHandoff = state.handoffs.at(-1);

  return {
    statePath: path.relative(process.cwd(), getTeamSyncStatePath()),
    activeWorkCount: summary.activeWorkCount,
    staleWorkCount: summary.staleWorkCount,
    completedWorkCount: summary.completedWorkCount,
    archivedWorkCount: summary.archivedWorkCount,
    handoffCount: summary.handoffCount,
    latestHandoff: latestHandoff
      ? {
          summary: latestHandoff.summary,
          next: latestHandoff.next,
          attention: latestHandoff.attention,
          createdAt: latestHandoff.createdAt,
        }
      : null,
  };
}

function buildCompanionContinuityPayload(args: {
  configured: boolean;
  bootstrap: SessionMemoriesResult;
  bootstrapQuality: SessionBootstrapQualityReport;
  includeSessionContext: boolean;
  maxContextTokens: number;
  warmSnapshotStoredEntries: number;
}): Record<string, unknown> {
  const config = args.configured ? loadConfig() : null;
  const workflow = readWorkflowState();
  const sessionSnapshot = readSessionSnapshot();
  const sourceSnapshot = readLocalJsonFile(
    path.join(".snipara", "source", "latest.json"),
  );

  return {
    version: COMPANION_CONTINUITY_CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    configured: args.configured,
    project: config
      ? {
          projectId: config.projectId,
          apiUrl: config.apiUrl,
          sessionId: config.sessionId,
        }
      : null,
    artifacts: {
      workflowStatePath: WORKFLOW_STATE_RELATIVE_PATH,
      teamSyncStatePath: path.relative(process.cwd(), getTeamSyncStatePath()),
      sessionSnapshotPath: path.join(".snipara", "activity", "session.json"),
      sourceSnapshotPath: path.join(".snipara", "source", "latest.json"),
    },
    bootstrap: args.bootstrap,
    bootstrapQuality: args.bootstrapQuality,
    localWarmSnapshot: {
      storedEntries: args.warmSnapshotStoredEntries,
    },
    sessionContext: {
      included: args.includeSessionContext,
      maxTokens: args.maxContextTokens,
    },
    workflow: summarizeWorkflowStateForContinuity(workflow),
    teamSync: summarizeTeamSyncForContinuity(),
    source: summarizeSourceSnapshot(sourceSnapshot),
    sessionSnapshot: sessionSnapshot
      ? {
          latestActivityAt: sessionSnapshot.summary.latestActivityAt,
          latestTitle: sessionSnapshot.summary.latestActivityTitle,
          latestKind: sessionSnapshot.summary.latestActivityKind,
          risk: sessionSnapshot.summary.risk,
          riskReasons: sessionSnapshot.summary.riskReasons,
          touchedFiles: sessionSnapshot.summary.touchedFiles,
          nextAction: sessionSnapshot.summary.recommendedNextAction,
        }
      : null,
    nextActions: [
      {
        id: "open_bootstrap_brief",
        label: "Open bootstrap brief",
        command:
          "snipara-companion session-bootstrap --include-session-context --max-context-tokens 1000",
        when: "bootstrap has entries or session context is included",
      },
      {
        id: "refresh_source_snapshot",
        label: "Refresh source snapshot",
        command: "snipara-companion source sync --json",
        when: "source.status is missing or local code/docs changed",
      },
      {
        id: "run_impact_gate",
        label: "Run code impact before risky edits",
        command:
          'snipara-companion code impact --changed-files <files> --diff-summary "next edit"',
        when: "the next edit is multi-file, risky, or user-visible",
      },
      {
        id: "commit_task_context",
        label: "Commit durable task context",
        command:
          'snipara-companion task-commit --summary "<done>" --files <files>',
        when: "a durable phase or task is complete",
      },
    ],
  };
}

export async function continueWorkspaceCommand(options: {
  maxCriticalTokens?: number;
  maxContextTokens?: number;
  includeSessionContext?: boolean;
  json?: boolean;
}): Promise<void> {
  const configured = isConfigured();
  const resolvedContextTokens =
    options.maxContextTokens !== undefined
      ? options.maxContextTokens
      : options.includeSessionContext
        ? DEFAULT_SESSION_CONTEXT_TOKENS
        : 0;

  let bootstrap = emptySessionMemoriesResult();
  let warmSnapshotStoredEntries = 0;

  if (configured) {
    const client = createClient(15000);
    bootstrap = await client.getSessionMemories(
      options.maxCriticalTokens,
      resolvedContextTokens,
    );
    const config = loadConfig();
    const warmSnapshot = createLocalQueryCache({
      cwd: process.cwd(),
      projectId: config.projectId,
      sessionId: config.sessionId,
    }).storeWarmSnapshot(bootstrap);
    warmSnapshotStoredEntries = warmSnapshot.storedEntries;
  }

  const bootstrapQuality = buildSessionBootstrapQuality(bootstrap, {
    expectedMaxTokens:
      (options.maxCriticalTokens ?? DEFAULT_FULL_WORKFLOW_CRITICAL_TOKENS) +
      resolvedContextTokens,
  });
  const payload = buildCompanionContinuityPayload({
    configured,
    bootstrap,
    bootstrapQuality,
    includeSessionContext: resolvedContextTokens > 0,
    maxContextTokens: resolvedContextTokens,
    warmSnapshotStoredEntries,
  });

  if (options.json) {
    printJson(payload);
    return;
  }

  console.log(chalk.bold("Snipara Companion Continuity"));
  console.log(`Version: ${COMPANION_CONTINUITY_CONTRACT_VERSION}`);
  console.log(`Configured: ${configured ? "yes" : "no"}`);
  console.log(
    `Workflow: ${(payload.workflow as Record<string, unknown>).status ?? "unknown"}`,
  );
  console.log(
    `Source: ${(payload.source as Record<string, unknown>).status ?? "unknown"}`,
  );
  console.log(
    "Next: snipara-companion continue-workspace --json for editor integrations",
  );
}

export async function recallCommand(options: {
  query: string;
  type?: "fact" | "decision" | "learning" | "preference" | "todo" | "context";
  scope?: "agent" | "project" | "team" | "user";
  category?: string;
  limit?: number;
  minRelevance?: number;
  includeInactive?: boolean;
  warningThreshold?: number;
  json?: boolean;
}): Promise<void> {
  ensureConfigured();

  const client = createClient(15000);
  const result = await client.recallMemories(options.query, {
    type: options.type,
    scope: options.scope,
    category: options.category,
    limit: options.limit,
    minRelevance: options.minRelevance,
    includeInactive: options.includeInactive,
    warningThreshold: options.warningThreshold,
  });
  if (options.json) {
    printJson(result);
    return;
  }
  printRecallResult(result);
}

export async function taskCommitCommand(options: {
  summary: string;
  category?: string;
  outcome?: "completed" | "partial" | "blocked" | "abandoned";
  files?: string[];
  json?: boolean;
}): Promise<void> {
  ensureConfigured();

  await memoryGuardCheckCommand({
    trigger: "commit",
    files: options.files,
    strict: true,
  });

  const client = createClient(30000);
  const result = await client.endOfTaskCommit({
    summary: options.summary,
    category: options.category,
    outcome: options.outcome,
    filesTouched: options.files,
  });
  if (options.json) {
    printJson(result);
    return;
  }
  printTaskCommitResult(result);
}
