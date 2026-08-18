import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type WhyCaptureSourceKind } from "../api/client";
import { loadConfig } from "../config/store";

export interface CompanionWhyCaptureInput {
  cwd?: string;
  sourceKind: WhyCaptureSourceKind;
  sourceSessionId?: string;
  task?: string;
  summary: string;
  why?: string;
  files?: string[];
  commands?: string[];
}

export interface CompanionWhyCaptureCandidate {
  text: string;
  type?: string;
  category?: string;
  decision?: string;
  rationale?: string;
}

export interface CompanionWhyCaptureMemory {
  memoryId?: string;
  text: string;
  type?: string;
  category?: string;
  reviewStatus?: string;
}

export interface CompanionWhyCaptureIssue {
  text: string;
  reason?: string;
}

export interface CompanionWhyCaptureReceipt {
  status: "captured" | "no_candidates" | "skipped" | "error";
  sourceKind: WhyCaptureSourceKind;
  previewCandidateCount: number;
  capturedCount: number;
  previewCandidates: CompanionWhyCaptureCandidate[];
  pendingMemories: CompanionWhyCaptureMemory[];
  duplicates: CompanionWhyCaptureIssue[];
  failed: CompanionWhyCaptureIssue[];
  commitSha?: string;
  error?: string;
}

const MAX_SOURCE_TEXT_CHARS = 12_000;
const MAX_TASK_CHARS = 700;
const MAX_RECEIPT_TEXT_CHARS = 900;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength = MAX_RECEIPT_TEXT_CHARS): string | undefined {
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

function previewCandidateReceipt(value: unknown): CompanionWhyCaptureCandidate | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const whyFields = isRecord(value.whyFields)
    ? value.whyFields
    : isRecord(value.why_fields)
      ? value.why_fields
      : undefined;
  const decision = boundedText(whyFields?.decision);
  const rationale = boundedText(whyFields?.why ?? whyFields?.rationale);
  const text = boundedText(value.content ?? value.text) ?? decision;
  if (!text) {
    return undefined;
  }
  return {
    text,
    ...(boundedText(value.type ?? value.memory_type, 80)
      ? { type: boundedText(value.type ?? value.memory_type, 80) }
      : {}),
    ...(boundedText(value.category, 120) ? { category: boundedText(value.category, 120) } : {}),
    ...(decision ? { decision } : {}),
    ...(rationale ? { rationale } : {}),
  };
}

function pendingMemoryReceipt(value: unknown): CompanionWhyCaptureMemory | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const memoryId = boundedText(value.memory_id ?? value.memoryId ?? value.id, 200);
  const text =
    boundedText(value.content ?? value.text) ?? (memoryId ? `Memory ${memoryId}` : undefined);
  if (!text) {
    return undefined;
  }
  return {
    ...(memoryId ? { memoryId } : {}),
    text,
    ...(boundedText(value.type ?? value.memory_type, 80)
      ? { type: boundedText(value.type ?? value.memory_type, 80) }
      : {}),
    category: boundedText(value.category, 120) ?? "why-capture",
    reviewStatus: boundedText(value.review_status ?? value.reviewStatus, 80) ?? "PENDING",
  };
}

function pendingDecisionReceipt(value: unknown): CompanionWhyCaptureMemory | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const recordId = boundedText(value.id, 200);
  const decisionId = boundedText(value.decision_id ?? value.decisionId, 200);
  if (!recordId && !decisionId) {
    return undefined;
  }
  const rawStatus = boundedText(value.status ?? value.review_status ?? value.reviewStatus, 80);
  const normalizedStatus = rawStatus?.toUpperCase();
  return {
    ...(recordId ? { memoryId: recordId } : {}),
    text: `Project decision ${decisionId ?? recordId}`,
    type: "decision",
    category: "why-capture",
    reviewStatus: normalizedStatus === "DRAFT" ? "PENDING" : (normalizedStatus ?? "PENDING"),
  };
}

function issueReceipt(
  value: unknown,
  fallbackReason?: string
): CompanionWhyCaptureIssue | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const text =
    boundedText(
      value.content ??
        value.decision ??
        value.title ??
        value.error ??
        value.reason ??
        value.decision_id ??
        value.id
    ) ?? "Why Capture item";
  const reason = boundedText(value.reason ?? value.error, 160) ?? fallbackReason;
  return { text, ...(reason ? { reason } : {}) };
}

function boundedUnique(values: string[] | undefined, limit: number): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

function readGitValue(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
  } catch {
    return undefined;
  }
}

function readCommitSha(cwd: string): string | undefined {
  return readGitValue(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
}

export interface StandaloneCommitEvidence {
  commitSha: string;
  summary: string;
  files: string[];
}

export function hasActiveManagedWorkflow(cwd: string): boolean {
  const statePath = path.join(cwd, ".snipara", "workflow", "current.json");
  if (!fs.existsSync(statePath)) {
    return false;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as { status?: unknown };
    return parsed.status !== "completed";
  } catch {
    // An unreadable workflow state is ambiguous; skip automatic capture rather
    // than risk duplicating a managed workflow's reviewed rationale.
    return true;
  }
}

export function readStandaloneCommitEvidence(
  cwd: string,
  commitSha: string,
  additionalFiles: string[] = []
): StandaloneCommitEvidence | undefined {
  if (!FULL_COMMIT_SHA.test(commitSha)) {
    return undefined;
  }

  const summary = readGitValue(cwd, ["show", "--no-patch", "--format=%B", commitSha]);
  if (!summary) {
    return undefined;
  }

  const commitFiles = readGitValue(cwd, [
    "diff-tree",
    "--root",
    "--no-commit-id",
    "--name-only",
    "-r",
    commitSha,
  ]);
  const files = boundedUnique(
    [...(commitFiles ? commitFiles.split(/\r?\n/) : []), ...additionalFiles],
    40
  );
  return { commitSha, summary, files };
}

export function readLatestWorkflowCommands(cwd: string): string[] {
  try {
    const state = JSON.parse(
      fs.readFileSync(path.join(cwd, ".snipara", "workflow", "current.json"), "utf8")
    ) as {
      runtime?: {
        sandbox?: {
          bindings?: Array<{ lastCheckpoint?: { commands?: unknown } }>;
        };
      };
    };
    const bindings = state.runtime?.sandbox?.bindings ?? [];
    for (let index = bindings.length - 1; index >= 0; index -= 1) {
      const commands = bindings[index]?.lastCheckpoint?.commands;
      if (Array.isArray(commands)) {
        return boundedUnique(
          commands.filter((command): command is string => typeof command === "string"),
          20
        );
      }
    }
  } catch {
    // Missing or partial workflow state should never block the primary command.
  }
  return [];
}

export async function captureStandaloneCommitWhy(input: {
  cwd: string;
  commitSha: string;
  files?: string[];
}): Promise<CompanionWhyCaptureReceipt> {
  const baseReceipt = {
    sourceKind: "commit" as const,
    previewCandidateCount: 0,
    capturedCount: 0,
    previewCandidates: [] as CompanionWhyCaptureCandidate[],
    pendingMemories: [] as CompanionWhyCaptureMemory[],
    duplicates: [] as CompanionWhyCaptureIssue[],
    failed: [] as CompanionWhyCaptureIssue[],
    commitSha: input.commitSha,
  };

  if (hasActiveManagedWorkflow(input.cwd)) {
    return { ...baseReceipt, status: "skipped", error: "managed_workflow_active" };
  }

  const evidence = readStandaloneCommitEvidence(input.cwd, input.commitSha, input.files);
  if (!evidence) {
    return { ...baseReceipt, status: "skipped", error: "commit_evidence_unavailable" };
  }

  const currentSha = readCommitSha(input.cwd);
  if (currentSha !== input.commitSha) {
    return { ...baseReceipt, status: "skipped", error: "head_changed_before_capture" };
  }

  return captureCompanionWhy({
    cwd: input.cwd,
    sourceKind: "commit",
    task: `Standalone commit ${input.commitSha.slice(0, 12)}`,
    summary: evidence.summary,
    files: evidence.files,
  });
}

function recordItems(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function taskCommitWhyCaptureReceipt(
  result: Record<string, unknown>,
  sourceKind: WhyCaptureSourceKind,
  cwd: string = process.cwd()
): CompanionWhyCaptureReceipt {
  const commitSha = readCommitSha(cwd);
  const candidates = recordItems(result.candidates).filter(
    (candidate) => isRecord(candidate.why_fields) || isRecord(candidate.whyFields)
  );
  const storedCandidates = recordItems(result.stored_candidates).filter(
    (candidate) => isRecord(candidate.why_fields) || isRecord(candidate.whyFields)
  );
  const decisionCapture = isRecord(result.decision_capture) ? result.decision_capture : {};
  const duplicates = recordItems(decisionCapture.duplicates)
    .map((item) => issueReceipt(item, "duplicate"))
    .filter((item): item is CompanionWhyCaptureIssue => Boolean(item));
  const failed = recordItems(decisionCapture.failed)
    .map((item) => issueReceipt(item, "capture_failed"))
    .filter((item): item is CompanionWhyCaptureIssue => Boolean(item));
  const caveats = Array.isArray(result.caveats)
    ? result.caveats.filter((item): item is string => typeof item === "string")
    : [];
  const hostedPhaseCommit = isRecord(result.hosted_phase_commit)
    ? result.hosted_phase_commit
    : undefined;
  const hostedFinalCommit = isRecord(result.hosted_final_commit)
    ? result.hosted_final_commit
    : undefined;
  const hostedError = boundedText(hostedPhaseCommit?.error ?? hostedFinalCommit?.error);
  const previewCandidates = candidates
    .map(previewCandidateReceipt)
    .filter((item): item is CompanionWhyCaptureCandidate => Boolean(item));
  const createdDecisionReceipts = recordItems(decisionCapture.created)
    .map(pendingDecisionReceipt)
    .filter((item): item is CompanionWhyCaptureMemory => Boolean(item));
  const storedMemoryReceipts = storedCandidates
    .map(pendingMemoryReceipt)
    .filter((item): item is CompanionWhyCaptureMemory => Boolean(item));
  const pendingMemories =
    createdDecisionReceipts.length > 0 ? createdDecisionReceipts : storedMemoryReceipts;
  const baseReceipt = {
    sourceKind,
    previewCandidateCount: previewCandidates.length,
    capturedCount: pendingMemories.length,
    previewCandidates,
    pendingMemories,
    duplicates,
    failed,
    ...(commitSha ? { commitSha } : {}),
  };

  if (hostedError) {
    return { ...baseReceipt, status: "error", error: hostedError };
  }
  if (caveats.includes("why_requires_human_owner")) {
    return { ...baseReceipt, status: "skipped", error: "why_requires_human_owner" };
  }
  if (
    candidates.length === 0 &&
    pendingMemories.length === 0 &&
    duplicates.length === 0 &&
    failed.length === 0
  ) {
    return { ...baseReceipt, status: "no_candidates" };
  }
  return { ...baseReceipt, status: "captured" };
}

export async function captureCompanionWhy(
  input: CompanionWhyCaptureInput
): Promise<CompanionWhyCaptureReceipt> {
  const cwd = input.cwd ?? process.cwd();
  const commitSha = readCommitSha(cwd);
  const baseReceipt = {
    sourceKind: input.sourceKind,
    previewCandidateCount: 0,
    capturedCount: 0,
    previewCandidates: [] as CompanionWhyCaptureCandidate[],
    pendingMemories: [] as CompanionWhyCaptureMemory[],
    duplicates: [] as CompanionWhyCaptureIssue[],
    failed: [] as CompanionWhyCaptureIssue[],
    ...(commitSha ? { commitSha } : {}),
  };

  if (!loadConfig({ cwd }).apiKey) {
    return { ...baseReceipt, status: "skipped" };
  }

  const task = input.task?.trim().slice(0, MAX_TASK_CHARS);
  const summary = input.summary.trim();
  const why = input.why?.trim();
  const sourceText = [
    task ? `Task: ${task}` : undefined,
    `Summary: ${summary}`,
    why ? `Why: ${why}` : undefined,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_SOURCE_TEXT_CHARS);
  const payload = {
    sourceKind: input.sourceKind,
    ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId.slice(0, 200) } : {}),
    ...(task ? { task } : {}),
    ...(why ? { why } : {}),
    sourceText,
    changedFiles: boundedUnique(input.files, 40),
    commands: boundedUnique(input.commands, 20),
    ...(commitSha ? { commitSha } : {}),
  };

  let previewCandidates: CompanionWhyCaptureCandidate[] = [];
  try {
    const client = createClient(10_000, { cwd });
    const preview = await client.captureWhy({
      ...payload,
      previewOnly: true,
      confirmed: false,
    });
    previewCandidates = (preview.candidates ?? [])
      .map(previewCandidateReceipt)
      .filter((item): item is CompanionWhyCaptureCandidate => Boolean(item));
    if (preview.candidateCount === 0) {
      return { ...baseReceipt, previewCandidates, status: "no_candidates" };
    }

    const confirmed = await client.captureWhy({
      ...payload,
      previewOnly: false,
      confirmed: true,
    });
    return {
      ...baseReceipt,
      status: "captured",
      previewCandidateCount: preview.candidateCount,
      capturedCount: confirmed.capturedCount ?? confirmed.candidateCount,
      previewCandidates,
      pendingMemories: (confirmed.memories ?? [])
        .map(pendingMemoryReceipt)
        .filter((item): item is CompanionWhyCaptureMemory => Boolean(item)),
      duplicates: (confirmed.decisionCapture?.duplicates ?? [])
        .map((item) => issueReceipt(item, "duplicate"))
        .filter((item): item is CompanionWhyCaptureIssue => Boolean(item)),
      failed: (confirmed.decisionCapture?.failed ?? [])
        .map((item) => issueReceipt(item, "capture_failed"))
        .filter((item): item is CompanionWhyCaptureIssue => Boolean(item)),
    };
  } catch (error) {
    return {
      ...baseReceipt,
      status: "error",
      previewCandidateCount: previewCandidates.length,
      previewCandidates,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
