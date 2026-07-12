import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type ProjectPolicyLedgerSyncArtifactInput } from "../api/client";
import {
  DECISION_APPLY_RELATIVE_DIR,
  POLICY_DRAFT_RELATIVE_DIR,
  buildDecisionApplyReport,
} from "./decision-apply";
import {
  listPendingDecisionRequests,
  listResolvedDecisionRecords,
  type ResolvedDecisionRecord,
} from "./decision-requests";

export const POLICY_LEDGER_SYNC_REPORT_VERSION = "snipara.workflow_policy_ledger_sync.v0" as const;

export interface PolicyLedgerSyncSummary {
  total: number;
  pendingRequests: number;
  resolvedDecisions: number;
  applyReceipts: number;
  policyDrafts: number;
}

export interface PolicyLedgerSyncReport {
  version: typeof POLICY_LEDGER_SYNC_REPORT_VERSION;
  generatedAt: string;
  dryRun: boolean;
  summary: PolicyLedgerSyncSummary;
  artifacts: ProjectPolicyLedgerSyncArtifactInput[];
  hosted?: Record<string, unknown>;
  caveats: string[];
}

export function buildPolicyLedgerSyncReport(
  options: { cwd?: string; dryRun?: boolean } = {}
): PolicyLedgerSyncReport {
  const cwd = options.cwd ?? process.cwd();
  const artifacts = collectPolicyLedgerSyncArtifacts(cwd);
  return {
    version: POLICY_LEDGER_SYNC_REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    dryRun: options.dryRun ?? true,
    summary: summarizePolicyLedgerSyncArtifacts(artifacts),
    artifacts,
    caveats: [
      "Sync uploads local Decision Request, resolution, apply receipt, and policy draft artifacts for hosted audit visibility.",
      "Hosted sync does not approve, refuse, or activate Project Policy automatically.",
      "Canonical policy changes still require an explicit human decision and the local apply-decisions workflow.",
    ],
  };
}

export async function workflowSyncPolicyLedgerCommand(options: {
  dryRun?: boolean;
  json?: boolean;
}): Promise<void> {
  const dryRun = options.dryRun ?? false;
  const report = buildPolicyLedgerSyncReport({ dryRun });
  if (!dryRun) {
    const client = createClient();
    report.hosted = await client.syncProjectPolicyLedger(report.artifacts);
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Project Policy Ledger Sync${dryRun ? " (dry-run)" : ""}`);
  console.log(`Artifacts: ${report.summary.total}`);
  console.log(`Pending requests: ${report.summary.pendingRequests}`);
  console.log(`Resolved decisions: ${report.summary.resolvedDecisions}`);
  console.log(`Apply receipts: ${report.summary.applyReceipts}`);
  console.log(`Policy drafts: ${report.summary.policyDrafts}`);
  if (dryRun) {
    console.log("No hosted changes were made.");
  } else {
    console.log("Hosted ledger sync completed.");
  }
}

export function collectPolicyLedgerSyncArtifacts(
  cwd: string = process.cwd()
): ProjectPolicyLedgerSyncArtifactInput[] {
  const pendingArtifacts = listPendingDecisionRequests(cwd).map((entry) => ({
    kind: "decision_request" as const,
    requestId: entry.request.requestId,
    fingerprint: entry.request.fingerprint,
    title: entry.request.question,
    status: "pending" as const,
    applyState: "needs_apply" as const,
    summary: entry.request.evidence.summary,
    sourcePath: entry.relativePath,
    updatedAt: entry.request.createdAt,
    payload: entry.request as unknown as Record<string, unknown>,
  }));

  const applyReport = buildDecisionApplyReport({ cwd, dryRun: true });
  const applyByRequestId = new Map(applyReport.items.map((item) => [item.requestId, item]));

  const resolvedArtifacts = listResolvedDecisionRecords(cwd).map((record) => {
    const applyItem = applyByRequestId.get(record.request.requestId);
    return {
      kind: "decision_resolution" as const,
      requestId: record.request.requestId,
      fingerprint: record.request.fingerprint,
      title: record.request.question,
      status: statusForResolvedRecord(record),
      applyState: applyItem?.state ?? "manual_follow_up_required",
      humanChoice: record.response.choice,
      summary: record.request.evidence.summary,
      sourcePath: path.join(
        ".snipara",
        "decisions",
        "resolved",
        `${record.request.requestId}.json`
      ),
      updatedAt: record.response.resolvedAt,
      payload: record as unknown as Record<string, unknown>,
    };
  });

  const applyArtifacts = readJsonFiles(path.join(cwd, DECISION_APPLY_RELATIVE_DIR), cwd).map(
    ({ parsed, relativePath }) => ({
      kind: "apply_receipt" as const,
      requestId: stringField(parsed, "requestId") ?? path.basename(relativePath, ".json"),
      fingerprint: stringField(parsed, "fingerprint"),
      title:
        stringField(parsed, "question") ?? stringField(parsed, "decision") ?? "Applied decision",
      status: statusForChoiceClass(stringField(parsed, "choiceClass")),
      applyState: "applied" as const,
      humanChoice: stringField(parsed, "choice"),
      summary: stringField(parsed, "decision"),
      sourcePath: relativePath,
      updatedAt: stringField(parsed, "appliedAt"),
      payload: parsed,
    })
  );

  const draftArtifacts = readJsonFiles(path.join(cwd, POLICY_DRAFT_RELATIVE_DIR), cwd).map(
    ({ parsed, relativePath }) => ({
      kind: "policy_draft" as const,
      requestId: stringField(parsed, "requestId") ?? path.basename(relativePath, ".json"),
      fingerprint: stringField(parsed, "fingerprint"),
      title: stringField(parsed, "title") ?? "Policy draft",
      status: "modified" as const,
      applyState: "manual_follow_up_required" as const,
      humanChoice: stringField(parsed, "humanChoice"),
      summary: stringField(parsed, "decision"),
      sourcePath: relativePath,
      updatedAt: stringField(parsed, "createdAt"),
      payload: parsed,
    })
  );

  return [...pendingArtifacts, ...resolvedArtifacts, ...applyArtifacts, ...draftArtifacts].sort(
    (left, right) =>
      (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") ||
      left.requestId.localeCompare(right.requestId) ||
      left.kind.localeCompare(right.kind)
  );
}

function summarizePolicyLedgerSyncArtifacts(
  artifacts: ProjectPolicyLedgerSyncArtifactInput[]
): PolicyLedgerSyncSummary {
  return {
    total: artifacts.length,
    pendingRequests: artifacts.filter((artifact) => artifact.kind === "decision_request").length,
    resolvedDecisions: artifacts.filter((artifact) => artifact.kind === "decision_resolution")
      .length,
    applyReceipts: artifacts.filter((artifact) => artifact.kind === "apply_receipt").length,
    policyDrafts: artifacts.filter((artifact) => artifact.kind === "policy_draft").length,
  };
}

function statusForResolvedRecord(
  record: ResolvedDecisionRecord
): ProjectPolicyLedgerSyncArtifactInput["status"] {
  switch (record.response.choice) {
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
      return "modified";
  }
}

function statusForChoiceClass(
  choiceClass?: string
): ProjectPolicyLedgerSyncArtifactInput["status"] {
  if (choiceClass === "approved") return "approved";
  if (choiceClass === "refused" || choiceClass === "deferred") return "refused";
  return "modified";
}

function readJsonFiles(
  directory: string,
  cwd: string
): Array<{ parsed: Record<string, unknown>; relativePath: string }> {
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs
    .readdirSync(directory)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => {
      const filePath = path.join(directory, fileName);
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
      return { parsed, relativePath: toProjectRelativePath(filePath, cwd) };
    });
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}

function toProjectRelativePath(absolutePath: string, cwd: string): string {
  const relative = path.relative(cwd, absolutePath).replace(/\\/g, "/");
  return relative.startsWith(".") ? relative : `.${path.sep}${relative}`.replace(/\\/g, "/");
}
