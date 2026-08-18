import { hashDecisionJsonValue } from "./decision-request";
import type { ControlledWorkerExecutionReceipt } from "./controlled-worker-execution";
import type { OutcomeIntelligenceReceipt } from "./outcome-intelligence";
import type { ProjectPolicyReceipt } from "./project-policy";

export const UNIFIED_RECEIPT_ENVELOPE_VERSION = "snipara.unified_receipt_envelope.v0" as const;

export type UnifiedReceiptFamily =
  | "project_policy"
  | "project_policy_sync"
  | "outcome_intelligence"
  | "controlled_worker_execution"
  | "engineering_lead_execution"
  | "adaptive_routing"
  | "htask_validation"
  | "handoff"
  | "context_pack"
  | "advisor_influence"
  | "coding_ledger"
  | "activation"
  | "unknown";

export type UnifiedReceiptStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "blocked"
  | "failed"
  | "succeeded"
  | "partial"
  | "unknown";

export type UnifiedReceiptStage =
  | "policy"
  | "routing"
  | "handoff"
  | "claim"
  | "execution"
  | "proof"
  | "validation"
  | "outcome"
  | "brain_update"
  | "activation"
  | "context";

export interface UnifiedWorkflowIdentity {
  workflowId?: string;
  workflowFingerprint?: string;
  phaseId?: string;
  workPackageId?: string;
  htaskId?: string;
  sessionId?: string;
  swarmId?: string;
  checkoutId?: string;
  workerId?: string;
  branch?: string;
  baseSha?: string;
  headSha?: string;
}

export interface UnifiedReceiptProducer {
  surface:
    | "companion"
    | "orchestrator"
    | "hosted_mcp"
    | "web"
    | "api"
    | "worker"
    | "human"
    | "import";
  command?: string;
  tool?: string;
  client?: string;
  agentId?: string;
  workerId?: string;
}

export interface UnifiedReceiptSubject {
  title: string;
  summary?: string;
  sourceRef?: string;
  changedFiles: string[];
  commands: string[];
}

export interface UnifiedReceiptLinks {
  parentReceiptId?: string;
  relatedReceiptIds: string[];
  approvalReceiptId?: string;
  outcomeReceiptId?: string;
  proofReceiptIds: string[];
  handoffReceiptId?: string;
  brainUpdateReceiptId?: string;
}

export interface UnifiedReceiptEvidence {
  reasonCodes: string[];
  proofRefs: string[];
  evidenceRefs: string[];
  payloadHash: string;
  privacyLevel: "standard" | "sensitive" | "restricted";
}

export interface UnifiedReceiptReview {
  reviewStatus: "pending" | "accepted" | "rejected" | "not_required";
  reviewer?: string;
  reviewedAt?: string;
}

export interface UnifiedReceiptEnvelope<Payload = unknown> {
  schemaVersion: typeof UNIFIED_RECEIPT_ENVELOPE_VERSION;
  receiptId: string;
  family: UnifiedReceiptFamily;
  receiptVersion: string;
  producedAt: string;
  receivedAt: string;
  projectId: string;
  workflow: UnifiedWorkflowIdentity;
  producer: UnifiedReceiptProducer;
  stage: UnifiedReceiptStage;
  status: UnifiedReceiptStatus;
  subject: UnifiedReceiptSubject;
  links: UnifiedReceiptLinks;
  evidence: UnifiedReceiptEvidence;
  review: UnifiedReceiptReview;
  payload: Payload;
  caveats: string[];
}

export interface BuildUnifiedReceiptEnvelopeInput<Payload = unknown> {
  projectId: string;
  family: UnifiedReceiptFamily;
  receiptVersion: string;
  receiptId?: string;
  producedAt?: string | Date;
  receivedAt?: string | Date;
  workflow?: UnifiedWorkflowIdentity;
  producer: UnifiedReceiptProducer;
  stage: UnifiedReceiptStage;
  status: UnifiedReceiptStatus;
  subject: Partial<UnifiedReceiptSubject> & { title: string };
  links?: Partial<UnifiedReceiptLinks>;
  reasonCodes?: string[];
  proofRefs?: string[];
  evidenceRefs?: string[];
  privacyLevel?: UnifiedReceiptEvidence["privacyLevel"];
  review?: Partial<UnifiedReceiptReview>;
  payload: Payload;
  caveats?: string[];
}

export interface ProjectPolicyUnifiedReceiptInput {
  projectId: string;
  receipt: ProjectPolicyReceipt;
  producedAt?: string | Date;
  receivedAt?: string | Date;
  producer?: Partial<UnifiedReceiptProducer>;
  workflow?: UnifiedWorkflowIdentity;
  subject?: Partial<UnifiedReceiptSubject>;
  review?: Partial<UnifiedReceiptReview>;
}

export interface OutcomeUnifiedReceiptInput {
  projectId: string;
  receipt: OutcomeIntelligenceReceipt;
  producedAt?: string | Date;
  receivedAt?: string | Date;
  producer?: Partial<UnifiedReceiptProducer>;
  workflow?: UnifiedWorkflowIdentity;
  reviewStatus?: UnifiedReceiptReview["reviewStatus"];
  metadata?: Record<string, unknown>;
}

export interface ControlledWorkerUnifiedReceiptInput {
  projectId: string;
  receipt: ControlledWorkerExecutionReceipt;
  producedAt?: string | Date;
  receivedAt?: string | Date;
  producer?: Partial<UnifiedReceiptProducer>;
  workflow?: UnifiedWorkflowIdentity;
}

export function buildUnifiedReceiptEnvelope<Payload>(
  input: BuildUnifiedReceiptEnvelopeInput<Payload>
): UnifiedReceiptEnvelope<Payload> {
  const payloadHash = hashDecisionJsonValue(input.payload);
  const receiptId =
    compactText(input.receiptId, 180) ||
    `unified-${input.family}-${payloadHash.replace(/^sha256:/, "").slice(0, 16)}`;

  return {
    schemaVersion: UNIFIED_RECEIPT_ENVELOPE_VERSION,
    receiptId,
    family: input.family,
    receiptVersion: compactText(input.receiptVersion, 180) || "unknown",
    producedAt: isoTimestamp(input.producedAt),
    receivedAt: isoTimestamp(input.receivedAt),
    projectId: compactText(input.projectId, 180),
    workflow: normalizeWorkflow(input.workflow),
    producer: normalizeProducer(input.producer),
    stage: input.stage,
    status: input.status,
    subject: {
      title: compactText(input.subject.title, 300) || receiptId,
      ...(compactText(input.subject.summary, 1_200)
        ? { summary: compactText(input.subject.summary, 1_200) }
        : {}),
      ...(compactText(input.subject.sourceRef, 1_000)
        ? { sourceRef: compactText(input.subject.sourceRef, 1_000) }
        : {}),
      changedFiles: uniqueStrings(input.subject.changedFiles ?? []),
      commands: uniqueStrings(input.subject.commands ?? []),
    },
    links: {
      ...(compactText(input.links?.parentReceiptId, 180)
        ? { parentReceiptId: compactText(input.links?.parentReceiptId, 180) }
        : {}),
      relatedReceiptIds: uniqueStrings(input.links?.relatedReceiptIds ?? []),
      ...(compactText(input.links?.approvalReceiptId, 180)
        ? { approvalReceiptId: compactText(input.links?.approvalReceiptId, 180) }
        : {}),
      ...(compactText(input.links?.outcomeReceiptId, 180)
        ? { outcomeReceiptId: compactText(input.links?.outcomeReceiptId, 180) }
        : {}),
      proofReceiptIds: uniqueStrings(input.links?.proofReceiptIds ?? []),
      ...(compactText(input.links?.handoffReceiptId, 180)
        ? { handoffReceiptId: compactText(input.links?.handoffReceiptId, 180) }
        : {}),
      ...(compactText(input.links?.brainUpdateReceiptId, 180)
        ? { brainUpdateReceiptId: compactText(input.links?.brainUpdateReceiptId, 180) }
        : {}),
    },
    evidence: {
      reasonCodes: uniqueStrings(input.reasonCodes ?? []),
      proofRefs: uniqueStrings(input.proofRefs ?? []),
      evidenceRefs: uniqueStrings(input.evidenceRefs ?? []),
      payloadHash,
      privacyLevel: input.privacyLevel ?? "standard",
    },
    review: {
      reviewStatus: input.review?.reviewStatus ?? "not_required",
      ...(compactText(input.review?.reviewer, 180)
        ? { reviewer: compactText(input.review?.reviewer, 180) }
        : {}),
      ...(input.review?.reviewedAt ? { reviewedAt: isoTimestamp(input.review.reviewedAt) } : {}),
    },
    payload: input.payload,
    caveats: uniqueStrings(input.caveats ?? []),
  };
}

export function projectPolicyReceiptToUnifiedEnvelope(
  input: ProjectPolicyUnifiedReceiptInput
): UnifiedReceiptEnvelope<ProjectPolicyReceipt> {
  const status: UnifiedReceiptStatus =
    input.receipt.verdict === "block"
      ? "blocked"
      : input.receipt.verdict === "allow"
        ? "accepted"
        : "pending";

  return buildUnifiedReceiptEnvelope({
    projectId: input.projectId,
    family: "project_policy",
    receiptVersion: input.receipt.version,
    receiptId: input.receipt.receiptId,
    producedAt: input.producedAt ?? input.receipt.generatedAt,
    receivedAt: input.receivedAt,
    workflow: input.workflow,
    producer: normalizeProducer({
      surface: "companion",
      ...input.producer,
    }),
    stage: "policy",
    status,
    subject: {
      title: input.subject?.title ?? `Project Policy ${input.receipt.verdict}`,
      summary: input.subject?.summary ?? `Policy verdict: ${input.receipt.verdict}`,
      changedFiles: input.subject?.changedFiles ?? [],
      commands: input.subject?.commands ?? [],
    },
    links: {},
    reasonCodes: input.receipt.reasonCodes,
    evidenceRefs: input.receipt.ruleRefs,
    review: input.review ?? {
      reviewStatus: input.receipt.verdict === "allow" ? "accepted" : "pending",
    },
    payload: input.receipt,
    caveats: [
      "Project Policy receipts are authoritative gates; historical outcomes cannot override blocks.",
    ],
  });
}

export function outcomeReceiptToUnifiedEnvelope(
  input: OutcomeUnifiedReceiptInput
): UnifiedReceiptEnvelope<OutcomeIntelligenceReceipt> {
  const receipt = input.receipt;
  return buildUnifiedReceiptEnvelope({
    projectId: input.projectId,
    family: "outcome_intelligence",
    receiptVersion: receipt.version,
    receiptId: receipt.receiptId,
    producedAt: input.producedAt ?? receipt.generatedAt,
    receivedAt: input.receivedAt,
    workflow: {
      workflowFingerprint: receipt.taskProfile.workflowFingerprint,
      sessionId: receipt.taskProfile.sessionId,
      ...input.workflow,
    },
    producer: normalizeProducer({
      surface: "api",
      ...input.producer,
    }),
    stage: "outcome",
    status: mapOutcomeStatus(receipt.outcome.status),
    subject: {
      title: receipt.decision.summary,
      summary: receipt.outcome.summary,
      sourceRef: receipt.sourceRef,
      changedFiles: receipt.taskProfile.changedFiles,
      commands: receipt.verification.evidence.flatMap((item) =>
        item.command ? [item.command] : []
      ),
    },
    links: {},
    reasonCodes: receipt.decision.reasonCodes,
    evidenceRefs: receipt.verification.evidence.map((item) => `${item.source}:${item.label}`),
    review: { reviewStatus: input.reviewStatus ?? "pending" },
    payload: receipt,
    caveats: receipt.caveats,
  });
}

export function controlledWorkerExecutionReceiptToUnifiedEnvelope(
  input: ControlledWorkerUnifiedReceiptInput
): UnifiedReceiptEnvelope<ControlledWorkerExecutionReceipt> {
  const receipt = input.receipt;
  return buildUnifiedReceiptEnvelope({
    projectId: input.projectId,
    family: "controlled_worker_execution",
    receiptVersion: receipt.version,
    receiptId: receipt.receiptId,
    producedAt: input.producedAt ?? receipt.generatedAt,
    receivedAt: input.receivedAt,
    workflow: {
      workerId: receipt.worker.id,
      ...input.workflow,
    },
    producer: normalizeProducer({
      surface: "companion",
      workerId: receipt.worker.id,
      ...input.producer,
    }),
    stage:
      receipt.status === "verification_required" || receipt.contract.proofRequired.length > 0
        ? "proof"
        : "execution",
    status: mapControlledWorkerStatus(receipt.status),
    subject: {
      title: receipt.task,
      summary: `${receipt.mode}: ${receipt.status}`,
      changedFiles: receipt.contract.writeScope,
      commands: receipt.execution.command ? [receipt.execution.command] : [],
    },
    links: {
      approvalReceiptId: receipt.contract.approvalReceiptId ?? undefined,
      outcomeReceiptId: receipt.contract.outcomeReceiptId ?? undefined,
      proofReceiptIds: receipt.contract.proofRequired,
    },
    reasonCodes: receipt.reasonCodes,
    proofRefs: receipt.contract.proofRequired,
    review: { reviewStatus: receipt.status === "planned" ? "pending" : "not_required" },
    payload: receipt,
    caveats: receipt.caveats,
  });
}

export function normalizeUnifiedReceiptStatus(value: unknown): UnifiedReceiptStatus {
  if (
    value === "pending" ||
    value === "accepted" ||
    value === "rejected" ||
    value === "blocked" ||
    value === "failed" ||
    value === "succeeded" ||
    value === "partial" ||
    value === "unknown"
  ) {
    return value;
  }
  return "unknown";
}

function mapOutcomeStatus(
  status: OutcomeIntelligenceReceipt["outcome"]["status"]
): UnifiedReceiptStatus {
  if (status === "success") return "succeeded";
  if (status === "failure") return "failed";
  if (status === "blocked") return "blocked";
  if (status === "partial") return "partial";
  return "unknown";
}

function mapControlledWorkerStatus(
  status: ControlledWorkerExecutionReceipt["status"]
): UnifiedReceiptStatus {
  if (status === "executed") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "blocked") return "blocked";
  if (status === "planned" || status === "verification_required") return "pending";
  return "unknown";
}

function normalizeProducer(
  producer: UnifiedReceiptProducer | Partial<UnifiedReceiptProducer>
): UnifiedReceiptProducer {
  return {
    surface: producer.surface ?? "import",
    ...(compactText(producer.command, 1_000)
      ? { command: compactText(producer.command, 1_000) }
      : {}),
    ...(compactText(producer.tool, 180) ? { tool: compactText(producer.tool, 180) } : {}),
    ...(compactText(producer.client, 180) ? { client: compactText(producer.client, 180) } : {}),
    ...(compactText(producer.agentId, 180) ? { agentId: compactText(producer.agentId, 180) } : {}),
    ...(compactText(producer.workerId, 180)
      ? { workerId: compactText(producer.workerId, 180) }
      : {}),
  };
}

function normalizeWorkflow(workflow: UnifiedWorkflowIdentity | undefined): UnifiedWorkflowIdentity {
  if (!workflow) return {};
  return {
    ...(compactText(workflow.workflowId, 180)
      ? { workflowId: compactText(workflow.workflowId, 180) }
      : {}),
    ...(compactText(workflow.workflowFingerprint, 400)
      ? { workflowFingerprint: compactText(workflow.workflowFingerprint, 400) }
      : {}),
    ...(compactText(workflow.phaseId, 180) ? { phaseId: compactText(workflow.phaseId, 180) } : {}),
    ...(compactText(workflow.workPackageId, 180)
      ? { workPackageId: compactText(workflow.workPackageId, 180) }
      : {}),
    ...(compactText(workflow.htaskId, 180) ? { htaskId: compactText(workflow.htaskId, 180) } : {}),
    ...(compactText(workflow.sessionId, 180)
      ? { sessionId: compactText(workflow.sessionId, 180) }
      : {}),
    ...(compactText(workflow.swarmId, 180) ? { swarmId: compactText(workflow.swarmId, 180) } : {}),
    ...(compactText(workflow.checkoutId, 180)
      ? { checkoutId: compactText(workflow.checkoutId, 180) }
      : {}),
    ...(compactText(workflow.workerId, 180)
      ? { workerId: compactText(workflow.workerId, 180) }
      : {}),
    ...(compactText(workflow.branch, 240) ? { branch: compactText(workflow.branch, 240) } : {}),
    ...(compactText(workflow.baseSha, 80) ? { baseSha: compactText(workflow.baseSha, 80) } : {}),
    ...(compactText(workflow.headSha, 80) ? { headSha: compactText(workflow.headSha, 80) } : {}),
  };
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
    const normalized = compactText(value, 1_000);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
