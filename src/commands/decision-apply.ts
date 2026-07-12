import * as fs from "node:fs";
import * as path from "node:path";
import {
  stableDecisionJsonStringify,
  type DecisionRequest,
} from "../contracts/project-intelligence";
import { listResolvedDecisionRecords, type ResolvedDecisionRecord } from "./decision-requests";

export const DECISION_APPLY_LEDGER_VERSION = "snipara.decision_apply_ledger.v0" as const;
export const DECISION_APPLY_RELATIVE_DIR = path.join(".snipara", "policy-ledger", "applied");
export const POLICY_DRAFT_RELATIVE_DIR = path.join(".snipara", "policies", "drafts");

export type DecisionApplyChoiceClass = "approved" | "refused" | "modified" | "deferred";
export type DecisionApplyState =
  | "needs_apply"
  | "applied"
  | "manual_follow_up_required"
  | "no_apply";

export interface DecisionApplyItem {
  requestId: string;
  fingerprint: string;
  choice: string;
  choiceClass: DecisionApplyChoiceClass;
  state: DecisionApplyState;
  producerKind: DecisionRequest["producer"]["kind"];
  question: string;
  decision: string;
  reviewer: string;
  resolvedAt: string;
  applyPath?: string;
  applyCommand?: string;
  files: string[];
  reasonCodes: string[];
  plannedActions: string[];
  alreadyApplied: boolean;
  appliedAt?: string;
  appliedPath?: string;
  policyDraftPath?: string;
  caveats: string[];
}

export interface DecisionApplySummary {
  totalResolvedPolicyDecisions: number;
  needsApply: number;
  applied: number;
  manualFollowUpRequired: number;
  noApply: number;
  written: number;
}

export interface DecisionApplyReport {
  version: typeof DECISION_APPLY_LEDGER_VERSION;
  generatedAt: string;
  dryRun: boolean;
  summary: DecisionApplySummary;
  items: DecisionApplyItem[];
  caveats: string[];
}

interface AppliedDecisionRecord {
  schemaVersion: typeof DECISION_APPLY_LEDGER_VERSION;
  requestId: string;
  fingerprint: string;
  appliedAt: string;
  choice: string;
  choiceClass: DecisionApplyChoiceClass;
  producerKind: DecisionRequest["producer"]["kind"];
  question: string;
  decision: string;
  reviewer: string;
  resolvedAt: string;
  applyPath?: string;
  applyCommand?: string;
  files: string[];
  reasonCodes: string[];
  plannedActions: string[];
  policyDraftPath?: string;
  caveats: string[];
}

export function buildDecisionApplyReport(
  options: {
    cwd?: string;
    dryRun?: boolean;
  } = {}
): DecisionApplyReport {
  const cwd = options.cwd ?? process.cwd();
  const dryRun = options.dryRun ?? true;
  const resolved = listResolvedDecisionRecords(cwd).filter((record) =>
    isProjectPolicyDecisionRecord(record)
  );
  const items = resolved
    .map((record) => buildDecisionApplyItem(record, cwd))
    .sort((left, right) => right.resolvedAt.localeCompare(left.resolvedAt));

  let written = 0;
  if (!dryRun) {
    for (const item of items) {
      if (item.state !== "needs_apply" || item.alreadyApplied) {
        continue;
      }
      writeAppliedDecisionRecord(item, cwd);
      item.state = "applied";
      item.alreadyApplied = true;
      item.appliedAt = new Date().toISOString();
      item.appliedPath = toProjectRelativePath(appliedDecisionPath(cwd, item.requestId), cwd);
      written += 1;
    }
  }

  return {
    version: DECISION_APPLY_LEDGER_VERSION,
    generatedAt: new Date().toISOString(),
    dryRun,
    summary: summarizeDecisionApplyItems(items, written),
    items,
    caveats: [
      "apply-decisions only processes already resolved local Decision Request receipts.",
      "Project Policy is never approved or changed silently; approved policy suggestions become reviewable local drafts.",
      "Manual follow-up items need the LLM agent to explain the next action to the user before any canonical policy changes.",
    ],
  };
}

function buildDecisionApplyItem(record: ResolvedDecisionRecord, cwd: string): DecisionApplyItem {
  const request = record.request;
  const choiceClass = classifyDecisionApplyChoice(record.response.choice);
  const existing = readAppliedDecisionRecord(cwd, request.requestId);
  const policyDraftPath = shouldWritePolicyDraft(record)
    ? toProjectRelativePath(policyDraftPathFor(cwd, request.requestId), cwd)
    : undefined;
  const plannedActions = plannedActionsFor(record, policyDraftPath);
  const manualFollowUp = requiresManualFollowUp(record);
  const noApply = choiceClass === "refused" || choiceClass === "deferred";
  const state: DecisionApplyState = existing
    ? "applied"
    : manualFollowUp
      ? "manual_follow_up_required"
      : noApply
        ? "no_apply"
        : "needs_apply";

  return {
    requestId: request.requestId,
    fingerprint: request.fingerprint,
    choice: record.response.choice,
    choiceClass,
    state,
    producerKind: request.producer.kind,
    question: request.question,
    decision: request.decision,
    reviewer: record.response.reviewer,
    resolvedAt: record.response.resolvedAt,
    applyPath: request.evidence.applyPath,
    applyCommand: request.evidence.applyCommand,
    files: request.evidence.files ?? [],
    reasonCodes: request.evidence.reasonCodes,
    plannedActions,
    alreadyApplied: Boolean(existing),
    appliedAt: existing?.appliedAt,
    appliedPath: existing
      ? toProjectRelativePath(appliedDecisionPath(cwd, request.requestId), cwd)
      : undefined,
    policyDraftPath,
    caveats: caveatsFor(record),
  };
}

function isProjectPolicyDecisionRecord(record: ResolvedDecisionRecord): boolean {
  return (
    record.request.producer.kind === "project_policy_review" ||
    record.request.producer.kind === "policy_suggestion" ||
    record.request.evidence.reasonCodes.some((code) => /policy/i.test(code)) ||
    /project policy|policy suggestion|policy/i.test(
      [
        record.request.decision,
        record.request.question,
        record.request.evidence.summary,
        record.request.evidence.applyPath ?? "",
      ].join(" ")
    )
  );
}

function classifyDecisionApplyChoice(choice: string): DecisionApplyChoiceClass {
  switch (choice) {
    case "approve_once":
    case "accept":
    case "accept_all":
    case "create_policy_suggestion":
    case "keep_advisory":
      return "approved";
    case "mark_policy_stale":
    case "request_exception":
      return "modified";
    case "reject":
    case "reject_all":
    case "reject_policy_suggestion":
    case "require_changes":
    case "respect_block":
      return "refused";
    default:
      return "deferred";
  }
}

function shouldWritePolicyDraft(record: ResolvedDecisionRecord): boolean {
  return (
    record.request.producer.kind === "policy_suggestion" &&
    classifyDecisionApplyChoice(record.response.choice) === "approved"
  );
}

function requiresManualFollowUp(record: ResolvedDecisionRecord): boolean {
  const choiceClass = classifyDecisionApplyChoice(record.response.choice);
  if (choiceClass === "modified") {
    return true;
  }
  const applyPath = record.request.evidence.applyPath ?? "";
  return /manual/i.test(applyPath) && !shouldWritePolicyDraft(record);
}

function plannedActionsFor(record: ResolvedDecisionRecord, policyDraftPath?: string): string[] {
  if (policyDraftPath) {
    return [`write_policy_draft:${policyDraftPath}`];
  }
  const choiceClass = classifyDecisionApplyChoice(record.response.choice);
  if (choiceClass === "refused") {
    return ["record_refusal_receipt"];
  }
  if (choiceClass === "deferred") {
    return ["no_apply:human_deferred_or_kept_pending"];
  }
  if (choiceClass === "modified") {
    return ["manual_follow_up_required"];
  }
  return ["record_approved_receipt"];
}

function caveatsFor(record: ResolvedDecisionRecord): string[] {
  const caveats: string[] = [];
  if (requiresManualFollowUp(record)) {
    caveats.push("Manual follow-up required before changing canonical Project Policy.");
  }
  if (shouldWritePolicyDraft(record)) {
    caveats.push("Approved policy suggestion is written as a local draft, not activated.");
  }
  if (classifyDecisionApplyChoice(record.response.choice) === "refused") {
    caveats.push("Refused decisions are retained as audit receipts only.");
  }
  return caveats;
}

function summarizeDecisionApplyItems(
  items: DecisionApplyItem[],
  written: number
): DecisionApplySummary {
  return {
    totalResolvedPolicyDecisions: items.length,
    needsApply: items.filter((item) => item.state === "needs_apply").length,
    applied: items.filter((item) => item.state === "applied").length,
    manualFollowUpRequired: items.filter((item) => item.state === "manual_follow_up_required")
      .length,
    noApply: items.filter((item) => item.state === "no_apply").length,
    written,
  };
}

function writeAppliedDecisionRecord(item: DecisionApplyItem, cwd: string): void {
  fs.mkdirSync(appliedDecisionDir(cwd), { recursive: true });
  let policyDraftPath: string | undefined;
  if (item.policyDraftPath) {
    const absoluteDraftPath = policyDraftPathFor(cwd, item.requestId);
    fs.mkdirSync(path.dirname(absoluteDraftPath), { recursive: true });
    fs.writeFileSync(
      absoluteDraftPath,
      `${stableDecisionJsonStringify({
        schemaVersion: "snipara.project_policy_draft.v0",
        requestId: item.requestId,
        fingerprint: item.fingerprint,
        createdAt: new Date().toISOString(),
        title: item.question,
        decision: item.decision,
        humanChoice: item.choice,
        reviewer: item.reviewer,
        resolvedAt: item.resolvedAt,
        source: "workflow apply-decisions",
        status: "draft",
        caveats: [
          "This is a reviewable local policy draft generated from an explicit human decision.",
          "It is not active Project Policy until a human applies it through the canonical policy surface.",
        ],
      })}\n`,
      "utf8"
    );
    policyDraftPath = toProjectRelativePath(absoluteDraftPath, cwd);
  }
  const appliedAt = new Date().toISOString();
  const record: AppliedDecisionRecord = {
    schemaVersion: DECISION_APPLY_LEDGER_VERSION,
    requestId: item.requestId,
    fingerprint: item.fingerprint,
    appliedAt,
    choice: item.choice,
    choiceClass: item.choiceClass,
    producerKind: item.producerKind,
    question: item.question,
    decision: item.decision,
    reviewer: item.reviewer,
    resolvedAt: item.resolvedAt,
    applyPath: item.applyPath,
    applyCommand: item.applyCommand,
    files: item.files,
    reasonCodes: item.reasonCodes,
    plannedActions: item.plannedActions,
    policyDraftPath,
    caveats: item.caveats,
  };
  fs.writeFileSync(
    appliedDecisionPath(cwd, item.requestId),
    `${stableDecisionJsonStringify(record)}\n`,
    "utf8"
  );
}

function readAppliedDecisionRecord(
  cwd: string,
  requestId: string
): AppliedDecisionRecord | undefined {
  const filePath = appliedDecisionPath(cwd, requestId);
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as AppliedDecisionRecord;
  return parsed.schemaVersion === DECISION_APPLY_LEDGER_VERSION ? parsed : undefined;
}

function appliedDecisionDir(cwd: string): string {
  return path.join(cwd, DECISION_APPLY_RELATIVE_DIR);
}

function appliedDecisionPath(cwd: string, requestId: string): string {
  return path.join(appliedDecisionDir(cwd), `${sanitizeFileStem(requestId)}.json`);
}

function policyDraftPathFor(cwd: string, requestId: string): string {
  return path.join(cwd, POLICY_DRAFT_RELATIVE_DIR, `${sanitizeFileStem(requestId)}.json`);
}

function sanitizeFileStem(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160) || "decision";
}

function toProjectRelativePath(absolutePath: string, cwd: string): string {
  const relative = path.relative(cwd, absolutePath).replace(/\\/g, "/");
  return relative.startsWith(".") ? relative : `.${path.sep}${relative}`.replace(/\\/g, "/");
}
