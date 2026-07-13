import { hashDecisionJsonValue } from "./decision-request";

export const CONTEXT_MUTATION_PLAN_VERSION = "snipara.context_mutation_plan.v0" as const;
export const CONTEXT_MUTATION_APPLY_RECEIPT_VERSION =
  "snipara.context_mutation_apply_receipt.v0" as const;
export const PROJECT_DRIFT_REPORT_VERSION = "snipara.project_drift_report.v0" as const;
export const PROJECT_CONTEXT_MANIFEST_VERSION = "snipara.project_context_manifest.v0" as const;
export const PROJECT_CONTEXT_VALIDATION_VERSION = "snipara.project_context_validation.v0" as const;

export type ContextMutationProducerKind =
  | "companion_context_control"
  | "project_context_manifest"
  | "project_drift_report"
  | "decision_request_apply";

export type ContextMutationOperationKind = "write_file" | "record_receipt";
export type ContextMutationOperationMode = "create" | "replace" | "create_or_replace";
export type ContextMutationApplyStatus = "applied" | "already_applied" | "stale_base" | "blocked";
export type ProjectDriftState =
  | "IN_SYNC"
  | "DRIFT_DETECTED"
  | "UNKNOWN"
  | "STALE_EVIDENCE"
  | "BLOCKED_BY_CONFLICT";
export type ProjectDriftSurface =
  | "git"
  | "workflow"
  | "decision_requests"
  | "context_control"
  | "project_context_manifest"
  | "source_index"
  | "custom";
export type ProjectContextAuthority = "canonical" | "supporting" | "generated";
export type ProjectContextTier = "HOT" | "WARM" | "COLD";
export type ProjectContextValidationStatus = "valid" | "review_required" | "invalid";

export interface ContextMutationProducer {
  kind: ContextMutationProducerKind;
  command: string;
  sourceRef?: string;
}

export interface ContextMutationBaseRevision {
  kind: "git" | "unknown";
  branch?: string;
  headSha?: string;
  dirty: boolean;
  dirtyFiles: string[];
}

export interface ContextMutationPrecondition {
  kind: "base_revision_matches" | "target_inside_context_control" | "manual_approval_recorded";
  summary: string;
  required: boolean;
}

export interface ContextMutationOperation {
  opId: string;
  kind: ContextMutationOperationKind;
  target: string;
  summary: string;
  mode: ContextMutationOperationMode;
  content?: unknown;
  contentHash?: string;
  reasonCodes: string[];
}

export interface ContextMutationPlan {
  schemaVersion: typeof CONTEXT_MUTATION_PLAN_VERSION;
  planId: string;
  planHash: string;
  createdAt: string;
  producer: ContextMutationProducer;
  projectId?: string;
  baseRevision: ContextMutationBaseRevision;
  summary: string;
  operations: ContextMutationOperation[];
  preconditions: ContextMutationPrecondition[];
  warnings: string[];
  approvalRequired: boolean;
  expiresAt: string | null;
}

export interface ContextMutationAppliedOperation {
  opId: string;
  kind: ContextMutationOperationKind;
  target: string;
  status: "applied" | "skipped";
  contentHash?: string;
  message?: string;
}

export interface ContextMutationApplyReceipt {
  schemaVersion: typeof CONTEXT_MUTATION_APPLY_RECEIPT_VERSION;
  receiptId: string;
  planId: string;
  planHash: string;
  appliedAt: string;
  status: ContextMutationApplyStatus;
  baseRevisionAtApply: ContextMutationBaseRevision;
  appliedOperations: ContextMutationAppliedOperation[];
  skippedOperations: ContextMutationAppliedOperation[];
  caveats: string[];
}

export interface ProjectDriftSignal {
  id: string;
  surface: ProjectDriftSurface;
  state: ProjectDriftState;
  summary: string;
  expected?: string;
  observed?: string;
  refs: string[];
  severity: "info" | "watch" | "risk" | "block";
  reasonCodes: string[];
}

export interface ProjectDriftReport {
  schemaVersion: typeof PROJECT_DRIFT_REPORT_VERSION;
  reportId: string;
  generatedAt: string;
  state: ProjectDriftState;
  summary: string;
  signals: ProjectDriftSignal[];
  caveats: string[];
}

export interface ProjectContextSource {
  path: string;
  authority: ProjectContextAuthority;
  tier: ProjectContextTier;
  required: boolean;
  description?: string;
}

export interface ProjectContextPolicy {
  id: string;
  scope: string;
  requirement: string;
  reviewRequired: boolean;
}

export interface ProjectContextManifest {
  schemaVersion: typeof PROJECT_CONTEXT_MANIFEST_VERSION;
  project?: {
    id?: string;
    name?: string;
  };
  sources: ProjectContextSource[];
  policies: ProjectContextPolicy[];
  freshness?: {
    maxAgeDays?: number;
  };
}

export interface ProjectContextValidationFinding {
  id: string;
  severity: "info" | "warning" | "error";
  summary: string;
  refs: string[];
  reasonCodes: string[];
}

export interface ProjectContextValidationReport {
  schemaVersion: typeof PROJECT_CONTEXT_VALIDATION_VERSION;
  generatedAt: string;
  manifestHash: string;
  status: ProjectContextValidationStatus;
  manifest?: ProjectContextManifest;
  findings: ProjectContextValidationFinding[];
  caveats: string[];
}

export interface BuildContextMutationPlanInput {
  createdAt?: string | Date;
  producer: ContextMutationProducer;
  projectId?: string;
  baseRevision: ContextMutationBaseRevision;
  summary: string;
  operations: ContextMutationOperation[];
  preconditions?: ContextMutationPrecondition[];
  warnings?: string[];
  approvalRequired?: boolean;
  expiresAt?: string | Date | null;
}

export interface BuildContextMutationApplyReceiptInput {
  plan: ContextMutationPlan;
  appliedAt?: string | Date;
  status: ContextMutationApplyStatus;
  baseRevisionAtApply: ContextMutationBaseRevision;
  appliedOperations?: ContextMutationAppliedOperation[];
  skippedOperations?: ContextMutationAppliedOperation[];
  caveats?: string[];
}

export interface BuildProjectDriftReportInput {
  generatedAt?: string | Date;
  signals: ProjectDriftSignal[];
  caveats?: string[];
}

export interface ValidateProjectContextManifestInput {
  manifest: unknown;
  generatedAt?: string | Date;
}

export function buildContextMutationPlan(
  input: BuildContextMutationPlanInput
): ContextMutationPlan {
  const operations = normalizeOperations(input.operations);
  if (operations.length === 0) {
    throw new Error("Context mutation plan needs at least one operation.");
  }
  const createdAt = isoTimestamp(input.createdAt);
  const expiresAt =
    input.expiresAt === undefined || input.expiresAt === null
      ? null
      : isoTimestamp(input.expiresAt);
  const preconditions = normalizePreconditions(input.preconditions);
  const warnings = uniqueStrings(input.warnings ?? []);
  const planHash = hashContextMutationPlanContent({
    producer: normalizeProducer(input.producer),
    projectId: normalizeOptionalString(input.projectId),
    baseRevision: normalizeBaseRevision(input.baseRevision),
    summary: input.summary,
    operations,
    preconditions,
    warnings,
    approvalRequired: Boolean(input.approvalRequired),
    expiresAt,
  });

  return {
    schemaVersion: CONTEXT_MUTATION_PLAN_VERSION,
    planId: `ctxplan-${planHash.replace(/^sha256:/, "").slice(0, 16)}`,
    planHash,
    createdAt,
    producer: normalizeProducer(input.producer),
    ...(normalizeOptionalString(input.projectId)
      ? { projectId: normalizeOptionalString(input.projectId) }
      : {}),
    baseRevision: normalizeBaseRevision(input.baseRevision),
    summary: input.summary.trim(),
    operations,
    preconditions,
    warnings,
    approvalRequired: Boolean(input.approvalRequired),
    expiresAt,
  };
}

export function buildContextMutationApplyReceipt(
  input: BuildContextMutationApplyReceiptInput
): ContextMutationApplyReceipt {
  return {
    schemaVersion: CONTEXT_MUTATION_APPLY_RECEIPT_VERSION,
    receiptId: `ctxapply-${input.plan.planHash.replace(/^sha256:/, "").slice(0, 16)}`,
    planId: input.plan.planId,
    planHash: input.plan.planHash,
    appliedAt: isoTimestamp(input.appliedAt),
    status: input.status,
    baseRevisionAtApply: normalizeBaseRevision(input.baseRevisionAtApply),
    appliedOperations: normalizeAppliedOperations(input.appliedOperations ?? []),
    skippedOperations: normalizeAppliedOperations(input.skippedOperations ?? []),
    caveats: uniqueStrings(input.caveats ?? []),
  };
}

export function buildProjectDriftReport(input: BuildProjectDriftReportInput): ProjectDriftReport {
  const signals = normalizeDriftSignals(input.signals);
  const state = summarizeDriftState(signals);
  const reportHash = hashDecisionJsonValue({
    state,
    signals,
    caveats: uniqueStrings(input.caveats ?? []),
  }).replace(/^sha256:/, "");
  return {
    schemaVersion: PROJECT_DRIFT_REPORT_VERSION,
    reportId: `drift-${reportHash.slice(0, 16)}`,
    generatedAt: isoTimestamp(input.generatedAt),
    state,
    summary: summarizeDriftSignals(signals, state),
    signals,
    caveats: uniqueStrings(input.caveats ?? []),
  };
}

export function validateProjectContextManifest(
  input: ValidateProjectContextManifestInput
): ProjectContextValidationReport {
  const generatedAt = isoTimestamp(input.generatedAt);
  const findings: ProjectContextValidationFinding[] = [];
  const manifestRecord = isRecord(input.manifest) ? input.manifest : undefined;
  if (!manifestRecord) {
    findings.push(
      validationFinding("manifest_not_object", "error", "Manifest must be a JSON object.")
    );
  }
  if (manifestRecord && manifestRecord.schemaVersion !== PROJECT_CONTEXT_MANIFEST_VERSION) {
    findings.push(
      validationFinding(
        "manifest_schema_version_invalid",
        "error",
        `Manifest schemaVersion must be ${PROJECT_CONTEXT_MANIFEST_VERSION}.`
      )
    );
  }

  const sources = normalizeManifestSources(manifestRecord?.sources, findings);
  const policies = normalizeManifestPolicies(manifestRecord?.policies, findings);
  const freshness = normalizeManifestFreshness(manifestRecord?.freshness, findings);
  const project = normalizeManifestProject(manifestRecord?.project, findings);
  if (sources.length === 0) {
    findings.push(
      validationFinding("manifest_sources_empty", "error", "Manifest needs at least one source.")
    );
  }

  const manifest =
    findings.some((finding) => finding.severity === "error") || !manifestRecord
      ? undefined
      : {
          schemaVersion: PROJECT_CONTEXT_MANIFEST_VERSION,
          ...(project ? { project } : {}),
          sources,
          policies,
          ...(freshness ? { freshness } : {}),
        };
  const status: ProjectContextValidationStatus = findings.some(
    (finding) => finding.severity === "error"
  )
    ? "invalid"
    : findings.some((finding) => finding.severity === "warning")
      ? "review_required"
      : "valid";

  return {
    schemaVersion: PROJECT_CONTEXT_VALIDATION_VERSION,
    generatedAt,
    manifestHash: hashDecisionJsonValue(input.manifest),
    status,
    ...(manifest ? { manifest } : {}),
    findings,
    caveats: [
      "ProjectContext V0 is declarative metadata only; it never executes commands.",
      "Validation does not upload documents or mutate hosted memory.",
    ],
  };
}

export function hashContextMutationPlanContent(value: unknown): string {
  return hashDecisionJsonValue(value);
}

export function isContextMutationPlan(value: unknown): value is ContextMutationPlan {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === CONTEXT_MUTATION_PLAN_VERSION &&
    typeof value.planId === "string" &&
    typeof value.planHash === "string" &&
    typeof value.createdAt === "string" &&
    isRecord(value.producer) &&
    isRecord(value.baseRevision) &&
    typeof value.summary === "string" &&
    Array.isArray(value.operations) &&
    Array.isArray(value.preconditions) &&
    Array.isArray(value.warnings) &&
    typeof value.approvalRequired === "boolean" &&
    (typeof value.expiresAt === "string" || value.expiresAt === null)
  );
}

export function isContextMutationApplyReceipt(
  value: unknown
): value is ContextMutationApplyReceipt {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === CONTEXT_MUTATION_APPLY_RECEIPT_VERSION &&
    typeof value.receiptId === "string" &&
    typeof value.planId === "string" &&
    typeof value.planHash === "string" &&
    typeof value.appliedAt === "string" &&
    typeof value.status === "string" &&
    isRecord(value.baseRevisionAtApply) &&
    Array.isArray(value.appliedOperations) &&
    Array.isArray(value.skippedOperations) &&
    Array.isArray(value.caveats)
  );
}

export function isProjectDriftReport(value: unknown): value is ProjectDriftReport {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === PROJECT_DRIFT_REPORT_VERSION &&
    typeof value.reportId === "string" &&
    typeof value.generatedAt === "string" &&
    typeof value.state === "string" &&
    typeof value.summary === "string" &&
    Array.isArray(value.signals) &&
    Array.isArray(value.caveats)
  );
}

export function isProjectContextValidationReport(
  value: unknown
): value is ProjectContextValidationReport {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === PROJECT_CONTEXT_VALIDATION_VERSION &&
    typeof value.generatedAt === "string" &&
    typeof value.manifestHash === "string" &&
    typeof value.status === "string" &&
    Array.isArray(value.findings) &&
    Array.isArray(value.caveats)
  );
}

function validationFinding(
  id: string,
  severity: ProjectContextValidationFinding["severity"],
  summary: string,
  refs: string[] = []
): ProjectContextValidationFinding {
  return {
    id,
    severity,
    summary,
    refs: uniqueStrings(refs),
    reasonCodes: [id],
  };
}

function normalizeManifestProject(
  value: unknown,
  findings: ProjectContextValidationFinding[]
): ProjectContextManifest["project"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    findings.push(
      validationFinding("manifest_project_invalid", "warning", "project must be an object.")
    );
    return undefined;
  }
  const id = normalizeOptionalString(typeof value.id === "string" ? value.id : undefined);
  const name = normalizeOptionalString(typeof value.name === "string" ? value.name : undefined);
  return id || name ? { ...(id ? { id } : {}), ...(name ? { name } : {}) } : undefined;
}

function normalizeManifestSources(
  value: unknown,
  findings: ProjectContextValidationFinding[]
): ProjectContextSource[] {
  if (!Array.isArray(value)) {
    findings.push(
      validationFinding("manifest_sources_invalid", "error", "sources must be an array.")
    );
    return [];
  }
  const seen = new Set<string>();
  const sources: ProjectContextSource[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      findings.push(
        validationFinding(
          "manifest_source_invalid",
          "error",
          `sources[${index}] must be an object.`
        )
      );
      return;
    }
    const sourcePath = normalizeOptionalString(
      typeof entry.path === "string" ? entry.path : undefined
    );
    if (!sourcePath || sourcePath.startsWith("/") || sourcePath.includes("..")) {
      findings.push(
        validationFinding(
          "manifest_source_path_invalid",
          "error",
          `sources[${index}].path must be a project-relative path without '..'.`,
          sourcePath ? [sourcePath] : []
        )
      );
      return;
    }
    if (seen.has(sourcePath)) {
      findings.push(
        validationFinding(
          "manifest_source_duplicate",
          "warning",
          `Duplicate source path: ${sourcePath}.`,
          [sourcePath]
        )
      );
      return;
    }
    seen.add(sourcePath);
    sources.push({
      path: sourcePath,
      authority: normalizeAuthority(entry.authority),
      tier: normalizeTier(entry.tier),
      required: typeof entry.required === "boolean" ? entry.required : true,
      ...(normalizeOptionalString(
        typeof entry.description === "string" ? entry.description : undefined
      )
        ? { description: normalizeOptionalString(entry.description as string) }
        : {}),
    });
  });
  return sources;
}

function normalizeManifestPolicies(
  value: unknown,
  findings: ProjectContextValidationFinding[]
): ProjectContextPolicy[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    findings.push(
      validationFinding("manifest_policies_invalid", "warning", "policies must be an array.")
    );
    return [];
  }
  return value
    .map((entry, index) => {
      if (!isRecord(entry)) {
        findings.push(
          validationFinding(
            "manifest_policy_invalid",
            "warning",
            `policies[${index}] must be an object.`
          )
        );
        return undefined;
      }
      const id = normalizeOptionalString(typeof entry.id === "string" ? entry.id : undefined);
      const scope = normalizeOptionalString(
        typeof entry.scope === "string" ? entry.scope : undefined
      );
      const requirement = normalizeOptionalString(
        typeof entry.requirement === "string" ? entry.requirement : undefined
      );
      if (!id || !scope || !requirement) {
        findings.push(
          validationFinding(
            "manifest_policy_fields_missing",
            "warning",
            `policies[${index}] needs id, scope, and requirement.`
          )
        );
        return undefined;
      }
      return {
        id,
        scope,
        requirement,
        reviewRequired: typeof entry.reviewRequired === "boolean" ? entry.reviewRequired : true,
      };
    })
    .filter((policy): policy is ProjectContextPolicy => Boolean(policy));
}

function normalizeManifestFreshness(
  value: unknown,
  findings: ProjectContextValidationFinding[]
): ProjectContextManifest["freshness"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    findings.push(
      validationFinding("manifest_freshness_invalid", "warning", "freshness must be an object.")
    );
    return undefined;
  }
  const maxAgeDays = typeof value.maxAgeDays === "number" ? value.maxAgeDays : undefined;
  if (maxAgeDays !== undefined && (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0)) {
    findings.push(
      validationFinding(
        "manifest_freshness_max_age_invalid",
        "warning",
        "freshness.maxAgeDays must be a positive number."
      )
    );
    return undefined;
  }
  return maxAgeDays === undefined ? undefined : { maxAgeDays };
}

function normalizeAuthority(value: unknown): ProjectContextAuthority {
  return value === "supporting" || value === "generated" || value === "canonical"
    ? value
    : "supporting";
}

function normalizeTier(value: unknown): ProjectContextTier {
  return value === "HOT" || value === "WARM" || value === "COLD" ? value : "WARM";
}

function summarizeDriftState(signals: ProjectDriftSignal[]): ProjectDriftState {
  if (signals.some((signal) => signal.state === "BLOCKED_BY_CONFLICT")) {
    return "BLOCKED_BY_CONFLICT";
  }
  if (signals.some((signal) => signal.state === "DRIFT_DETECTED")) {
    return "DRIFT_DETECTED";
  }
  if (signals.some((signal) => signal.state === "STALE_EVIDENCE")) {
    return "STALE_EVIDENCE";
  }
  if (signals.some((signal) => signal.state === "UNKNOWN")) {
    return "UNKNOWN";
  }
  return "IN_SYNC";
}

function summarizeDriftSignals(signals: ProjectDriftSignal[], state: ProjectDriftState): string {
  if (signals.length === 0) {
    return "No drift signals were collected.";
  }
  const counts = signals.reduce<Record<ProjectDriftState, number>>(
    (accumulator, signal) => ({
      ...accumulator,
      [signal.state]: accumulator[signal.state] + 1,
    }),
    {
      IN_SYNC: 0,
      DRIFT_DETECTED: 0,
      UNKNOWN: 0,
      STALE_EVIDENCE: 0,
      BLOCKED_BY_CONFLICT: 0,
    }
  );
  return `Project drift state ${state}: ${counts.DRIFT_DETECTED} drift, ${counts.STALE_EVIDENCE} stale, ${counts.UNKNOWN} unknown, ${counts.BLOCKED_BY_CONFLICT} blocked, ${counts.IN_SYNC} in sync.`;
}

function normalizeDriftSignals(signals: ProjectDriftSignal[]): ProjectDriftSignal[] {
  return signals
    .map((signal) => ({
      id: signal.id.trim(),
      surface: signal.surface,
      state: signal.state,
      summary: signal.summary.trim(),
      ...(normalizeOptionalString(signal.expected)
        ? { expected: normalizeOptionalString(signal.expected) }
        : {}),
      ...(normalizeOptionalString(signal.observed)
        ? { observed: normalizeOptionalString(signal.observed) }
        : {}),
      refs: uniqueStrings(signal.refs ?? []),
      severity: signal.severity,
      reasonCodes: uniqueStrings(signal.reasonCodes ?? []),
    }))
    .filter((signal) => signal.id && signal.summary);
}

function normalizeProducer(producer: ContextMutationProducer): ContextMutationProducer {
  return {
    kind: producer.kind,
    command: producer.command.trim(),
    ...(normalizeOptionalString(producer.sourceRef)
      ? { sourceRef: normalizeOptionalString(producer.sourceRef) }
      : {}),
  };
}

function normalizeBaseRevision(revision: ContextMutationBaseRevision): ContextMutationBaseRevision {
  return {
    kind: revision.kind,
    ...(normalizeOptionalString(revision.branch) ? { branch: revision.branch?.trim() } : {}),
    ...(normalizeOptionalString(revision.headSha) ? { headSha: revision.headSha?.trim() } : {}),
    dirty: Boolean(revision.dirty),
    dirtyFiles: uniqueStrings(revision.dirtyFiles ?? []),
  };
}

function normalizeOperations(operations: ContextMutationOperation[]): ContextMutationOperation[] {
  return operations
    .map((operation) => {
      const contentHash =
        operation.contentHash ??
        (operation.content === undefined ? undefined : hashDecisionJsonValue(operation.content));
      return {
        opId: operation.opId.trim(),
        kind: operation.kind,
        target: operation.target.trim(),
        summary: operation.summary.trim(),
        mode: operation.mode,
        ...(operation.content !== undefined ? { content: operation.content } : {}),
        ...(contentHash ? { contentHash } : {}),
        reasonCodes: uniqueStrings(operation.reasonCodes ?? []),
      };
    })
    .filter((operation) => operation.opId && operation.target && operation.summary);
}

function normalizeAppliedOperations(
  operations: ContextMutationAppliedOperation[]
): ContextMutationAppliedOperation[] {
  return operations.map((operation) => ({
    opId: operation.opId.trim(),
    kind: operation.kind,
    target: operation.target.trim(),
    status: operation.status,
    ...(operation.contentHash ? { contentHash: operation.contentHash } : {}),
    ...(normalizeOptionalString(operation.message)
      ? { message: normalizeOptionalString(operation.message) }
      : {}),
  }));
}

function normalizePreconditions(
  preconditions: ContextMutationPrecondition[] | undefined
): ContextMutationPrecondition[] {
  return (preconditions ?? [])
    .map((precondition) => ({
      kind: precondition.kind,
      summary: precondition.summary.trim(),
      required: Boolean(precondition.required),
    }))
    .filter((precondition) => precondition.summary);
}

function isoTimestamp(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) return new Date(value).toISOString();
  return new Date().toISOString();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
