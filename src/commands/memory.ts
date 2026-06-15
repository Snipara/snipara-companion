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
  createClient,
  type MemoryInvalidateResult,
  type MemoryScope,
  type MemorySupersedeResult,
} from "../api/client";

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

export interface MemoryAuditResult {
  version: "snipara.memory_audit.v1";
  generatedAt: string;
  scope?: MemoryScope;
  health?: Record<string, unknown>;
  cleanCandidates?: Record<string, unknown>;
  compactDryRun?: Record<string, unknown>;
  errors: Array<{ surface: string; message: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
