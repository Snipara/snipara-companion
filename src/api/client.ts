/**
 * Hosted Snipara API client and shared response types.
 *
 * `createClient` builds the authenticated client every command uses to reach
 * Snipara Hosted MCP / API (context query, memory, code graph, collaboration,
 * Team Sync, automations, …). This module also defines the shared response
 * type definitions those commands consume. Auth and base URL come from the
 * companion config (see config/store).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AdvisorInfluenceLifecycle,
  HostedContextControlApplyReceipt,
  HostedContextControlPlan,
  HostedContextControlSource,
} from "../contracts/project-intelligence";
import {
  loadConfig,
  type ConfigResolutionOptions,
  type RLMConfig,
} from "../config/store";
import { resolveProject } from "../project/resolver";

export interface ContextQueryResult {
  sections: Array<{
    title: string;
    content: string;
    file: string;
    lines: [number, number];
    relevance_score: number;
    token_count: number;
    truncated: boolean;
    quality_score?: number | null;
    quality_flags?: string[];
  }>;
  total_tokens: number;
  max_tokens: number;
  query: string;
  suggestions?: string[];
  answer_pack?: AnswerPack | null;
  answer_pack_included?: boolean;
  answer_pack_tokens?: number;
  routing_recommendation?: "direct" | "rlm";
  routing_confidence?: number;
  routing_reason?: string;
  query_complexity?: "simple" | "moderate" | "complex";
  recommended_tool?: string;
  recommended_tool_arguments?: Record<string, unknown>;
  graph_hybrid_used?: boolean;
  graph_context_tool?: string;
  graph_context_summary?: string;
  search_mode?: ContextQuerySearchMode;
  timing?: Record<string, number>;
  retrieval_diagnostics?: Record<string, unknown>;
}

export type ContextQuerySearchMode = "keyword" | "semantic" | "hybrid";

export interface ContextQueryOptions {
  searchMode?: ContextQuerySearchMode;
  includeMetadata?: boolean;
  includeAnswerPack?: boolean;
  autoDecompose?: boolean;
  includeSharedContext?: boolean;
  includeAllTiers?: boolean;
  returnReferences?: boolean;
}

export interface AnswerPackSource {
  title?: string;
  file?: string;
  lines?: [number, number] | number[];
  relevance_score?: number;
  quality_score?: number | null;
}

export interface AnswerPackClaim {
  claim: string;
  source?: AnswerPackSource;
  score?: number;
}

export interface AnswerPack {
  version?: string;
  query_intent?: string;
  source_facts?: AnswerPackClaim[];
  source_map?: AnswerPackSource[];
  caveats?: AnswerPackClaim[];
  what_not_to_claim?: string[];
  verification_checklist?: string[];
  low_confidence?: boolean;
  code_context?: {
    recommended_tool?: string | null;
    recommended_tool_arguments?: Record<string, unknown>;
    graph_context_included?: boolean;
    impact_hint?: string | null;
  };
  token_count?: number;
}

export interface HostedContextControlDiffResponse {
  project: { id: string; name: string; slug: string };
  plan: HostedContextControlPlan;
}

export interface HostedContextControlApplyResponse {
  project: { id: string; name: string; slug: string };
  receipt: HostedContextControlApplyReceipt;
}

export interface CodeGraphNodeResult {
  symbol_key: string;
  qualified_name: string;
  local_name: string;
  kind: string;
  language: string;
  module_path: string;
  file_path: string;
  start_line: number;
  end_line: number;
  signature?: string | null;
  depth?: number;
}

export interface CodeGraphEdgeResult {
  from_symbol_key: string;
  to_symbol_key: string;
  from_qualified_name?: string | null;
  to_qualified_name?: string | null;
  kind: string;
  source: string;
  confidence: number;
}

export interface CodeCallersResult {
  matched_targets: CodeGraphNodeResult[];
  callers: CodeGraphNodeResult[];
  depth: number;
  total_callers: number;
}

export interface CodeImportsResult {
  matched_targets: CodeGraphNodeResult[];
  direction: "in" | "out";
  compacted: boolean;
  matched_target_count: number;
  scanned_target_count: number;
  imports: CodeGraphNodeResult[];
  total_imports: number;
}

export interface CodeNeighborsResult {
  matched_targets: CodeGraphNodeResult[];
  nodes: CodeGraphNodeResult[];
  edges: CodeGraphEdgeResult[];
  depth: number;
}

export interface CodeShortestPathResult {
  matched_sources: CodeGraphNodeResult[];
  matched_targets: CodeGraphNodeResult[];
  found: boolean;
  path: CodeGraphNodeResult[];
  edges: CodeGraphEdgeResult[];
  hops: number;
}

export interface SharedContextDocumentResult {
  id: string;
  title: string;
  category: string;
  is_mandatory?: boolean;
  token_count: number;
  collection_name: string;
  source_type: "TEAM_CONTEXT" | "LINKED_COLLECTION" | string;
  tags: string[];
}

export interface SharedContextResult {
  documents: SharedContextDocumentResult[];
  merged_content?: string | null;
  total_tokens: number;
  collections_loaded: number;
  linked_collections_loaded?: number;
  team_context_documents_loaded?: number;
  linked_collection_documents_loaded?: number;
  context_hash: string;
}

export interface SyncDocumentInput {
  path: string;
  content: string;
  kind?: "DOC" | "BINARY";
  format?: string;
  language?: string | null;
  metadata?: Record<string, unknown>;
}

export type ProjectPolicyLedgerSyncArtifactKind =
  | "decision_request"
  | "decision_resolution"
  | "apply_receipt"
  | "policy_draft";

export type ProjectPolicyLedgerSyncStatus =
  | "pending"
  | "approved"
  | "refused"
  | "superseded"
  | "modified";

export type ProjectPolicyLedgerSyncApplyState =
  | "needs_apply"
  | "applied"
  | "manual_follow_up_required"
  | "no_apply";

export interface ProjectPolicyLedgerSyncArtifactInput {
  kind: ProjectPolicyLedgerSyncArtifactKind;
  requestId: string;
  fingerprint?: string;
  title?: string;
  status?: ProjectPolicyLedgerSyncStatus;
  applyState?: ProjectPolicyLedgerSyncApplyState;
  humanChoice?: string;
  summary?: string;
  sourcePath?: string;
  updatedAt?: string;
  payload: Record<string, unknown>;
}

export type BusinessCollectionPreset =
  | "business_response_playbook"
  | "business_library"
  | "offer_templates"
  | "company_presentations"
  | "reference_diagrams";

export interface UploadDocumentOptions {
  kind?: "DOC" | "BINARY";
  format?: string;
  language?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ListBusinessCollectionsOptions {
  includeCustom?: boolean;
  includeMissingPresets?: boolean;
}

export interface EnsureBusinessCollectionOptions {
  preset?: BusinessCollectionPreset;
  name?: string;
  slug?: string;
  description?: string;
}

export interface UploadBusinessDocumentOptions {
  collectionId?: string;
  preset?: BusinessCollectionPreset;
  collectionSlug?: string;
  title: string;
  content: string;
  category?: "MANDATORY" | "BEST_PRACTICES" | "GUIDELINES" | "REFERENCE";
  tags?: string[];
  priority?: number;
  allowCustomCollection?: boolean;
}

export interface ListClientProjectsOptions {
  includeInternal?: boolean;
  limit?: number;
}

export interface CreateClientProjectOptions {
  name: string;
  slug?: string;
  description?: string;
  externalClientId?: string;
}

export interface TrackFileResult {
  success: boolean;
  files_tracked: number;
}

export interface SessionPersistResult {
  success: boolean;
  session_id: string;
  files_tracked: number;
}

export type WhyCaptureSourceKind = "phase_commit" | "final_commit" | "handoff";

export interface WhyCaptureInput {
  decision?: string;
  why?: string;
  rationale?: string;
  sourceText?: string;
  sourceKind: WhyCaptureSourceKind;
  sourceSessionId?: string;
  task?: string;
  changedFiles?: string[];
  commands?: string[];
  commitSha?: string;
  confirmed?: boolean;
  previewOnly?: boolean;
}

export interface WhyCaptureResult {
  previewOnly: boolean;
  confirmed: boolean;
  candidateCount: number;
  capturedCount?: number;
  candidates?: Array<{
    content?: string;
    type?: string;
    category?: string;
    reviewNotes?: string;
    whyFields?: {
      decision?: string | null;
      why?: string | null;
      outcome?: string | null;
    };
  }>;
  memories?: Array<{
    id?: string;
    memory_id?: string;
    content?: string;
    type?: string;
    category?: string;
    reviewStatus?: string;
    review_status?: string;
  }>;
  decisionCapture?: {
    createdCount?: number;
    duplicateCount?: number;
    failedCount?: number;
    created?: Array<Record<string, unknown>>;
    duplicates?: Array<Record<string, unknown>>;
    failed?: Array<Record<string, unknown>>;
  };
}

export interface EndOfTaskCommitWhyInput {
  decision?: string;
  rationale?: string;
  alternatives?: string[];
  constraints?: string[];
  observedOutcome?: string;
}

export interface JournalAppendResult {
  success?: boolean;
  date?: string;
  message?: string;
}

export interface ConnectionProbeResult {
  connected: boolean;
  statusCode?: number;
  detail: string;
  tool?: string;
}

export type MemoryType =
  | "fact"
  | "decision"
  | "learning"
  | "preference"
  | "todo"
  | "context";
export type MemoryScope = "agent" | "project" | "team" | "user";
export type MemoryStatus = "ACTIVE" | "INVALIDATED" | "SUPERSEDED";

export interface RecalledMemory {
  memory_id: string;
  content: string;
  type: MemoryType;
  scope: MemoryScope;
  category?: string;
  status: MemoryStatus;
  relevance: number;
  confidence: number;
  created_at: string;
  last_accessed_at?: string;
  access_count: number;
  invalidated_reason?: string;
  superseded_by_memory_id?: string;
}

export interface RecallWarning {
  memory_id: string;
  status: MemoryStatus;
  content: string;
  category?: string;
  reason?: string;
  superseded_by_memory_id?: string;
  relevance: number;
  created_at: string;
}

export interface RecallResult {
  memories: RecalledMemory[];
  warnings: RecallWarning[];
  total_searched: number;
  query: string;
  timing_ms: number;
}

export interface SessionMemoryEntry extends Record<string, unknown> {
  id?: string;
  memory_id?: string;
  text?: string;
  content?: string;
  summary?: string;
  title?: string;
  type?: string;
  category?: string;
  confidence?: number;
  created_at?: string | null;
}

export interface SessionMemoryTier {
  memories: SessionMemoryEntry[];
  count: number;
  tokens: number;
}

export interface SessionMemoryProfiles extends Record<string, unknown> {
  project_memory_id?: string | null;
  owner_memory_id?: string | null;
  tokens?: number;
  precedence?: string[];
}

export interface SessionMemoriesResult extends Record<string, unknown> {
  critical: SessionMemoryTier;
  daily: SessionMemoryTier;
  profiles?: SessionMemoryProfiles;
  total_tokens?: number;
  message?: string;
}

export interface StoredMemory {
  memory_id: string;
  content: string;
  type: MemoryType;
  scope: MemoryScope;
  category?: string;
  status: MemoryStatus;
  confidence: number;
  source?: string;
  created_at: string;
  expires_at?: string;
  invalidated_at?: string;
  invalidated_reason?: string;
  superseded_by_memory_id?: string;
  access_count: number;
}

export interface MemoriesResult {
  memories: StoredMemory[];
  total_count: number;
  has_more: boolean;
}

export interface RememberMemoryResult {
  memory_id?: string;
  stored?: boolean;
  message?: string;
  [key: string]: unknown;
}

export interface MemoryInvalidateResult {
  memory_id: string;
  status?: MemoryStatus;
  invalidated?: boolean;
  invalidated_at: string;
  reason?: string;
  message: string;
  error?: string;
}

export interface MemorySupersedeResult {
  old_memory_id: string;
  new_memory_id: string;
  superseded?: boolean;
  superseded_at?: string;
  reason?: string;
  message: string;
  error?: string;
}

export interface AutomationCheckpointSummary {
  id: string;
  sessionId: string;
  createdAt: string;
  task?: string;
  source?: string;
}

export interface CanonicalAutomationEvent {
  type: string;
  client?: string;
  workspace?: string;
  session_id?: string;
  agent_id?: string;
  timestamp?: string;
  privacy_level?: string;
  payload?: Record<string, unknown>;
}

export interface EmitEventResult {
  accepted: number;
  sessionIds: string[];
  events: AutomationCheckpointSummary[];
}

export type AdvisorInfluenceAgentDecision =
  | "accepted"
  | "modified"
  | "ignored"
  | "blocked";
export type AdvisorInfluenceOutcomeLinkStatus =
  | "pending"
  | "linked"
  | "missed"
  | "unevaluated";
export type AdvisorInfluenceReceiptCreationOutcomeLinkStatus = "pending";

export interface AdvisorInfluenceRecommendationInput {
  id: string;
  version?: "advisor-recommendation-v0";
  source: string;
  severity: string;
  title: string;
  rationale: string;
  reasonCodes: string[];
  historicalImpactSummary?: string | null;
  reasonCodeReliability?: number | null;
  recommendedVerification: string[];
  expectedBehaviorChange: string;
  evidence?: unknown[];
  caveats?: string[];
}

export interface RecordAdvisorInfluenceReceiptInput {
  servedJudgmentId: string;
  judgmentSnapshotId?: string;
  judgmentExposureId?: string;
  runId?: string;
  recommendation: AdvisorInfluenceRecommendationInput;
  agentDecision: AdvisorInfluenceAgentDecision;
  behaviorChange: string;
  verificationExecuted: string[];
  outcomeLinkStatus?: AdvisorInfluenceReceiptCreationOutcomeLinkStatus;
  metadata?: AdvisorInfluenceReceiptMetadataInput;
}

export interface AdvisorInfluenceReceiptMetadataInput extends Record<
  string,
  unknown
> {
  source?: string;
  firstParty?: boolean;
  planBefore?: string | null;
  planAfter?: string | null;
  changedBecauseOfRecommendation?: boolean | null;
  advisorInfluenceLifecycle?: AdvisorInfluenceLifecycle;
  filesAffected?: string[];
  toolActions?: string[];
  humanOverride?: string | null;
  task?: string | null;
  branch?: string | null;
  runId?: string | null;
  generatedAt?: string | null;
}

export interface RecordAdvisorInfluenceReceiptResult {
  project: {
    id: string;
    name: string;
    slug: string;
  };
  receipt: Record<string, unknown>;
  advisorInfluence: Record<string, unknown>;
}

export interface ProjectIntelligenceBriefRequest {
  task?: string;
  diffSummary?: string;
  changedFiles?: string[];
  symbols?: string[];
  routes?: string[];
  codeContext?: {
    localHeadSha?: string;
    branch?: string;
    workingTreeDirty?: boolean;
  };
  correlation?: {
    surface?: "companion";
    runId?: string;
    sessionId?: string;
  };
}

export interface HostedProjectIntelligenceBriefResult {
  project: {
    id: string;
    name: string;
    slug: string;
  };
  servedJudgmentId: string | null;
  judgmentSnapshotId: string | null;
  judgmentExposureId: string | null;
  persistedShadowSignalCount: number;
  brief: {
    version: string;
    task?: string | null;
    judgment?: {
      advisorRecommendations?: unknown[];
    };
  };
}

export interface AutomationConfigFile {
  path: string;
  content: string;
}

export interface AutomationConfigBundle {
  client?: string;
  files: AutomationConfigFile[];
  instructions: string[];
}

export interface ProjectAutomationSettings {
  automationClient?: string;
  autoInjectContext?: boolean;
  trackAccessedFiles?: boolean;
  preserveOnCompaction?: boolean;
  restoreOnSessionStart?: boolean;
  enrichPrompts?: boolean;
  maxTokensPerQuery?: number;
  searchMode?: string;
  includeSummaries?: boolean;
  adaptiveRoutingMode?: string;
  adaptiveRoutingRequireApproval?: boolean;
  adaptiveRoutingPlannerRetainsReasoning?: boolean;
  adaptiveRoutingPreferLocalWorkers?: boolean;
  adaptiveRoutingAllowedEndpointTypes?: string[];
  adaptiveRoutingPreferredEndpointTypes?: string[];
  adaptiveRoutingAllowedWorkerClasses?: string[];
  adaptiveRoutingFallback?: string;
  adaptiveRoutingDailyBudgetCents?: number;
  adaptiveRoutingMonthlyBudgetCents?: number;
  adaptiveRoutingCatalogLimit?: number;
}

export interface ProjectAutomationSettingsResult {
  settings: ProjectAutomationSettings;
  plan?: string;
  featureAvailability?: Record<string, unknown>;
}

export interface RecentAutomationEvent {
  id: string;
  sessionId: string;
  createdAt: string;
  event: CanonicalAutomationEvent;
}

export interface RecentAutomationEventsResult {
  events: RecentAutomationEvent[];
  count: number;
}

export type StuckGuardAction = "none" | "observe" | "inject" | "enforce";

export interface StuckGuardReason {
  code: string;
  message: string;
  weight: number;
  evidence?: string;
}

export interface StuckGuardRescuePack {
  marker: string;
  title: string;
  instructions: string[];
  recall: {
    tool: "snipara_recall";
    arguments: {
      query: string;
      scope: "project";
      limit: number;
      min_relevance: number;
    };
  };
  contextQuery: {
    tool: "snipara_context_query";
    arguments: {
      query: string;
      max_tokens: number;
      search_mode: "keyword";
      return_references: true;
      auto_decompose: false;
      include_all_tiers: false;
    };
  };
  injectionText: string;
}

export interface StuckGuardDecision {
  enabled: boolean;
  triggered: boolean;
  configuredMode: "observe" | "inject" | "enforce";
  action: StuckGuardAction;
  score: number;
  reasons: StuckGuardReason[];
  riskKeywords: string[];
  memoryCheckedRecently: boolean;
  cooldownActive: boolean;
  eventCount: number;
  sessionId?: string;
  evaluatedAt: string;
  recallQuery?: string;
  contextQuery?: string;
  rescuePack?: StuckGuardRescuePack;
}

export interface StuckGuardEvaluationResult {
  project: {
    id: string;
    slug: string;
    name: string;
  };
  decision: StuckGuardDecision;
  eventsEvaluated: number;
}

export interface EvaluateStuckGuardArgs {
  sessionId?: string;
  event?: CanonicalAutomationEvent;
  events?: CanonicalAutomationEvent[];
  includeRecent?: boolean;
  limit?: number;
}

export interface TeamSyncProjectSummary {
  id: string;
  name: string;
  slug: string;
  githubRepo?: string | null;
  githubBranch?: string | null;
  githubSyncEnabled?: boolean;
  githubPrAnswerPacksEnabled?: boolean;
}

export interface TeamSyncCandidateFile {
  path: string;
  score: number;
  reason: string;
}

export interface TeamSyncCandidateSymbol {
  qualifiedName: string;
  filePath: string;
  score: number;
  reason: string;
}

export interface TeamSyncDecisionSignal {
  id: string;
  title: string;
  status: string;
  impact: string | null;
  updatedAt: string;
  summary: string;
  tags: string[];
  recommendedAction: string;
}

export interface TeamSyncOverlapSignal {
  path: string;
  workItemIds: string[];
  workItemTitles: string[];
  severity: string;
}

export interface TeamSyncSessionCheckpoint {
  id: string;
  sessionId: string;
  task: string | null;
  source: string;
  filesTracked: string[];
  commands: string[];
  createdAt: string;
  expiresAt?: string | null;
}

export interface TeamSyncSessionContext {
  sessionId: string | null;
  latestAt: string | null;
  files: string[];
  commands: string[];
  tasks: string[];
  checkpoints: TeamSyncSessionCheckpoint[];
  contexts: Array<{
    id: string;
    key: string;
    valuePreview: string;
    updatedAt: string;
    expiresAt?: string | null;
  }>;
  runtime: {
    eventCount: number;
    latestEventAt: string | null;
    activeSessionCount: number;
    latestSessionId: string | null;
    clients: string[];
    agents: string[];
    invalidEventCount: number;
    eventTypes: Array<{
      type: string;
      count: number;
    }>;
  } | null;
  caveats: string[];
}

export interface TeamSyncFreshness {
  index: {
    healthStatus: string;
    healthScore: number | null;
    coveragePercent: number | null;
    staleCount: number;
    unindexedDocuments: number;
    lastIndexAt: string | null;
    lastIndexStatus: string | null;
    businessContextNeedsAttention: number | null;
  } | null;
  codeGraph: {
    status: string | null;
    sourceCommitSha: string | null;
    sourceBranch: string | null;
    indexedAt: string | null;
    ageHours: number | null;
    coveragePercent: number | null;
    indexedCodeDocumentCount: number | null;
    codeDocumentCount: number | null;
    warningCount: number | null;
    errorMessage: string | null;
  } | null;
  caveats: string[];
}

export interface TeamSyncWorkBrief {
  id: string;
  generatedAt: string;
  task: string;
  evidenceLevel: string;
  summary: string;
  likelyFiles: TeamSyncCandidateFile[];
  likelySymbols: TeamSyncCandidateSymbol[];
  activeCollisions: TeamSyncOverlapSignal[];
  relevantDecisions: TeamSyncDecisionSignal[];
  recommendedReads: Array<{
    type: string;
    label: string;
    target: string;
    reason: string;
  }>;
  recommendedTests: string[];
  recommendedTools: Array<{
    tool: string;
    reason: string;
    target?: string;
  }>;
  packageSurfaces: string[];
  releaseSurfaces: string[];
  sourceFacts: string[];
  freshness: TeamSyncFreshness | null;
  sessionContext: TeamSyncSessionContext | null;
  recommendedActions: string[];
  caveats: string[];
  target: {
    repository: string | null;
    branch: string | null;
    baseSha: string | null;
    projectDefaultBranch: string | null;
    sessionId: string | null;
    client: string | null;
  };
}

export interface TeamSyncWhatChangedSummary {
  changeCount: number;
  directChanges: number;
  nearbyChanges: number;
  projectChanges: number;
  criticalSurfaceChanges: number;
  failedPacks: number;
  weakAuthorityChanges: number;
  branchFiltered: boolean;
  branchMatches: number;
  sessionSignals: number;
  executionSessions: number;
  executionEvents: number;
  decisionChanges: number;
  staleAssumptions: number;
  overlapClusters: number;
  failedJobs: number;
  recommendedActions: number;
  latestChangedAt: string | null;
}

export interface TeamSyncWhatChangedResult {
  version: string;
  generatedAt: string;
  scope: {
    mode: string;
    paths: string[];
    explicitPaths: string[];
    recentFiles: string[];
    branch: string | null;
    projectDefaultBranch: string | null;
    sessionId: string | null;
    since: string | null;
  };
  summary: TeamSyncWhatChangedSummary;
  changes: Array<{
    id: string;
    title: string;
    repository: string;
    pullNumber: number;
    sourceUrl: string | null;
    status: string;
    updatedAt: string;
    headSha: string;
    branch: string | null;
    relevance: string;
    changedFiles: string[];
    matchedFiles: string[];
    impactedSymbols: string[];
    recommendedAction: string;
  }>;
  decisions: TeamSyncDecisionSignal[];
  staleAssumptions: Array<{
    id: string;
    severity: string;
    reason: string;
    observedAt: string | null;
    recommendedAction: string;
  }>;
  failedJobs: Array<{
    id: string;
    type: string;
    status: string;
    message: string | null;
    updatedAt: string;
    sourceUrl?: string | null;
    recommendedAction: string;
  }>;
  freshness: TeamSyncFreshness | null;
  sessionContext: TeamSyncSessionContext | null;
  nextActions?: Array<{
    id: string;
    label: string;
    source: string;
    severity: string;
    kind?: string;
    priority?: string;
    reason: string | null;
  }>;
  recommendedActions: string[];
  caveats: string[];
}

export interface TeamSyncExecutionMemoryResult {
  sessions?: unknown[];
  events?: unknown[];
  caveats: string[];
  [key: string]: unknown;
}

export interface TeamSyncHandoff {
  id: string;
  summary: string;
  task: string | null;
  branch: string | null;
  baseSha: string | null;
  headSha: string | null;
  sessionId: string | null;
  client: string | null;
  files: string[];
  commands: string[];
  tests: string[];
  blocker: string | null;
  assumptions: string[];
  nextStep: string | null;
  attention: string;
  durable: boolean;
  createdAt: string;
  expiresAt: string | null;
  source: string | null;
  createdBy: string | null;
  caveats: string[];
}

export interface TeamSyncWorkBriefResponse {
  project: TeamSyncProjectSummary;
  brief: TeamSyncWorkBrief;
  whatChanged: TeamSyncWhatChangedResult;
}

export interface TeamSyncChangesResponse {
  project: TeamSyncProjectSummary;
  limit: number;
  whatChanged: TeamSyncWhatChangedResult;
  changes: TeamSyncWhatChangedResult["changes"];
}

export interface TeamSyncHandoffResponse {
  project: TeamSyncProjectSummary;
  handoff: TeamSyncHandoff;
}

export interface TeamSyncResumeResponse {
  project: TeamSyncProjectSummary;
  handoff: TeamSyncHandoff | null;
  match: {
    score: number;
    reasons: string[];
  };
  sessionContext: TeamSyncSessionContext | null;
  executionMemory: TeamSyncExecutionMemoryResult;
  recommendedActions: string[];
  caveats: string[];
}

export type CollaborationActorType = "HUMAN" | "AGENT" | "SYSTEM";
export type CollaborationResourceKind =
  | "FILE"
  | "ROUTE"
  | "SYMBOL"
  | "SCHEMA"
  | "PACKAGE"
  | "DEPLOY"
  | "SURFACE"
  | "CUSTOM";
export type CollaborationLeaseMode =
  | "WATCH"
  | "ADVISORY"
  | "REQUIRES_ACK"
  | "EXCLUSIVE"
  | "HARD_BLOCK";
export type CollaborationLeaseStatus =
  | "ACTIVE"
  | "RELEASED"
  | "EXPIRED"
  | "OVERRIDDEN";
export type CollaborationConflictSeverity =
  | "INFO"
  | "WATCH"
  | "WARNING"
  | "CRITICAL";
export type CollaborationGuardDecision =
  | "CLEAR"
  | "WATCH"
  | "REVIEW_REQUIRED"
  | "REQUIRES_ACK"
  | "BLOCKED";

export interface CollaborationResource {
  kind: CollaborationResourceKind;
  id: string;
  label?: string;
  sourcePath?: string;
}

export interface CollaborationActorPayload {
  actorId?: string;
  actorType?: CollaborationActorType;
  actorLabel?: string;
  sessionId?: string;
}

export interface CollaborationSessionSummary {
  id: string;
  actorId: string;
  actorType: CollaborationActorType;
  actorLabel?: string | null;
  sessionId?: string | null;
  swarmId?: string | null;
  client?: string | null;
  repository?: string | null;
  branch?: string | null;
  worktree?: string | null;
  task?: string | null;
  status: string;
  dirtyFiles?: string[];
  startedAt?: string;
  lastHeartbeatAt?: string;
  heartbeatTtlSeconds?: number | null;
  [key: string]: unknown;
}

export interface CollaborationLeaseSummary {
  id: string;
  workSessionId?: string | null;
  swarmId?: string | null;
  resourceKind: CollaborationResourceKind;
  resourceId: string;
  resourceLabel?: string | null;
  mode: CollaborationLeaseMode;
  status: CollaborationLeaseStatus;
  claimedByActorId: string;
  claimedByActorType: CollaborationActorType;
  claimedByLabel?: string | null;
  reason?: string | null;
  claimedAt?: string;
  heartbeatAt?: string;
  expiresAt?: string | null;
  [key: string]: unknown;
}

export interface CollaborationConflict {
  code: string;
  decision: CollaborationGuardDecision;
  severity: CollaborationConflictSeverity;
  resource: CollaborationResource;
  conflictingActor: {
    actorId: string;
    actorType: CollaborationActorType;
    actorLabel?: string | null;
    sessionId?: string | null;
  };
  reason: string;
  recommendedAction: string;
  leaseId?: string | null;
  workSessionId?: string | null;
}

export interface CollaborationGuardEvaluation {
  decision: CollaborationGuardDecision;
  severity: CollaborationConflictSeverity;
  evaluatedAt: string;
  resources: CollaborationResource[];
  conflicts: CollaborationConflict[];
  recommendedActions: string[];
}

export interface CollaborationStateResponse {
  project: TeamSyncProjectSummary;
  sessions: CollaborationSessionSummary[];
  leases: CollaborationLeaseSummary[];
  events?: Array<Record<string, unknown>>;
  sessionSnapshots: unknown[];
  leaseSnapshots: unknown[];
}

export interface CollaborationSessionResponse {
  project: TeamSyncProjectSummary;
  session: CollaborationSessionSummary;
  resources: CollaborationResource[];
}

export interface CollaborationLeaseResponse {
  project: TeamSyncProjectSummary;
  resources: CollaborationResource[];
  leases: CollaborationLeaseSummary[];
}

export interface CollaborationLeaseUpdateResponse {
  project: TeamSyncProjectSummary;
  lease: CollaborationLeaseSummary;
}

export interface CollaborationGuardResponse {
  project: TeamSyncProjectSummary;
  resources: CollaborationResource[];
  evaluation: CollaborationGuardEvaluation;
  guardEvent: Record<string, unknown> | null;
}

export interface ApiKeyProjectSummary {
  id: string;
  name: string;
  slug: string;
  githubRepo?: string | null;
  teamName?: string | null;
  teamSlug?: string | null;
  automationClient?: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface MCPResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number;
  result?: {
    content: Array<{
      type: string;
      text: string;
    }>;
  };
  error?: {
    code: number;
    message: string;
  };
}

interface SniparaStoredToken {
  project_slug?: string;
  project_id?: string;
  api_key?: string;
}

const CORRELATED_RETRIEVAL_TOOL_NAMES = new Set([
  "snipara_context_query",
  "snipara_ask",
  "snipara_search",
  "snipara_recall",
  "snipara_get_chunk",
  "rlm_context_query",
  "rlm_ask",
  "rlm_search",
  "rlm_recall",
  "rlm_get_chunk",
]);

function withCompanionRetrievalClient(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (
    !CORRELATED_RETRIEVAL_TOOL_NAMES.has(toolName) ||
    args.client !== undefined
  ) {
    return args;
  }

  return {
    ...args,
    client: "snipara-companion",
  };
}

function getSniparaTokenStorePath(): string {
  return path.join(os.homedir(), ".snipara", "tokens.json");
}

function loadProjectApiKeyFromTokenStore(
  projectIdentifier: string,
  currentApiKey?: string,
): string | null {
  const tokensPath = getSniparaTokenStorePath();
  if (!fs.existsSync(tokensPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(tokensPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, SniparaStoredToken>;
    const direct = parsed[projectIdentifier];

    if (direct?.api_key && direct.api_key !== currentApiKey) {
      return direct.api_key;
    }

    for (const token of Object.values(parsed)) {
      if (
        (token.project_slug === projectIdentifier ||
          token.project_id === projectIdentifier) &&
        token.api_key &&
        token.api_key !== currentApiKey
      ) {
        return token.api_key;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getResolvedApiUrl(apiUrl?: string): string {
  const resolvedApiUrl = apiUrl || loadConfig().apiUrl;
  return resolvedApiUrl.replace(/\/+$/, "");
}

function getResolvedDashboardApiUrl(apiUrl?: string): string {
  const explicitDashboardUrl =
    process.env.SNIPARA_DASHBOARD_URL || process.env.SNIPARA_WEB_URL;
  if (explicitDashboardUrl) {
    return explicitDashboardUrl.replace(/\/+$/, "");
  }

  const resolvedApiUrl = getResolvedApiUrl(apiUrl);
  try {
    const url = new URL(resolvedApiUrl);
    if (url.hostname === "api.snipara.com") {
      return "https://www.snipara.com";
    }
    if (url.hostname.startsWith("api.")) {
      url.hostname = url.hostname.replace(/^api\./, "www.");
      url.pathname = "";
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/+$/, "");
    }
  } catch {
    return resolvedApiUrl;
  }

  return resolvedApiUrl;
}

function toRecordArray(value: unknown): SessionMemoryEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is SessionMemoryEntry => isRecord(item));
}

function normalizeSessionMemoryTier(value: unknown): SessionMemoryTier {
  if (Array.isArray(value)) {
    const memories = toRecordArray(value);
    return {
      memories,
      count: memories.length,
      tokens: 0,
    };
  }

  if (!isRecord(value)) {
    return {
      memories: [],
      count: 0,
      tokens: 0,
    };
  }

  const memories = toRecordArray(value.memories);
  return {
    memories,
    count: typeof value.count === "number" ? value.count : memories.length,
    tokens: typeof value.tokens === "number" ? value.tokens : 0,
  };
}

function normalizeSessionMemoryProfiles(
  value: unknown,
): SessionMemoryProfiles | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    ...value,
    project_memory_id:
      typeof value.project_memory_id === "string"
        ? value.project_memory_id
        : null,
    owner_memory_id:
      typeof value.owner_memory_id === "string" ? value.owner_memory_id : null,
    tokens: typeof value.tokens === "number" ? value.tokens : undefined,
    precedence: Array.isArray(value.precedence)
      ? value.precedence.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : undefined,
  };
}

export function normalizeSessionMemoriesResult(
  value: unknown,
): SessionMemoriesResult {
  const record = isRecord(value) ? value : {};
  const critical = normalizeSessionMemoryTier(record.critical);
  const daily = normalizeSessionMemoryTier(record.daily);
  const profiles = normalizeSessionMemoryProfiles(record.profiles);
  const derivedTotalTokens = critical.tokens + daily.tokens;

  return {
    ...record,
    critical,
    daily,
    profiles,
    total_tokens:
      typeof record.total_tokens === "number"
        ? record.total_tokens
        : derivedTotalTokens || undefined,
    message: typeof record.message === "string" ? record.message : undefined,
  };
}

function connectionProbeFailure(
  error: unknown,
  tool: string,
): ConnectionProbeResult {
  const detail = error instanceof Error ? error.message : String(error);
  const match = detail.match(/\bHTTP (\d{3})\b/);

  if (error instanceof Error && error.name === "AbortError") {
    return {
      connected: false,
      detail: `timed out while probing ${tool}; hosted MCP may still be reachable, retry with a lighter tool or increase timeout`,
      tool,
    };
  }

  return {
    connected: false,
    statusCode: match ? Number(match[1]) : undefined,
    detail,
    tool,
  };
}

/**
 * Snipara API Client - Uses MCP JSON-RPC protocol
 */
export class RLMClient {
  private config: RLMConfig;
  private timeout: number;
  private cwd: string;

  constructor(timeout: number = 5000, options: ConfigResolutionOptions = {}) {
    this.config = loadConfig(options);
    this.timeout = timeout;
    this.cwd = options.cwd ?? process.cwd();
  }

  private resolveProjectIdentifier(): string {
    return (
      this.config.projectId ?? resolveProject({ cwd: this.cwd }).identifier
    );
  }

  private dashboardApiUrl(): string {
    return getResolvedDashboardApiUrl(this.config.apiUrl);
  }

  private async fetchWithApiKeyRetry(
    url: string | URL,
    init: {
      method: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: globalThis.AbortSignal;
    },
    projectIdentifier: string,
  ): Promise<Response> {
    const primaryApiKey = this.config.apiKey;
    if (!primaryApiKey) {
      throw new Error(
        "API key not configured. Run 'npx -y snipara-companion@latest init' first.",
      );
    }

    const baseHeaders = (init.headers ?? {}) as Record<string, string>;
    const send = async (apiKey: string): Promise<Response> =>
      fetch(url, {
        ...init,
        headers: {
          ...baseHeaders,
          "X-API-Key": apiKey,
        },
      });

    const initialResponse = await send(primaryApiKey);
    if (initialResponse.status !== 401) {
      return initialResponse;
    }

    const fallbackApiKey = loadProjectApiKeyFromTokenStore(
      projectIdentifier,
      primaryApiKey,
    );
    if (!fallbackApiKey) {
      return initialResponse;
    }

    const retryResponse = await send(fallbackApiKey);
    if (retryResponse.ok) {
      this.config.apiKey = fallbackApiKey;
    }

    return retryResponse;
  }

  private async dashboardProjectRequest<T>(
    pathSuffix: string,
    init: {
      method: string;
      body?: unknown;
    },
    options: {
      invalidMessage: string;
      validate?: (data: T) => boolean;
    },
  ): Promise<T> {
    if (!this.config.apiKey) {
      throw new Error(
        "API key not configured. Run 'npx -y snipara-companion@latest init' first.",
      );
    }

    const projectIdentifier = this.resolveProjectIdentifier();
    const projectId = encodeURIComponent(projectIdentifier);
    const url = `${this.dashboardApiUrl()}/api/projects/${projectId}${pathSuffix}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await this.fetchWithApiKeyRetry(
        url,
        {
          method: init.method,
          headers: {
            "Content-Type": "application/json",
          },
          ...(init.body ? { body: JSON.stringify(init.body) } : {}),
          signal: controller.signal,
        },
        projectIdentifier,
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const envelope = (await response.json()) as {
        success: boolean;
        data?: T;
      };

      if (
        !envelope.success ||
        !envelope.data ||
        options.validate?.(envelope.data) === false
      ) {
        throw new Error(options.invalidMessage);
      }

      return envelope.data;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Make an MCP JSON-RPC request
   */
  private async mcpCall<T>(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    if (!this.config.apiKey) {
      throw new Error(
        "API key not configured. Run 'npx -y snipara-companion@latest init' first.",
      );
    }

    // Prefer a stored projectId from config; fall back to per-workspace
    // auto-resolution (git remote, package.json, .snipara/project, etc.).
    // Slashes are URL-encoded so owner/repo works on /mcp/{project_id}.
    const identifier = this.resolveProjectIdentifier();
    const encoded = encodeURIComponent(identifier);
    const url = `${this.config.apiUrl}/mcp/${encoded}`;

    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: withCompanionRetrievalClient(toolName, args),
      },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await this.fetchWithApiKeyRetry(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.config.sessionId
              ? { "X-Snipara-Session-Id": this.config.sessionId }
              : {}),
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
        identifier,
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as MCPResponse<T>;

      if (data.error) {
        throw new Error(data.error.message);
      }

      if (!data.result?.content?.[0]?.text) {
        throw new Error("Empty MCP response");
      }

      return JSON.parse(data.result.content[0].text) as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async callTool<T>(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    return this.mcpCall<T>(toolName, args);
  }

  /**
   * Query for optimized context using snipara_context_query
   */
  async queryContext(
    query: string,
    maxTokens: number = 8000,
    options: ContextQueryOptions = {},
  ): Promise<ContextQueryResult> {
    interface MCPContextResult {
      sections: Array<{
        title: string;
        content: string;
        file?: string;
        lines?: [number, number];
        token_count?: number;
        file_path?: string;
        line_start?: number;
        line_end?: number;
        relevance_score?: number;
        quality_score?: number | null;
        quality_flags?: string[];
        tokens?: number;
        truncated?: boolean;
      }>;
      total_tokens?: number;
      query?: string;
      suggestions?: string[];
      answer_pack?: AnswerPack | null;
      answer_pack_included?: boolean;
      answer_pack_tokens?: number;
      routing_recommendation?: "direct" | "rlm";
      routing_confidence?: number;
      routing_reason?: string;
      query_complexity?: "simple" | "moderate" | "complex";
      recommended_tool?: string;
      recommended_tool_arguments?: Record<string, unknown>;
      graph_hybrid_used?: boolean;
      graph_context_tool?: string;
      graph_context_summary?: string;
      search_mode?: ContextQuerySearchMode;
      timing?: Record<string, number>;
      retrieval_diagnostics?: Record<string, unknown>;
    }

    const result = await this.mcpCall<MCPContextResult>(
      "snipara_context_query",
      {
        query,
        max_tokens: maxTokens,
        search_mode: options.searchMode ?? "hybrid",
        include_metadata: options.includeMetadata ?? true,
        include_answer_pack: options.includeAnswerPack ?? true,
        auto_decompose: options.autoDecompose,
        include_shared_context: options.includeSharedContext,
        include_all_tiers: options.includeAllTiers,
        return_references: options.returnReferences,
      },
    );

    // Transform MCP result to expected format
    return {
      sections: (result.sections || []).map((s) => ({
        title: s.title || "Untitled",
        content: s.content || "",
        file: s.file || s.file_path || "",
        lines: Array.isArray(s.lines)
          ? [s.lines[0] || 0, s.lines[1] || 0]
          : ([s.line_start || 0, s.line_end || 0] as [number, number]),
        relevance_score: s.relevance_score || 0,
        token_count: s.token_count || s.tokens || 0,
        truncated: s.truncated || false,
        quality_score: s.quality_score,
        quality_flags: s.quality_flags || [],
      })),
      total_tokens: result.total_tokens || 0,
      max_tokens: maxTokens,
      query: result.query || query,
      suggestions: result.suggestions || [],
      answer_pack: result.answer_pack || null,
      answer_pack_included: result.answer_pack_included || false,
      answer_pack_tokens: result.answer_pack_tokens || 0,
      routing_recommendation: result.routing_recommendation,
      routing_confidence: result.routing_confidence,
      routing_reason: result.routing_reason,
      query_complexity: result.query_complexity,
      recommended_tool: result.recommended_tool,
      recommended_tool_arguments: result.recommended_tool_arguments || {},
      graph_hybrid_used: result.graph_hybrid_used,
      graph_context_tool: result.graph_context_tool,
      graph_context_summary: result.graph_context_summary,
      search_mode: result.search_mode,
      timing: result.timing,
      retrieval_diagnostics: result.retrieval_diagnostics,
    };
  }

  async sharedContext(
    options: {
      maxTokens?: number;
      categories?: string[];
      includeContent?: boolean;
    } = {},
  ): Promise<SharedContextResult> {
    return this.mcpCall<SharedContextResult>("snipara_shared_context", {
      max_tokens: options.maxTokens ?? 2000,
      categories: options.categories,
      include_content: options.includeContent ?? true,
    });
  }

  async codeCallers(
    qualifiedName: string,
    options: {
      symbolKey?: string;
      depth?: number;
      limit?: number;
    } = {},
  ): Promise<CodeCallersResult> {
    return this.mcpCall<CodeCallersResult>("snipara_code_callers", {
      qualified_name: qualifiedName,
      symbol_key: options.symbolKey,
      depth: options.depth ?? 1,
      limit: options.limit ?? 50,
    });
  }

  async codeImports(options: {
    qualifiedName?: string;
    symbolKey?: string;
    filePath?: string;
    direction?: "in" | "out";
    includeFileNodes?: boolean;
    limit?: number;
  }): Promise<CodeImportsResult> {
    return this.mcpCall<CodeImportsResult>("snipara_code_imports", {
      qualified_name: options.qualifiedName,
      symbol_key: options.symbolKey,
      file_path: options.filePath,
      direction: options.direction ?? "out",
      include_file_nodes: options.includeFileNodes ?? false,
      limit: options.limit ?? 50,
    });
  }

  async codeNeighbors(
    qualifiedName: string,
    options: {
      symbolKey?: string;
      depth?: number;
      edgeKinds?: string[];
      limit?: number;
    } = {},
  ): Promise<CodeNeighborsResult> {
    return this.mcpCall<CodeNeighborsResult>("snipara_code_neighbors", {
      qualified_name: qualifiedName,
      symbol_key: options.symbolKey,
      depth: options.depth ?? 2,
      edge_kinds: options.edgeKinds,
      limit: options.limit ?? 200,
    });
  }

  async codeShortestPath(
    fromQualifiedName: string,
    toQualifiedName: string,
    options: {
      fromSymbolKey?: string;
      toSymbolKey?: string;
      edgeKinds?: string[];
      maxHops?: number;
    } = {},
  ): Promise<CodeShortestPathResult> {
    return this.mcpCall<CodeShortestPathResult>("snipara_code_shortest_path", {
      from: fromQualifiedName,
      from_symbol_key: options.fromSymbolKey,
      to: toQualifiedName,
      to_symbol_key: options.toSymbolKey,
      edge_kinds: options.edgeKinds,
      max_hops: options.maxHops ?? 6,
    });
  }

  async codeSymbolCard(options: {
    qualifiedName?: string;
    symbolKey?: string;
    limit?: number;
  }): Promise<Record<string, unknown>> {
    return this.mcpCall<Record<string, unknown>>("snipara_code_symbol_card", {
      qualified_name: options.qualifiedName,
      symbol_key: options.symbolKey,
      limit: options.limit ?? 20,
    });
  }

  async codeImpact(options: {
    qualifiedName?: string;
    symbolKey?: string;
    filePath?: string;
    changedFiles?: string[];
    diffSummary?: string;
    depth?: number;
    direction?: "in" | "out" | "both";
    edgeKinds?: string[];
    limit?: number;
  }): Promise<Record<string, unknown>> {
    return this.mcpCall<Record<string, unknown>>("snipara_code_impact", {
      qualified_name: options.qualifiedName,
      symbol_key: options.symbolKey,
      file_path: options.filePath,
      changed_files: options.changedFiles,
      diff_summary: options.diffSummary,
      depth: options.depth ?? 3,
      direction: options.direction ?? "both",
      edge_kinds: options.edgeKinds,
      limit: options.limit ?? 50,
    });
  }

  /**
   * Track accessed files using snipara_remember
   */
  async trackFiles(files: string[]): Promise<TrackFileResult> {
    const content = `Files accessed: ${files.join(", ")}`;

    await this.mcpCall("snipara_remember", {
      content,
      type: "context",
      category: "file-access",
      ttl_days: 1,
    });

    return {
      success: true,
      files_tracked: files.length,
    };
  }

  /**
   * Persist session context using snipara_remember
   */
  async persistSession(): Promise<SessionPersistResult> {
    return {
      success: true,
      session_id: this.config.sessionId || "unknown",
      files_tracked: 0,
    };
  }

  /**
   * Recall memories with optional lifecycle warnings.
   */
  async recallMemories(
    query: string,
    options: {
      type?: MemoryType;
      scope?: MemoryScope;
      category?: string;
      limit?: number;
      minRelevance?: number;
      includeInactive?: boolean;
      warningThreshold?: number;
    } = {},
  ): Promise<RecallResult> {
    return this.mcpCall<RecallResult>("snipara_recall", {
      query,
      type: options.type,
      scope: options.scope,
      category: options.category,
      limit: options.limit ?? 5,
      min_relevance: options.minRelevance ?? 0.5,
      include_inactive: options.includeInactive ?? false,
      warning_threshold: options.warningThreshold ?? 0.72,
    });
  }

  async rememberMemory(args: {
    text: string;
    type?: MemoryType;
    scope?: MemoryScope;
    category?: string;
    ttlDays?: number;
    source?: string;
  }): Promise<RememberMemoryResult> {
    return this.mcpCall<RememberMemoryResult>("snipara_remember", {
      text: args.text,
      type: args.type,
      scope: args.scope,
      category: args.category,
      ttl_days: args.ttlDays,
      source: args.source,
    });
  }

  /**
   * List stored memories with lifecycle filters.
   */
  async listMemories(
    options: {
      type?: MemoryType;
      scope?: MemoryScope;
      category?: string;
      status?: MemoryStatus;
      search?: string;
      limit?: number;
      offset?: number;
      includeInactive?: boolean;
    } = {},
  ): Promise<MemoriesResult> {
    return this.mcpCall<MemoriesResult>("snipara_memories", {
      type: options.type,
      scope: options.scope,
      category: options.category,
      status: options.status,
      search: options.search,
      limit: options.limit ?? 20,
      offset: options.offset ?? 0,
      include_inactive: options.includeInactive ?? false,
    });
  }

  /**
   * Invalidate a memory without deleting it.
   */
  async invalidateMemory(
    memoryId: string,
    reason?: string,
  ): Promise<MemoryInvalidateResult> {
    return this.mcpCall<MemoryInvalidateResult>("snipara_memory_invalidate", {
      memory_id: memoryId,
      reason,
    });
  }

  /**
   * Mark an existing memory as superseded by another memory.
   */
  async supersedeMemory(
    oldMemoryId: string,
    newMemoryId: string,
    reason?: string,
  ): Promise<MemorySupersedeResult> {
    return this.mcpCall<MemorySupersedeResult>("snipara_memory_supersede", {
      old_memory_id: oldMemoryId,
      new_memory_id: newMemoryId,
      reason,
    });
  }

  /**
   * Get session status (recall recent memories)
   */
  async getSession(): Promise<{ session_id: string; files_tracked: number }> {
    const result = await this.recallMemories("session context file-access", {
      type: "context",
      category: "file-access",
      limit: 5,
      minRelevance: 0,
    });

    const fileMemories = (result.memories || []).filter(
      (m) => m.category === "file-access",
    );

    return {
      session_id: this.config.sessionId || "none",
      files_tracked: fileMemories.length,
    };
  }

  /**
   * Test API connection with a lightweight MCP tool before falling back to stats.
   */
  async probeConnection(): Promise<ConnectionProbeResult> {
    const probeTools = ["snipara_settings", "snipara_stats"];
    let lastFailure: ConnectionProbeResult | null = null;

    for (const tool of probeTools) {
      try {
        await this.mcpCall(tool, {});
        return {
          connected: true,
          detail: `project access confirmed via ${tool}`,
          tool,
        };
      } catch (error) {
        const failure = connectionProbeFailure(error, tool);
        if (failure.statusCode === 401 || failure.statusCode === 403) {
          return failure;
        }
        lastFailure = failure;
      }
    }

    return (
      lastFailure ?? {
        connected: false,
        detail: "connection probe failed before a tool response was received",
      }
    );
  }

  async testConnection(): Promise<boolean> {
    const probe = await this.probeConnection();
    return probe.connected;
  }

  async emitEvent(event: {
    type: string;
    client: string;
    workspace: string;
    session_id: string;
    agent_id: string;
    timestamp: string;
    privacy_level: "standard" | "sensitive" | "restricted";
    payload?: Record<string, unknown>;
  }): Promise<EmitEventResult> {
    if (!this.config.apiKey) {
      throw new Error(
        "API key not configured. Run 'npx -y snipara-companion@latest init' first.",
      );
    }

    if (!this.config.projectId) {
      throw new Error(
        "Project not configured. Run 'npx -y snipara-companion@latest init' first.",
      );
    }

    const projectId = encodeURIComponent(this.config.projectId);
    const url = `${this.dashboardApiUrl()}/api/projects/${projectId}/automation/events`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await this.fetchWithApiKeyRetry(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ events: [event] }),
          signal: controller.signal,
        },
        this.resolveProjectIdentifier(),
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        success: boolean;
        data: EmitEventResult;
      };

      if (!data.success) {
        throw new Error("Automation event ingestion failed");
      }

      return data.data;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async recordAdvisorInfluenceReceipt(
    input: RecordAdvisorInfluenceReceiptInput,
  ): Promise<RecordAdvisorInfluenceReceiptResult> {
    return this.dashboardProjectRequest<RecordAdvisorInfluenceReceiptResult>(
      "/project-intelligence/advisor-influence",
      {
        method: "POST",
        body: input,
      },
      {
        invalidMessage: "Advisor influence receipt write failed",
        validate: (data) => Boolean(data.receipt && data.advisorInfluence),
      },
    );
  }

  async createProjectIntelligenceBrief(
    input: ProjectIntelligenceBriefRequest
  ): Promise<HostedProjectIntelligenceBriefResult> {
    return this.dashboardProjectRequest<HostedProjectIntelligenceBriefResult>(
      "/project-intelligence/brief",
      {
        method: "POST",
        body: input,
      },
      {
        invalidMessage: "Project Intelligence brief generation failed",
        validate: (data) =>
          Boolean(data.project && data.brief) &&
          (typeof data.servedJudgmentId === "string" || data.servedJudgmentId === null),
      }
    );
  }

  async captureWhy(input: WhyCaptureInput): Promise<WhyCaptureResult> {
    return this.dashboardProjectRequest<WhyCaptureResult>(
      "/agents/memory/why-capture",
      {
        method: "POST",
        body: input,
      },
      {
        invalidMessage: "Why Capture request failed",
        validate: (data) =>
          typeof data.previewOnly === "boolean" &&
          typeof data.confirmed === "boolean" &&
          Number.isInteger(data.candidateCount),
      },
    );
  }

  async getAutomationEvents(args?: {
    sessionId?: string;
    limit?: number;
  }): Promise<RecentAutomationEventsResult> {
    if (!this.config.apiKey) {
      throw new Error(
        "API key not configured. Run 'npx -y snipara-companion@latest init' first.",
      );
    }

    if (!this.config.projectId) {
      throw new Error(
        "Project not configured. Run 'npx -y snipara-companion@latest init' first.",
      );
    }

    const projectId = encodeURIComponent(this.config.projectId);
    const url = new URL(
      `${this.dashboardApiUrl()}/api/projects/${projectId}/automation/events`,
    );

    if (args?.sessionId) {
      url.searchParams.set("sessionId", args.sessionId);
    }
    if (typeof args?.limit === "number") {
      url.searchParams.set("limit", String(args.limit));
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await this.fetchWithApiKeyRetry(
        url,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        },
        this.resolveProjectIdentifier(),
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        success: boolean;
        data: RecentAutomationEventsResult;
      };

      if (!data.success) {
        throw new Error("Automation event read failed");
      }

      return data.data;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async getAutomationConfigBundle(
    client: string,
  ): Promise<AutomationConfigBundle> {
    if (!this.config.apiKey) {
      throw new Error(
        "API key not configured. Run 'npx -y snipara-companion@latest init' first.",
      );
    }

    const projectIdentifier = this.resolveProjectIdentifier();
    const projectId = encodeURIComponent(projectIdentifier);
    const url = new URL(
      `${this.dashboardApiUrl()}/api/projects/${projectId}/automation/config`,
    );
    url.searchParams.set("format", "files");
    url.searchParams.set("client", client);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await this.fetchWithApiKeyRetry(
        url,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        },
        projectIdentifier,
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        success: boolean;
        data?: Partial<AutomationConfigBundle>;
      };

      if (!data.success || !Array.isArray(data.data?.files)) {
        throw new Error("Automation config bundle response was invalid");
      }

      return {
        client:
          typeof data.data.client === "string" ? data.data.client : undefined,
        files: data.data.files.filter(
          (file): file is AutomationConfigFile =>
            typeof file?.path === "string" && typeof file?.content === "string",
        ),
        instructions: Array.isArray(data.data.instructions)
          ? data.data.instructions.filter(
              (item): item is string => typeof item === "string",
            )
          : [],
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async getAutomationSettings(): Promise<ProjectAutomationSettingsResult> {
    if (!this.config.apiKey) {
      throw new Error(
        "API key not configured. Run 'npx -y snipara-companion@latest init' first.",
      );
    }

    const projectIdentifier = this.resolveProjectIdentifier();
    const projectId = encodeURIComponent(projectIdentifier);
    const url = `${this.dashboardApiUrl()}/api/projects/${projectId}/automation`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await this.fetchWithApiKeyRetry(
        url,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        },
        projectIdentifier,
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        success: boolean;
        data?: Partial<ProjectAutomationSettingsResult>;
      };

      if (
        !data.success ||
        !data.data?.settings ||
        typeof data.data.settings !== "object"
      ) {
        throw new Error("Automation settings response was invalid");
      }

      return {
        settings: data.data.settings,
        plan: typeof data.data.plan === "string" ? data.data.plan : undefined,
        featureAvailability:
          data.data.featureAvailability &&
          typeof data.data.featureAvailability === "object" &&
          !Array.isArray(data.data.featureAvailability)
            ? (data.data.featureAvailability as Record<string, unknown>)
            : undefined,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async evaluateStuckGuard(
    args: EvaluateStuckGuardArgs = {},
  ): Promise<StuckGuardEvaluationResult> {
    if (!this.config.apiKey) {
      throw new Error(
        "API key not configured. Run 'npx -y snipara-companion@latest init' first.",
      );
    }

    if (!this.config.projectId) {
      throw new Error(
        "Project not configured. Run 'npx -y snipara-companion@latest init' first.",
      );
    }

    const projectId = encodeURIComponent(this.config.projectId);
    const url = `${this.dashboardApiUrl()}/api/projects/${projectId}/automation/stuck-guard`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await this.fetchWithApiKeyRetry(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(args),
          signal: controller.signal,
        },
        this.resolveProjectIdentifier(),
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        success: boolean;
        data: StuckGuardEvaluationResult;
      };

      if (!data.success) {
        throw new Error("Stuck Guard evaluation failed");
      }

      return data.data;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async getStuckGuardStatus(args?: {
    sessionId?: string;
    limit?: number;
  }): Promise<StuckGuardEvaluationResult> {
    if (!this.config.apiKey) {
      throw new Error(
        "API key not configured. Run 'npx -y snipara-companion@latest init' first.",
      );
    }

    if (!this.config.projectId) {
      throw new Error(
        "Project not configured. Run 'npx -y snipara-companion@latest init' first.",
      );
    }

    const projectId = encodeURIComponent(this.config.projectId);
    const url = new URL(
      `${this.dashboardApiUrl()}/api/projects/${projectId}/automation/stuck-guard`,
    );

    if (args?.sessionId) {
      url.searchParams.set("sessionId", args.sessionId);
    }
    if (typeof args?.limit === "number") {
      url.searchParams.set("limit", String(args.limit));
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await this.fetchWithApiKeyRetry(
        url,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        },
        this.resolveProjectIdentifier(),
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        success: boolean;
        data: StuckGuardEvaluationResult;
      };

      if (!data.success) {
        throw new Error("Stuck Guard status read failed");
      }

      return data.data;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async createTeamSyncWorkBrief(args: {
    task: string;
    branch?: string;
    baseSha?: string;
    sessionId?: string;
    client?: string;
    changedFiles?: string[];
    recentFiles?: string[];
    limit?: number;
  }): Promise<TeamSyncWorkBriefResponse> {
    if (!this.config.apiKey) {
      throw new Error(
        "API key not configured. Run 'npx -y snipara-companion@latest init' first.",
      );
    }

    const projectIdentifier = this.resolveProjectIdentifier();
    const projectId = encodeURIComponent(projectIdentifier);
    const url = `${this.dashboardApiUrl()}/api/projects/${projectId}/team-sync/work-briefs`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await this.fetchWithApiKeyRetry(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(args),
          signal: controller.signal,
        },
        projectIdentifier,
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        success: boolean;
        data?: TeamSyncWorkBriefResponse;
      };

      if (!data.success || !data.data?.brief || !data.data.whatChanged) {
        throw new Error("Team Sync work brief response was invalid");
      }

      return data.data;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async getTeamSyncWhatChanged(args: {
    limit?: number;
    since?: string;
    branch?: string;
    sessionId?: string;
    paths?: string[];
    recentFiles?: string[];
  }): Promise<TeamSyncChangesResponse> {
    if (!this.config.apiKey) {
      throw new Error(
        "API key not configured. Run 'npx -y snipara-companion@latest init' first.",
      );
    }

    const projectIdentifier = this.resolveProjectIdentifier();
    const projectId = encodeURIComponent(projectIdentifier);
    const url = new URL(
      `${this.dashboardApiUrl()}/api/projects/${projectId}/team-sync/changes`,
    );

    if (typeof args.limit === "number") {
      url.searchParams.set("limit", String(args.limit));
    }
    if (args.since) {
      url.searchParams.set("since", args.since);
    }
    if (args.branch) {
      url.searchParams.set("branch", args.branch);
    }
    if (args.sessionId) {
      url.searchParams.set("sessionId", args.sessionId);
    }
    for (const file of args.paths ?? []) {
      url.searchParams.append("path", file);
    }
    for (const file of args.recentFiles ?? []) {
      url.searchParams.append("recentFile", file);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await this.fetchWithApiKeyRetry(
        url,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        },
        projectIdentifier,
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        success: boolean;
        data?: TeamSyncChangesResponse;
      };

      if (!data.success || !data.data?.whatChanged) {
        throw new Error("Team Sync changes response was invalid");
      }

      return data.data;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async createTeamSyncHandoff(args: {
    summary: string;
    task?: string;
    branch?: string;
    baseSha?: string;
    headSha?: string;
    sessionId?: string;
    client?: string;
    files?: string[];
    commands?: string[];
    tests?: string[];
    blocker?: string;
    assumptions?: string[];
    nextStep?: string;
    relatedLinks?: Array<{
      label: string;
      url: string;
    }>;
    attention?: "clear" | "watch" | "review" | "proof_required";
    durable?: boolean;
  }): Promise<TeamSyncHandoffResponse> {
    if (!this.config.apiKey) {
      throw new Error(
        "API key not configured. Run 'npx -y snipara-companion@latest init' first.",
      );
    }

    const projectIdentifier = this.resolveProjectIdentifier();
    const projectId = encodeURIComponent(projectIdentifier);
    const url = `${this.dashboardApiUrl()}/api/projects/${projectId}/team-sync/handoffs`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await this.fetchWithApiKeyRetry(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(args),
          signal: controller.signal,
        },
        projectIdentifier,
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        success: boolean;
        data?: TeamSyncHandoffResponse;
      };

      if (!data.success || !data.data?.handoff) {
        throw new Error("Team Sync handoff response was invalid");
      }

      return data.data;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async getLatestTeamSyncHandoff(args?: {
    sessionId?: string;
    branch?: string;
    task?: string;
    recentFiles?: string[];
  }): Promise<TeamSyncResumeResponse> {
    if (!this.config.apiKey) {
      throw new Error(
        "API key not configured. Run 'npx -y snipara-companion@latest init' first.",
      );
    }

    const projectIdentifier = this.resolveProjectIdentifier();
    const projectId = encodeURIComponent(projectIdentifier);
    const url = new URL(
      `${this.dashboardApiUrl()}/api/projects/${projectId}/team-sync/handoffs/latest`,
    );

    if (args?.sessionId) {
      url.searchParams.set("sessionId", args.sessionId);
    }
    if (args?.branch) {
      url.searchParams.set("branch", args.branch);
    }
    if (args?.task) {
      url.searchParams.set("task", args.task);
    }
    if (args?.recentFiles?.length) {
      url.searchParams.set("recentFiles", args.recentFiles.join(","));
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await this.fetchWithApiKeyRetry(
        url,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        },
        projectIdentifier,
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        success: boolean;
        data?: TeamSyncResumeResponse;
      };

      if (
        !data.success ||
        !data.data?.match ||
        !Array.isArray(data.data.recommendedActions)
      ) {
        throw new Error("Team Sync resume response was invalid");
      }

      return data.data;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async getCollaborationState(): Promise<CollaborationStateResponse> {
    return this.dashboardProjectRequest<CollaborationStateResponse>(
      "/collaboration/sessions",
      {
        method: "GET",
      },
      {
        invalidMessage: "Collaboration state response was invalid",
        validate: (data) =>
          Array.isArray(data.sessions) && Array.isArray(data.leases),
      },
    );
  }

  async startCollaborationSession(
    args: CollaborationActorPayload & {
      workSessionId?: string;
      swarmId?: string;
      client?: string;
      repository?: string;
      branch?: string;
      worktree?: string;
      task?: string;
      heartbeatTtlSeconds?: number;
      files?: string[];
      dirtyFiles?: string[];
      resources?: CollaborationResource[];
      metadata?: Record<string, unknown>;
    },
  ): Promise<CollaborationSessionResponse> {
    return this.dashboardProjectRequest<CollaborationSessionResponse>(
      "/collaboration/sessions",
      {
        method: "POST",
        body: args,
      },
      {
        invalidMessage: "Collaboration session response was invalid",
        validate: (data) =>
          Boolean(data.session?.id) && Array.isArray(data.resources),
      },
    );
  }

  async updateCollaborationSession(
    workSessionId: string,
    args: CollaborationActorPayload & {
      status?: "ACTIVE" | "STALE" | "COMPLETED" | "ABANDONED";
      swarmId?: string;
      client?: string;
      repository?: string;
      branch?: string;
      worktree?: string;
      task?: string;
      heartbeatTtlSeconds?: number;
      files?: string[];
      dirtyFiles?: string[];
      resources?: CollaborationResource[];
      metadata?: Record<string, unknown>;
    },
  ): Promise<CollaborationSessionResponse> {
    return this.dashboardProjectRequest<CollaborationSessionResponse>(
      `/collaboration/sessions/${encodeURIComponent(workSessionId)}`,
      {
        method: "PATCH",
        body: args,
      },
      {
        invalidMessage: "Collaboration session update response was invalid",
        validate: (data) =>
          Boolean(data.session?.id) && Array.isArray(data.resources),
      },
    );
  }

  async createCollaborationLeases(
    args: CollaborationActorPayload & {
      workSessionId?: string;
      swarmId?: string;
      mode?: CollaborationLeaseMode;
      reason?: string;
      ttlSeconds?: number;
      files?: string[];
      resources?: CollaborationResource[];
      metadata?: Record<string, unknown>;
    },
  ): Promise<CollaborationLeaseResponse> {
    return this.dashboardProjectRequest<CollaborationLeaseResponse>(
      "/collaboration/leases",
      {
        method: "POST",
        body: args,
      },
      {
        invalidMessage: "Collaboration lease response was invalid",
        validate: (data) =>
          Array.isArray(data.resources) && Array.isArray(data.leases),
      },
    );
  }

  async updateCollaborationLease(
    leaseId: string,
    args: CollaborationActorPayload & {
      action?: "heartbeat" | "release" | "override";
      reason?: string;
    },
  ): Promise<CollaborationLeaseUpdateResponse> {
    return this.dashboardProjectRequest<CollaborationLeaseUpdateResponse>(
      `/collaboration/leases/${encodeURIComponent(leaseId)}`,
      {
        method: "PATCH",
        body: args,
      },
      {
        invalidMessage: "Collaboration lease update response was invalid",
        validate: (data) => Boolean(data.lease?.id),
      },
    );
  }

  async evaluateCollaborationGuard(
    args: CollaborationActorPayload & {
      workSessionId?: string;
      action?: string;
      files?: string[];
      resources?: CollaborationResource[];
      persist?: boolean;
      metadata?: Record<string, unknown>;
    },
  ): Promise<CollaborationGuardResponse> {
    return this.dashboardProjectRequest<CollaborationGuardResponse>(
      "/collaboration/guard",
      {
        method: "POST",
        body: args,
      },
      {
        invalidMessage: "Collaboration guard response was invalid",
        validate: (data) =>
          Array.isArray(data.resources) &&
          Boolean(data.evaluation?.decision) &&
          Array.isArray(data.evaluation.conflicts),
      },
    );
  }

  async plan(
    query: string,
    maxTokens?: number,
  ): Promise<Record<string, unknown>> {
    return this.mcpCall("snipara_plan", {
      query,
      strategy: "relevance_first",
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    });
  }

  async uploadDocument(
    path: string,
    content: string,
    options: UploadDocumentOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.mcpCall("snipara_upload_document", {
      path,
      content,
      ...(options.kind ? { kind: options.kind } : {}),
      ...(options.format ? { format: options.format } : {}),
      ...(options.language ? { language: options.language } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
    });
  }

  async listBusinessCollections(
    options: ListBusinessCollectionsOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.mcpCall("snipara_list_business_collections", {
      ...(options.includeCustom !== undefined
        ? { include_custom: options.includeCustom }
        : {}),
      ...(options.includeMissingPresets !== undefined
        ? { include_missing_presets: options.includeMissingPresets }
        : {}),
    });
  }

  async ensureBusinessCollection(
    options: EnsureBusinessCollectionOptions,
  ): Promise<Record<string, unknown>> {
    return this.mcpCall("snipara_ensure_business_collection", {
      ...(options.preset ? { preset: options.preset } : {}),
      ...(options.name ? { name: options.name } : {}),
      ...(options.slug ? { slug: options.slug } : {}),
      ...(options.description ? { description: options.description } : {}),
    });
  }

  async uploadBusinessDocument(
    options: UploadBusinessDocumentOptions,
  ): Promise<Record<string, unknown>> {
    return this.mcpCall("snipara_upload_business_document", {
      ...(options.collectionId ? { collection_id: options.collectionId } : {}),
      ...(options.preset ? { preset: options.preset } : {}),
      ...(options.collectionSlug
        ? { collection_slug: options.collectionSlug }
        : {}),
      title: options.title,
      content: options.content,
      ...(options.category ? { category: options.category } : {}),
      ...(options.tags ? { tags: options.tags } : {}),
      ...(typeof options.priority === "number"
        ? { priority: options.priority }
        : {}),
      ...(options.allowCustomCollection !== undefined
        ? { allow_custom_collection: options.allowCustomCollection }
        : {}),
    });
  }

  async listClientProjects(
    options: ListClientProjectsOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.mcpCall("snipara_list_client_projects", {
      ...(options.includeInternal !== undefined
        ? { include_internal: options.includeInternal }
        : {}),
      ...(options.limit ? { limit: options.limit } : {}),
    });
  }

  async createClientProject(
    options: CreateClientProjectOptions,
  ): Promise<Record<string, unknown>> {
    return this.mcpCall("snipara_create_client_project", {
      name: options.name,
      ...(options.slug ? { slug: options.slug } : {}),
      ...(options.description ? { description: options.description } : {}),
      ...(options.externalClientId
        ? { external_client_id: options.externalClientId }
        : {}),
    });
  }

  async syncDocuments(
    documents: SyncDocumentInput[],
    deleteMissing: boolean = false,
  ): Promise<Record<string, unknown>> {
    return this.mcpCall("snipara_sync_documents", {
      documents,
      delete_missing: deleteMissing,
    });
  }

  async syncProjectPolicyLedger(
    artifacts: ProjectPolicyLedgerSyncArtifactInput[],
  ): Promise<Record<string, unknown>> {
    return this.dashboardProjectRequest<Record<string, unknown>>(
      "/project-policy/ledger",
      {
        method: "POST",
        body: {
          client: {
            name: "snipara-companion",
            version: "unknown",
          },
          syncedAt: new Date().toISOString(),
          artifacts,
        },
      },
      {
        invalidMessage: "Invalid Project Policy ledger sync response",
        validate: (data) => typeof data === "object" && data !== null,
      },
    );
  }

  async diffHostedContextControl(input: {
    manifestHash: string;
    sources: HostedContextControlSource[];
  }): Promise<HostedContextControlDiffResponse> {
    return this.dashboardProjectRequest<HostedContextControlDiffResponse>(
      "/context-control",
      { method: "POST", body: { action: "diff", ...input } },
      {
        invalidMessage: "Invalid hosted Context Control diff response",
        validate: (data) => Boolean(data.project?.id && data.plan?.planHash),
      },
    );
  }

  async applyHostedContextControl(input: {
    plan: HostedContextControlPlan;
    approval?: unknown;
  }): Promise<HostedContextControlApplyResponse> {
    return this.dashboardProjectRequest<HostedContextControlApplyResponse>(
      "/context-control",
      { method: "POST", body: { action: "apply", ...input } },
      {
        invalidMessage: "Invalid hosted Context Control apply response",
        validate: (data) =>
          Boolean(data.project?.id && data.receipt?.receiptId),
      },
    );
  }

  async reindex(options: {
    kind?: "doc" | "code";
    mode?: "incremental" | "full";
    jobId?: string;
  }): Promise<Record<string, unknown>> {
    return this.mcpCall("snipara_reindex", {
      ...(options.kind ? { kind: options.kind } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.jobId ? { job_id: options.jobId } : {}),
    });
  }

  async indexHealth(
    staleThresholdDays?: number,
  ): Promise<Record<string, unknown>> {
    return this.mcpCall("snipara_index_health", {
      ...(staleThresholdDays
        ? { stale_threshold_days: staleThresholdDays }
        : {}),
    });
  }

  async getChunk(chunkId: string): Promise<Record<string, unknown>> {
    return this.mcpCall("snipara_get_chunk", {
      chunk_id: chunkId,
    });
  }

  async multiQuery(
    queries: Array<{ query: string; maxTokens?: number }>,
    maxTokens?: number,
  ): Promise<Record<string, unknown>> {
    return this.mcpCall("snipara_multi_query", {
      queries: queries.map((item) => ({
        query: item.query,
        ...(item.maxTokens ? { max_tokens: item.maxTokens } : {}),
      })),
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    });
  }

  async orchestrate(
    query: string,
    maxTokens?: number,
  ): Promise<Record<string, unknown>> {
    return this.mcpCall("snipara_orchestrate", {
      query,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    });
  }

  async loadDocument(path: string): Promise<Record<string, unknown>> {
    return this.mcpCall("snipara_load_document", {
      path,
    });
  }

  async getSessionMemories(
    maxCriticalTokens?: number,
    maxDailyTokens?: number,
    includeYesterday?: boolean,
  ): Promise<SessionMemoriesResult> {
    const result = await this.mcpCall<unknown>("snipara_session_memories", {
      ...(maxCriticalTokens !== undefined
        ? { max_critical_tokens: maxCriticalTokens }
        : {}),
      ...(maxDailyTokens !== undefined
        ? { max_daily_tokens: maxDailyTokens }
        : {}),
      ...(includeYesterday !== undefined
        ? { include_yesterday: includeYesterday }
        : {}),
    });

    return normalizeSessionMemoriesResult(result);
  }

  async endOfTaskCommit(args: {
    summary: string;
    task?: string;
    why?: EndOfTaskCommitWhyInput;
    category?: string;
    outcome?: "completed" | "partial" | "blocked" | "abandoned";
    filesTouched?: string[];
    persistTypes?: string[];
    handoffOnly?: boolean;
  }): Promise<Record<string, unknown>> {
    return this.mcpCall("snipara_end_of_task_commit", {
      summary: args.summary,
      ...(args.task ? { task: args.task } : {}),
      ...(args.why
        ? {
            why: {
              ...(args.why.decision ? { decision: args.why.decision } : {}),
              ...(args.why.rationale ? { rationale: args.why.rationale } : {}),
              ...(args.why.alternatives ? { alternatives: args.why.alternatives } : {}),
              ...(args.why.constraints ? { constraints: args.why.constraints } : {}),
              ...(args.why.observedOutcome
                ? { observed_outcome: args.why.observedOutcome }
                : {}),
            },
          }
        : {}),
      category: args.category,
      outcome: args.outcome || "completed",
      files_touched: args.filesTouched || [],
      persist_types: args.persistTypes ?? ["decision", "learning", "workflow"],
      ...(args.handoffOnly !== undefined
        ? { handoff_only: args.handoffOnly }
        : {}),
    });
  }

  async journalAppend(
    text: string,
    tags?: string[],
  ): Promise<JournalAppendResult> {
    return this.mcpCall<JournalAppendResult>("snipara_journal_append", {
      text,
      tags: tags && tags.length > 0 ? tags : undefined,
    });
  }
}

export async function listProjectsForApiKey(
  apiKey: string,
  apiUrl?: string,
  timeout: number = 10000,
): Promise<ApiKeyProjectSummary[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(
      `${getResolvedDashboardApiUrl(apiUrl)}/api/cli/projects`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        signal: controller.signal,
      },
    );

    const body = (await response.json().catch(() => null)) as {
      success?: boolean;
      data?: ApiKeyProjectSummary[];
      error?: string;
      message?: string;
    } | null;

    if (!response.ok || !body?.success || !Array.isArray(body.data)) {
      const message =
        body?.error ||
        body?.message ||
        `HTTP ${response.status}: ${response.statusText}`;
      throw new Error(message);
    }

    return body.data;
  } finally {
    clearTimeout(timeoutId);
  }
}
/**
 * Create a default client instance
 */
export function createClient(
  timeout?: number,
  options: ConfigResolutionOptions = {},
): RLMClient {
  return new RLMClient(timeout, options);
}
