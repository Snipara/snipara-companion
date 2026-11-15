/**
 * Local worker routing: the runtime catalog and the eligibility resolver.
 *
 * Companion used to obtain both by shelling out to `snipara-orchestrator`
 * (`local-model-catalog --json` and `route --dry-run --json`). They are ported
 * here so Companion no longer needs the Orchestrator package
 * (docs/planning/orchestrator-fold-20261115/PLAN.md). The behaviour is held to
 * the Python implementation of snipara-orchestrator 2.0.0 by the parity
 * fixtures in `test/fixtures/local-worker-routing-parity.json`.
 *
 * The resolver rejects candidates that break a policy, capability or scope
 * ceiling and picks one deterministically. It does not score, rank by quality
 * or learn, and it never launches a worker: every resolution is a dry run whose
 * policy decision says whether a separate approval is required.
 */

type Json = Record<string, unknown>;

export const OPENAI_COMPATIBLE_API_PATHS = {
  models: "/v1/models",
  responses: "/v1/responses",
  chatCompletions: "/v1/chat/completions",
  completions: "/v1/completions",
  embeddings: "/v1/embeddings",
} as const;

export const DEFAULT_LOCAL_MODEL_BASE_URL = "http://127.0.0.1:1234";
export const DEFAULT_LOCAL_MODEL_PROVIDER = "lm-studio";
export const LOCAL_RUNTIME_CATALOG_SCHEMA = "snipara.orchestrator.runtime_catalog.v1";

const LARGE_CONTEXT_BUDGET_MIN_TOKENS = 64000;
const POLICY_DECISION_VERSION = "adaptive-routing-policy-decision-v0";
const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const KNOWN_CONTEXT_WINDOW_FIELD_NAMES = [
  "contextWindow",
  "context_window",
  "context-length",
  "context_length",
  "maxContext",
  "max_context",
  "max_tokens",
  "maxModelLen",
];

const LEVELS: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 1,
  small: 1,
  normal: 2,
  medium: 2,
  balanced: 2,
  high: 3,
  large: 3,
  premium: 4,
};

const RISK_LEVELS: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };

interface LocalWorkerProfileEntry {
  profileId: string;
  label: string;
  match?: string[];
  strengths: string[];
  structuredOutputFit: string;
  formatFailureRisk: string;
  timeoutRisk: string;
  notes: string[];
  reasoning: string;
}

const LOCAL_WORKER_PROFILE_LIBRARY: LocalWorkerProfileEntry[] = [
  {
    profileId: "local-gpt-oss-code-strict",
    label: "GPT-OSS strict code worker",
    match: ["gpt-oss"],
    strengths: ["code", "structured_output", "execution_safe"],
    structuredOutputFit: "high",
    formatFailureRisk: "low",
    timeoutRisk: "low",
    notes: ["Good default local coding route when deterministic output matters."],
    reasoning: "medium",
  },
  {
    profileId: "local-qwen3-coder-long-context",
    label: "Qwen coder long-context worker",
    match: ["qwen3-coder", "qwen/qwen3-coder", "qwen3-30b", "qwen3-30b-a3b"],
    strengths: ["code", "long_context", "repo_scan"],
    structuredOutputFit: "medium",
    formatFailureRisk: "high",
    timeoutRisk: "low",
    notes: ["Use when long-context repo exploration matters more than strict serialization."],
    reasoning: "high",
  },
  {
    profileId: "local-devstral-refactor",
    label: "Devstral refactor worker",
    match: ["devstral"],
    strengths: ["code", "refactor", "agentic_exploration"],
    structuredOutputFit: "medium",
    formatFailureRisk: "medium",
    timeoutRisk: "high",
    notes: ["Use for heavier refactors when chunking and checkpointing are available."],
    reasoning: "medium",
  },
];

const DEFAULT_LOCAL_WORKER_PROFILE: LocalWorkerProfileEntry = {
  profileId: "local-openai-compatible-generic",
  label: "Generic local OpenAI-compatible worker",
  strengths: ["code"],
  structuredOutputFit: "medium",
  formatFailureRisk: "medium",
  timeoutRisk: "medium",
  notes: ["No model-specific routing hints were inferred for this worker."],
  reasoning: "medium",
};

// ---------------------------------------------------------------------------
// Input normalisation. The Python models accept camelCase or snake_case keys,
// apply defaults, ignore unknown keys and drop null optionals on output.

function field(input: Json, camel: string, snake: string): unknown {
  if (camel in input) return input[camel];
  if (snake in input) return input[snake];
  return undefined;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function optStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function strList(value: unknown, fallback: string[] = []): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [...fallback];
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asRecord(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function withoutUndefined<T extends Json>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export interface WorkProfile {
  taskType: string;
  risk: string;
  scope: string[];
  contextBudget: string;
  reasoningDepth: string;
  evidenceRequirements: string[];
  preferredProfileStrengths: string[];
  notes: string[];
}

export function normalizeWorkProfile(input: unknown): WorkProfile {
  const raw = asRecord(input);
  return {
    taskType: str(field(raw, "taskType", "task_type"), "unknown"),
    risk: str(raw.risk, "medium"),
    scope: strList(raw.scope),
    contextBudget: str(field(raw, "contextBudget", "context_budget"), "medium"),
    reasoningDepth: str(field(raw, "reasoningDepth", "reasoning_depth"), "medium"),
    evidenceRequirements: strList(field(raw, "evidenceRequirements", "evidence_requirements")),
    preferredProfileStrengths: strList(
      field(raw, "preferredProfileStrengths", "preferred_profile_strengths")
    ),
    notes: strList(raw.notes),
  };
}

export interface ModelRequirements {
  workerRole: string;
  reasoning: string;
  plannerRetainsReasoning: boolean;
  speed: string;
  cost: string;
  contextBudget: string;
  capabilities: string[];
  forbiddenCapabilities: string[];
  writeScope: string[];
  structuredOutputRequired: boolean;
  preferredEndpointTypes: string[];
  allowedEndpointTypes: string[];
  privacyClass?: string;
  riskCeiling?: string;
  policyMode?: string;
  approvalRequired?: boolean;
  dailyBudgetCents?: number;
  monthlyBudgetCents?: number;
  fallback: string;
}

export function normalizeRequirements(input: unknown): ModelRequirements {
  const raw = asRecord(input);
  const approval = field(raw, "approvalRequired", "approval_required");
  const daily = field(raw, "dailyBudgetCents", "daily_budget_cents");
  const monthly = field(raw, "monthlyBudgetCents", "monthly_budget_cents");
  return withoutUndefined({
    workerRole: str(field(raw, "workerRole", "worker_role"), "execution"),
    reasoning: str(raw.reasoning, "medium"),
    plannerRetainsReasoning: bool(
      field(raw, "plannerRetainsReasoning", "planner_retains_reasoning"),
      false
    ),
    speed: str(raw.speed, "normal"),
    cost: str(raw.cost, "balanced"),
    contextBudget: str(field(raw, "contextBudget", "context_budget"), "medium"),
    capabilities: strList(raw.capabilities),
    forbiddenCapabilities: strList(field(raw, "forbiddenCapabilities", "forbidden_capabilities"), [
      "secrets",
    ]),
    writeScope: strList(field(raw, "writeScope", "write_scope")),
    structuredOutputRequired: bool(
      field(raw, "structuredOutputRequired", "structured_output_required"),
      false
    ),
    preferredEndpointTypes: strList(
      field(raw, "preferredEndpointTypes", "preferred_endpoint_types")
    ),
    allowedEndpointTypes: strList(field(raw, "allowedEndpointTypes", "allowed_endpoint_types")),
    privacyClass: optStr(field(raw, "privacyClass", "privacy_class")),
    riskCeiling: optStr(field(raw, "riskCeiling", "risk_ceiling")),
    policyMode: optStr(field(raw, "policyMode", "policy_mode")),
    approvalRequired: typeof approval === "boolean" ? approval : undefined,
    dailyBudgetCents: typeof daily === "number" ? daily : undefined,
    monthlyBudgetCents: typeof monthly === "number" ? monthly : undefined,
    fallback: str(raw.fallback, "main_agent"),
  }) as ModelRequirements;
}

export interface WorkerProfileHints {
  profileId: string;
  label?: string;
  strengths: string[];
  structuredOutputFit: string;
  formatFailureRisk: string;
  timeoutRisk: string;
  notes: string[];
}

function normalizeWorkerProfile(input: unknown): WorkerProfileHints | undefined {
  const raw = asRecord(input);
  const profileId = optStr(field(raw, "profileId", "profile_id"));
  if (!profileId) return undefined;
  return withoutUndefined({
    profileId,
    label: optStr(raw.label),
    strengths: strList(raw.strengths),
    structuredOutputFit: str(field(raw, "structuredOutputFit", "structured_output_fit"), "medium"),
    formatFailureRisk: str(field(raw, "formatFailureRisk", "format_failure_risk"), "medium"),
    timeoutRisk: str(field(raw, "timeoutRisk", "timeout_risk"), "medium"),
    notes: strList(raw.notes),
  }) as WorkerProfileHints;
}

export interface RuntimeWorkerCandidate {
  candidateId: string;
  workerClass: string;
  catalogSource: string;
  endpointType: string;
  workerRoles: string[];
  capabilities: string[];
  writeScope: string[];
  reasoning: string;
  speed: string;
  cost: string;
  contextBudget: string;
  isAvailable: boolean;
  requiresApiKey: boolean;
  workerProfileId?: string;
  workerProfile?: WorkerProfileHints;
}

interface CandidateWithMetadata {
  payload: RuntimeWorkerCandidate;
  metadata: Json;
}

function normalizeCandidate(input: unknown): CandidateWithMetadata {
  const raw = asRecord(input);
  const payload = withoutUndefined({
    candidateId: str(field(raw, "candidateId", "candidate_id"), ""),
    workerClass: str(field(raw, "workerClass", "worker_class"), ""),
    catalogSource: str(field(raw, "catalogSource", "catalog_source"), ""),
    endpointType: str(field(raw, "endpointType", "endpoint_type"), "cloud"),
    workerRoles: strList(field(raw, "workerRoles", "worker_roles"), ["execution"]),
    capabilities: strList(raw.capabilities),
    writeScope: strList(field(raw, "writeScope", "write_scope")),
    reasoning: str(raw.reasoning, "medium"),
    speed: str(raw.speed, "normal"),
    cost: str(raw.cost, "balanced"),
    contextBudget: str(field(raw, "contextBudget", "context_budget"), "medium"),
    isAvailable: bool(field(raw, "isAvailable", "is_available"), true),
    requiresApiKey: bool(field(raw, "requiresApiKey", "requires_api_key"), false),
    workerProfileId: optStr(field(raw, "workerProfileId", "worker_profile_id")),
    workerProfile: normalizeWorkerProfile(field(raw, "workerProfile", "worker_profile")),
  }) as RuntimeWorkerCandidate;
  return { payload, metadata: asRecord(raw.metadata) };
}

// ---------------------------------------------------------------------------
// The resolver.

export interface RoutingPolicyDecision {
  version: string;
  mode: string;
  executionAllowed: boolean;
  approvalRequired: boolean;
  approvalReceipt: string;
  reasonCodes: string[];
  caveats: string[];
  recommendedAction: string;
  guardrails: Json;
}

export interface RoutingResolution {
  status: "resolved" | "fallback";
  selected?: { candidate: RuntimeWorkerCandidate; reasons: string[] };
  routingCard: Json;
  policyDecision: RoutingPolicyDecision;
  evaluatedCount: number;
  rejectedCount: number;
  rejectedReasons: Record<string, string[]>;
  fallback: string;
  reasons: string[];
  warnings?: string[];
}

function level(value: string): number {
  return LEVELS[value.toLowerCase()] ?? 2;
}

function riskLevel(value: string): number {
  return RISK_LEVELS[value.toLowerCase()] ?? 2;
}

function normalizeScope(value: string): string {
  return String(value)
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part)
    .join("/");
}

function scopeHasTraversal(value: string): boolean {
  return value === ".." || value.startsWith("../") || `/${value}/`.includes("/../");
}

/** Escape a character-class chunk for a JavaScript `u`-mode class. */
function escapeClassChunk(chunk: string): string {
  // Python's `re` reads a leading `]` and an unescaped `-` its own way; a `u`-mode
  // JavaScript class needs `\\`, `]` and a literal `-` escaped.
  return chunk.replace(/[\\\]-]/g, "\\$&");
}

/**
 * Translate one `[...]` class the way Python's `fnmatch.translate` does (3.12):
 * a leading `!` negates, a `]` right after `[` or `[!` is literal, ranges whose
 * ends are reversed are dropped instead of raising, a trailing `-` is literal, an
 * empty class matches nothing and `[!]`-style empty negation matches anything.
 * `body` is the text between the brackets.
 */
function translateClass(body: string): string {
  let stuff: string;
  if (!body.includes("-")) {
    stuff = escapeClassChunk(body);
  } else {
    const chunks: string[] = [];
    let start = 0;
    let k = body.startsWith("!") ? 2 : 1;
    for (;;) {
      k = body.indexOf("-", k);
      if (k < 0) break;
      chunks.push(body.slice(start, k));
      start = k + 1;
      k += 3;
    }
    const last = body.slice(start);
    if (last) chunks.push(last);
    else chunks[chunks.length - 1] += "-";
    for (let index = chunks.length - 1; index > 0; index -= 1) {
      const previous = chunks[index - 1];
      if (previous[previous.length - 1] > chunks[index][0]) {
        chunks[index - 1] = previous.slice(0, -1) + chunks[index].slice(1);
        chunks.splice(index, 1);
      }
    }
    stuff = chunks.map(escapeClassChunk).join("-");
  }
  if (!stuff) return "(?!)";
  if (stuff === "!") return ".";
  if (stuff.startsWith("!")) stuff = `^${stuff.slice(1)}`;
  else if (stuff.startsWith("^") || stuff.startsWith("[")) stuff = `\\${stuff}`;
  return `[${stuff}]`;
}

/** Python `fnmatch.fnmatchcase` on POSIX: `*` crosses `/`, case-sensitive, full match. */
function fnmatch(name: string, pattern: string): boolean {
  let regex = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      regex += ".*";
    } else if (char === "?") {
      regex += ".";
    } else if (char === "[") {
      let j = i + 1;
      if (j < pattern.length && pattern[j] === "!") j += 1;
      if (j < pattern.length && pattern[j] === "]") j += 1;
      while (j < pattern.length && pattern[j] !== "]") j += 1;
      if (j >= pattern.length) {
        regex += "\\[";
      } else {
        regex += translateClass(pattern.slice(i + 1, j));
        i = j;
      }
    } else {
      // Outside a class, `u`-mode only accepts escapes of syntax characters and `/`;
      // escaping anything else (such as `-`) is a syntax error.
      regex += char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
  }
  try {
    return new RegExp(`^(?:${regex})$`, "su").test(name);
  } catch {
    // Python would have compiled it; refusing the scope is the safe reading.
    return false;
  }
}

function scopePatternMatches(requested: string, pattern: string): boolean {
  const normalizedPattern = normalizeScope(pattern);
  if (!normalizedPattern || scopeHasTraversal(normalizedPattern)) return false;
  if (normalizedPattern === "*" || normalizedPattern === "**") return true;
  if (requested === normalizedPattern) return true;
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3).replace(/\/+$/, "");
    return Boolean(prefix) && (requested === prefix || requested.startsWith(`${prefix}/`));
  }
  if (normalizedPattern.endsWith("/*")) {
    const prefix = normalizedPattern.slice(0, -2).replace(/\/+$/, "");
    const suffix = requested.startsWith(`${prefix}/`) ? requested.slice(prefix.length + 1) : "";
    return Boolean(prefix) && Boolean(suffix) && !suffix.includes("/");
  }
  return fnmatch(requested, normalizedPattern);
}

function writeScopeAllowed(requested: string[], allowed: string[]): boolean {
  if (requested.length === 0) return true;
  if (allowed.length === 0) return false;
  return requested.every((item) => {
    const normalizedRequested = normalizeScope(item);
    if (!normalizedRequested || scopeHasTraversal(normalizedRequested)) return false;
    return allowed.some((pattern) => scopePatternMatches(normalizedRequested, pattern));
  });
}

function hostnameOf(raw: string): { hostname: string; credentials: boolean } {
  try {
    const parsed = new URL(raw);
    return {
      hostname: parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
      credentials: Boolean(parsed.username || parsed.password),
    };
  } catch {
    return { hostname: "", credentials: false };
  }
}

function candidateEndpointIsLoopback(candidate: CandidateWithMetadata): boolean {
  const transport = asRecord(candidate.metadata.transport);
  if (String(transport.kind ?? "") === "cli") return true;
  const rawUrl = transport.baseUrl || candidate.metadata.baseUrl;
  if (typeof rawUrl !== "string" || !rawUrl) {
    return candidate.payload.catalogSource !== "worker_registry";
  }
  const { hostname, credentials } = hostnameOf(rawUrl);
  if (credentials) return false;
  return LOCAL_HOSTS.has(hostname);
}

function candidateReasons(
  candidate: CandidateWithMetadata,
  workProfile: WorkProfile,
  requirements: ModelRequirements
): [boolean, string[]] {
  const c = candidate.payload;
  if (!c.isAvailable) return [false, ["candidate is currently unavailable"]];
  const candidatePrivacy = String(candidate.metadata.privacyClass || "").toLowerCase();
  const requestedPrivacy = String(requirements.privacyClass || "").toLowerCase();
  if (requestedPrivacy && candidatePrivacy && candidatePrivacy !== requestedPrivacy) {
    return [false, [`candidate privacy class ${candidatePrivacy} does not match requirement`]];
  }
  const candidateRiskCeiling = String(candidate.metadata.riskCeiling || "critical").toLowerCase();
  const requestedRisk = String(
    requirements.riskCeiling || workProfile.risk || "medium"
  ).toLowerCase();
  if (riskLevel(requestedRisk) > riskLevel(candidateRiskCeiling)) {
    return [
      false,
      [`work risk ${requestedRisk} exceeds candidate ceiling ${candidateRiskCeiling}`],
    ];
  }
  if (c.endpointType === "local" && !candidateEndpointIsLoopback(candidate)) {
    return [false, ["local endpoint type does not resolve to a loopback HTTP endpoint"]];
  }
  if (
    requirements.allowedEndpointTypes.length > 0 &&
    !requirements.allowedEndpointTypes.includes(c.endpointType)
  ) {
    return [false, [`endpoint type ${c.endpointType} is not in allowed endpoint types`]];
  }
  if (!c.workerRoles.includes(requirements.workerRole)) {
    return [false, [`worker role ${requirements.workerRole} is not in candidate roles`]];
  }
  if (requirements.forbiddenCapabilities.some((item) => c.capabilities.includes(item))) {
    return [false, ["candidate advertises at least one forbidden capability"]];
  }
  const missing = [...new Set(requirements.capabilities)].filter(
    (item) => !c.capabilities.includes(item)
  );
  if (missing.length > 0) {
    return [false, [`missing required capabilities: ${missing.sort().join(", ")}`]];
  }
  if (!writeScopeAllowed(requirements.writeScope, c.writeScope)) {
    return [false, ["write scope is not allowed by candidate catalog"]];
  }
  if (level(c.contextBudget) < level(requirements.contextBudget)) {
    return [false, ["candidate context budget is below required context budget"]];
  }
  if (!requirements.plannerRetainsReasoning && level(c.reasoning) < level(requirements.reasoning)) {
    return [
      false,
      [`candidate reasoning '${c.reasoning}' is below required '${requirements.reasoning}'`],
    ];
  }

  const reasons = [
    `worker role ${requirements.workerRole} is supported`,
    "required capabilities are present",
    "write scope is allowed",
  ];
  if (requirements.plannerRetainsReasoning) {
    reasons.push("planner retains deep reasoning for this work package");
  }
  if (requirements.preferredEndpointTypes.includes(c.endpointType)) {
    reasons.push(`preferred endpoint type ${c.endpointType} matched`);
  }
  if (c.workerProfileId) {
    reasons.push(`worker profile ${c.workerProfileId} is available`);
  }
  if (c.workerProfile) {
    const preferred = new Set(workProfile.preferredProfileStrengths);
    const matched = [
      ...new Set(c.workerProfile.strengths.filter((item) => preferred.has(item))),
    ].sort();
    if (matched.length > 0) {
      reasons.push(`matched preferred profile strengths: ${matched.join(", ")}`);
    }
    if (requirements.structuredOutputRequired) {
      reasons.push(`structured output fit is ${c.workerProfile.structuredOutputFit}`);
    }
  }
  return [true, reasons];
}

function policyDecision(
  workProfile: WorkProfile,
  requirements: ModelRequirements,
  selected: boolean
): RoutingPolicyDecision {
  const normalizedMode = String(requirements.policyMode || "approval_required")
    .trim()
    .toLowerCase();
  const mode = ["dry_run", "approval_required", "auto_low_risk"].includes(normalizedMode)
    ? normalizedMode
    : "approval_required";
  const explicitApprovalRequired = requirements.approvalRequired !== false;
  const lowRisk = String(workProfile.risk || "medium").toLowerCase() === "low";
  const reasonCodes = new Set(["adaptive_routing_policy_decision"]);
  const caveats = [
    "Adaptive Work Routing policy decisions do not silently spawn workers.",
    "Raw savings do not qualify a route for automatic delegation without accepted outcomes.",
  ].sort();
  const guardrails = {
    plannerRetainsReasoning: true,
    explicitHandoffRequired: true,
    rawSavingsNotSufficient: true,
    failClosedFallback: "main_agent",
  };
  const decision = (
    fields: Omit<RoutingPolicyDecision, "version" | "caveats" | "guardrails" | "reasonCodes">
  ) => ({
    version: POLICY_DECISION_VERSION,
    ...fields,
    reasonCodes: [...reasonCodes].sort(),
    caveats,
    guardrails,
  });

  if (!selected) {
    reasonCodes.add("adaptive_routing_dry_run");
    return decision({
      mode: "dry_run",
      executionAllowed: false,
      approvalRequired: false,
      approvalReceipt: "not_applicable",
      recommendedAction: "Fail closed to the main agent until a runtime candidate resolves.",
    });
  }
  if (mode === "auto_low_risk" && !explicitApprovalRequired && lowRisk) {
    reasonCodes.add("adaptive_routing_auto_low_risk");
    return decision({
      mode: "auto_low_risk",
      executionAllowed: true,
      approvalRequired: false,
      approvalReceipt: "not_required",
      recommendedAction:
        "Low-risk routing can proceed through an explicit worker handoff without a separate approval receipt.",
    });
  }
  reasonCodes.add(
    explicitApprovalRequired || mode === "approval_required"
      ? "adaptive_routing_approval_required"
      : "adaptive_routing_risk_requires_approval"
  );
  return decision({
    mode: "approval_required",
    executionAllowed: false,
    approvalRequired: true,
    approvalReceipt: "required",
    recommendedAction: "Collect a direct MCP approval receipt before delegated execution.",
  });
}

/**
 * Resolve provider-neutral requirements against runtime candidates.
 * Mirrors `DynamicModelResolver.resolve(...).to_payload()`.
 */
export function resolveWorkerCandidates(input: {
  workProfile?: unknown;
  requirements?: unknown;
  candidates?: unknown[];
}): RoutingResolution {
  const workProfile = normalizeWorkProfile(input.workProfile);
  const requirements = normalizeRequirements(input.requirements);
  const candidates = (input.candidates ?? []).map(normalizeCandidate);
  const routingCard: Json = {
    mode: "dry_run",
    workProfile,
    requirements,
    humanApprovalRequired: true,
    fallback: requirements.fallback,
    rejectedReasons: {},
    reasons: [],
    warnings: [],
  };

  const fallback = (
    reason: string,
    evaluatedCount: number,
    rejectedCount: number,
    rejectedReasons: Record<string, string[]>
  ): RoutingResolution => {
    routingCard.warnings = [reason];
    routingCard.rejectedReasons = rejectedReasons;
    return {
      status: "fallback",
      routingCard,
      policyDecision: policyDecision(workProfile, requirements, false),
      evaluatedCount,
      rejectedCount,
      rejectedReasons,
      fallback: requirements.fallback,
      reasons: [reason],
      warnings: [`Failing closed to ${requirements.fallback}.`],
    };
  };

  if (candidates.length === 0) {
    return fallback("runtime catalog returned no worker candidates", 0, 0, {});
  }

  const eligible: Array<{ candidate: CandidateWithMetadata; reasons: string[] }> = [];
  const rejectedReasons: Record<string, string[]> = {};
  let rejectedCount = 0;
  for (const candidate of candidates) {
    const [accepted, reasons] = candidateReasons(candidate, workProfile, requirements);
    if (!accepted) {
      rejectedCount += 1;
      rejectedReasons[candidate.payload.candidateId] = reasons;
      continue;
    }
    eligible.push({ candidate, reasons });
  }
  if (eligible.length === 0) {
    return fallback(
      "no runtime catalog candidate satisfied the requirements",
      candidates.length,
      rejectedCount,
      rejectedReasons
    );
  }

  // Deterministic choice: preferred endpoint types first, then candidate id.
  const notPreferred = (item: (typeof eligible)[number]) =>
    requirements.preferredEndpointTypes.includes(item.candidate.payload.endpointType) ? 0 : 1;
  const selected = eligible.reduce((best, item) => {
    const byPreference = notPreferred(item) - notPreferred(best);
    if (byPreference !== 0) return byPreference < 0 ? item : best;
    return item.candidate.payload.candidateId < best.candidate.payload.candidateId ? item : best;
  });

  const warnings: string[] = [];
  const profile = selected.candidate.payload.workerProfile;
  if (selected.candidate.payload.endpointType === "local" && requirements.plannerRetainsReasoning) {
    warnings.push(
      "Selected local worker because the planner retains deep reasoning and work is scoped."
    );
  }
  if (profile && profile.timeoutRisk === "high") {
    warnings.push(
      "Selected worker profile has high timeout risk; keep execution chunked and checkpointed."
    );
  }
  if (requirements.structuredOutputRequired && profile && profile.formatFailureRisk === "high") {
    warnings.push(
      "Selected worker profile has high format-failure risk for strict structured output."
    );
  }

  const decision = policyDecision(workProfile, requirements, true);
  Object.assign(routingCard, {
    recommendedWorkerClass: selected.candidate.payload.workerClass,
    costEstimate: { currency: "USD", confidence: "low" },
    humanApprovalRequired: decision.approvalRequired,
    rejectedReasons,
    reasons: selected.reasons,
    warnings,
  });
  const resolution: RoutingResolution = {
    status: "resolved",
    selected: { candidate: selected.candidate.payload, reasons: selected.reasons },
    routingCard,
    policyDecision: decision,
    evaluatedCount: candidates.length,
    rejectedCount,
    rejectedReasons,
    fallback: requirements.fallback,
    reasons: selected.reasons,
  };
  if (warnings.length > 0) resolution.warnings = warnings;
  return resolution;
}

// ---------------------------------------------------------------------------
// The local runtime catalog for an OpenAI-compatible model server.

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

function positiveInteger(value: unknown, strictDigits: boolean): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value > 0 ? value : undefined;
  if (typeof value === "string") {
    const pattern = strictDigits ? /^\d+$/ : /^\s*[+-]?\d+\s*$/;
    if (!pattern.test(value)) return undefined;
    const parsed = Number.parseInt(value, 10);
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

export interface LocalModelRecord {
  id: string;
  contextWindow?: number;
}

function coerceModelRecord(value: unknown): LocalModelRecord | undefined {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id } : undefined;
  }
  const raw = asRecord(value);
  const id = stringValue(raw.id);
  if (!id) return undefined;
  const record: LocalModelRecord = { id };
  for (const key of KNOWN_CONTEXT_WINDOW_FIELD_NAMES) {
    if (key in raw) {
      const contextWindow = positiveInteger(raw[key], true);
      if (contextWindow) {
        record.contextWindow = contextWindow;
        break;
      }
    }
  }
  return record;
}

export function coerceModelRecords(values: unknown[]): LocalModelRecord[] {
  return values
    .map(coerceModelRecord)
    .filter((record): record is LocalModelRecord => Boolean(record));
}

export function isGenerativeModelId(modelId: string): boolean {
  const lowered = modelId.toLowerCase();
  return !["embed", "embedding", "rerank"].some((token) => lowered.includes(token));
}

export function sanitizeCandidateId(value: string): string {
  let sanitized = "";
  for (const char of value.toLowerCase()) {
    if (/^[\p{L}\p{N}]$/u.test(char)) sanitized += char;
    else if (".-_/:".includes(char)) sanitized += "-";
  }
  return sanitized.replace(/^-+|-+$/g, "") || "local-model";
}

export function validateOpenAICompatibleUrl(baseUrl: string, allowRemote = false): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("OpenAI-compatible endpoint must be an HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error("OpenAI-compatible endpoint must be an HTTP(S) URL.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Credentials are forbidden in worker endpoint URLs.");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!allowRemote && !LOCAL_HOSTS.has(hostname)) {
    throw new Error("Remote OpenAI-compatible endpoints require explicit allow_remote.");
  }
  return trimmed;
}

export function defaultCapabilitiesForWorker(workerRole: string): string[] {
  if (workerRole === "coding") return ["code_edit"];
  if (workerRole === "testing") return ["test_generation"];
  if (workerRole === "review") return ["code_review"];
  return [];
}

function inferLocalWorkerProfile(model: string | undefined): LocalWorkerProfileEntry {
  const lowered = String(model ?? "").toLowerCase();
  const entry = LOCAL_WORKER_PROFILE_LIBRARY.find((item) =>
    (item.match ?? []).some((token) => lowered.includes(token))
  );
  const { match: _match, ...profile } = entry ?? DEFAULT_LOCAL_WORKER_PROFILE;
  return { ...profile, strengths: [...profile.strengths], notes: [...profile.notes] };
}

function chooseDefaultModel(modelIds: string[]): string | undefined {
  return modelIds
    .map(stringValue)
    .find((id): id is string => Boolean(id) && isGenerativeModelId(id!));
}

function choosePreferredModel(modelIds: string[], preferred: string): string | undefined {
  const lowered = preferred.toLowerCase();
  return modelIds
    .map(stringValue)
    .find((id): id is string => Boolean(id) && id!.toLowerCase().includes(lowered));
}

function resolveCatalogModels(
  model: string | undefined,
  records: LocalModelRecord[],
  emitAllModels: boolean
): LocalModelRecord[] {
  const generative = records.filter((record) => isGenerativeModelId(record.id));
  if (emitAllModels && generative.length > 0) return generative;
  if (model === undefined) return generative.length > 0 ? [generative[0]] : [{ id: "" }];
  const normalized = model.toLowerCase();
  const partial: LocalModelRecord[] = [];
  for (const candidate of generative) {
    const candidateModel = stringValue(candidate.id);
    if (!candidateModel) continue;
    if (candidateModel.toLowerCase() === normalized) return [candidate];
    if (candidateModel.toLowerCase().includes(normalized)) partial.push(candidate);
  }
  if (partial.length > 0) return partial.slice(0, 1);
  return [{ id: model }];
}

export interface LocalModelCatalogOptions {
  baseUrl?: string;
  provider?: string;
  model?: string;
  preferModel?: string;
  workerRole?: string;
  writeScope?: string[];
  capabilities?: string[];
  allModels?: boolean;
  apiKeyEnv?: string;
  apiKeyHeader?: "authorization" | "x-api-key";
  allowRemote?: boolean;
}

export interface LocalModelCatalog {
  schemaVersion: string;
  source: "openai_compatible_local";
  provider: string;
  baseUrl: string;
  models: string[];
  apiPaths: typeof OPENAI_COMPATIBLE_API_PATHS;
  candidates: RuntimeWorkerCandidate[];
  workerEndpoints: Record<string, Json>;
  workerProfiles: Record<string, WorkerProfileHints>;
}

/** The catalog for already-fetched `/v1/models` records. Mirrors `local-model-catalog --json`. */
export function buildLocalModelCatalogFromRecords(
  options: LocalModelCatalogOptions,
  rawRecords: unknown[]
): LocalModelCatalog {
  const baseUrl = validateOpenAICompatibleUrl(
    options.baseUrl ?? DEFAULT_LOCAL_MODEL_BASE_URL,
    options.allowRemote
  );
  const provider = options.provider ?? DEFAULT_LOCAL_MODEL_PROVIDER;
  const workerRole = options.workerRole ?? "coding";
  const apiKeyHeader = options.apiKeyHeader ?? "authorization";
  const records = coerceModelRecords(rawRecords);
  const modelIds = records.map((record) => record.id);

  let model = options.model || undefined;
  if (!model) {
    if (options.preferModel) {
      model = choosePreferredModel(modelIds, options.preferModel);
      if (!model) {
        throw new Error(
          `No /v1/models entry matched --prefer-model '${options.preferModel}'. Available models: ${modelIds.join(", ") || "none"}`
        );
      }
    } else {
      model = chooseDefaultModel(modelIds);
    }
  }
  const capabilities = options.capabilities ?? defaultCapabilitiesForWorker(workerRole);

  const candidates: RuntimeWorkerCandidate[] = [];
  const workerEndpoints: Record<string, Json> = {};
  const workerProfiles: Record<string, WorkerProfileHints> = {};
  for (const catalogModel of resolveCatalogModels(model, records, options.allModels ?? false)) {
    const catalogModelId = stringValue(catalogModel.id);
    const contextWindow = positiveInteger(catalogModel.contextWindow, false);
    const profile = inferLocalWorkerProfile(catalogModelId);
    const parts = [sanitizeCandidateId(provider), sanitizeCandidateId(baseUrl)];
    if (catalogModelId) parts.push(sanitizeCandidateId(catalogModelId));
    const candidateId = parts.join(":");
    const workerProfile = normalizeWorkerProfile(profile) as WorkerProfileHints;
    candidates.push({
      candidateId,
      workerClass: workerRole,
      catalogSource: "openai_compatible_local",
      endpointType: "local",
      workerRoles: [workerRole],
      capabilities: [...capabilities],
      writeScope: [...(options.writeScope ?? [])],
      reasoning: profile.reasoning,
      speed: "normal",
      cost: "minimal",
      contextBudget:
        contextWindow === undefined
          ? "medium"
          : contextWindow >= LARGE_CONTEXT_BUDGET_MIN_TOKENS
            ? "large"
            : "medium",
      isAvailable: true,
      requiresApiKey: Boolean(options.apiKeyEnv),
      workerProfileId: profile.profileId,
      workerProfile,
    });
    // A plain record, not a model: an unselected model is an explicit null.
    workerEndpoints[candidateId] = {
      provider,
      baseUrl,
      model: catalogModelId ?? null,
      apiPaths: OPENAI_COMPATIBLE_API_PATHS,
      ...(options.apiKeyEnv ? { apiKeyEnv: options.apiKeyEnv, apiKeyHeader } : {}),
      workerProfileId: profile.profileId,
      ...(contextWindow ? { contextWindow } : {}),
    };
    workerProfiles[profile.profileId] = workerProfile;
  }
  return {
    schemaVersion: LOCAL_RUNTIME_CATALOG_SCHEMA,
    source: "openai_compatible_local",
    provider,
    baseUrl,
    models: modelIds.length > 0 ? modelIds : model ? [model] : [],
    apiPaths: OPENAI_COMPATIBLE_API_PATHS,
    candidates,
    workerEndpoints,
    workerProfiles,
  };
}

export function resolveProviderApiKey(apiKeyEnv: string | undefined): string | undefined {
  if (!apiKeyEnv) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new Error("Provider API key env name must be a shell-safe variable name.");
  }
  const value = process.env[apiKeyEnv];
  if (!value) throw new Error(`Provider API key environment variable is not set: ${apiKeyEnv}`);
  return value;
}

export async function fetchOpenAICompatibleModels(
  baseUrl: string,
  options: {
    apiKey?: string;
    apiKeyHeader?: "authorization" | "x-api-key";
    timeoutMs?: number;
  } = {}
): Promise<LocalModelRecord[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}${OPENAI_COMPATIBLE_API_PATHS.models}`;
  const headers: Record<string, string> = {};
  if (options.apiKey) {
    if ((options.apiKeyHeader ?? "authorization").toLowerCase() === "x-api-key")
      headers["X-API-Key"] = options.apiKey;
    else headers.Authorization = `Bearer ${options.apiKey}`;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  let payload: unknown;
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    payload = (await response.json()) as unknown;
  } finally {
    clearTimeout(timeoutId);
  }
  const models = asRecord(payload).data;
  return Array.isArray(models) ? coerceModelRecords(models) : [];
}

/** Probe an OpenAI-compatible server and build its runtime catalog. */
export async function buildLocalModelCatalog(
  options: LocalModelCatalogOptions
): Promise<LocalModelCatalog> {
  const baseUrl = validateOpenAICompatibleUrl(
    options.baseUrl ?? DEFAULT_LOCAL_MODEL_BASE_URL,
    options.allowRemote
  );
  const apiKey = resolveProviderApiKey(options.apiKeyEnv);
  let records: LocalModelRecord[];
  try {
    records = await fetchOpenAICompatibleModels(baseUrl, {
      apiKey,
      apiKeyHeader: options.apiKeyHeader,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${baseUrl}/v1/models: ${message}`);
  }
  return buildLocalModelCatalogFromRecords({ ...options, baseUrl }, records);
}
