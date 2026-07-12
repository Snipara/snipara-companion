/**
 * `memory` commands — hosted memory hygiene and lifecycle.
 *
 * Read-only hygiene (health, clean-candidates, audit) plus deliberately
 * conservative lifecycle mutations: `compact` is dry-run only, while
 * `invalidate` and `supersede` require explicit memory IDs. All operations
 * target hosted Memory V2 through the API client; nothing here deletes memory
 * implicitly.
 */
import chalk from "chalk";
import {
  buildDecisionRequest,
  type BuildDecisionRequestInput,
  type DecisionRequest,
  type DecisionRequestEvidenceItem,
  type DecisionRequestProducerKind,
} from "../contracts/project-intelligence";
import {
  createClient,
  type MemoryInvalidateResult,
  type MemoryScope,
  type MemorySupersedeResult,
} from "../api/client";
import { writeDecisionRequest, type DecisionRequestWriteResult } from "./decision-requests";

export interface MemoryHealthCommandOptions {
  scope?: MemoryScope;
  includeInactive?: boolean;
  sampleLimit?: number;
  json?: boolean;
}

export interface MemoryCleanCandidatesCommandOptions {
  scope?: MemoryScope;
  includeInactive?: boolean;
  limitPerBucket?: number;
  json?: boolean;
}

export interface MemoryCompactCommandOptions {
  scope?: MemoryScope;
  deduplicate?: boolean;
  promoteThreshold?: number;
  archiveOlderThanDays?: number;
  json?: boolean;
}

export interface MemoryAuditCommandOptions
  extends
    MemoryHealthCommandOptions,
    MemoryCleanCandidatesCommandOptions,
    MemoryCompactCommandOptions {}

export interface MemoryInvalidateCommandOptions {
  reason?: string;
  invalidatedAt?: string;
  json?: boolean;
}

export interface MemorySupersedeCommandOptions {
  reason?: string;
  json?: boolean;
}

export interface MemoryReviewsCommandOptions {
  scope?: MemoryScope;
  status?: string;
  type?: string;
  category?: string;
  search?: string;
  limit?: number;
  offset?: number;
  includeEvidence?: boolean;
  includeCleanCandidates?: boolean;
  includeDuplicates?: boolean;
  includeInactive?: boolean;
  minSimilarity?: number;
  emitDecisions?: boolean;
  json?: boolean;
}

export interface MemoryAuditResult {
  version: "snipara.memory_audit.v1";
  generatedAt: string;
  scope?: MemoryScope;
  summary?: MemoryAuditSummary;
  health?: Record<string, unknown>;
  cleanCandidates?: Record<string, unknown>;
  compactDryRun?: Record<string, unknown>;
  errors: Array<{ surface: string; message: string }>;
}

export interface MemoryReviewConnectorResult {
  version: "snipara.memory_review_connector.v0";
  generatedAt: string;
  scope?: MemoryScope;
  surfaces: Record<string, { status: "ok" | "error"; count?: number; message?: string }>;
  items: MemoryReviewConnectorItem[];
  requests: DecisionRequest[];
  writes: DecisionRequestWriteResult[];
  emitted: { enabled: boolean; count: number; requestIds: string[] };
  emittedCount: number;
  emittedRequestIds: string[];
  caveats: string[];
}

export interface MemoryReviewConnectorItem {
  source: "review_queue" | "clean_candidates" | "duplicate_candidates";
  bucket?: string;
  memoryId: string;
  targetMemoryId?: string;
  title: string;
  summary: string;
  kind: DecisionRequestProducerKind;
  status?: string;
  action: string;
  options: string[];
  recommendation?: string;
  reasonCodes: string[];
  evidenceItem: DecisionRequestEvidenceItem;
}

export interface MemoryAuditSummary {
  totalScanned?: number;
  activeCount?: number;
  autoCompactThreshold?: number;
  autoCompactWouldTrigger?: boolean;
  cleanupCandidateCounts: Record<string, number>;
  compactDryRunMutated?: boolean;
  compactDryRunPlannedActions?: number;
  recommendedActions: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberLikeValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function preview(value: unknown, maxLength = 180): string {
  const text =
    typeof value === "string"
      ? value
      : value === undefined || value === null
        ? ""
        : JSON.stringify(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function recordArrayValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function firstString(values: unknown[]): string | undefined {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return undefined;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function buildHealthArgs(options: MemoryHealthCommandOptions): Record<string, unknown> {
  return compactObject({
    scope: options.scope,
    include_inactive: options.includeInactive || undefined,
    sample_limit: options.sampleLimit,
  });
}

function buildCleanCandidatesArgs(
  options: MemoryCleanCandidatesCommandOptions
): Record<string, unknown> {
  return compactObject({
    scope: options.scope,
    include_inactive: options.includeInactive || undefined,
    limit_per_bucket: options.limitPerBucket,
  });
}

function buildReviewQueueArgs(options: MemoryReviewsCommandOptions): Record<string, unknown> {
  return compactObject({
    scope: options.scope,
    status: options.status ?? "pending",
    type: options.type,
    category: options.category,
    search: options.search,
    limit: options.limit,
    offset: options.offset,
    include_evidence: options.includeEvidence ?? true,
  });
}

function buildDuplicateCandidateArgs(
  options: MemoryReviewsCommandOptions
): Record<string, unknown> {
  return compactObject({
    scope: options.scope,
    include_inactive: options.includeInactive || undefined,
    limit: options.limit,
    min_similarity: options.minSimilarity,
  });
}

function buildCompactArgs(options: MemoryCompactCommandOptions): Record<string, unknown> {
  return compactObject({
    scope: options.scope,
    deduplicate: options.deduplicate ?? true,
    promote_threshold: options.promoteThreshold,
    archive_older_than_days: options.archiveOlderThanDays,
    dry_run: true,
  });
}

async function callMemoryTool<T = Record<string, unknown>>(
  toolName: string,
  args: Record<string, unknown>
): Promise<T> {
  const client = createClient(30000);
  return client.callTool<T>(toolName, args);
}

function throwIfToolError(result: unknown): void {
  if (isRecord(result) && typeof result.error === "string" && result.error.length > 0) {
    throw new Error(result.error);
  }
}

function printCounts(counts: unknown): void {
  if (!isRecord(counts)) {
    return;
  }

  const byStatus = isRecord(counts.by_status) ? counts.by_status : {};
  const byType = isRecord(counts.by_type) ? counts.by_type : {};
  const topCategories = Array.isArray(counts.top_categories) ? counts.top_categories : [];

  if (Object.keys(byStatus).length > 0) {
    console.log(
      `Status: ${Object.entries(byStatus)
        .map(([key, value]) => `${key}: ${preview(value, 24)}`)
        .join(" | ")}`
    );
  }
  if (Object.keys(byType).length > 0) {
    console.log(
      `Types: ${Object.entries(byType)
        .map(([key, value]) => `${key}: ${preview(value, 24)}`)
        .join(" | ")}`
    );
  }
  if (topCategories.length > 0) {
    console.log("Top categories:");
    for (const category of topCategories.slice(0, 6)) {
      if (!isRecord(category)) {
        console.log(`- ${preview(category)}`);
        continue;
      }
      console.log(
        `- ${preview(category.category ?? "unknown", 80)}: ${preview(category.count, 24)}`
      );
    }
  }
}

function printMemoryHealth(result: Record<string, unknown>): void {
  console.log(chalk.bold("Memory Health"));

  if (result.project_id) {
    console.log(`Project: ${preview(result.project_id, 80)}`);
  }
  if (result.scope) {
    console.log(`Scope: ${preview(result.scope, 40)}`);
  }

  const totalScanned = numberValue(result.total_scanned);
  if (totalScanned !== undefined) {
    console.log(`Scanned: ${totalScanned}`);
  }

  const autoCompact = isRecord(result.auto_compact) ? result.auto_compact : {};
  if (Object.keys(autoCompact).length > 0) {
    const threshold = preview(autoCompact.threshold, 24);
    const wouldTrigger = autoCompact.would_trigger_by_count === true ? "yes" : "no";
    console.log(
      `Auto-compaction: threshold ${threshold || "n/a"} | would trigger: ${wouldTrigger}`
    );
  }

  printCounts(result.counts);

  const hygiene = isRecord(result.hygiene) ? result.hygiene : {};
  if (numberValue(hygiene.anomaly_count) !== undefined) {
    console.log(`Anomalies: ${preview(hygiene.anomaly_count, 24)}`);
  }
  const samples = Array.isArray(hygiene.samples) ? hygiene.samples : [];
  if (samples.length > 0) {
    console.log("Anomaly samples:");
    for (const sample of samples.slice(0, 5)) {
      console.log(`- ${preview(sample, 220)}`);
    }
  }
}

function printCandidateBucket(name: string, value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    return;
  }

  console.log(chalk.bold(name));
  for (const candidate of value.slice(0, 6)) {
    if (!isRecord(candidate)) {
      console.log(`- ${preview(candidate, 240)}`);
      continue;
    }

    const id = preview(candidate.memory_id ?? candidate.id ?? "unknown", 64);
    const reason = candidate.reason ? ` | ${preview(candidate.reason, 80)}` : "";
    const status = candidate.status ? ` | ${preview(candidate.status, 40)}` : "";
    console.log(`- ${id}${reason}${status}`);
    const text = candidate.preview ?? candidate.content ?? candidate.summary;
    if (text) {
      console.log(`  ${preview(text, 220)}`);
    }
  }
}

function printCleanCandidates(result: Record<string, unknown>): void {
  console.log(chalk.bold("Memory Clean Candidates"));
  if (numberValue(result.total_scanned) !== undefined) {
    console.log(`Scanned: ${preview(result.total_scanned, 24)}`);
  }

  const counts = isRecord(result.counts) ? result.counts : {};
  if (Object.keys(counts).length > 0) {
    console.log(
      Object.entries(counts)
        .map(([key, value]) => `${key}: ${preview(value, 24)}`)
        .join(" | ")
    );
  }

  const candidates = isRecord(result.candidates) ? result.candidates : {};
  printCandidateBucket("Noise", candidates.noise);
  printCandidateBucket("Duplicates", candidates.duplicates);
  printCandidateBucket("Possibly Stale", candidates.possibly_stale);
  printCandidateBucket("Category Anomalies", candidates.category_anomalies);
  printCandidateBucket("Needs Human Review", candidates.needs_human_review);
}

function summarizeMemoryContent(value: Record<string, unknown>, maxLength = 240): string {
  return preview(
    firstString([
      value.summary,
      value.preview,
      value.content,
      value.text,
      value.reason,
      value.needs_review_reason,
    ]) ?? JSON.stringify(value),
    maxLength
  );
}

function memoryIdFrom(value: Record<string, unknown>): string | undefined {
  return firstString([value.memory_id, value.id, value.memoryId]);
}

function memoryEvidenceItem(
  value: Record<string, unknown>,
  options: {
    ref: string;
    title: string;
    summary: string;
    kind: string;
    status?: string;
    reason?: string;
    source: string;
    bucket?: string;
  }
): DecisionRequestEvidenceItem {
  const evidence = recordArrayValue(value.evidence);
  const evidenceRefs = evidence
    .map((entry) => firstString([entry.external_ref, entry.document_id, entry.chunk_id]))
    .filter((entry): entry is string => Boolean(entry));
  return {
    ref: options.ref,
    title: options.title,
    summary: options.summary,
    kind: options.kind,
    status: options.status,
    files: uniqueStrings(evidenceRefs),
    metadata: compactObject({
      source: options.source,
      bucket: options.bucket,
      reason: options.reason,
      type: stringValue(value.type),
      scope: stringValue(value.scope),
      category: stringValue(value.category),
      status: stringValue(value.status),
      reviewStatus: stringValue(value.review_status),
      authorityStatus: stringValue(value.authority_status),
      confidenceState: stringValue(value.confidence_state),
      confidence: numberValue(value.confidence),
      createdAt: stringValue(value.created_at),
      updatedAt: stringValue(value.updated_at),
      staleAt: stringValue(value.stale_at),
      validUntil: stringValue(value.valid_until),
      hasEvidence: evidence.length > 0,
      mutated: booleanValue(value.mutated),
    }) as Record<string, string | number | boolean | null>,
  };
}

function reviewQueueItems(result: Record<string, unknown>): MemoryReviewConnectorItem[] {
  return recordArrayValue(result.items).flatMap((item) => {
    const memoryId = memoryIdFrom(item);
    if (!memoryId) return [];
    const status = stringValue(item.status);
    const reviewStatus = stringValue(item.review_status);
    const reason = stringValue(item.needs_review_reason);
    const summary = summarizeMemoryContent(item);
    return [
      {
        source: "review_queue",
        memoryId,
        title: `Review memory ${memoryId}`,
        summary,
        kind: "memory_review_queue",
        status: reviewStatus ?? status,
        action: "review_queue_item",
        options: ["accept", "reject", "archive", "invalidate", "keep_pending"],
        recommendation:
          reviewStatus === "approved" || status === "active" ? "keep_pending" : "accept",
        reasonCodes: uniqueStrings(["memory_review_queue", reason ?? "", status ?? ""]),
        evidenceItem: memoryEvidenceItem(item, {
          ref: `memory:${memoryId}`,
          title: `Review memory ${memoryId}`,
          summary,
          kind: "memory_review_queue",
          status: reviewStatus ?? status,
          reason,
          source: "review_queue",
        }),
      },
    ];
  });
}

function cleanCandidateItems(result: Record<string, unknown>): MemoryReviewConnectorItem[] {
  const candidates = isRecord(result.candidates) ? result.candidates : {};
  const items: MemoryReviewConnectorItem[] = [];
  for (const [bucket, value] of Object.entries(candidates)) {
    for (const candidate of recordArrayValue(value)) {
      const memoryId = memoryIdFrom(candidate);
      if (!memoryId) continue;
      const reason = stringValue(candidate.reason) ?? bucket;
      const summary = summarizeMemoryContent(candidate);
      const staleBucket = bucket === "possibly_stale";
      const duplicateBucket = bucket === "duplicates";
      const options = duplicateBucket
        ? ["merge", "supersede", "keep", "inspect"]
        : staleBucket
          ? ["verify", "invalidate", "keep", "inspect"]
          : ["archive", "invalidate", "keep", "inspect"];
      const recommendation = staleBucket ? "verify" : duplicateBucket ? "inspect" : "archive";
      const kind: DecisionRequestProducerKind = duplicateBucket
        ? "memory_duplicate_candidate"
        : "memory_clean_candidate";
      items.push({
        source: "clean_candidates",
        bucket,
        memoryId,
        title: `${bucket.replace(/_/g, " ")} memory candidate ${memoryId}`,
        summary,
        kind,
        status: stringValue(candidate.status),
        action: `${bucket}_candidate`,
        options,
        recommendation,
        reasonCodes: uniqueStrings(["memory_clean_candidates", bucket, reason]),
        evidenceItem: memoryEvidenceItem(candidate, {
          ref: `memory:${memoryId}`,
          title: `${bucket.replace(/_/g, " ")} memory candidate ${memoryId}`,
          summary,
          kind,
          status: stringValue(candidate.status),
          reason,
          source: "clean_candidates",
          bucket,
        }),
      });
    }
  }
  return items;
}

function duplicateCandidateItems(result: Record<string, unknown>): MemoryReviewConnectorItem[] {
  return recordArrayValue(result.groups).flatMap((group, index) => {
    const candidates = recordArrayValue(group.candidates ?? group.memories ?? group.items);
    const keepMemoryId = firstString([group.keep_memory_id, group.canonical_memory_id]);
    return candidates.flatMap((candidate) => {
      const memoryId = memoryIdFrom(candidate);
      if (!memoryId || memoryId === keepMemoryId) return [];
      const summary = summarizeMemoryContent(candidate);
      return [
        {
          source: "duplicate_candidates",
          bucket: `group_${index + 1}`,
          memoryId,
          targetMemoryId: keepMemoryId,
          title: `Duplicate memory candidate ${memoryId}`,
          summary,
          kind: "memory_duplicate_candidate",
          status: stringValue(candidate.status),
          action: "duplicate_candidate",
          options: ["merge", "supersede", "keep", "inspect"],
          recommendation: keepMemoryId ? "supersede" : "inspect",
          reasonCodes: uniqueStrings(["memory_duplicate_candidates", `group_${index + 1}`]),
          evidenceItem: memoryEvidenceItem(candidate, {
            ref: `memory:${memoryId}`,
            title: `Duplicate memory candidate ${memoryId}`,
            summary,
            kind: "memory_duplicate_candidate",
            status: stringValue(candidate.status),
            reason: "duplicate_candidate",
            source: "duplicate_candidates",
            bucket: `group_${index + 1}`,
          }),
        },
      ];
    });
  });
}

export function buildMemoryReviewDecisionRequest(item: MemoryReviewConnectorItem): DecisionRequest {
  const applyPath =
    item.recommendation === "verify"
      ? "snipara_memory_verify"
      : item.recommendation === "invalidate"
        ? "snipara_memory_invalidate"
        : "snipara_memory_resolve_queue_item";
  const actionHint =
    item.recommendation === "verify"
      ? `snipara_memory_verify({ memory_id: "${item.memoryId}" })`
      : item.recommendation === "invalidate"
        ? `snipara_memory_invalidate({ memory_id: "${item.memoryId}" })`
        : `snipara_memory_resolve_queue_item({ memory_id: "${item.memoryId}", action: "<human-choice>" })`;
  const input: BuildDecisionRequestInput = {
    producer: {
      kind: item.kind,
      command: "memory reviews",
      sourceRef: `${item.source}:${item.bucket ?? item.action}`,
    },
    decision: `memory_${item.action}`,
    question: `${item.title}: what should happen?`,
    evidence: {
      summary: item.summary,
      refs: [item.evidenceItem.ref],
      items: [item.evidenceItem],
      reasonCodes: item.reasonCodes,
      applyPath,
      applyCommand: actionHint,
    },
    options: item.options,
    recommendation: item.recommendation,
    rationale:
      "Generated from hosted read-only memory review surfaces; no memory is mutated until a human resolves the request through an existing apply path.",
    fingerprintParts: [
      "memory-review-connector-v0",
      item.source,
      item.bucket ?? "",
      item.memoryId,
      item.targetMemoryId ?? "",
      item.reasonCodes,
      item.options,
    ],
  };
  return buildDecisionRequest(input);
}

export async function buildMemoryReviewConnector(
  options: MemoryReviewsCommandOptions
): Promise<MemoryReviewConnectorResult> {
  const result: MemoryReviewConnectorResult = {
    version: "snipara.memory_review_connector.v0",
    generatedAt: new Date().toISOString(),
    ...(options.scope ? { scope: options.scope } : {}),
    surfaces: {},
    items: [],
    requests: [],
    writes: [],
    emitted: { enabled: Boolean(options.emitDecisions), count: 0, requestIds: [] },
    emittedCount: 0,
    emittedRequestIds: [],
    caveats: [
      "Read-only connector: hosted memory tools are queried, but no memory is mutated.",
      "Emitted decision requests must still be resolved explicitly; no timeout/default applies.",
      "Non-Producer apply paths remain declared receipts until a hosted apply integration resolves them.",
    ],
  };

  try {
    const reviewQueue = await callMemoryTool<Record<string, unknown>>(
      "snipara_memory_review_queue",
      buildReviewQueueArgs(options)
    );
    const items = reviewQueueItems(reviewQueue);
    result.items.push(...items);
    result.surfaces.review_queue = { status: "ok", count: items.length };
  } catch (error) {
    result.surfaces.review_queue = {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (options.includeCleanCandidates !== false) {
    try {
      const cleanCandidates = await callMemoryTool<Record<string, unknown>>(
        "snipara_memory_clean_candidates",
        buildCleanCandidatesArgs({
          scope: options.scope,
          includeInactive: options.includeInactive,
          limitPerBucket: options.limit,
        })
      );
      const items = cleanCandidateItems(cleanCandidates);
      result.items.push(...items);
      result.surfaces.clean_candidates = { status: "ok", count: items.length };
    } catch (error) {
      result.surfaces.clean_candidates = {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (options.includeDuplicates !== false) {
    try {
      const duplicateCandidates = await callMemoryTool<Record<string, unknown>>(
        "snipara_memory_duplicate_candidates",
        buildDuplicateCandidateArgs(options)
      );
      const items = duplicateCandidateItems(duplicateCandidates);
      result.items.push(...items);
      result.surfaces.duplicate_candidates = { status: "ok", count: items.length };
    } catch (error) {
      result.surfaces.duplicate_candidates = {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const seen = new Set<string>();
  result.items = result.items.filter((item) => {
    const key = `${item.source}:${item.bucket ?? ""}:${item.memoryId}:${item.action}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  result.requests = result.items.map(buildMemoryReviewDecisionRequest);
  if (options.emitDecisions) {
    result.writes = result.requests.map((request) => writeDecisionRequest(request));
    result.emittedRequestIds = result.writes.map((write) => write.requestId);
    result.emittedCount = result.emittedRequestIds.length;
    result.emitted = {
      enabled: true,
      count: result.emittedCount,
      requestIds: result.emittedRequestIds,
    };
  }
  return result;
}

function printMemoryReviewConnector(result: MemoryReviewConnectorResult): void {
  console.log(chalk.bold("Memory Review Connector"));
  const surfaceSummary = Object.entries(result.surfaces)
    .map(([surface, status]) =>
      status.status === "ok" ? `${surface}: ${status.count ?? 0}` : `${surface}: error`
    )
    .join(" | ");
  if (surfaceSummary) {
    console.log(surfaceSummary);
  }
  if (result.items.length === 0) {
    console.log("No memory review items found.");
    return;
  }
  for (const item of result.items) {
    console.log(`- ${item.memoryId} [${item.source}${item.bucket ? `/${item.bucket}` : ""}]`);
    console.log(`  ${item.summary}`);
    console.log(`  options: ${item.options.join(", ")}`);
    if (item.recommendation) {
      console.log(`  recommendation: ${item.recommendation}`);
    }
  }
  if (result.writes.length > 0) {
    console.log("");
    console.log(chalk.bold("Decision Requests"));
    for (const write of result.writes) {
      console.log(`- ${write.status}: ${write.requestId}`);
    }
  }
}

function printCompactDryRun(result: Record<string, unknown>): void {
  console.log(chalk.bold("Memory Compact Dry Run"));
  if (result.mutated !== undefined) {
    console.log(`Mutated: ${preview(result.mutated, 24)}`);
  }

  const summary = isRecord(result.summary) ? result.summary : result;
  const entries = Object.entries(summary).filter(([, value]) => {
    if (value === undefined || value === null) {
      return false;
    }
    return typeof value !== "object" || Array.isArray(value);
  });
  for (const [key, value] of entries.slice(0, 10)) {
    console.log(`${key}: ${preview(value, 140)}`);
  }

  const plan = result.plan ?? result.actions ?? result.candidates ?? result.operations;
  if (Array.isArray(plan) && plan.length > 0) {
    console.log("Planned actions:");
    for (const item of plan.slice(0, 8)) {
      console.log(`- ${preview(item, 240)}`);
    }
  }
}

function buildMemoryAuditSummary(audit: MemoryAuditResult): MemoryAuditSummary {
  const health = isRecord(audit.health) ? audit.health : {};
  const healthCounts = isRecord(health.counts) ? health.counts : {};
  const healthByStatus = isRecord(healthCounts.by_status) ? healthCounts.by_status : {};
  const autoCompact = isRecord(health.auto_compact) ? health.auto_compact : {};
  const cleanCandidates = isRecord(audit.cleanCandidates) ? audit.cleanCandidates : {};
  const candidateCounts = isRecord(cleanCandidates.counts) ? cleanCandidates.counts : {};
  const compactDryRun = isRecord(audit.compactDryRun) ? audit.compactDryRun : {};

  const cleanupCandidateCounts = Object.fromEntries(
    Object.entries(candidateCounts)
      .map(([key, value]) => [key, numberLikeValue(value)])
      .filter((entry): entry is [string, number] => entry[1] !== undefined)
  );
  const totalScanned = numberLikeValue(health.total_scanned ?? cleanCandidates.total_scanned);
  const activeCount = numberLikeValue(healthByStatus.active);
  const autoCompactThreshold = numberLikeValue(autoCompact.threshold);
  const autoCompactWouldTrigger = autoCompact.would_trigger_by_count === true;
  const compactDryRunPlannedActions = numberLikeValue(
    compactDryRun.planned_actions ?? compactDryRun.plannedActions
  );
  const recommendedActions: string[] = [];
  const scope = audit.scope ?? "project";

  if (
    autoCompactWouldTrigger ||
    (activeCount !== undefined &&
      autoCompactThreshold !== undefined &&
      activeCount > autoCompactThreshold)
  ) {
    recommendedActions.push(
      `snipara-companion memory clean-candidates --scope ${scope} --limit-per-bucket 5`
    );
    recommendedActions.push(
      `snipara-companion memory compact --scope ${scope} --archive-older-than-days 30`
    );
  }

  if (Object.values(cleanupCandidateCounts).some((count) => count > 0)) {
    recommendedActions.push(
      'snipara-companion memory-guard check --intent "apply memory cleanup" --destructive --strict'
    );
  }

  return {
    ...(totalScanned !== undefined ? { totalScanned } : {}),
    ...(activeCount !== undefined ? { activeCount } : {}),
    ...(autoCompactThreshold !== undefined ? { autoCompactThreshold } : {}),
    ...(Object.keys(autoCompact).length > 0 ? { autoCompactWouldTrigger } : {}),
    cleanupCandidateCounts,
    ...(typeof compactDryRun.mutated === "boolean"
      ? { compactDryRunMutated: compactDryRun.mutated }
      : {}),
    ...(compactDryRunPlannedActions !== undefined ? { compactDryRunPlannedActions } : {}),
    recommendedActions: uniqueStrings(recommendedActions),
  };
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function printMemoryAuditSummary(summary: MemoryAuditSummary): void {
  console.log(chalk.bold("Memory Hygiene Summary"));
  if (summary.totalScanned !== undefined) {
    console.log(`Scanned: ${summary.totalScanned}`);
  }
  if (summary.activeCount !== undefined) {
    console.log(`Active: ${summary.activeCount}`);
  }
  if (summary.autoCompactThreshold !== undefined) {
    console.log(
      `Auto-compaction: threshold ${summary.autoCompactThreshold} | would trigger: ${
        summary.autoCompactWouldTrigger ? "yes" : "no"
      }`
    );
  }
  if (Object.keys(summary.cleanupCandidateCounts).length > 0) {
    console.log(
      `Cleanup candidates: ${Object.entries(summary.cleanupCandidateCounts)
        .map(([key, value]) => `${key}: ${value}`)
        .join(" | ")}`
    );
  }
  if (summary.recommendedActions.length > 0) {
    console.log("Recommended actions:");
    for (const action of summary.recommendedActions) {
      console.log(`- ${action}`);
    }
  }
}

function printMemoryInvalidate(result: MemoryInvalidateResult): void {
  console.log(chalk.bold("Memory Invalidated"));
  console.log(`Memory: ${result.memory_id}`);
  if (result.invalidated_at) {
    console.log(`Invalidated at: ${result.invalidated_at}`);
  }
  if (result.reason) {
    console.log(`Reason: ${result.reason}`);
  }
  if (result.message) {
    console.log(result.message);
  }
}

function printMemorySupersede(result: MemorySupersedeResult): void {
  console.log(chalk.bold("Memory Superseded"));
  console.log(`Old memory: ${result.old_memory_id}`);
  console.log(`New memory: ${result.new_memory_id}`);
  if (result.superseded_at) {
    console.log(`Superseded at: ${result.superseded_at}`);
  }
  if (result.reason) {
    console.log(`Reason: ${result.reason}`);
  }
  if (result.message) {
    console.log(result.message);
  }
}

export async function memoryHealthCommand(options: MemoryHealthCommandOptions): Promise<void> {
  const result = await callMemoryTool("snipara_memory_health", buildHealthArgs(options));

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printMemoryHealth(result);
}

export async function memoryCleanCandidatesCommand(
  options: MemoryCleanCandidatesCommandOptions
): Promise<void> {
  const result = await callMemoryTool(
    "snipara_memory_clean_candidates",
    buildCleanCandidatesArgs(options)
  );

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printCleanCandidates(result);
}

export async function memoryReviewsCommand(options: MemoryReviewsCommandOptions): Promise<void> {
  const result = await buildMemoryReviewConnector(options);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printMemoryReviewConnector(result);
}

export async function memoryCompactCommand(options: MemoryCompactCommandOptions): Promise<void> {
  const result = await callMemoryTool("snipara_memory_compact", buildCompactArgs(options));

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printCompactDryRun(result);
  console.log("");
  console.log(
    "Dry-run only. Apply cleanup with explicit lifecycle tools after reviewing candidates."
  );
  console.log(
    'Before any destructive follow-up, run: snipara-companion memory-guard check --intent "apply memory cleanup" --destructive --strict'
  );
}

export async function memoryInvalidateCommand(
  memoryId: string,
  options: MemoryInvalidateCommandOptions
): Promise<void> {
  const result = await callMemoryTool<MemoryInvalidateResult>(
    "snipara_memory_invalidate",
    compactObject({
      memory_id: memoryId,
      reason: options.reason,
      invalidated_at: options.invalidatedAt,
    })
  );
  throwIfToolError(result);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printMemoryInvalidate(result);
}

export async function memorySupersedeCommand(
  oldMemoryId: string,
  newMemoryId: string,
  options: MemorySupersedeCommandOptions
): Promise<void> {
  const result = await callMemoryTool<MemorySupersedeResult>(
    "snipara_memory_supersede",
    compactObject({
      old_memory_id: oldMemoryId,
      new_memory_id: newMemoryId,
      reason: options.reason,
    })
  );
  throwIfToolError(result);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printMemorySupersede(result);
}

export async function buildMemoryAudit(
  options: MemoryAuditCommandOptions
): Promise<MemoryAuditResult> {
  const result: MemoryAuditResult = {
    version: "snipara.memory_audit.v1",
    generatedAt: new Date().toISOString(),
    ...(options.scope ? { scope: options.scope } : {}),
    errors: [],
  };

  try {
    result.health = await callMemoryTool("snipara_memory_health", buildHealthArgs(options));
  } catch (error) {
    result.errors.push({
      surface: "memory_health",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    result.cleanCandidates = await callMemoryTool(
      "snipara_memory_clean_candidates",
      buildCleanCandidatesArgs(options)
    );
  } catch (error) {
    result.errors.push({
      surface: "memory_clean_candidates",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    result.compactDryRun = await callMemoryTool(
      "snipara_memory_compact",
      buildCompactArgs(options)
    );
  } catch (error) {
    result.errors.push({
      surface: "memory_compact_dry_run",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  result.summary = buildMemoryAuditSummary(result);

  return result;
}

export async function memoryAuditCommand(options: MemoryAuditCommandOptions): Promise<void> {
  const audit = await buildMemoryAudit(options);

  if (options.json) {
    console.log(JSON.stringify(audit, null, 2));
    return;
  }

  console.log(chalk.bold("Memory Audit"));
  if (audit.scope) {
    console.log(`Scope: ${audit.scope}`);
  }
  console.log("");

  if (audit.summary) {
    printMemoryAuditSummary(audit.summary);
    console.log("");
  }

  if (audit.health) {
    printMemoryHealth(audit.health);
    console.log("");
  }
  if (audit.cleanCandidates) {
    printCleanCandidates(audit.cleanCandidates);
    console.log("");
  }
  if (audit.compactDryRun) {
    printCompactDryRun(audit.compactDryRun);
    console.log("");
  }

  if (audit.errors.length > 0) {
    console.log(chalk.bold("Degraded Surfaces"));
    for (const error of audit.errors) {
      console.log(`- ${error.surface}: ${error.message}`);
    }
    console.log("");
  }

  console.log(
    "No memory was mutated. Use the dry-run and candidate IDs to decide explicit follow-up cleanup."
  );
  console.log(
    'Before any destructive follow-up, run: snipara-companion memory-guard check --intent "apply memory cleanup" --destructive --strict'
  );
}
