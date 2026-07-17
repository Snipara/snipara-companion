import { hashDecisionJsonValue } from "./decision-request";

export const CONTROLLED_WORKER_EXECUTION_RECEIPT_VERSION =
  "snipara.controlled_worker_execution.receipt.v0" as const;

export type ControlledWorkerExecutionMode = "dry_run" | "approval_required" | "auto_low_risk";
export type ControlledWorkerExecutionStatus =
  | "planned"
  | "executed"
  | "blocked"
  | "failed"
  | "verification_required";

export interface ControlledWorkerExecutionReceipt {
  version: typeof CONTROLLED_WORKER_EXECUTION_RECEIPT_VERSION;
  receiptId: string;
  generatedAt: string;
  task: string;
  mode: ControlledWorkerExecutionMode;
  status: ControlledWorkerExecutionStatus;
  worker: {
    id: string;
    role: string;
    endpointType: "local" | "cloud" | "self_hosted" | "unknown";
  };
  contract: {
    writeScope: string[];
    acceptanceCriteria: string[];
    proofRequired: string[];
    outputFragments: string[];
    missingOutputFragments: string[];
    approvalReceiptId: string | null;
    outcomeReceiptId: string | null;
  };
  execution: {
    command: string | null;
    exitCode: number | null;
    stdoutPreview: string | null;
    stderrPreview: string | null;
    durationMs: number | null;
    provider: string | null;
    model: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    totalCostUsd: number | null;
    changedFiles: string[];
    scopeViolations: string[];
  };
  trust: {
    eventId: string | null;
    workCategory: string | null;
    profileHash: string | null;
    state: string;
    hardGateReady: boolean;
    approvalReceiptRequired: boolean;
  };
  reasonCodes: string[];
  caveats: string[];
}

export interface BuildControlledWorkerExecutionReceiptInput {
  generatedAt?: string | Date;
  task: string;
  mode?: ControlledWorkerExecutionMode;
  status?: ControlledWorkerExecutionStatus;
  worker?: {
    id?: string;
    role?: string;
    endpointType?: "local" | "cloud" | "self_hosted" | "unknown";
  };
  writeScope?: string[];
  acceptanceCriteria?: string[];
  proofRequired?: string[];
  outputFragments?: string[];
  missingOutputFragments?: string[];
  approvalReceiptId?: string | null;
  outcomeReceiptId?: string | null;
  command?: string | null;
  exitCode?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  durationMs?: number | null;
  provider?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalCostUsd?: number | null;
  changedFiles?: string[];
  scopeViolations?: string[];
  trust?: {
    eventId?: string | null;
    workCategory?: string | null;
    profileHash?: string | null;
    state?: string;
    hardGateReady?: boolean;
    approvalReceiptRequired?: boolean;
  };
  reasonCodes?: string[];
}

export function buildControlledWorkerExecutionReceipt(
  input: BuildControlledWorkerExecutionReceiptInput
): ControlledWorkerExecutionReceipt {
  const generatedAt = isoTimestamp(input.generatedAt);
  const mode = input.mode ?? "dry_run";
  const writeScope = uniqueStrings(input.writeScope ?? []);
  const acceptanceCriteria = uniqueStrings(input.acceptanceCriteria ?? []);
  const proofRequired = uniqueStrings(input.proofRequired ?? []);
  const outputFragments = uniqueStrings(input.outputFragments ?? []);
  const missingOutputFragments = uniqueStrings(input.missingOutputFragments ?? []);
  const reasonCodes = new Set<string>([
    "controlled_worker_execution_v0",
    `controlled_worker_execution_${mode}`,
    ...(input.reasonCodes ?? []),
  ]);
  const status = input.status ?? defaultStatusForMode(mode, input.approvalReceiptId);
  const worker = {
    id: compactText(input.worker?.id, 120) || "unassigned-worker",
    role: compactText(input.worker?.role, 80) || "coding",
    endpointType: input.worker?.endpointType ?? "unknown",
  };
  const command = compactText(input.command ?? null, 1_000) || null;
  const core = {
    task: compactText(input.task),
    mode,
    worker,
    writeScope,
    acceptanceCriteria,
    proofRequired,
    outputFragments,
    missingOutputFragments,
    approvalReceiptId: input.approvalReceiptId ?? null,
    outcomeReceiptId: input.outcomeReceiptId ?? null,
    command,
    exitCode: input.exitCode ?? null,
  };
  const receiptHash = hashDecisionJsonValue(core).replace(/^sha256:/, "");

  const delegatedApprovalSatisfied =
    input.trust?.hardGateReady === true && input.trust.approvalReceiptRequired === false;
  if (!input.approvalReceiptId && mode !== "dry_run" && !delegatedApprovalSatisfied) {
    reasonCodes.add("controlled_worker_execution_missing_approval");
  }
  if (proofRequired.length === 0) {
    reasonCodes.add("controlled_worker_execution_missing_proof_contract");
  }
  if (acceptanceCriteria.length === 0) {
    reasonCodes.add("controlled_worker_execution_missing_acceptance");
  }
  if (missingOutputFragments.length > 0) {
    reasonCodes.add("controlled_worker_execution_output_contract_failed");
  }

  return {
    version: CONTROLLED_WORKER_EXECUTION_RECEIPT_VERSION,
    receiptId: `worker-exec-${receiptHash.slice(0, 16)}`,
    generatedAt,
    task: compactText(input.task) || "Controlled worker task",
    mode,
    status,
    worker,
    contract: {
      writeScope,
      acceptanceCriteria,
      proofRequired,
      outputFragments,
      missingOutputFragments,
      approvalReceiptId: input.approvalReceiptId ?? null,
      outcomeReceiptId: input.outcomeReceiptId ?? null,
    },
    execution: {
      command,
      exitCode: typeof input.exitCode === "number" ? input.exitCode : null,
      stdoutPreview: compactText(input.stdout ?? null, 2_000) || null,
      stderrPreview: compactText(input.stderr ?? null, 2_000) || null,
      durationMs: finiteNumber(input.durationMs),
      provider: compactText(input.provider ?? null, 120) || null,
      model: compactText(input.model ?? null, 240) || null,
      inputTokens: finiteNumber(input.inputTokens),
      outputTokens: finiteNumber(input.outputTokens),
      totalCostUsd: finiteNumber(input.totalCostUsd),
      changedFiles: uniqueStrings(input.changedFiles ?? []),
      scopeViolations: uniqueStrings(input.scopeViolations ?? []),
    },
    trust: {
      eventId: compactText(input.trust?.eventId ?? null, 160) || null,
      workCategory: compactText(input.trust?.workCategory ?? null, 120) || null,
      profileHash: compactText(input.trust?.profileHash ?? null, 160) || null,
      state: compactText(input.trust?.state ?? null, 80) || "probation_supervised",
      hardGateReady: Boolean(input.trust?.hardGateReady),
      approvalReceiptRequired: input.trust?.approvalReceiptRequired !== false,
    },
    reasonCodes: Array.from(reasonCodes).sort(),
    caveats: [
      "Controlled Worker Execution V0 is fail-closed and does not silently launch workers.",
      "Project Policy and explicit approval ceilings outrank worker-routing outcome history.",
      "Worker output requires proof and review before durable Project Brain promotion.",
    ],
  };
}

function defaultStatusForMode(
  mode: ControlledWorkerExecutionMode,
  approvalReceiptId: string | null | undefined
): ControlledWorkerExecutionStatus {
  if (mode === "dry_run") return "planned";
  if (!approvalReceiptId) return "blocked";
  return "verification_required";
}

function isoTimestamp(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) return new Date(value).toISOString();
  return new Date().toISOString();
}

function compactText(value: string | null | undefined, maxLength = 700): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
