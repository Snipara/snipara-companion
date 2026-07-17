import { hashDecisionJsonValue } from "./decision-request";

export const HOST_NATIVE_RUN_VERSION = "snipara.host_native_run.v1" as const;

export const HOST_NATIVE_ADAPTER_KINDS = [
  "codex_app_server",
  "claude_cli",
  "openai_compatible",
  "claude_managed_agents",
] as const;

export const HOST_NATIVE_RUN_STATES = [
  "planned",
  "starting",
  "running",
  "waiting_for_approval",
  "steering",
  "cancelling",
  "interrupted",
  "completed",
  "failed",
  "timed_out",
] as const;

export type HostNativeAdapterKind = (typeof HOST_NATIVE_ADAPTER_KINDS)[number];
export type HostNativeRunState = (typeof HOST_NATIVE_RUN_STATES)[number];
export type HostNativeSteerMode =
  | "append_in_flight"
  | "interrupt_and_replace"
  | "queue_next"
  | "unsupported";

export interface HostNativeCapabilities {
  inFlightSteer: boolean;
  queuedMessages: boolean;
  durableResume: boolean;
  targetedChildControl: boolean;
  approvalEvents: boolean;
  nestedAgents: boolean;
  providerArtifactApi: boolean;
  providerSandbox: boolean;
}

export interface HostNativeDiscovery {
  adapter: HostNativeAdapterKind;
  available: boolean;
  executable?: string;
  version?: string;
  protocol: string;
  capabilities: HostNativeCapabilities;
  reasonCodes: string[];
}

export interface HostNativeWorkPackage {
  task: string;
  workspaceRoot: string;
  writeScope: string[];
  acceptanceCriteria: string[];
  proofRequired: string[];
  timeoutSeconds: number;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface HostNativeRunRecord {
  schemaVersion: typeof HOST_NATIVE_RUN_VERSION;
  runId: string;
  adapter: HostNativeAdapterKind;
  state: HostNativeRunState;
  createdAt: string;
  updatedAt: string;
  providerSessionId: string | null;
  providerTurnId: string | null;
  workspaceRoot: string;
  workPackage: Omit<HostNativeWorkPackage, "workspaceRoot">;
  commandPreview: string[];
  metrics: {
    durationMs: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    totalCostUsd: number | null;
  };
  evidence: {
    outputPreview: string | null;
    errorPreview: string | null;
    artifactRefs: string[];
    proofRefs: string[];
  };
  reasonCodes: string[];
  caveats: string[];
}

export interface BuildHostNativeRunRecordInput {
  adapter: HostNativeAdapterKind;
  state?: HostNativeRunState;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  providerSessionId?: string | null;
  providerTurnId?: string | null;
  workPackage: HostNativeWorkPackage;
  commandPreview?: string[];
  durationMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalCostUsd?: number | null;
  output?: string | null;
  error?: string | null;
  artifactRefs?: string[];
  proofRefs?: string[];
  reasonCodes?: string[];
}

export function buildHostNativeRunRecord(
  input: BuildHostNativeRunRecordInput
): HostNativeRunRecord {
  const createdAt = isoTimestamp(input.createdAt);
  const updatedAt = isoTimestamp(input.updatedAt ?? input.createdAt);
  const task = compactText(input.workPackage.task, 1_000) || "Bounded host-native task";
  const workspaceRoot = input.workPackage.workspaceRoot.trim();
  if (!workspaceRoot) throw new Error("Host-native work package needs a workspace root.");
  const writeScope = uniqueStrings(input.workPackage.writeScope);
  const acceptanceCriteria = uniqueStrings(input.workPackage.acceptanceCriteria);
  const proofRequired = uniqueStrings(input.workPackage.proofRequired);
  const runFingerprint = hashDecisionJsonValue({
    adapter: input.adapter,
    task,
    workspaceRoot,
    writeScope,
    createdAt,
  }).replace(/^sha256:/, "");
  return {
    schemaVersion: HOST_NATIVE_RUN_VERSION,
    runId: `host-run-${runFingerprint.slice(0, 16)}`,
    adapter: input.adapter,
    state: input.state ?? "planned",
    createdAt,
    updatedAt,
    providerSessionId: compactText(input.providerSessionId, 240) || null,
    providerTurnId: compactText(input.providerTurnId, 240) || null,
    workspaceRoot,
    workPackage: {
      task,
      writeScope,
      acceptanceCriteria,
      proofRequired,
      timeoutSeconds: Math.max(1, Math.floor(input.workPackage.timeoutSeconds || 600)),
      ...(input.workPackage.metadata ? { metadata: input.workPackage.metadata } : {}),
    },
    commandPreview: uniqueStrings(input.commandPreview ?? []).map((part) => compactText(part, 240)),
    metrics: {
      durationMs: finiteNumber(input.durationMs),
      inputTokens: finiteNumber(input.inputTokens),
      outputTokens: finiteNumber(input.outputTokens),
      totalCostUsd: finiteNumber(input.totalCostUsd),
    },
    evidence: {
      outputPreview: compactText(input.output, 4_000) || null,
      errorPreview: compactText(input.error, 2_000) || null,
      artifactRefs: uniqueStrings(input.artifactRefs ?? []),
      proofRefs: uniqueStrings(input.proofRefs ?? []),
    },
    reasonCodes: uniqueStrings(["host_native_orchestration_v1", ...(input.reasonCodes ?? [])]),
    caveats: [
      "The native agent host remains authoritative for model execution and permissions.",
      "Persisted output is a bounded redacted preview, not a complete provider transcript.",
      "A completed run still requires the declared proof and review before promotion.",
    ],
  };
}

function isoTimestamp(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) return new Date(value).toISOString();
  return new Date().toISOString();
}

function compactText(value: string | null | undefined, maxLength: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
