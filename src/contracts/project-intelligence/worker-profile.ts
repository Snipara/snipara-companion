import { createHash } from "node:crypto";

export const WORKER_PROFILE_SCHEMA_VERSION =
  "snipara.worker_profile.v0" as const;

export const WORKER_PROFILE_V0_VERSION = WORKER_PROFILE_SCHEMA_VERSION;

export const WORKER_PROFILE_RISK_CEILINGS = [
  "low",
  "medium",
  "high",
  "critical",
] as const;
export const WORKER_PROFILE_PRIVACY_CLASSES = ["local", "cloud"] as const;
export const WORKER_PROFILE_KINDS = ["openai_http", "cli"] as const;

export type WorkerProfileRiskCeiling =
  (typeof WORKER_PROFILE_RISK_CEILINGS)[number];
export type WorkerProfilePrivacyClass =
  (typeof WORKER_PROFILE_PRIVACY_CLASSES)[number];
export type WorkerProfileTransportKind = (typeof WORKER_PROFILE_KINDS)[number];

export interface WorkerProfileOpenAITransport {
  kind: "openai_http";
  baseUrl: string;
  model?: string;
  preferModel?: string;
  provider?: string;
  apiKeyEnv?: string;
  apiKeyHeader?: "authorization" | "x-api-key";
}

export interface WorkerProfileCliTransport {
  kind: "cli";
  command: string;
  shell?: string;
  args?: string[];
}

export type WorkerProfileTransport =
  | WorkerProfileOpenAITransport
  | WorkerProfileCliTransport;

export interface WorkerProfileCapabilities {
  roles: string[];
  languages: string[];
  contextWindow: number;
  toolUse: boolean;
}

export interface WorkerProfileProbe {
  probedAt: string;
  source: "workers probe";
  modelsSeen: string[];
}

export interface WorkerProfileCeilings {
  writeScope: string[];
  riskCeiling: WorkerProfileRiskCeiling;
  privacyClass: WorkerProfilePrivacyClass;
}

export interface WorkerProfileHints {
  costTier?: "free" | "metered" | "premium";
  latencyTier?: "fast" | "balanced" | "batch";
}

export interface WorkerProfile {
  schemaVersion: typeof WORKER_PROFILE_SCHEMA_VERSION;
  workerId: string;
  label: string;
  transport: WorkerProfileTransport;
  capabilities: WorkerProfileCapabilities;
  ceilings: WorkerProfileCeilings;
  reasoning: "low" | "medium" | "high";
  hints?: WorkerProfileHints;
  probe?: WorkerProfileProbe;
  createdAt: string;
  updatedAt: string;
}

export interface BuildWorkerProfileInput {
  workerId: string;
  label?: string;
  transport: WorkerProfileTransport;
  capabilities?: Partial<WorkerProfileCapabilities>;
  ceilings?: Partial<WorkerProfileCeilings>;
  reasoning?: "low" | "medium" | "high";
  hints?: WorkerProfileHints;
  probe?: WorkerProfileProbe;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export const DEFAULT_WORKER_CONTEXT_WINDOW = 65536 as const;

export function normalizeWorkerProfile(value: unknown): WorkerProfile | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.schemaVersion !== WORKER_PROFILE_SCHEMA_VERSION) {
    return null;
  }

  const workerId = stringValue(value.workerId);
  const label = stringValue(value.label) ?? workerId;
  const transport = normalizeWorkerProfileTransport(value.transport);
  if (!workerId || !label || !transport) {
    return null;
  }

  const capabilities = normalizeWorkerProfileCapabilities(value.capabilities);
  if (!capabilities) {
    return null;
  }

  const ceilings = normalizeWorkerProfileCeilings(value.ceilings);
  if (!ceilings) {
    return null;
  }
  const normalizedHints = normalizeWorkerProfileHints(value.hints);
  const normalizedProbe = normalizeWorkerProfileProbe(value.probe);
  const reasoning = normalizeWorkerProfileReasoning(value.reasoning);

  return {
    schemaVersion: WORKER_PROFILE_SCHEMA_VERSION,
    workerId,
    label,
    transport,
    capabilities,
    ceilings,
    reasoning: reasoning || "medium",
    ...(normalizedHints ? { hints: normalizedHints } : undefined),
    ...(normalizedProbe ? { probe: normalizedProbe } : {}),
    createdAt: normalizeDateTime(value.createdAt) ?? new Date().toISOString(),
    updatedAt: normalizeDateTime(value.updatedAt) ?? new Date().toISOString(),
  };
}

export function buildWorkerProfile(
  input: BuildWorkerProfileInput,
): WorkerProfile {
  const now = new Date().toISOString();
  const workerId = normalizeWorkerId(stringValue(input.workerId) ?? "worker");
  const capabilities = normalizeWorkerProfileCapabilities(
    input.capabilities,
  ) ?? {
    roles: ["coding"],
    languages: ["typescript"],
    contextWindow: DEFAULT_WORKER_CONTEXT_WINDOW,
    toolUse: false,
  };
  const ceilings = normalizeWorkerProfileCeilings(input.ceilings) ?? {
    writeScope: [],
    riskCeiling: "low",
    privacyClass: "local",
  };
  const transport = normalizeWorkerProfileTransport(input.transport);
  if (!transport) {
    throw new Error("Invalid worker transport.");
  }
  const normalizedHints = normalizeWorkerProfileHints(input.hints);
  const reasoning = normalizeWorkerProfileReasoning(input.reasoning);

  return {
    schemaVersion: WORKER_PROFILE_SCHEMA_VERSION,
    workerId,
    label: stringValue(input.label) || workerId,
    transport,
    capabilities,
    ceilings,
    reasoning: reasoning || "medium",
    ...(normalizedHints ? { hints: normalizedHints } : undefined),
    ...(input.probe ? { probe: input.probe } : {}),
    createdAt: normalizeDateTime(input.createdAt) ?? now,
    updatedAt: normalizeDateTime(input.updatedAt) ?? now,
  };
}

export function inferWorkerReasoningFromModel(
  model: string | null | undefined,
): "low" | "medium" | "high" {
  const normalized = String(model ?? "").toLowerCase();
  if (!normalized) {
    return "medium";
  }

  if (
    normalized.includes("r1") ||
    normalized.includes("deepseek") ||
    normalized.includes("o3")
  ) {
    return "high";
  }

  if (/\b(7b|8b|mini|small|tiny|flash)\b/.test(normalized)) {
    return "low";
  }

  return "medium";
}

export function isWorkerProfile(value: unknown): value is WorkerProfile {
  return normalizeWorkerProfile(value) !== null;
}

export function stableWorkerProfileJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value), null, 2);
}

export function hashWorkerProfileContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeWorkerProfileTransport(
  value: unknown,
): WorkerProfileTransport | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = stringValue(value.kind);
  if (kind === "openai_http") {
    const baseUrl = normalizeHttpsUrl(value.baseUrl);
    if (!baseUrl) {
      return null;
    }
    return {
      kind: "openai_http",
      baseUrl,
      ...(stringValue(value.model) ? { model: stringValue(value.model) } : {}),
      ...(stringValue(value.preferModel)
        ? { preferModel: stringValue(value.preferModel) }
        : {}),
      ...(stringValue(value.provider)
        ? { provider: stringValue(value.provider) }
        : {}),
      ...(safeEnvironmentVariableName(value.apiKeyEnv)
        ? { apiKeyEnv: safeEnvironmentVariableName(value.apiKeyEnv) }
        : {}),
      ...(value.apiKeyHeader === "authorization" ||
      value.apiKeyHeader === "x-api-key"
        ? { apiKeyHeader: value.apiKeyHeader }
        : {}),
    };
  }
  if (kind === "cli") {
    const command = stringValue(value.command);
    if (!command) {
      return null;
    }
    return {
      kind: "cli",
      command,
      ...(stringValue(value.shell) ? { shell: stringValue(value.shell) } : {}),
      ...(Array.isArray(value.args)
        ? {
            args: (value.args as unknown[])
              .map((item) => stringValue(item))
              .filter((item): item is string => Boolean(item)),
          }
        : {}),
    };
  }
  return null;
}

function normalizeWorkerProfileCapabilities(
  value: unknown,
): WorkerProfileCapabilities | null {
  const normalized = {
    roles: normalizeStringList((value as { roles?: unknown })?.roles).map(
      (item) => item.trim(),
    ),
    languages: normalizeStringList(
      (value as { languages?: unknown })?.languages,
    ).map((item) => item.trim()),
    contextWindow: numberValue(
      (value as { contextWindow?: unknown })?.contextWindow,
    ),
    toolUse: booleanValue((value as { toolUse?: unknown })?.toolUse),
  };

  const roles = normalized.roles.length > 0 ? normalized.roles : ["coding"];
  const languages =
    normalized.languages.length > 0 ? normalized.languages : ["typescript"];
  const contextWindow =
    normalized.contextWindow && Number.isFinite(normalized.contextWindow)
      ? Math.max(128, normalized.contextWindow)
      : DEFAULT_WORKER_CONTEXT_WINDOW;

  return {
    roles,
    languages,
    contextWindow,
    toolUse: normalized.toolUse,
  };
}

function normalizeWorkerProfileCeilings(
  value: unknown,
): WorkerProfileCeilings | null {
  if (!isRecord(value)) {
    return {
      writeScope: [],
      riskCeiling: "low",
      privacyClass: "local",
    };
  }

  const writeScope = normalizeStringList(value.writeScope);
  const riskCeiling = normalizeWorkerProfileRiskCeiling(value.riskCeiling);
  const privacyClass = normalizeWorkerProfilePrivacyClass(value.privacyClass);
  if (!riskCeiling || !privacyClass) {
    return null;
  }

  return {
    writeScope,
    riskCeiling,
    privacyClass,
  };
}

function normalizeWorkerProfileHints(
  value: unknown,
): WorkerProfileHints | null {
  if (!isRecord(value)) {
    return null;
  }
  const costTier = stringValue(value.costTier);
  const latencyTier = stringValue(value.latencyTier);
  return {
    ...(costTier === "free" || costTier === "metered" || costTier === "premium"
      ? { costTier }
      : {}),
    ...(latencyTier === "fast" ||
    latencyTier === "balanced" ||
    latencyTier === "batch"
      ? { latencyTier }
      : {}),
  };
}

function normalizeWorkerProfileReasoning(
  value: unknown,
): "low" | "medium" | "high" | null {
  const raw = stringValue(value);
  if (!raw) {
    return null;
  }
  const lowered = raw.toLowerCase();
  return lowered === "low" || lowered === "medium" || lowered === "high"
    ? lowered
    : null;
}

function normalizeWorkerProfileProbe(
  value: unknown,
): WorkerProfileProbe | null {
  if (!isRecord(value)) {
    return null;
  }
  const probedAt = normalizeDateTime(value.probedAt);
  const source = stringValue(value.source);
  const modelsSeen = normalizeStringList(value.modelsSeen);
  if (!probedAt || source !== "workers probe") {
    return null;
  }
  return {
    probedAt,
    source: "workers probe",
    modelsSeen: uniqueStrings(modelsSeen),
  };
}

function normalizeWorkerProfileRiskCeiling(
  value: unknown,
): WorkerProfileRiskCeiling | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  return WORKER_PROFILE_RISK_CEILINGS.includes(raw as WorkerProfileRiskCeiling)
    ? (raw as WorkerProfileRiskCeiling)
    : undefined;
}

function normalizeWorkerProfilePrivacyClass(
  value: unknown,
): WorkerProfilePrivacyClass | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  return WORKER_PROFILE_PRIVACY_CLASSES.includes(
    raw as WorkerProfilePrivacyClass,
  )
    ? (raw as WorkerProfilePrivacyClass)
    : undefined;
}

function normalizeHttpsUrl(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) {
    return null;
  }
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  return raw.replace(/\/+$/, "");
}

function normalizeDateTime(value: unknown): string | undefined {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const raw = stringValue(value);
  if (!raw) {
    return undefined;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function normalizeWorkerId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.startsWith("local-")
    ? normalized
    : `local-${normalized || "worker"}`;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function normalizeStringList(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : value === undefined
      ? []
      : [value];
  return uniqueStrings(
    values.map(stringValue).filter((item): item is string => Boolean(item)),
  );
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function safeEnvironmentVariableName(value: unknown): string | undefined {
  const normalized = stringValue(value);
  return normalized && /^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)
    ? normalized
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object" && value.constructor === Object) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJsonValue(child)]),
    );
  }
  return value;
}
