import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CompanionWhyCaptureReceipt } from "./why-capture";

export const FINAL_COMMIT_REPORT_VERSION = "snipara.final_commit_report.v1" as const;
export const FINAL_COMMIT_REPORT_RELATIVE_PATH = path.join(
  ".snipara",
  "workflow",
  "final-report.json"
);

export type FinalCommitOutcome = "completed" | "partial" | "blocked" | "abandoned";
export type FinalCommitEvidenceStatus = "passed" | "failed" | "not_run" | "unknown";

export interface FinalCommitMemoryItem {
  memoryId?: string;
  text: string;
  type?: string;
  category?: string;
  reason?: string;
  reviewStatus?: string;
  source: "phase_commit" | "why_capture";
  phaseId?: string;
}

export interface WorkflowPhaseCommitReceipt {
  phaseId: string;
  capturedAt: string;
  category: string;
  outcome: FinalCommitOutcome;
  hostedStatus: "processed" | "local_fallback";
  stored: FinalCommitMemoryItem[];
  skipped: FinalCommitMemoryItem[];
  whyCapture?: CompanionWhyCaptureReceipt;
}

export interface FinalCommitReportPhase {
  id: string;
  title: string;
  status: string;
  summary?: string;
  outcome?: string;
  files: string[];
}

export interface FinalCommitReportWorkflowState {
  workflowId: string;
  goal: string;
  status: string;
  createdAt: string;
  phases: Array<{
    id: string;
    title: string;
    status: string;
    summary?: string;
    outcome?: string;
    files?: string[];
  }>;
  phaseCommitReceipts?: WorkflowPhaseCommitReceipt[];
  runtime?: {
    sandbox?: {
      bindings?: Array<{
        lastCheckpoint?: {
          commands?: string[];
        };
      }>;
    };
  };
}

export interface FinalCommitEvidenceItem {
  status: FinalCommitEvidenceStatus;
  text: string;
  source: "explicit" | "runtime_checkpoint";
}

export interface FinalCommitNotPersistedItem {
  text: string;
  reason: string;
  source: "phase_commit" | "why_capture" | "final_commit";
}

export interface FinalCommitReportV1 {
  version: typeof FINAL_COMMIT_REPORT_VERSION;
  generatedAt: string;
  workflowId?: string;
  outcome: FinalCommitOutcome;
  changed: {
    summary: string;
    files: string[];
    phases: FinalCommitReportPhase[];
    repository: {
      branch?: string;
      head?: string;
      dirty: boolean;
      dirtyFiles: string[];
    };
  };
  rationale: {
    status: "provided" | "captured" | "missing";
    text?: string;
    source: "explicit" | "why_capture" | "none";
  };
  evidence: {
    items: FinalCommitEvidenceItem[];
    counts: Record<FinalCommitEvidenceStatus, number>;
  };
  retainedDecisions: {
    status: "confirmed" | "none" | "unavailable";
    items: FinalCommitMemoryItem[];
    note?: string;
  };
  pendingDecisions: {
    status: "pending_review" | "none" | "unavailable";
    items: FinalCommitMemoryItem[];
    note?: string;
  };
  notPersisted: {
    items: FinalCommitNotPersistedItem[];
  };
  closeout: {
    risks: string[];
    nextStep: string;
  };
  caveats: string[];
}

export interface FinalCommitReportArtifact {
  status: "written" | "error";
  version: typeof FINAL_COMMIT_REPORT_VERSION;
  path?: string;
  relativePath: typeof FINAL_COMMIT_REPORT_RELATIVE_PATH;
  hash?: string;
  error?: string;
}

interface BuildFinalCommitReportInput {
  state?: FinalCommitReportWorkflowState;
  summary: string;
  why?: string;
  outcome: FinalCommitOutcome;
  files?: string[];
  evidence?: string[];
  risks?: string[];
  nextStep?: string;
  whyCapture: CompanionWhyCaptureReceipt;
  finalCommitResult: Record<string, unknown>;
  cwd?: string;
  now?: Date;
}

const MAX_TEXT_LENGTH = 900;
const MAX_LIST_ITEMS = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength = MAX_TEXT_LENGTH): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return undefined;
  }
  const redacted = compact
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer <redacted>")
    .replace(
      /\b(api[_-]?key|token|password|passwd|secret|private[_-]?key)\b\s*[:=]\s*[^\s,;]+/gi,
      "$1=<redacted>"
    );
  return redacted.length <= maxLength
    ? redacted
    : `${redacted.slice(0, maxLength - 15)}...[truncated]`;
}

function uniqueStrings(values: Array<string | undefined>, limit = MAX_LIST_ITEMS): string[] {
  return [...new Set(values.map((value) => boundedText(value)).filter(Boolean) as string[])].slice(
    0,
    limit
  );
}

function normalizedMemoryItem(
  value: unknown,
  source: FinalCommitMemoryItem["source"],
  phaseId?: string
): FinalCommitMemoryItem | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const text = boundedText(value.text ?? value.content ?? value.decision ?? value.summary);
  const memoryId = boundedText(value.memory_id ?? value.memoryId ?? value.id, 200);
  if (!text && !memoryId) {
    return undefined;
  }
  return {
    ...(memoryId ? { memoryId } : {}),
    text: text ?? `Memory ${memoryId}`,
    ...(boundedText(value.memory_type ?? value.memoryType ?? value.type, 80)
      ? { type: boundedText(value.memory_type ?? value.memoryType ?? value.type, 80) }
      : {}),
    ...(boundedText(value.category, 120) ? { category: boundedText(value.category, 120) } : {}),
    ...(boundedText(value.reason, 160) ? { reason: boundedText(value.reason, 160) } : {}),
    ...(boundedText(value.review_status ?? value.reviewStatus, 80)
      ? { reviewStatus: boundedText(value.review_status ?? value.reviewStatus, 80) }
      : {}),
    source,
    ...(phaseId ? { phaseId } : {}),
  };
}

function recordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function buildWorkflowPhaseCommitReceipt(input: {
  phaseId: string;
  category: string;
  outcome: FinalCommitOutcome;
  result: Record<string, unknown>;
  capturedAt?: string;
}): WorkflowPhaseCommitReceipt {
  const stored = recordList(input.result.stored_candidates)
    .filter((item) => !isRecord(item.why_fields) && !isRecord(item.whyFields))
    .map((item) => normalizedMemoryItem(item, "phase_commit", input.phaseId))
    .filter((item): item is FinalCommitMemoryItem => Boolean(item));
  const skipped = recordList(input.result.skipped_candidates)
    .map((item) => normalizedMemoryItem(item, "phase_commit", input.phaseId))
    .filter((item): item is FinalCommitMemoryItem => Boolean(item));
  const hostedPhaseCommit = isRecord(input.result.hosted_phase_commit)
    ? input.result.hosted_phase_commit
    : undefined;

  return {
    phaseId: input.phaseId,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    category: input.category,
    outcome: input.outcome,
    hostedStatus: hostedPhaseCommit?.status === "error" ? "local_fallback" : "processed",
    stored,
    skipped,
  };
}

function parseEvidenceItem(value: string): FinalCommitEvidenceItem | undefined {
  const text = boundedText(value);
  if (!text) {
    return undefined;
  }
  const matched = text.match(
    /^(passed|pass|ok|success|failed|fail|error|not[-_ ]?run|skipped|unknown)\s*:\s*(.+)$/i
  );
  if (!matched) {
    return { status: "unknown", text, source: "explicit" };
  }
  const rawStatus = matched[1].toLowerCase();
  const status: FinalCommitEvidenceStatus =
    rawStatus === "passed" || rawStatus === "pass" || rawStatus === "ok" || rawStatus === "success"
      ? "passed"
      : rawStatus === "failed" || rawStatus === "fail" || rawStatus === "error"
        ? "failed"
        : rawStatus === "unknown"
          ? "unknown"
          : "not_run";
  return { status, text: matched[2].trim(), source: "explicit" };
}

function buildEvidence(
  state: FinalCommitReportWorkflowState | undefined,
  evidence: string[] | undefined
): FinalCommitReportV1["evidence"] {
  const explicit = (evidence ?? [])
    .map(parseEvidenceItem)
    .filter((item): item is FinalCommitEvidenceItem => Boolean(item));
  const explicitTexts = new Set(explicit.map((item) => item.text));
  const runtimeCommands = uniqueStrings(
    state?.runtime?.sandbox?.bindings?.flatMap(
      (binding) => binding.lastCheckpoint?.commands ?? []
    ) ?? []
  )
    .filter((command) => !explicitTexts.has(command))
    .map<FinalCommitEvidenceItem>((command) => ({
      status: "unknown",
      text: command,
      source: "runtime_checkpoint",
    }));
  const items = [...explicit, ...runtimeCommands].slice(0, MAX_LIST_ITEMS);
  const counts: Record<FinalCommitEvidenceStatus, number> = {
    passed: 0,
    failed: 0,
    not_run: 0,
    unknown: 0,
  };
  for (const item of items) {
    counts[item.status] += 1;
  }
  return { items, counts };
}

function readGitState(cwd: string): FinalCommitReportV1["changed"]["repository"] {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    const dirtyFiles = uniqueStrings(
      status
        .split("\n")
        .map((line) => line.slice(3).trim())
        .filter(Boolean)
    );
    return { branch, head, dirty: dirtyFiles.length > 0, dirtyFiles };
  } catch {
    return { dirty: false, dirtyFiles: [] };
  }
}

function finalCommitHostedFailed(result: Record<string, unknown>): boolean {
  const hosted = isRecord(result.hosted_final_commit) ? result.hosted_final_commit : undefined;
  return hosted?.status === "error";
}

function whyCaptureRationale(receipt: CompanionWhyCaptureReceipt): string | undefined {
  return receipt.previewCandidates.map((candidate) => candidate.rationale).find(Boolean);
}

export function buildFinalCommitReport(input: BuildFinalCommitReportInput): FinalCommitReportV1 {
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const phases = (input.state?.phases ?? []).map((phase) => ({
    id: phase.id,
    title: phase.title,
    status: phase.status,
    ...(boundedText(phase.summary) ? { summary: boundedText(phase.summary) } : {}),
    ...(boundedText(phase.outcome, 80) ? { outcome: boundedText(phase.outcome, 80) } : {}),
    files: uniqueStrings(phase.files ?? []),
  }));
  const files = uniqueStrings([...(input.files ?? []), ...phases.flatMap((phase) => phase.files)]);
  const repository = readGitState(cwd);
  const evidence = buildEvidence(input.state, input.evidence);
  const phaseReceipts = input.state?.phaseCommitReceipts ?? [];
  const retainedItems = phaseReceipts.flatMap((receipt) => receipt.stored);
  const skippedItems = phaseReceipts.flatMap((receipt) =>
    receipt.skipped.map<FinalCommitNotPersistedItem>((item) => ({
      text: item.text,
      reason: item.reason ?? "not_stored",
      source: "phase_commit",
    }))
  );
  const allWhyCaptureReceipts = [
    ...phaseReceipts.map((receipt) => receipt.whyCapture).filter(Boolean),
    input.whyCapture,
  ] as CompanionWhyCaptureReceipt[];
  const pendingItems = allWhyCaptureReceipts.flatMap((receipt) =>
    receipt.pendingMemories.map<FinalCommitMemoryItem>((item) => ({
      ...(item.memoryId ? { memoryId: item.memoryId } : {}),
      text: item.text,
      ...(item.type ? { type: item.type } : {}),
      ...(item.category ? { category: item.category } : {}),
      reviewStatus: item.reviewStatus ?? "pending",
      source: "why_capture",
    }))
  );
  const notPersisted: FinalCommitNotPersistedItem[] = [
    {
      text: "Final commit durable-memory extraction",
      reason: "handoff_only_by_design",
      source: "final_commit",
    },
    ...skippedItems,
    ...allWhyCaptureReceipts.flatMap((receipt) =>
      receipt.duplicates.map((item) => ({
        text: item.text,
        reason: "duplicate",
        source: "why_capture" as const,
      }))
    ),
    ...allWhyCaptureReceipts.flatMap((receipt) =>
      receipt.failed.map((item) => ({
        text: item.text,
        reason: item.reason ?? "capture_failed",
        source: "why_capture" as const,
      }))
    ),
  ];
  if (input.whyCapture.status === "no_candidates") {
    notPersisted.push({
      text: "No durable rationale candidate detected",
      reason: "no_candidates",
      source: "why_capture",
    });
  } else if (input.whyCapture.status === "skipped") {
    notPersisted.push({
      text: "Why Capture was not configured",
      reason: "capture_skipped",
      source: "why_capture",
    });
  } else if (input.whyCapture.status === "error") {
    notPersisted.push({
      text: input.whyCapture.error ?? "Why Capture failed",
      reason: "capture_error",
      source: "why_capture",
    });
  }

  const explicitWhy = boundedText(input.why);
  const capturedWhy = allWhyCaptureReceipts.map(whyCaptureRationale).find(Boolean);
  const risks = uniqueStrings([
    ...(input.risks ?? []),
    ...(input.outcome !== "completed" ? [`Final outcome is ${input.outcome}.`] : []),
    ...phases
      .filter((phase) => !["completed", "skipped"].includes(phase.status))
      .map((phase) => `Phase '${phase.id}' is ${phase.status}.`),
    ...(repository.dirty
      ? [`Working tree has ${repository.dirtyFiles.length} dirty file(s).`]
      : []),
    ...(evidence.counts.failed > 0
      ? [`${evidence.counts.failed} verification item(s) failed.`]
      : []),
    ...(evidence.counts.not_run > 0
      ? [`${evidence.counts.not_run} verification item(s) were not run.`]
      : []),
    ...(input.whyCapture.status === "error"
      ? ["Why Capture failed without blocking closeout."]
      : []),
    ...(finalCommitHostedFailed(input.finalCommitResult)
      ? ["Hosted final handoff failed; a local fallback was recorded."]
      : []),
  ]);
  const nextStep =
    boundedText(input.nextStep) ??
    (risks.length > 0
      ? "Resolve or explicitly accept the listed risks."
      : "No follow-up recorded.");
  const completedPhaseCount = phases.filter((phase) => phase.status === "completed").length;

  return {
    version: FINAL_COMMIT_REPORT_VERSION,
    generatedAt: (input.now ?? new Date()).toISOString(),
    ...(input.state?.workflowId ? { workflowId: input.state.workflowId } : {}),
    outcome: input.outcome,
    changed: {
      summary: boundedText(input.summary) ?? "No final summary provided.",
      files,
      phases,
      repository,
    },
    rationale: explicitWhy
      ? { status: "provided", text: explicitWhy, source: "explicit" }
      : capturedWhy
        ? { status: "captured", text: capturedWhy, source: "why_capture" }
        : { status: "missing", source: "none" },
    evidence,
    retainedDecisions: {
      status:
        retainedItems.length > 0
          ? "confirmed"
          : completedPhaseCount > 0 && phaseReceipts.length === 0
            ? "unavailable"
            : "none",
      items: retainedItems,
      ...(completedPhaseCount > 0 && phaseReceipts.length === 0
        ? { note: "This workflow predates local phase memory receipts." }
        : {}),
    },
    pendingDecisions: {
      status:
        pendingItems.length > 0
          ? "pending_review"
          : input.whyCapture.status === "error" || input.whyCapture.status === "skipped"
            ? "unavailable"
            : "none",
      items: pendingItems,
      ...(input.whyCapture.status === "error"
        ? { note: "Why Capture failed; pending state could not be confirmed." }
        : input.whyCapture.status === "skipped"
          ? { note: "Why Capture was not configured." }
          : {}),
    },
    notPersisted: { items: notPersisted.slice(0, MAX_LIST_ITEMS) },
    closeout: { risks, nextStep },
    caveats: [
      "Final commit remains handoff-only and never auto-approves Why Capture candidates.",
      "Only evidence explicitly status-tagged as passed is shown as passed.",
      "Runtime checkpoint commands without an execution receipt remain unknown.",
    ],
  };
}

export function writeFinalCommitReport(
  report: FinalCommitReportV1,
  cwd: string = process.cwd()
): FinalCommitReportArtifact {
  const outputPath = path.join(cwd, FINAL_COMMIT_REPORT_RELATIVE_PATH);
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const content = `${JSON.stringify(report, null, 2)}\n`;
    fs.writeFileSync(outputPath, content, "utf8");
    return {
      status: "written",
      version: FINAL_COMMIT_REPORT_VERSION,
      path: outputPath,
      relativePath: FINAL_COMMIT_REPORT_RELATIVE_PATH,
      hash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    };
  } catch (error) {
    return {
      status: "error",
      version: FINAL_COMMIT_REPORT_VERSION,
      relativePath: FINAL_COMMIT_REPORT_RELATIVE_PATH,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatMemoryItem(item: FinalCommitMemoryItem): string {
  const identity = item.memoryId ? ` (${item.memoryId})` : "";
  const status = item.reviewStatus ? ` [${item.reviewStatus}]` : "";
  const type = item.type ? `[${item.type}] ` : "";
  return `${type}${item.text}${status}${identity}`;
}

export function formatFinalCommitReport(report: FinalCommitReportV1): string {
  const lines: string[] = [
    `Final Commit Report — ${report.outcome.toUpperCase()}`,
    "",
    "1. What changed",
    `- ${report.changed.summary}`,
    `- Files: ${report.changed.files.length}`,
    `- Phases: ${report.changed.phases.filter((phase) => phase.status === "completed").length}/${report.changed.phases.length} completed`,
    "",
    "2. Why",
    report.rationale.text
      ? `- ${report.rationale.text} (${report.rationale.source})`
      : "- Not provided or detected.",
    "",
    "3. Evidence",
  ];
  if (report.evidence.items.length === 0) {
    lines.push("- No verification evidence declared.");
  } else {
    for (const item of report.evidence.items) {
      lines.push(`- [${item.status}] ${item.text}`);
    }
  }
  lines.push("", "4. Decisions kept");
  if (report.retainedDecisions.items.length === 0) {
    lines.push(`- ${report.retainedDecisions.note ?? "None confirmed for this workflow."}`);
  } else {
    for (const item of report.retainedDecisions.items) {
      lines.push(`- ${formatMemoryItem(item)}`);
    }
  }
  lines.push("", "5. Decisions proposed for review");
  if (report.pendingDecisions.items.length === 0) {
    lines.push(`- ${report.pendingDecisions.note ?? "None."}`);
  } else {
    for (const item of report.pendingDecisions.items) {
      lines.push(`- ${formatMemoryItem(item)}`);
    }
  }
  lines.push("", "6. Not persisted");
  for (const item of report.notPersisted.items) {
    lines.push(`- [${item.reason}] ${item.text}`);
  }
  lines.push("", "7. Risks and next step");
  if (report.closeout.risks.length === 0) {
    lines.push("- Risks: none recorded.");
  } else {
    for (const risk of report.closeout.risks) {
      lines.push(`- Risk: ${risk}`);
    }
  }
  lines.push(`- Next: ${report.closeout.nextStep}`);
  return lines.join("\n");
}
