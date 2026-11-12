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

export interface MemoryCompactCommandOptions {
  scope?: MemoryScope;
  deduplicate?: boolean;
  json?: boolean;
}

export interface MemoryAuditCommandOptions
  extends
    MemoryHealthCommandOptions,
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
  emitDecisions?: boolean;
  json?: boolean;
}

export interface MemoryAuditResult {
  version: "snipara.memory_audit.v1";
  generatedAt: string;
  scope?: MemoryScope;
  summary?: MemoryAuditSummary;
  health?: Record<string, unknown>;
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
  source: "review_queue";
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

function buildCompactArgs(options: MemoryCompactCommandOptions): Record<string, unknown> {
  return compactObject({
    scope: options.scope,
    deduplicate: options.deduplicate ?? true,
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
  const compactDryRun = isRecord(audit.compactDryRun) ? audit.compactDryRun : {};

  const totalScanned = numberLikeValue(health.total_scanned);
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
    recommendedActions.push(`snipara-companion memory compact --scope ${scope}`);
  }

  return {
    ...(totalScanned !== undefined ? { totalScanned } : {}),
    ...(activeCount !== undefined ? { activeCount } : {}),
    ...(autoCompactThreshold !== undefined ? { autoCompactThreshold } : {}),
    ...(Object.keys(autoCompact).length > 0 ? { autoCompactWouldTrigger } : {}),
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

export interface MemoryRestoreCommandOptions {
  reason?: string;
  undoSupersede?: boolean;
  json?: boolean;
}

export async function memoryRestoreCommand(
  memoryId: string,
  options: MemoryRestoreCommandOptions
): Promise<void> {
  const result = await callMemoryTool<Record<string, unknown>>(
    "snipara_memory_restore",
    compactObject({
      memory_id: memoryId,
      reason: options.reason,
      undo_supersede: options.undoSupersede || undefined,
    })
  );
  throwIfToolError(result);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.bold("Memory Restore"));
  console.log(`Memory: ${preview(result.memory_id, 80)}`);
  console.log(`Restored: ${preview(result.restored, 24)}`);
  if (result.previous_status) {
    console.log(`Previous status: ${preview(result.previous_status, 40)}`);
  }
  if (result.message) {
    console.log(preview(result.message, 200));
  }
}

export interface MemoryOutcomeCommandOptions {
  count?: number;
  json?: boolean;
}

export async function memoryOutcomeCommand(
  outcome: string,
  memoryIds: string[],
  options: MemoryOutcomeCommandOptions
): Promise<void> {
  const result = await callMemoryTool<Record<string, unknown>>(
    "snipara_memory_outcome",
    compactObject({ memory_ids: memoryIds, outcome, count: options.count })
  );
  throwIfToolError(result);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.bold("Memory Outcome"));
  console.log(`Recorded: ${preview(result.recorded, 24)} (${outcome})`);
  for (const item of recordArrayValue(result.memories)) {
    const flag = item.retirement_candidate === true ? " | retirement candidate" : "";
    console.log(
      `- ${preview(item.memory_id, 80)}: posterior ${preview(item.posterior, 24)} (confirmed ${preview(item.confirmed, 12)}, refuted ${preview(item.refuted, 12)})${flag}`
    );
  }
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

/** Read one bounded inventory page; never approximate inventory through recall. */
export function memoryListPage(options: { limit?: number; offset?: number }) {
  const limit = options.limit ?? 20, offset = options.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 ||
      !Number.isSafeInteger(offset) || offset < 0) throw new Error("Memory list requires limit 1..50 and a nonnegative integer offset");
  return { limit, offset };
}

export async function memoryListCommand(options: {
  limit?: number; offset?: number; scope?: MemoryScope; category?: string; json?: boolean;
} = {}): Promise<void> {
  const page = memoryListPage(options);
  const result = await createClient().listMemories({ ...page, scope: options.scope, category: options.category });
  const memories = result.memories.slice(0, page.limit).map(memory => ({
    memory_id: memory.memory_id, type: memory.type, scope: memory.scope,
    category: memory.category, status: memory.status, preview: memory.content.slice(0, 240),
  }));
  const receipt = { memories, total_count: result.total_count,
    has_more: result.has_more, next_offset: result.has_more ? page.offset + page.limit : null };
  console.log(options.json ? JSON.stringify(receipt) :
    memories.map(memory => `${memory.memory_id} [${memory.type}/${memory.scope}] ${memory.preview}`).join("\n") +
    `\nNext offset: ${receipt.next_offset ?? "none"}; total: ${receipt.total_count}`);
}
