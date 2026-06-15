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
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
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
  type RecentAutomationEvent,
  type RecallResult,
  type SharedContextDocumentResult,
  type SharedContextResult,
  type SessionMemoriesResult,
  type SessionMemoryEntry,
  type SessionMemoryTier,
  type SyncDocumentInput,
  type TeamSyncResumeResponse,
} from "../api/client";
import { createLocalQueryCache } from "../cache/query-cache";
import { isConfigured, loadConfig } from "../config/store";
import {
  detectRuntimeEnvironment,
  formatOrchestratorRecommendationReason,
  getOrchestratorRecommendation,
  type OrchestratorRecommendation,
  shouldSuggestRuntimeForWorkflow,
} from "../runtime/detection";
import {
  writeOrchestratorHandoff,
  type WrittenOrchestratorHandoff,
} from "../runtime/orchestrator-handoff";
import { buildCanonicalEvent } from "./events";
import { appendJournalCheckpoint, type JournalWriteResult } from "./journal";
import { buildLocalImpactResult } from "./code";
import { memoryGuardCheckCommand } from "./memory-guard";
import {
  autoArchiveTeamSyncState,
  buildTeamSyncHandoffRecord,
  buildTeamSyncSummary,
  completeTeamSyncStateFromEvidence,
  getTeamSyncStatePath,
  loadTeamSyncState,
  saveTeamSyncState,
  type TeamSyncHandoffRecord,
  type TeamSyncWorkRecord,
} from "./team-sync";

const DEFAULT_SESSION_CONTEXT_TOKENS = 1000;
const DEFAULT_FULL_WORKFLOW_CRITICAL_TOKENS = 2000;
const DEFAULT_SHARED_CONTEXT_TOKENS = 2000;
const TASK_COMMIT_TIMEOUT_MS = 30_000;
const FINAL_COMMIT_TIMEOUT_MS = 90_000;
const FINAL_COMMIT_RETRY_TIMEOUT_MS = 45_000;
const FINAL_COMMIT_SUMMARY_MAX_CHARS = 1_200;
const FINAL_COMMIT_RETRY_SUMMARY_MAX_CHARS = 600;
const SHARED_CONTEXT_INTENT_PATTERN =
  /\b(standard|standards|convention|conventions|guideline|guidelines|best practice|best practices|policy|policies|compliance|compliant|security rules|team rules|style guide|playbook|checklist)\b/i;
type SyncDocumentKind = "DOC" | "BINARY";

const DOCUMENT_SYNC_FORMATS: Record<string, { kind: SyncDocumentKind; format: string }> = {
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
const BUSINESS_ASSET_CLASSES = new Set(["BUSINESS_DOCUMENT", "PRESENTATION", "DIAGRAM"]);
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

export type WorkflowMode = "lite" | "standard" | "auto" | "full" | "orchestrate";
export type OnboardFolderMode = "auto" | "business_context" | "code_project" | "mixed";
export type DetectedOnboardFolderMode = "business_context" | "code_project" | "mixed" | "unknown";
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
type ManagedWorkflowSchemaVersion = "snipara.workflow.v1" | "snipara.workflow.v2";

export const WORKFLOW_STATE_RELATIVE_PATH = path.join(".snipara", "workflow", "current.json");
export const WORKFLOW_PLANS_RELATIVE_DIR = path.join(".snipara", "workflow", "plans");

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
  suggestedNextAction: string;
}

export interface AgenticTimelineEvent {
  time: string;
  kind:
    | "workflow-start"
    | "phase-start"
    | "phase-commit"
    | "final-commit"
    | "team-sync-start"
    | "team-sync-complete"
    | "team-sync-handoff";
  title: string;
  detail?: string;
  source: "workflow" | "team-sync";
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
      ", "
    )}.`
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
    console.log("Not configured. Run 'npx -y snipara-companion@latest init' first.");
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
        merged[key] = mergeRecords(merged[key] as Record<string, unknown>, value);
      } else {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function parseJsonRecord(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `${label} must be valid JSON: ${error instanceof Error ? error.message : error}`
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
  value: string | undefined
): BusinessCollectionPreset | undefined {
  const normalized = value?.trim().replace(/[-\s]/g, "_").toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (!BUSINESS_COLLECTION_PRESETS.has(normalized)) {
    throw new Error(
      "Business collection preset must be one of: business_response_playbook, business_library, offer_templates, company_presentations, reference_diagrams"
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
    options.metadataFile ? readJsonRecord(options.metadataFile, "--metadata-file") : undefined,
    options.metadata ? parseJsonRecord(options.metadata, "--metadata") : undefined,
    options.assetClass ? { assetClass: normalizeEnum(options.assetClass) } : undefined,
    options.usageMode ? { usageMode: options.usageMode } : undefined,
    options.sourceKind ? { sourceKind: options.sourceKind } : undefined,
    options.clientId ? { clientId: options.clientId } : undefined,
    options.sourceModifiedAt ? { sourceModifiedAt: options.sourceModifiedAt } : undefined,
    options.sourceSnapshotAt ? { sourceSnapshotAt: options.sourceSnapshotAt } : undefined
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
  filePath: string
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
  format: string | undefined
): boolean {
  if (!kind || !format) {
    return false;
  }
  return Object.values(DOCUMENT_SYNC_FORMATS).some(
    (candidate) => candidate.kind === kind && candidate.format === format
  );
}

function isBinaryPayload(content: string): boolean {
  return (
    content.startsWith("base64:") || (content.startsWith("data:") && content.includes(";base64,"))
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
  return createHash("sha256").update(contentBufferForHash(content)).digest("hex");
}

function toPreview(value: unknown, maxLength: number = 160): string {
  if (typeof value === "string") {
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
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
  const prefix = args.workflowId ? `Workflow ${args.workflowId}\nFinal commit\n` : "";
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
  return /abort|timeout|timed out|network|fetch|econn|etimedout|http 5\d\d/.test(message);
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
  return isFinalCommitCategory(normalized) ? normalized : `final-commit:${normalized}`;
}

export function getPlanStepDisplayTitle(step: unknown, index: number = 0): string {
  if (typeof step === "string") {
    return toPreview(step);
  }

  if (!isRecord(step)) {
    return `Step ${index + 1}`;
  }

  return toPreview(step.title ?? step.name ?? step.action ?? step.goal ?? `Step ${index + 1}`);
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

function uniqueStringList(values: Array<string | undefined> | undefined): string[] | undefined {
  if (!values) {
    return undefined;
  }
  const unique = Array.from(
    new Set(
      values.map((value) => stringValue(value)).filter((value): value is string => Boolean(value))
    )
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

function uniquePhaseId(candidate: string, index: number, used: Set<string>): string {
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
  fallbackGoal: string
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
    stringValue(step.id) ?? stringValue(step.phase_id) ?? stringValue(step.key) ?? title,
    index,
    usedIds
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
    ...(normalizeStringArray(step.gates) ? { gates: normalizeStringArray(step.gates) } : {}),
    ...(booleanValue(step.needs_runtime ?? step.runtime) !== undefined
      ? { needsRuntime: Boolean(booleanValue(step.needs_runtime ?? step.runtime)) }
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
  return /^(phases|steps|tasks|items)\s*:?\s*$/i.test(stripWorkflowMarkdownLine(line));
}

function isWorkflowMetaLine(line: string): boolean {
  return /^(goal|status|mode|date|audience)\s*:/i.test(stripWorkflowMarkdownLine(line));
}

function matchWorkflowListItem(line: string): { indent: number; text: string } | undefined {
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

function parseWorkflowPlanText(content: string, fallbackGoal: string): unknown[] {
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

  const explicitSectionIndex = lines.findIndex((line) => isWorkflowSectionMarker(line));
  const phaseStartIndex = explicitSectionIndex >= 0 ? explicitSectionIndex + 1 : 0;
  const hasTopLevelList = lines.some((line) => Boolean(matchWorkflowListItem(line)));

  const parsedPhases: Array<{ title: string; query: string; acceptance?: string }> = [];
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
      query: [currentPhase.title, ...details.map((detail) => `- ${detail}`)].join("\n"),
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

  const headingPhases: Array<{ title: string; query: string; acceptance?: string }> = [];
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
  fallbackGoal: string
): ManagedWorkflowPhase[] {
  const usedIds = new Set<string>();
  const steps =
    typeof input === "string"
      ? parseWorkflowPlanText(input, fallbackGoal)
      : findWorkflowSteps(input);
  const sourceSteps = steps.length > 0 ? steps : [fallbackGoal];
  return sourceSteps.map((step, index) =>
    normalizeWorkflowPhase(step, index, usedIds, fallbackGoal)
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
  goal?: string
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
            gates: ["snipara-companion code impact", "targeted regression tests"],
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
            gates: ["team-sync what-changed", "resume context regression tests"],
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
  cwd: string = process.cwd()
): string {
  return path.resolve(cwd, WORKFLOW_PLANS_RELATIVE_DIR, `${preset}-plan.json`);
}

function toProjectRelativePath(absolutePath: string, cwd: string = process.cwd()): string {
  const relative = path.relative(cwd, absolutePath);
  return relative && !relative.startsWith("..") ? relative : absolutePath;
}

export function buildWorkflowPlanScaffold(
  preset: WorkflowPlanPreset,
  options: {
    goal?: string;
    outputPath?: string;
    cwd?: string;
  } = {}
): WorkflowPlanScaffoldResult {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const outputPath = path.resolve(options.outputPath ?? defaultWorkflowPlanOutputPath(preset, cwd));
  const plan = buildWorkflowPlanPresetDocument(preset, options.goal);
  return {
    preset,
    goal: plan.goal,
    outputPath,
    relativeOutputPath: toProjectRelativePath(outputPath, cwd),
    plan,
  };
}

function readWorkflowPlanFile(planFile: string, fallbackGoal: string): ManagedWorkflowPhase[] {
  const content = fs.readFileSync(planFile, "utf-8");
  if (planFile.toLowerCase().endsWith(".json")) {
    return normalizeWorkflowPlanInput(JSON.parse(content), fallbackGoal);
  }
  return normalizeWorkflowPlanInput(content, fallbackGoal);
}

function getWorkflowStatePath(cwd: string = process.cwd()): string {
  return path.join(cwd, WORKFLOW_STATE_RELATIVE_PATH);
}

function normalizeManagedWorkflowState(state: ManagedWorkflowState): ManagedWorkflowState {
  if (
    state.schemaVersion !== "snipara.workflow.v1" &&
    state.schemaVersion !== "snipara.workflow.v2"
  ) {
    throw new Error(`${WORKFLOW_STATE_RELATIVE_PATH} is not a valid Snipara workflow state file`);
  }

  return {
    ...state,
    runtime: normalizeManagedWorkflowRuntimeState(state.runtime),
  };
}

function normalizeManagedWorkflowRuntimeState(
  runtime: ManagedWorkflowRuntimeState | undefined
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
                commands: uniqueStringList(binding.lastCheckpoint.commands) ?? [],
                artifacts: uniqueStringList(binding.lastCheckpoint.artifacts) ?? [],
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

function readWorkflowState(cwd: string = process.cwd()): ManagedWorkflowState | undefined {
  const statePath = getWorkflowStatePath(cwd);
  if (!fs.existsSync(statePath)) {
    return undefined;
  }
  const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8")) as ManagedWorkflowState;
  if (!Array.isArray(parsed.phases)) {
    throw new Error(`${WORKFLOW_STATE_RELATIVE_PATH} is not a valid Snipara workflow state file`);
  }
  return normalizeManagedWorkflowState(parsed);
}

function readRequiredWorkflowState(): ManagedWorkflowState {
  const state = readWorkflowState();
  if (!state) {
    throw new Error(
      `No managed workflow found at ${WORKFLOW_STATE_RELATIVE_PATH}. Run 'snipara-companion workflow start' first.`
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
  fs.writeFileSync(statePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
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
  fs.writeFileSync(`${scaffold.outputPath}`, `${JSON.stringify(scaffold.plan, null, 2)}\n`, "utf8");

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
      scaffold.relativeOutputPath
    )}`
  );
  if (scaffold.plan.steps.some((step) => step.needs_runtime)) {
    console.log(
      "Runtime-bound phases are included; use workflow phase-start and workflow runtime-checkpoint during sandbox-backed validation."
    );
  }
  console.log("");
}

function findWorkflowPhase(state: ManagedWorkflowState, phaseId: string): ManagedWorkflowPhase {
  const phase = state.phases.find((candidate) => candidate.id === phaseId);
  if (!phase) {
    throw new Error(`Unknown workflow phase '${phaseId}'`);
  }
  return phase;
}

function nextOpenPhase(state: ManagedWorkflowState): ManagedWorkflowPhase | undefined {
  return state.phases.find((phase) => phase.status === "pending" || phase.status === "blocked");
}

function currentWorkflowPhase(state: ManagedWorkflowState): ManagedWorkflowPhase | undefined {
  if (state.currentPhaseId) {
    return state.phases.find((phase) => phase.id === state.currentPhaseId);
  }
  return nextOpenPhase(state);
}

function sandboxBindings(state: ManagedWorkflowState): ManagedWorkflowSandboxRuntimeBinding[] {
  return state.runtime?.sandbox?.bindings ?? [];
}

function findSandboxRuntimeBinding(
  state: ManagedWorkflowState,
  phaseId: string
): ManagedWorkflowSandboxRuntimeBinding | undefined {
  return sandboxBindings(state).find((binding) => binding.phaseId === phaseId);
}

function defaultSandboxSessionId(
  state: ManagedWorkflowState,
  phase: Pick<ManagedWorkflowPhase, "id">
): string {
  const workflowSlug = sanitizeWorkflowId(state.workflowId, "workflow").slice(0, 24);
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
  now: string
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

  const existing = state.runtime.sandbox.bindings.find((binding) => binding.phaseId === phase.id);
  if (existing) {
    existing.bootstrapQuery = existing.bootstrapQuery || phaseQuery(state, phase);
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
  checkpoint: ManagedWorkflowRuntimeCheckpoint | undefined
): string[] | undefined {
  if (!checkpoint?.rehydratableState) {
    return undefined;
  }
  return uniqueStringList(Object.keys(checkpoint.rehydratableState));
}

function normalizeRuntimeCheckpointRecord(
  checkpoint: ManagedWorkflowRuntimeCheckpoint
): ManagedWorkflowRuntimeCheckpoint {
  return {
    ...checkpoint,
    files: uniqueStringList(checkpoint.files) ?? [],
    commands: uniqueStringList(checkpoint.commands) ?? [],
    artifacts: uniqueStringList(checkpoint.artifacts) ?? [],
  };
}

function runtimeCheckpointEventPayload(
  event: RecentAutomationEvent
): Record<string, unknown> | undefined {
  const payload = isRecord(event.event.payload) ? event.event.payload : undefined;
  if (!payload) {
    return undefined;
  }
  const toolName = stringValue(payload.tool_name ?? payload.toolName ?? payload.tool);
  if (toolName !== "snipara_sandbox_runtime_checkpoint") {
    return undefined;
  }
  return payload;
}

function parseRuntimeCheckpointFromEvent(
  event: RecentAutomationEvent,
  workflowId: string,
  phaseId: string
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
      stringValue(runtimeCheckpoint.bootstrap_query) ?? stringValue(payload.task) ?? undefined,
    files:
      normalizeStringArray(runtimeCheckpoint.files) ??
      normalizeStringArray(payload.files) ??
      undefined,
    commands:
      normalizeStringArray(runtimeCheckpoint.commands) ??
      normalizeStringArray(payload.commands) ??
      undefined,
    artifacts: normalizeStringArray(runtimeCheckpoint.artifacts) ?? undefined,
    rehydratableState: recordField(runtimeCheckpoint, "rehydratable_state"),
  });
}

function phaseStatusFromOutcome(outcome: TaskCommitOutcome): ManagedWorkflowPhaseStatus {
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

function phaseQuery(state: ManagedWorkflowState, phase: ManagedWorkflowPhase): string {
  return phase.query || `${state.goal}: ${phase.title}`;
}

function effectiveWorkflowMode(mode: WorkflowMode): Exclude<WorkflowMode, "auto"> {
  return mode === "auto" ? "standard" : mode;
}

function shouldFollowWorkflowRecommendations(mode: WorkflowMode): boolean {
  const effectiveMode = effectiveWorkflowMode(mode);
  return effectiveMode === "standard" || effectiveMode === "full";
}

function printManagedWorkflowState(state: ManagedWorkflowState): void {
  printKeyValue("Workflow:", `${state.workflowId} (${state.status})`);
  printKeyValue("Goal:", state.goal);
  printKeyValue("State file:", WORKFLOW_STATE_RELATIVE_PATH);
  if (state.currentPhaseId) {
    printKeyValue("Current phase:", state.currentPhaseId);
    const runtimeBinding = findSandboxRuntimeBinding(state, state.currentPhaseId);
    if (runtimeBinding) {
      printKeyValue("Sandbox session:", runtimeBinding.sessionId);
    }
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

function printManagedWorkflowDiscipline(): void {
  console.log(chalk.bold("Coding workflow mode"));
  console.log(
    "- LITE: small single-phase edits still start with Snipara recall/context and end with local verification."
  );
  console.log(
    "- STANDARD: normal coding work uses context plus recommended code-graph follow-up; --mode auto is a compatibility alias."
  );
  console.log(
    "- FULL: use this managed workflow with phases/chunks for multi-file, risky, release/deploy, architectural, or compaction-prone coding work."
  );
  console.log(
    "- FULL + ORCHESTRATED: use explicit snipara-orchestrator handoff only for production gates, drift checks, htasks, or multi-agent coordination."
  );
  console.log(
    "- Before concluding on routes/services/jobs, risky changes, or what is missing, run the code impact gate."
  );
  console.log(
    "- For execution/test/debug/finalization that benefits from repeatable isolation, use Snipara Sandbox MCP execute_python or snipara-sandbox run."
  );
  console.log("");
}

function printManagedWorkflowNextCommands(state: ManagedWorkflowState): void {
  const phase = currentWorkflowPhase(state);
  printManagedWorkflowDiscipline();
  if (!phase || state.status === "completed") {
    console.log(chalk.bold("Next commands"));
    console.log("snipara-companion final-commit --summary '<final summary>' --files <files...>");
    console.log("");
    return;
  }

  console.log(chalk.bold("Next commands"));
  console.log(`snipara-companion workflow phase-start ${phase.id}`);
  console.log(
    `snipara-companion workflow run --mode full --include-session-context --query ${shellQuote(
      phaseQuery(state, phase)
    )}`
  );
  if (phase.files && phase.files.length > 0) {
    console.log(
      `snipara-companion code impact --changed-files ${phase.files.map(shellQuote).join(" ")} --diff-summary ${shellQuote(
        phase.title
      )}`
    );
  } else {
    console.log(
      "snipara-companion code impact --changed-files <files...> --diff-summary '<change>'"
    );
  }
  if (phase.needsRuntime) {
    printManagedWorkflowRuntimeGuidance();
    console.log(
      `snipara-companion workflow runtime-checkpoint ${phase.id} --summary '<resume-ready runtime state>' --rehydrate-file <state.json>`
    );
  }
  console.log(
    `snipara-companion workflow phase-commit ${phase.id} --summary '<what changed>' --files <files...>`
  );
  console.log("");
}

function printManagedWorkflowResumeBoundary(): void {
  console.log(chalk.bold("Resume boundary"));
  console.log(
    "- workflow resume restores local phase state plus hosted memory and Team Sync continuity."
  );
  console.log(
    "- For runtime-bound phases, it restores the recorded Sandbox binding and prints a reattach or rehydrate plan."
  );
  console.log("- It does not snapshot or exactly restore a live Snipara Sandbox process.");
  console.log("");
}

function printManagedWorkflowRuntimeGuidance(): void {
  const report = detectRuntimeEnvironment();
  if (report.runtime.cliAvailable) {
    console.log(
      "Use Snipara Sandbox MCP execute_python for execution/test/debug/finalization when repeatable isolated validation helps."
    );
    if (!report.runtime.mcpConfigured) {
      console.log("Add Snipara Sandbox MCP config with: npx create-snipara repair --with-runtime");
    }
    return;
  }

  console.log(
    "This phase may need sandboxed execution/test/debug/finalization. Add Snipara Sandbox with: npx create-snipara repair --with-runtime"
  );
  console.log("Fresh setup option: npx create-snipara --profile full-stack --advanced");
}

interface WorkflowRuntimeResumePlan {
  binding: ManagedWorkflowSandboxRuntimeBinding;
  checkpoint?: ManagedWorkflowRuntimeCheckpoint;
  reattachSessionId: string;
  caveats: string[];
}

async function loadWorkflowRuntimeResumePlan(
  state: ManagedWorkflowState
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
          currentPhase.id
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
      "No runtime checkpoint payload was found for the active phase yet; capture one after material Sandbox work with workflow runtime-checkpoint."
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
  } | null
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
    `- In your AI client, call Snipara Sandbox MCP list_sessions and look for session_id='${data.reattachSessionId}'.`
  );
  console.log(
    `- If it exists, continue execute_python/get_repl_context calls with session_id='${data.reattachSessionId}'.`
  );

  console.log("Rehydrate path:");
  console.log(
    `- Call snipara_repl_context with the active phase query, then set_repl_context(key='context', value=<context_data>, session_id='${data.binding.sessionId}').`
  );
  if (
    data.checkpoint?.rehydratableState &&
    Object.keys(data.checkpoint.rehydratableState).length > 0
  ) {
    console.log(
      `- Restore the checkpointed JSON state for keys ${Object.keys(data.checkpoint.rehydratableState).join(", ")} in the same session before execute_python(setup_code).`
    );
  } else {
    console.log(
      "- Restore any JSON-serializable runtime state you saved for this phase before execute_python(setup_code)."
    );
  }
  if (data.checkpoint?.bootstrapQuery || data.binding.bootstrapQuery) {
    console.log(
      `- Bootstrap query: ${shellQuote(data.checkpoint?.bootstrapQuery ?? data.binding.bootstrapQuery)}`
    );
  }
  if (data.caveats.length) {
    console.log(`Caveats: ${data.caveats.join("; ")}`);
  }
}

function printCompactObject(record: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) {
      printKeyValue(`${key}:`, toPreview(value));
    }
  }
}

function recordField(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function recordArrayField(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
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
    const status = execFileSync("git", ["status", "--short"], execOptions).trim();
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
    const branch = execFileSync("git", ["branch", "--show-current"], execOptions).trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

function runGitText(
  args: string[],
  cwd: string = process.cwd(),
  timeout: number = 3000
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
      throw new Error(`Unable to resolve workflow impact base ref '${explicitBase}'.`);
    }
    return explicitBase;
  }

  const upstream = runGitText(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    repoRoot
  );
  if (upstream) {
    return upstream;
  }

  const branch = readCurrentGitBranch(repoRoot);
  const originBranch = branch ? `origin/${branch}` : undefined;
  if (originBranch && runGitText(["rev-parse", "--verify", originBranch], repoRoot)) {
    return originBranch;
  }

  throw new Error(
    "Unable to resolve an upstream branch for workflow impact gate. Pass --base <ref>."
  );
}

function readUnpushedCommits(repoRoot: string, baseRef: string): WorkflowImpactGateCommit[] {
  const output = runGitText(
    ["log", "--format=%H%x1f%s%x1f%an%x1f%aI%x1e", `${baseRef}..HEAD`],
    repoRoot,
    5000
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
  return readGitNulList(["diff", "--name-only", "-z", `${baseRef}..HEAD`, "--"], repoRoot)
    .map(normalizeRepoFilePath)
    .sort();
}

function parseDirtyFileFromStatusLine(line: string): string | undefined {
  const rawPath = line.slice(2).trim();
  if (!rawPath) {
    return undefined;
  }
  const renamedPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() : rawPath;
  return renamedPath ? normalizeRepoFilePath(renamedPath.replace(/^"|"$/g, "")) : undefined;
}

function isLocalImpactCodeFile(filePath: string): boolean {
  return [".ts", ".tsx", ".mts", ".cts", ".py", ".pyi", ".go"].includes(path.extname(filePath));
}

function completedWorkflowPhasesForImpact(
  state: ManagedWorkflowState | undefined,
  changedFiles: string[]
): WorkflowImpactGatePhase[] {
  const changedFileSet = new Set(changedFiles);
  return (state?.phases ?? [])
    .filter((phase) => phase.status === "completed" && phase.completedAt)
    .map((phase) => {
      const files = uniqueStringList((phase.files ?? []).map(normalizeRepoFilePath)) ?? [];
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
      String(left.completedAt ?? "").localeCompare(String(right.completedAt ?? ""))
    );
}

function buildHostedImpactFollowUpCommand(changedFiles: string[]): string | undefined {
  if (changedFiles.length === 0) {
    return undefined;
  }
  const files = changedFiles.map(shellQuote).join(" ");
  return `snipara-companion code impact --changed-files ${files} --diff-summary 'unpushed workflow phases after push/index'`;
}

function compactLocalImpactForWorkflowGate(
  impact: Record<string, unknown>
): Record<string, unknown> {
  const symbols = Array.isArray(impact.symbols) ? impact.symbols : [];
  const incoming = Array.isArray(impact.incoming) ? impact.incoming : [];
  const outgoing = Array.isArray(impact.outgoing) ? impact.outgoing : [];
  const impactedFiles = Array.isArray(impact.impactedFiles) ? impact.impactedFiles : [];
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
  } = {}
): WorkflowImpactGateResult {
  const repoRoot = readGitRepoRoot(options.cwd);
  const branch = readCurrentGitBranch(repoRoot);
  const upstream = resolveWorkflowImpactBaseRef(repoRoot, options.base);
  const baseSha = runGitText(["rev-parse", "--verify", upstream], repoRoot);
  const headSha = runGitText(["rev-parse", "--verify", "HEAD"], repoRoot);
  const changedFiles = readUnpushedChangedFiles(repoRoot, upstream);
  const codeChangedFiles = changedFiles.filter(isLocalImpactCodeFile);
  const nonCodeChangedFiles = changedFiles.filter((file) => !isLocalImpactCodeFile(file));
  const commits = readUnpushedCommits(repoRoot, upstream);
  const dirtyStatusLines = readLocalGitState(repoRoot).statusLines ?? [];
  const dirtyFiles = dirtyStatusLines
    .map(parseDirtyFileFromStatusLine)
    .filter((file): file is string => Boolean(file));
  const state = readWorkflowState(repoRoot);
  const completedPhases = completedWorkflowPhasesForImpact(state, changedFiles);
  const phaseFileSet = new Set(completedPhases.flatMap((phase) => phase.files));
  const changedFilesWithoutPhase = changedFiles.filter((file) => !phaseFileSet.has(file));
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
          })
        )
      : null;
  const reasonCodes = [
    dirtyFiles.length > 0 ? "dirty_working_tree_not_included" : undefined,
    commits.length === 0 ? "no_unpushed_commits" : undefined,
    changedFilesWithoutPhase.length > 0 ? "changed_files_without_phase_commit" : undefined,
    phaseFilesOutsideUnpushedDiff.length > 0 ? "phase_files_outside_unpushed_diff" : undefined,
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
      ? { hostedFollowUpCommand: buildHostedImpactFollowUpCommand(changedFiles) }
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
      console.log(chalk.gray(`... ${result.unpushed.commits.length - 12} more`));
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
    const impactedFiles = Array.isArray(localImpact.impactedFiles) ? localImpact.impactedFiles : [];
    const incoming = Array.isArray(localImpact.incoming) ? localImpact.incoming : [];
    const outgoing = Array.isArray(localImpact.outgoing) ? localImpact.outgoing : [];
    console.log(chalk.bold("Local Impact"));
    printKeyValue("Impacted files:", impactedFiles.length);
    printKeyValue("Incoming edges:", incoming.length);
    printKeyValue("Outgoing edges:", outgoing.length);
    const warnings = recordArrayField(localImpact, "warnings");
    if (warnings.length > 0) {
      console.log(`Warnings: ${warnings.map((warning) => toPreview(warning.code)).join(", ")}`);
    }
    console.log("");
  }

  if (result.dirtyWorkingTree.statusLines.length > 0) {
    console.log(chalk.bold("Dirty Working Tree"));
    for (const line of result.dirtyWorkingTree.statusLines.slice(0, 8)) {
      console.log(`- ${line}`);
    }
    if (result.dirtyWorkingTree.statusLines.length > 8) {
      console.log(chalk.gray(`... ${result.dirtyWorkingTree.statusLines.length - 8} more`));
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

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.map((item) => stringValue(item)).filter((item): item is string => Boolean(item))
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
    "Document/context health is separate; this section only describes indexed code graph freshness."
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
        : `no (indexed ${shortCommit(commit)} vs local ${shortCommit(localGit.head)})`
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
        : `dirty (${localGit.statusLines.length} entries; uncommitted edits are outside hosted graph)`
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
    targets.length > 0 ? `targets: ${targets.slice(0, 4).join(", ")}` : undefined,
  ]
    .filter(Boolean)
    .join(" - ");
  return suffix ? `${label} - ${suffix}` : label;
}

function printActionList(title: string, records: Record<string, unknown>[], maxItems = 8): void {
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
    console.log(`- ${tool}(${JSON.stringify(args)})${reason ? ` - ${reason}` : ""}`);
  }
  console.log("");
}

function printAgentVerificationReminder(): void {
  console.log(chalk.bold("Agent Use"));
  console.log("- Treat this as indexed repository context, then verify exact files locally.");
  console.log("- If degraded or stale, use the suggested lightweight code tools and local tests.");
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
  return toolName.startsWith("rlm_") ? `snipara_${toolName.slice("rlm_".length)}` : toolName;
}

function printQueryResult(result: ContextQueryResult): void {
  printKeyValue("Query:", result.query);
  printKeyValue("Sections:", result.sections.length);
  printKeyValue("Tokens:", result.total_tokens);
  if (result.recommended_tool) {
    printKeyValue("Suggested tool:", displaySniparaToolName(result.recommended_tool));
  }
  console.log("");

  if (result.sections.length === 0) {
    if (result.recommended_tool) {
      console.log(chalk.cyan("Structural query detected."));
      console.log(chalk.gray(JSON.stringify(result.recommended_tool_arguments || {}, null, 2)));
      console.log("");
      return;
    }
    console.log(chalk.yellow("No relevant sections found."));
    return;
  }

  for (const section of result.sections) {
    console.log(chalk.bold(section.title));
    if (section.file) {
      console.log(chalk.gray(`${section.file}:${section.lines[0]}-${section.lines[1]}`));
    }
    if (section.content) {
      console.log(section.content.trim());
    }
    console.log("");
  }
}

function formatNodeLabel(node: CodeGraphNodeResult): string {
  const location = node.file_path ? ` (${node.file_path}:${node.start_line})` : "";
  return `${node.qualified_name}${location}`;
}

function printNodeList(label: string, nodes: CodeGraphNodeResult[], maxItems: number = 8): void {
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
    `- ${doc.title} (${doc.collection_name} · ${source} · ${doc.category}${mandatory} · ${doc.token_count} tokens)${tags}`
  );
}

function printSharedContextResult(result: SharedContextResult): void {
  printKeyValue("Tool:", "snipara_shared_context");
  printKeyValue(
    "Linked collections:",
    result.linked_collections_loaded ?? result.collections_loaded
  );
  printKeyValue("Team context docs:", result.team_context_documents_loaded ?? 0);
  printKeyValue(
    "Linked collection docs:",
    result.linked_collection_documents_loaded ?? result.documents.length
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
  printCompactObject(result, ["message", "match_strategy", "degraded", "recommendation"]);
  console.log("");

  printCodeIndexFreshness(result);
  const targets = recordArrayField(result, "matched_targets");
  printNodeList("Matched Targets", targets as unknown as CodeGraphNodeResult[], 5);

  const cards = recordArrayField(result, "cards");
  if (cards.length > 0) {
    console.log(chalk.bold("Symbol Cards"));
    for (const card of cards.slice(0, 5)) {
      const context = recordField(card, "context") ?? {};
      const relations = recordField(card, "relations") ?? {};
      const relationCounts = ["tests", "docs", "routes", "config", "mcp_tools", "symbols"]
        .map((key) => {
          const value = relations[key];
          return Array.isArray(value) && value.length > 0 ? `${key}:${value.length}` : undefined;
        })
        .filter(Boolean)
        .join(" ");
      console.log(`- ${toPreview(context.qualified_name ?? card.symbol_key, 140)}`);
      if (context.summary) {
        console.log(`  Summary: ${toPreview(context.summary, 180)}`);
      }
      console.log(
        `  Role: ${toPreview(context.role)} | Layer: ${toPreview(
          context.layer
        )} | Risk: ${toPreview(context.risk_level ?? context.riskLevel)}`
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
  printCompactObject(result, ["message", "degraded", "retryable", "recommendation"]);
  const risk = recordField(result, "risk");
  if (risk) {
    printKeyValue("Risk:", `${toPreview(risk.level)} (${toPreview(risk.score)})`);
  }
  const evidence = recordField(result, "evidence_summary");
  if (evidence?.matched_target_count !== undefined) {
    printKeyValue("Matched targets:", toPreview(evidence.matched_target_count));
  } else {
    printKeyValue("Matched targets:", recordArrayField(result, "matched_targets").length);
  }
  const changedFiles = stringArrayField(result, "changed_files");
  if (changedFiles.length > 0) {
    printKeyValue("Changed files:", changedFiles.slice(0, 6).join(", "));
  }
  console.log("");

  printCodeIndexFreshness(result);
  const targets = recordArrayField(result, "matched_targets");
  printNodeList("Matched Targets", targets as unknown as CodeGraphNodeResult[], 5);

  const impact = recordField(result, "impact");
  if (impact) {
    printImpactCounts(impact);
    console.log("");
  }

  printActionList("Recommended Actions", recordArrayField(result, "recommended_actions"));
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
  if (!queryResult.recommended_tool || !queryResult.recommended_tool_arguments) {
    return undefined;
  }

  const client = createClient(20000);
  const result = await client.callTool<unknown>(
    queryResult.recommended_tool,
    queryResult.recommended_tool_arguments
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

  if (typeof summary === "string" && summary.length > 0) {
    printKeyValue("Summary:", summary);
  }
  if (typeof strategy === "string" && strategy.length > 0) {
    printKeyValue("Strategy:", strategy);
  }
  printKeyValue("Steps:", steps.length);
  console.log("");

  if (steps.length > 0) {
    steps.forEach((step, index) => {
      if (typeof step === "string") {
        console.log(`${index + 1}. ${step}`);
        return;
      }
      if (isRecord(step)) {
        const title = toPreview(
          step.title ?? step.name ?? step.action ?? step.goal ?? `Step ${index + 1}`
        );
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
      console.log("Use MCP execute_python from your AI client for sandboxed validation.");
    } else {
      console.log(
        "For MCP execute_python, add Snipara Sandbox MCP config with: npx create-snipara repair --with-runtime"
      );
    }
    console.log(`For standalone execution: snipara-sandbox run ${JSON.stringify(query)}`);
    if (!report.providerKeys.any) {
      console.log(
        "Standalone snipara-sandbox run / snipara-sandbox agent needs OPENAI_API_KEY or ANTHROPIC_API_KEY."
      );
    } else if (
      report.providerKeys.sources.openai === "env-file" ||
      report.providerKeys.sources.anthropic === "env-file"
    ) {
      console.log(
        "Provider key was found in a local .env file; export it first if standalone snipara-sandbox run does not load .env in your shell."
      );
    }
    if (!report.docker.available) {
      console.log(
        "Docker was not detected; use local/sandbox mode or install Docker for isolation."
      );
    }
    return;
  }

  console.log("Need sandboxed execution or autonomous Sandbox jobs?");
  console.log("Existing project: npx create-snipara repair --with-runtime");
  console.log("Fresh setup: npx create-snipara --profile full-stack --advanced");
  console.log("Manual install: pip install 'snipara-sandbox[all]'");
}

function runtimeHintVersionLabel(report: ReturnType<typeof detectRuntimeEnvironment>): string {
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
  recommendation: OrchestratorRecommendation | null = getOrchestratorRecommendation(query, mode)
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
    `Reasons: ${recommendation.reasons.map((reason) => formatOrchestratorRecommendationReason(reason)).join("; ")}`
  );

  if (report.orchestrator.cliAvailable) {
    const versionLabel = report.orchestrator.version ? ` (${report.orchestrator.version})` : "";
    console.log(`snipara-orchestrator is installed${versionLabel}.`);
    if (recommendation.level === "auto") {
      console.log(
        "Policy auto-route marked this task for orchestrator handling and prepared the handoff automatically."
      );
    } else if (recommendation.orchestratorRequired) {
      console.log(
        "Companion recommends an explicit orchestrator handoff for production proof gates, drift checks, htask queues, or multi-agent coordination."
      );
    } else {
      console.log(
        "Companion can keep this local for now, but orchestrator is likely to help once proof gates or shared coordination become explicit."
      );
    }
    if (recommendation.reasons.includes("htask_or_swarm_intent")) {
      console.log(
        "Preferred multi-agent path: snipara-orchestrator swarm-create | swarm-join | htask-create-feature | htask-create | htask-next | htask-tree | htask-complete."
      );
      console.log(
        "Direct hosted fallback: snipara-companion swarm create|join and snipara-companion htask create|create-feature|next|tree|complete."
      );
    }
  } else {
    console.log(
      "For production proof gates, drift checks, htasks, or multi-agent coordination, install explicitly with: npx create-snipara repair --with-orchestrator"
    );
    console.log("Manual install: pip install snipara-orchestrator");
    if (recommendation.reasons.includes("htask_or_swarm_intent")) {
      console.log(
        "Until orchestrator is installed, use snipara-companion swarm create|join and snipara-companion htask create|create-feature|next|tree|complete as direct hosted fallbacks, then promote the queue back to snipara-orchestrator once multi-agent coordination is intentional."
      );
    }
  }

  console.log(
    "Companion keeps workflow state and phase commits; it does not spawn orchestrator workers automatically."
  );
}

function printPreparedOrchestratorHandoff(handoff: WrittenOrchestratorHandoff): void {
  console.log("");
  console.log(chalk.bold("Prepared Orchestrator Handoff"));
  console.log(`Path: ${handoff.relativePath}`);
  console.log(`Command: ${handoff.command}`);
}

function printUploadResult(path: string, result: Record<string, unknown>): void {
  printKeyValue("Uploaded:", path);
  printCompactObject(result, ["message", "document_id", "documentId", "version", "status"]);
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

  const attention = result.documents.filter((item) => item.recommended_action !== "none");
  if (attention.length > 0) {
    console.log(chalk.bold("Attention"));
    for (const item of attention.slice(0, 10)) {
      console.log(`- ${item.path}: ${item.recommended_action} (${item.reasons.join(", ")})`);
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
    `${result.classification.mode} (${Math.round(result.classification.confidence * 100)}%)`
  );
  printKeyValue("Supported documents:", result.summary.supported_documents);
  printKeyValue("Ignored files:", result.summary.ignored_files);
  if (result.summary.unsupported_business_files > 0) {
    printKeyValue("Unsupported business-looking files:", result.summary.unsupported_business_files);
  }
  printKeyValue("Would sync:", result.dryRun.would_sync);
  printKeyValue("Invalid metadata:", result.dryRun.invalid_metadata);
  if (result.sync.reindex) {
    printKeyValue("Reindex:", `${result.sync.reindexKind}/${result.sync.reindexMode}`);
  }
  console.log("");

  if (result.classification.signals.code.length > 0) {
    console.log(chalk.bold("Code signals"));
    for (const signal of result.classification.signals.code.slice(0, 8)) {
      console.log(`- ${signal}`);
    }
    if (result.classification.signals.code.length > 8) {
      console.log(chalk.gray(`... ${result.classification.signals.code.length - 8} more`));
    }
    console.log("");
  }

  if (result.classification.signals.business.length > 0) {
    console.log(chalk.bold("Business signals"));
    for (const signal of result.classification.signals.business.slice(0, 8)) {
      console.log(`- ${signal}`);
    }
    if (result.classification.signals.business.length > 8) {
      console.log(chalk.gray(`... ${result.classification.signals.business.length - 8} more`));
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
    chalk.gray("Preview only. Re-run with --apply to upload, or --write-manifest to save JSON.")
  );
  console.log("");
  printJson(result);
}

function printReindexResult(result: Record<string, unknown>): void {
  printKeyValue("Tool:", "snipara_reindex");
  printCompactObject(result, ["message", "job_id", "jobId", "status", "kind", "mode", "progress"]);
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

  const businessContext = isRecord(result.business_context) ? result.business_context : null;
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

    const signals = Array.isArray(businessContext.signals) ? businessContext.signals : [];
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

function printChunkResult(chunkId: string, result: Record<string, unknown>): void {
  printKeyValue("Chunk:", chunkId);
  printCompactObject(result, ["title", "file_path", "path", "line_start", "line_end", "tokens"]);
  console.log("");

  const content = result.content;
  if (typeof content === "string") {
    console.log(content.trim());
    return;
  }

  printJson(result);
}

function readSessionEntryPreview(entry: SessionMemoryEntry): string {
  return toPreview(entry.text ?? entry.content ?? entry.summary ?? entry.title, 220);
}

function printSessionTier(label: string, tier: SessionMemoryTier): void {
  if (tier.memories.length === 0) {
    return;
  }

  console.log(chalk.bold(label));
  for (const entry of tier.memories.slice(0, 5)) {
    console.log(`- ${readSessionEntryPreview(entry)}`);
  }
  console.log("");
}

function printSessionBootstrap(
  result: SessionMemoriesResult,
  options: { includeSessionContext: boolean }
): void {
  const normalized = normalizeSessionMemoriesResult(result);

  printKeyValue("Durable memory:", normalized.critical.count);
  printKeyValue(
    "Session context:",
    options.includeSessionContext
      ? normalized.daily.count
      : "skipped by default (use --include-session-context)"
  );
  if (typeof normalized.total_tokens === "number") {
    printKeyValue("Tokens:", normalized.total_tokens);
  }
  if (typeof normalized.message === "string" && normalized.message.length > 0) {
    printKeyValue("Message:", normalized.message);
  }
  console.log("");

  printSessionTier("Durable Memory", normalized.critical);
  if (options.includeSessionContext) {
    printSessionTier("Session Context (weak carryover)", normalized.daily);
  }

  if (normalized.critical.count === 0 && normalized.daily.count === 0) {
    printJson(normalized);
  }
}

function printTaskCommitResult(result: Record<string, unknown>): void {
  printKeyValue("Tool:", "snipara_end_of_task_commit");
  printCompactObject(result, ["stored", "skipped", "status", "message"]);
  const handoff = isRecord(result.team_sync_handoff) ? result.team_sync_handoff : null;
  if (handoff) {
    const status = typeof handoff.status === "string" ? handoff.status : "unknown";
    const memoryId = typeof handoff.memory_id === "string" ? ` (${handoff.memory_id})` : "";
    printKeyValue("Team Sync handoff:", `${status}${memoryId}`);
  }
  console.log("");
  printJson(result);
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
        printCompactObject(entry, ["query", "total_tokens", "max_tokens", "answer", "summary"]);
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
          printCompactObject(entry, ["query", "total_tokens", "max_tokens", "answer", "summary"]);
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
      printCompactObject(section, ["file", "file_path", "score", "relevance_score"]);
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
      const meta = [memory.type, memory.scope, memory.category].filter(Boolean).join(" · ");
      console.log(chalk.bold(toPreview(memory.content, 180)));
      if (meta.length > 0) {
        printKeyValue("Meta:", meta);
      }
      printKeyValue(
        "Scores:",
        `relevance ${memory.relevance.toFixed(2)} · confidence ${memory.confidence.toFixed(2)}`
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
      console.log(`- ${warning.status}: ${toPreview(warning.content, 140)}${reason}`);
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
  json?: boolean;
  followRecommendation?: boolean;
}): Promise<void> {
  ensureConfigured();

  const client = createClient(15000);
  const result = await client.queryContext(options.query, options.maxTokens || 8000);
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
        : result
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
  json?: boolean;
}): Promise<void> {
  ensureConfigured();

  const client = createClient(15000);
  const result = await client.plan(options.query, options.maxTokens);
  if (options.json) {
    printJson(result);
    return;
  }
  printPlanResult(result);
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
    printJson(reindexResult ? { upload: result, reindex: reindexResult } : result);
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
  const collections = Array.isArray(result.collections) ? result.collections : [];
  printKeyValue("Collections:", collections.length);
  for (const collection of collections) {
    if (!isRecord(collection)) continue;
    console.log(
      `- ${collection.name ?? collection.slug} (${collection.slug}) · ${
        collection.document_count ?? 0
      } docs`
    );
  }
  const missing = Array.isArray(result.missing_presets) ? result.missing_presets : [];
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
  printCompactObject(result, ["message", "action", "name", "slug", "collection_id"]);
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
    options.content ?? (options.file ? fs.readFileSync(options.file, "utf-8") : undefined);
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
    console.log(`- ${project.name ?? project.slug} (${project.slug}) · ${project.scope}`);
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
  printCompactObject(result, ["message", "action", "name", "slug", "project_id"]);
  console.log("");
  printJson(result);
}

function normalizeSyncDocumentsPayload(payload: unknown): CollectedSyncDocuments {
  const rawDocuments = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.documents)
      ? payload.documents
      : undefined;

  if (!rawDocuments) {
    throw new Error("Sync payload must be an array or an object with a documents array");
  }

  const manifestRecord = isRecord(payload) && !Array.isArray(payload) ? payload : {};
  const defaults = isRecord(manifestRecord.defaults) ? manifestRecord.defaults : {};
  const metadataDefaults = mergeRecords(
    isRecord(defaults.metadata) ? defaults.metadata : undefined,
    isRecord(manifestRecord.metadataDefaults) ? manifestRecord.metadataDefaults : undefined,
    isRecord(manifestRecord.metadata) ? manifestRecord.metadata : undefined
  );

  const documents = rawDocuments.map((item, index) => {
    if (!isRecord(item) || typeof item.path !== "string" || typeof item.content !== "string") {
      throw new Error(`Invalid document at index ${index}: expected { path, content }`);
    }
    const metadata = mergeRecords(metadataDefaults, isRecord(item.metadata) ? item.metadata : {});
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
      deleteMissing: optionalBoolean(manifestRecord.deleteMissing ?? manifestRecord.delete_missing),
      dryRun: optionalBoolean(manifestRecord.dryRun ?? manifestRecord.dry_run),
      reindex: optionalBoolean(manifestRecord.reindex),
      reindexKind: optionalReindexKind(manifestRecord.reindexKind ?? manifestRecord.reindex_kind),
      reindexMode: optionalReindexMode(manifestRecord.reindexMode ?? manifestRecord.reindex_mode),
    },
  };
}

function toUploadPath(filePath: string, rootDir: string, prefix?: string): string {
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
      if (!entry.isFile() || !DEFAULT_SYNC_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
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
    const payload = JSON.parse(fs.readFileSync(options.file, "utf-8")) as unknown;
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
  const normalized = stringValue(value)?.replace(/[-\s]/g, "_").toLowerCase() ?? "auto";
  if (
    normalized === "auto" ||
    normalized === "business_context" ||
    normalized === "code_project" ||
    normalized === "mixed"
  ) {
    return normalized;
  }
  throw new Error("Onboard mode must be one of: auto, business_context, code_project, mixed");
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

function scanOnboardFolder(options: { dir: string; recursive: boolean }): OnboardFolderFile[] {
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
  overrideMode: OnboardFolderMode = "auto"
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

    if ([".docx", ".pdf", ".pptx", ".vsdx", ".xlsx", ".xls", ".csv", ".tsv"].includes(ext)) {
      businessScore += 2;
      addSignal(businessSignals, `${ext} documents`);
    }
    if (hasBusinessKeyword(file.path)) {
      businessScore += 2;
      addSignal(businessSignals, `business keyword in ${file.path}`);
    }
    if (file.supported && [".md", ".markdown", ".mdx", ".txt", ".rst", ".adoc"].includes(ext)) {
      supportedPlainDocuments += 1;
    }
  }

  codeScore += Math.min(5, codeSourceFiles * 0.25);
  businessScore += Math.min(3, supportedPlainDocuments * 0.35);
  if (codeSourceFiles > 0) {
    addSignal(codeSignals, `${codeSourceFiles} source-looking files`);
  }
  if (supportedPlainDocuments > 0) {
    addSignal(businessSignals, `${supportedPlainDocuments} supported text documents`);
  }

  const codeStrong = codeScore >= 3;
  const businessStrong =
    businessScore >= 2.5 || (!codeStrong && files.some((file) => file.supported));
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
        ? Math.min(0.92, 0.58 + Math.min(codeScore, businessScore) / Math.max(totalScore, 1))
        : Math.min(0.95, 0.55 + Math.max(codeScore, businessScore) / Math.max(totalScore + 4, 1));
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
  mode: DetectedOnboardFolderMode
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

function buildOnboardSyncManifestPayload(result: OnboardFolderManifest): Record<string, unknown> {
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

export function buildOnboardFolderManifest(options: OnboardFolderOptions): OnboardFolderManifest {
  const rootDir = path.resolve(options.dir);
  const recursive = options.recursive ?? true;
  const files = scanOnboardFolder({ dir: rootDir, recursive });
  const modeOverride = normalizeOnboardFolderMode(options.mode);
  const classification = classifyOnboardFolder(rootDir, files, modeOverride);
  const sourceKind = options.sourceKind ?? "local_agent";
  const sourceProvider = options.sourceProvider ?? "local_folder";
  const snapshotDate = options.snapshotAt ? parseIsoDate(options.snapshotAt) : new Date();
  if (!snapshotDate) {
    throw new Error("--snapshot-at must be a valid ISO date");
  }
  const snapshotAt = snapshotDate.toISOString();
  const usageMode = normalizeUsageMode(options.usageMode ?? "current_truth") ?? "current_truth";
  const supportedFiles = files.filter((file) => file.supported);
  const ignoredFiles = files.filter((file) => !file.supported);
  const unsupportedBusinessFiles = ignoredFiles.filter(isBusinessLookingFile);
  const extractionMethod =
    sourceProvider === "local_folder" ? "local_folder_scan" : "llm_client_connector";

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
    options.clientId ? { clientId: options.clientId } : undefined
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
      "Could not confidently classify this folder; review the manifest before applying."
    );
  }
  if (classification.detected_mode !== classification.mode) {
    warnings.push(
      `Mode override applied: detected ${classification.detected_mode}, using ${classification.mode}.`
    );
  }
  if (classification.mode === "code_project") {
    warnings.push(
      "This looks like a code project. onboard-folder is business-first and only uploads supported documents; use the GitHub OAuth/code onboarding flow for source-code indexing."
    );
  }
  if (classification.mode === "mixed") {
    warnings.push(
      "This folder looks mixed. Review per-document contextLane metadata before applying."
    );
  }
  if (unsupportedBusinessFiles.length > 0) {
    warnings.push(
      `${unsupportedBusinessFiles.length} business-looking files are ignored because their formats are not supported by snipara_sync_documents yet.`
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
  const referenceProvenance = metadata.referenceProvenance ?? metadata.reference_provenance;
  if (isRecord(referenceProvenance)) {
    return Object.values(referenceProvenance).some((value) => Boolean(stringValue(value)));
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
  reasons: string[]
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
  now: Date
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

  const usageModeRaw = metadata.usageMode ?? metadata.usage_mode ?? metadata.contextRole;
  const usageMode = normalizeUsageMode(usageModeRaw);
  if (usageModeRaw !== undefined && !usageMode) {
    reasons.push("invalid_usage_mode");
  }

  const sourceKind = stringValue(metadata.sourceKind ?? metadata.source_kind);
  if (sourceKind && !SOURCE_KINDS.has(sourceKind)) {
    reasons.push("invalid_source_kind");
  }

  const { maxAgeDays } = validateFreshnessPolicy(metadata, reasons);
  const sourceModifiedAtRaw = metadata.sourceModifiedAt ?? metadata.source_modified_at;
  const sourceSnapshotAtRaw = metadata.sourceSnapshotAt ?? metadata.source_snapshot_at;
  const sourceModifiedAt = parseIsoDate(sourceModifiedAtRaw);
  const sourceSnapshotAt = parseIsoDate(sourceSnapshotAtRaw);
  const sourceHash = stringValue(metadata.sourceContentHash ?? metadata.source_content_hash);
  const latestHash = stringValue(
    metadata.latestSourceContentHash ??
      metadata.currentSourceContentHash ??
      metadata.manifestSourceContentHash
  );

  if (sourceModifiedAtRaw !== undefined && !sourceModifiedAt) {
    reasons.push("invalid_source_modified_at");
  }
  if (sourceSnapshotAtRaw !== undefined && !sourceSnapshotAt) {
    reasons.push("invalid_source_snapshot_at");
  }

  if (usageMode === "current_truth" && !sourceModifiedAt && !sourceSnapshotAt && !sourceHash) {
    reviewReasons.push("missing_source_metadata");
  }

  if (usageMode === "historical_reference" && !hasReferenceProvenance(metadata)) {
    reviewReasons.push("missing_reference_provenance");
  }

  const effectiveMaxAgeDays = maxAgeDays ?? (usageMode === "current_truth" ? 30 : undefined);
  if (sourceSnapshotAt && effectiveMaxAgeDays !== undefined) {
    const daysSinceSnapshot = Math.max(
      0,
      Math.floor((now.getTime() - sourceSnapshotAt.getTime()) / (1000 * 60 * 60 * 24))
    );
    if (daysSinceSnapshot > effectiveMaxAgeDays) {
      reuploadReasons.push("source_snapshot_expired");
    }
  }
  if (sourceModifiedAt && sourceSnapshotAt && sourceModifiedAt > sourceSnapshotAt) {
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
  } = {}
): SyncDocumentsDryRunSummary {
  const now = options.now ?? new Date();
  const items = documents.map((document) => validateDocumentForDryRun(document, now));
  const invalidMetadata = items.filter((item) => item.status === "invalid_metadata").length;
  const needsReupload = items.filter((item) => item.recommended_action === "reupload").length;
  const needsMetadataReview = items.filter(
    (item) => item.recommended_action === "review_source_metadata"
  ).length;
  const stale = items.filter((item) =>
    item.reasons.some((reason) => REUPLOAD_REASONS.has(reason))
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
      `No supported documents found to sync (${[...DEFAULT_SYNC_EXTENSIONS].sort().join(", ")})`
    );
  }

  const deleteMissing = options.deleteMissing ?? collected.manifestOptions.deleteMissing ?? false;
  const dryRun = options.dryRun ?? collected.manifestOptions.dryRun ?? false;
  const reindex = options.reindex ?? collected.manifestOptions.reindex ?? false;
  const reindexKind = options.reindexKind ?? collected.manifestOptions.reindexKind ?? "doc";
  const reindexMode = options.reindexMode ?? collected.manifestOptions.reindexMode ?? "incremental";

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
    printJson({ sync: result, ...(reindexResult ? { reindex: reindexResult } : {}) });
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
  }
): Promise<void> {
  const manifest = buildOnboardFolderManifest(options);
  if (options.writeManifest) {
    fs.writeFileSync(
      options.writeManifest,
      `${JSON.stringify(buildOnboardSyncManifestPayload(manifest), null, 2)}\n`,
      "utf-8"
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
      "Onboarding manifest has invalid metadata; run without --apply and review JSON."
    );
  }

  ensureConfigured();

  const client = createClient(30000);
  const syncResult = await client.syncDocuments(
    manifest.sync.documents,
    manifest.sync.deleteMissing
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
    `${manifest.classification.mode} (${Math.round(manifest.classification.confidence * 100)}%)`
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
        }
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

export async function chunkGetCommand(options: { chunkId: string; json?: boolean }): Promise<void> {
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
    options.maxTokens
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
    throw new Error("Provide --qualified-name, --symbol-key, --file-path, or --changed-files");
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
  json?: boolean;
}): Promise<void> {
  ensureConfigured();

  const client = createClient(20000);
  const orchestratorRecommendation = getOrchestratorRecommendation(options.query, options.mode, {
    policyAutoRoute: options.autoRouteOrchestrator,
    policySource: options.orchestratorPolicySource,
  });
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
          mode: options.mode,
        })
      : null;

  if (options.mode === "orchestrate") {
    const result = await client.orchestrate(options.query, options.maxTokens);
    if (options.json) {
      printJson({
        mode: options.mode,
        orchestrate: result,
        orchestrator_recommendation: orchestratorRecommendation,
        orchestrator_handoff: preparedHandoff,
      });
      return;
    }
    printOrchestrateResult(result);
    if (options.runtimeHint !== false) {
      printRuntimeHint(options.query, options.mode);
      printOrchestratorHandoffHint(options.query, options.mode, orchestratorRecommendation);
    }
    if (preparedHandoff) {
      printPreparedOrchestratorHandoff(preparedHandoff);
    }
    return;
  }

  const effectiveMode = effectiveWorkflowMode(options.mode);
  const payload: Record<string, unknown> = {
    mode: options.mode,
    effective_mode: effectiveMode,
    orchestrator_recommendation: orchestratorRecommendation,
    orchestrator_handoff: preparedHandoff,
  };

  if (effectiveMode === "full") {
    const maxContextTokens =
      options.maxContextTokens !== undefined
        ? options.maxContextTokens
        : options.includeSessionContext
          ? DEFAULT_SESSION_CONTEXT_TOKENS
          : 0;
    const bootstrap = await client.getSessionMemories(
      options.maxCriticalTokens ?? DEFAULT_FULL_WORKFLOW_CRITICAL_TOKENS,
      maxContextTokens
    );
    payload.session_bootstrap = bootstrap;
  }

  const context = await client.queryContext(options.query, options.maxTokens || 8000);
  payload.context = context;

  if (shouldFollowWorkflowRecommendations(options.mode) && hasSharedContextIntent(options.query)) {
    payload.shared_context = await client.sharedContext({
      maxTokens: Math.min(
        DEFAULT_SHARED_CONTEXT_TOKENS,
        Math.max(500, Math.floor((options.maxTokens || 8000) * 0.3))
      ),
      categories: inferSharedContextCategories(options.query),
      includeContent: true,
    });
  }

  if (context.recommended_tool && shouldFollowWorkflowRecommendations(options.mode)) {
    payload.executed_recommended_tool = await runRecommendedTool(context);
  }

  if (effectiveMode === "full") {
    payload.plan = await client.plan(options.query, options.maxTokens);
  }

  if (options.json) {
    printJson(payload);
    return;
  }

  if (effectiveMode === "full" && payload.session_bootstrap) {
    console.log(chalk.bold("Workflow Bootstrap"));
    printSessionBootstrap(payload.session_bootstrap as SessionMemoriesResult, {
      includeSessionContext: Boolean(options.includeSessionContext),
    });
  }

  printQueryResult(context);

  if (payload.shared_context && typeof payload.shared_context === "object") {
    printSharedContextResult(payload.shared_context as SharedContextResult);
  }

  if (payload.executed_recommended_tool && typeof payload.executed_recommended_tool === "object") {
    printRecommendedToolExecution(
      payload.executed_recommended_tool as {
        toolName: string;
        args: Record<string, unknown>;
        result: unknown;
      }
    );
  }

  if (effectiveMode === "full" && payload.plan && typeof payload.plan === "object") {
    console.log(chalk.bold("Generated Plan"));
    printPlanResult(payload.plan as Record<string, unknown>);
  }

  if (options.runtimeHint !== false) {
    printRuntimeHint(options.query, options.mode);
    printOrchestratorHandoffHint(options.query, options.mode, orchestratorRecommendation);
  }
  if (preparedHandoff) {
    printPreparedOrchestratorHandoff(preparedHandoff);
  }
}

export async function workflowStartCommand(options: {
  goal?: string;
  planFile?: string;
  id?: string;
  force?: boolean;
  json?: boolean;
}): Promise<void> {
  const existing = readWorkflowState();
  if (existing && existing.status === "active" && !options.force) {
    throw new Error(
      `Active workflow '${existing.workflowId}' already exists. Use --force to replace ${WORKFLOW_STATE_RELATIVE_PATH}.`
    );
  }

  const goal =
    options.goal ??
    (options.planFile ? `Workflow from ${path.basename(options.planFile)}` : undefined);
  if (!goal) {
    throw new Error("Provide --goal or --plan-file");
  }

  const phases = options.planFile
    ? readWorkflowPlanFile(options.planFile, goal)
    : normalizeWorkflowPlanInput(goal, goal);
  const now = new Date().toISOString();
  const workflowId =
    options.id ?? sanitizeWorkflowId(goal, `workflow-${now.slice(0, 10).replace(/-/g, "")}`);
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

  if (options.json) {
    printJson(state);
    return;
  }
  printManagedWorkflowState(state);
  printManagedWorkflowNextCommands(state);
}

export async function workflowStatusCommand(options: { json?: boolean }): Promise<void> {
  const state = readRequiredWorkflowState();
  if (options.json) {
    printJson(state);
    return;
  }
  printManagedWorkflowState(state);
  printManagedWorkflowNextCommands(state);
}

function lastCompletedWorkflowPhase(
  state: ManagedWorkflowState | undefined
): ManagedWorkflowPhase | undefined {
  return state?.phases
    .filter((phase) => phase.status === "completed" && phase.completedAt)
    .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)))[0];
}

function latestTeamSyncHandoff(
  handoffs: TeamSyncHandoffRecord[]
): TeamSyncHandoffRecord | undefined {
  return [...handoffs].sort((left, right) =>
    String(right.createdAt).localeCompare(String(left.createdAt))
  )[0];
}

function buildAgenticStatusRisks(args: {
  state?: ManagedWorkflowState;
  dirtyFileCount: number;
  staleWorkCount: number;
  latestHandoff?: TeamSyncHandoffRecord;
}): string[] {
  const risks: string[] = [];
  const currentPhase = args.state ? currentWorkflowPhase(args.state) : undefined;

  if (!args.state) {
    risks.push("No active managed workflow state found locally.");
  }
  if (args.dirtyFileCount > 0) {
    risks.push(`${args.dirtyFileCount} dirty git file(s) need review before handoff or commit.`);
  }
  if (args.staleWorkCount > 0) {
    risks.push(`${args.staleWorkCount} stale Team Sync work item(s) are still active.`);
  }
  if (currentPhase?.status === "blocked") {
    risks.push(`Current phase '${currentPhase.id}' is blocked.`);
  }
  if (args.latestHandoff?.attention && args.latestHandoff.attention !== "note") {
    risks.push(`Latest handoff attention: ${args.latestHandoff.attention}.`);
  }

  return risks;
}

function buildSuggestedAgenticNextAction(
  state: ManagedWorkflowState | undefined,
  risks: string[]
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

export function buildAgenticWorkStatus(cwd: string = process.cwd()): AgenticWorkStatus {
  const state = readWorkflowState(cwd);
  const git = readLocalGitState(cwd);
  autoArchiveTeamSyncState(cwd);
  const teamSyncState = loadTeamSyncState(cwd);
  const teamSyncSummary = buildTeamSyncSummary(teamSyncState);
  const latestHandoff = latestTeamSyncHandoff(teamSyncState.handoffs);
  const currentPhase = state ? currentWorkflowPhase(state) : undefined;
  const lastPhaseCommit = lastCompletedWorkflowPhase(state);
  const dirtyFileCount = git.statusLines?.length ?? 0;
  const risks = buildAgenticStatusRisks({
    state,
    dirtyFileCount,
    staleWorkCount: teamSyncSummary.staleWorkCount,
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
          resumeCommand: "snipara-companion workflow resume --include-session-context",
        }
      : null,
    teamSync: {
      activeWorkCount: teamSyncSummary.activeWorkCount,
      staleWorkCount: teamSyncSummary.staleWorkCount,
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
      note: "Run snipara-companion brief for hosted decisions and memory authority signals.",
    },
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
    printKeyValue("Workflow:", `${status.workflow.id} (${status.workflow.status})`);
    if (status.workflow.currentPhase) {
      printKeyValue(
        "Current phase:",
        `${status.workflow.currentPhase.id} (${status.workflow.currentPhase.status})`
      );
    }
    if (status.workflow.lastPhaseCommit) {
      const lastCommit = status.workflow.lastPhaseCommit;
      printKeyValue(
        "Last phase commit:",
        `${lastCommit.phaseId}${lastCommit.summary ? ` - ${toPreview(lastCommit.summary, 100)}` : ""}`
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
  if (status.teamSync.latestHandoff) {
    console.log(`Latest handoff: ${toPreview(status.teamSync.latestHandoff.summary, 120)}`);
    if (status.teamSync.latestHandoff.next) {
      console.log(`Next from handoff: ${toPreview(status.teamSync.latestHandoff.next, 120)}`);
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
  console.log(status.openDecisions.note);

  console.log("");
  printKeyValue("Next suggested action:", status.suggestedNextAction);
  if (status.workflow) {
    printKeyValue("Resume:", status.workflow.resumeCommand);
  }
  console.log("");
}

export async function agenticStatusCommand(options: { json?: boolean }): Promise<void> {
  const status = buildAgenticWorkStatus();
  if (options.json) {
    printJson(status);
    return;
  }
  printAgenticWorkStatus(status);
}

function pushTimelineEvent(
  events: AgenticTimelineEvent[],
  event: AgenticTimelineEvent | undefined
): void {
  if (event?.time) {
    events.push(event);
  }
}

function workflowTimelineEvents(state: ManagedWorkflowState | undefined): AgenticTimelineEvent[] {
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

function teamSyncHandoffEvent(handoff: TeamSyncHandoffRecord): AgenticTimelineEvent {
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
  } = {}
): AgenticTimeline {
  const limit = options.limit && options.limit > 0 ? options.limit : 20;
  const state = readWorkflowState(options.cwd);
  const teamSyncState = loadTeamSyncState(options.cwd ?? process.cwd());
  const events = [
    ...workflowTimelineEvents(state),
    ...teamSyncState.work.flatMap(teamSyncWorkEvents),
    ...teamSyncState.handoffs.map(teamSyncHandoffEvent),
  ]
    .sort((left, right) => String(right.time).localeCompare(String(left.time)))
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

export async function workflowTimelineCommand(options: {
  limit?: number;
  json?: boolean;
}): Promise<void> {
  const timeline = buildAgenticTimeline({ limit: options.limit });
  if (options.json) {
    printJson(timeline);
    return;
  }
  printAgenticTimeline(timeline);
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

  if (options.json) {
    printJson({ workflow: state, current_phase: phase });
    return;
  }

  printManagedWorkflowState(state);
  printManagedWorkflowDiscipline();
  console.log(chalk.bold("Phase context gate"));
  console.log(
    "snipara-companion session-bootstrap --include-session-context --max-context-tokens 1000"
  );
  console.log(
    `snipara-companion workflow run --mode full --include-session-context --query ${shellQuote(
      phaseQuery(state, phase)
    )}`
  );
  if (phase.files && phase.files.length > 0) {
    console.log(
      `snipara-companion code impact --changed-files ${phase.files.map(shellQuote).join(" ")} --diff-summary ${shellQuote(
        phase.title
      )}`
    );
  } else {
    console.log(
      "snipara-companion code impact --changed-files <files...> --diff-summary '<change>'"
    );
  }
  console.log(
    "For a named class/function/method in this phase, run: snipara-companion code symbol-card --qualified-name '<symbol>'"
  );
  if (runtimeBinding) {
    console.log(`Runtime binding: Snipara Sandbox session ${runtimeBinding.sessionId}`);
    console.log(
      `Checkpoint runtime progress with: snipara-companion workflow runtime-checkpoint ${phase.id} --summary '<resume-ready runtime state>' --rehydrate-file <state.json>`
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
        "Rehydratable runtime state is too large for workflow runtime-checkpoint; store bulky data as artifacts and pass only compact JSON here."
      );
    }
  }

  const checkpoint = normalizeRuntimeCheckpointRecord({
    summary: options.summary,
    capturedAt: now,
    automationSessionId: loadConfig().sessionId,
    environment: stringValue(options.environment) ?? binding.environment,
    profile: stringValue(options.profile) ?? binding.profile,
    bootstrapQuery: stringValue(options.bootstrapQuery) ?? binding.bootstrapQuery,
    files: uniqueStringList(options.files) ?? phase.files ?? [],
    commands: uniqueStringList(options.commands) ?? [],
    artifacts: uniqueStringList(options.artifacts) ?? binding.artifacts ?? [],
    ...(rehydratableState ? { rehydratableState } : {}),
  });

  binding.automationSessionId = checkpoint.automationSessionId ?? binding.automationSessionId;
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
            ...(checkpoint.rehydratableState
              ? { rehydratable_state: checkpoint.rehydratableState }
              : {}),
          },
        },
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
  if (hostedEvent?.id) {
    console.log(`Hosted runtime event: ${hostedEvent.id}`);
  } else if (hostedError) {
    console.log(`Hosted runtime event unavailable: ${hostedError}`);
  }
  console.log("");
  console.log(`Resume with: snipara-companion workflow resume --include-session-context`);
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
        : DEFAULT_SESSION_CONTEXT_TOKENS;
  const client = createClient(15000);
  const bootstrap = await client.getSessionMemories(
    options.maxCriticalTokens ?? DEFAULT_FULL_WORKFLOW_CRITICAL_TOKENS,
    resolvedContextTokens
  );
  const teamSyncResume = await loadWorkflowTeamSyncResume(state);
  const runtimeResume = await loadWorkflowRuntimeResumePlan(state);

  if (options.json) {
    printJson({
      workflow: state,
      session_bootstrap: bootstrap,
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
  printSessionBootstrap(bootstrap, {
    includeSessionContext: resolvedContextTokens > 0,
  });
  printWorkflowTeamSyncResume(teamSyncResume);
  printWorkflowRuntimeResumePlan(runtimeResume);
  printManagedWorkflowResumeBoundary();
  printManagedWorkflowNextCommands(state);
}

async function loadWorkflowTeamSyncResume(
  state: ManagedWorkflowState
): Promise<{ data?: TeamSyncResumeResponse; error?: string } | null> {
  const config = loadConfig();
  if (!config.apiKey) {
    return null;
  }

  const currentPhase =
    state.phases.find((phase) => phase.id === state.currentPhaseId) ?? nextOpenPhase(state);
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

function printWorkflowTeamSyncResume(
  result: { data?: TeamSyncResumeResponse; error?: string } | null
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
    console.log(`Recommended actions: ${data.recommendedActions.slice(0, 3).join("; ")}`);
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
    timeoutMs: number
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
      positiveIntegerEnv("SNIPARA_FINAL_COMMIT_TIMEOUT_MS", FINAL_COMMIT_TIMEOUT_MS)
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
          positiveIntegerEnv("SNIPARA_FINAL_COMMIT_RETRY_TIMEOUT_MS", FINAL_COMMIT_RETRY_TIMEOUT_MS)
        );
      } catch (retryError) {
        attempts.push({
          summary_chars: retrySummary.length,
          error: hostedCommitErrorMessage(retryError),
        });
      }
    }
  }

  const lastError = attempts[attempts.length - 1]?.error ?? "hosted final-commit failed";
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

function printTeamSyncCompletionNotice(completedWork: TeamSyncWorkRecord[]): void {
  if (completedWork.length === 0) {
    return;
  }
  console.log(`Team Sync completed work: ${completedWork.map((item) => item.summary).join(", ")}`);
}

export async function workflowPhaseCommitCommand(options: {
  phaseId: string;
  summary: string;
  category?: string;
  outcome?: TaskCommitOutcome;
  files?: string[];
  json?: boolean;
}): Promise<void> {
  const state = readRequiredWorkflowState();
  const phase = findWorkflowPhase(state, options.phaseId);
  const outcome = options.outcome ?? "completed";
  const files = options.files && options.files.length > 0 ? options.files : phase.files;

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
    category: options.category ?? "workflow-phase",
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

  const next = nextOpenPhase(state);
  state.currentPhaseId = next?.id;
  state.status = state.phases.every((candidate) =>
    ["completed", "skipped"].includes(candidate.status)
  )
    ? "completed"
    : phase.status === "blocked"
      ? "blocked"
      : "active";
  state.updatedAt = now;
  state.lastCommit = {
    category: options.category ?? "workflow-phase",
    outcome,
    summary: options.summary,
    committedAt: now,
  };
  writeWorkflowState(state);
  const completedTeamSyncWork =
    outcome === "completed" && state.status === "completed"
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

  if (options.json) {
    printJson({
      workflow: state,
      commit: result,
      journal,
      teamSyncCompletedWork: completedTeamSyncWork,
    });
    return;
  }
  printTaskCommitResult(result);
  printJournalWarning(journal);
  printTeamSyncCompletionNotice(completedTeamSyncWork);
  printManagedWorkflowState(state);
  printManagedWorkflowNextCommands(state);
}

export async function finalCommitCommand(options: {
  summary: string;
  category?: string;
  outcome?: TaskCommitOutcome;
  files?: string[];
  json?: boolean;
}): Promise<void> {
  await memoryGuardCheckCommand({
    trigger: "pre-final",
    files: options.files,
    strict: true,
  });

  const state = readWorkflowState();
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
    state.currentPhaseId = outcome === "completed" ? undefined : state.currentPhaseId;
    state.updatedAt = now;
    state.lastCommit = {
      category,
      outcome,
      summary: options.summary,
      committedAt: now,
    };
    writeWorkflowState(state);
  }
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

  if (options.json) {
    printJson({
      workflow: state,
      commit: result,
      journal,
      teamSyncCompletedWork: completedTeamSyncWork,
    });
    return;
  }
  printTaskCommitResult(result);
  printJournalWarning(journal);
  printTeamSyncCompletionNotice(completedTeamSyncWork);
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
  ensureConfigured();

  const resolvedContextTokens =
    options.maxContextTokens !== undefined
      ? options.maxContextTokens
      : options.includeSessionContext
        ? DEFAULT_SESSION_CONTEXT_TOKENS
        : 0;
  const client = createClient(15000);
  const result = await client.getSessionMemories(options.maxCriticalTokens, resolvedContextTokens);
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
    });
    return;
  }
  printSessionBootstrap(result, {
    includeSessionContext: resolvedContextTokens > 0,
  });
  if (warmSnapshot.storedEntries > 0) {
    printKeyValue(
      "Warm cache:",
      `${warmSnapshot.storedEntries} bootstrap memory/context entries primed locally`
    );
    console.log("");
  }
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
