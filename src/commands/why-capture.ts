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
  const whyFields = isRecord(value.whyFields) ? value.whyFields : undefined;
  const decision = boundedText(whyFields?.decision);
  const rationale = boundedText(whyFields?.why);
  const text = boundedText(value.content) ?? decision;
  if (!text) {
    return undefined;
  }
  return {
    text,
    ...(boundedText(value.type, 80) ? { type: boundedText(value.type, 80) } : {}),
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
  const text = boundedText(value.content) ?? (memoryId ? `Memory ${memoryId}` : undefined);
  if (!text) {
    return undefined;
  }
  return {
    ...(memoryId ? { memoryId } : {}),
    text,
    ...(boundedText(value.type, 80) ? { type: boundedText(value.type, 80) } : {}),
    ...(boundedText(value.category, 120) ? { category: boundedText(value.category, 120) } : {}),
    reviewStatus: boundedText(value.review_status ?? value.reviewStatus, 80) ?? "pending",
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
    boundedText(value.content ?? value.decision ?? value.title ?? value.error ?? value.reason) ??
    "Why Capture item";
  const reason = boundedText(value.reason ?? value.error, 160) ?? fallbackReason;
  return { text, ...(reason ? { reason } : {}) };
}

function boundedUnique(values: string[] | undefined, limit: number): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

function readCommitSha(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
  } catch {
    return undefined;
  }
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
