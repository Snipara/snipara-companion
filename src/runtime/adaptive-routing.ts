/**
 * Adaptive work routing recommendation for `workflow run`.
 *
 * Builds the work profile, model requirements, routing card and local worker
 * resolution that `workflow run` reports. This used to share a module with the
 * handoff to snipara-orchestrator's frozen Controller, which left Companion with
 * it (docs/planning/orchestrator-fold-20261115/PLAN.md, phase 3).
 */

export interface AdaptiveWorkProfile {
  taskType: string;
  risk: string;
  scope: string[];
  contextBudget: string;
  reasoningDepth: string;
  evidenceRequirements?: string[];
  preferredProfileStrengths?: string[];
  notes?: string[];
}

export interface AdaptiveModelRequirements {
  workerRole: string;
  reasoning: string;
  plannerRetainsReasoning: boolean;
  speed: string;
  cost: string;
  contextBudget: string;
  capabilities: string[];
  forbiddenCapabilities: string[];
  writeScope: string[];
  structuredOutputRequired?: boolean;
  preferredEndpointTypes?: string[];
  allowedEndpointTypes?: string[];
  dailyBudgetCents?: number;
  monthlyBudgetCents?: number;
  fallback: "main_agent";
}

export interface AdaptiveRoutingCostEstimate {
  currency: "USD";
  confidence: "low" | "medium" | "high";
}

export interface AdaptiveRoutingCard {
  mode: "dry_run";
  workProfile: AdaptiveWorkProfile;
  requirements: AdaptiveModelRequirements;
  recommendedWorkerClass: string;
  costEstimate: AdaptiveRoutingCostEstimate;
  humanApprovalRequired: boolean;
  fallback: "main_agent";
  rejectedReasons?: Record<string, string[]>;
  reasons: string[];
  warnings: string[];
}

export interface AdaptiveRoutingGatewayStatus {
  source: "hosted_mcp" | "companion_local";
  success: boolean;
  resolutionStatus?: string;
  candidateCount: number;
  fallback?: string;
  warnings: string[];
}

export interface AdaptiveRoutingRuntimeCatalog {
  version?: string;
  source?: string;
  provider?: string;
  baseUrl?: string;
  models?: string[];
  apiPaths?: Record<string, unknown>;
  workerEndpoints?: Record<string, Record<string, unknown>>;
  workerProfiles?: Record<string, Record<string, unknown>>;
  candidates: Array<Record<string, unknown>>;
}

export interface AdaptiveRoutingResolution {
  status?: string;
  selected?: Record<string, unknown>;
  policyDecision?: Record<string, unknown>;
  evaluatedCount?: number;
  rejectedCount?: number;
  fallback?: string;
  reasons?: string[];
  warnings?: string[];
  rejectedReasons?: Record<string, string[]>;
}

export interface AdaptiveStrongRepairContract {
  enabled: boolean;
  maxAttempts: 1;
  finalAuthority: "strong_adapter";
  proofRequired: true;
  scopePreserved: true;
  fallback: "main_agent";
}

export interface AdaptiveWorkRoutingRecommendation {
  workProfile: AdaptiveWorkProfile;
  requirements: AdaptiveModelRequirements;
  routingCard: AdaptiveRoutingCard;
  gateway?: AdaptiveRoutingGatewayStatus;
  runtimeCatalog?: AdaptiveRoutingRuntimeCatalog;
  resolution?: AdaptiveRoutingResolution;
  strongRepair?: AdaptiveStrongRepairContract;
}

export interface AdaptiveWorkRoutingOptions {
  query: string;
  mode?: string;
  changedFiles?: string[];
  preferredEndpointTypes?: string[];
  allowedEndpointTypes?: string[];
  workerRole?: string;
  plannerRetainsReasoning?: boolean;
  preferredProfileStrengths?: string[];
  structuredOutputRequired?: boolean;
  dailyBudgetCents?: number;
  monthlyBudgetCents?: number;
  strongRepair?: boolean;
}

export function buildAdaptiveWorkRoutingRecommendation(
  options: AdaptiveWorkRoutingOptions
): AdaptiveWorkRoutingRecommendation {
  const changedFiles = normalizeStringList(options.changedFiles);
  const preferredEndpointTypes = normalizeEndpointTypes(options.preferredEndpointTypes);
  const allowedEndpointTypes = normalizeEndpointTypes(options.allowedEndpointTypes);
  const taskType = inferAdaptiveTaskType(options.query, changedFiles);
  const risk = inferAdaptiveRisk(options.query, changedFiles);
  const contextBudget = inferAdaptiveContextBudget(options.mode, risk, changedFiles);
  const reasoningDepth = inferAdaptiveReasoningDepth(risk, taskType);
  const workerRole = options.workerRole ?? inferAdaptiveWorkerRole(taskType);
  const plannerRetainsReasoning =
    options.plannerRetainsReasoning ?? preferredEndpointTypes.includes("local");
  const preferredProfileStrengths = normalizeProfileStrengths(
    options.preferredProfileStrengths ??
      inferAdaptivePreferredProfileStrengths(taskType, options.query, changedFiles, workerRole)
  );
  const capabilities = inferAdaptiveCapabilities(taskType, workerRole);
  const forbiddenCapabilities = risk === "high" ? ["secrets", "prod_write"] : ["secrets"];
  const structuredOutputRequired =
    options.structuredOutputRequired ??
    inferAdaptiveStructuredOutputRequirement(taskType, options.query, changedFiles, workerRole);
  const workProfile: AdaptiveWorkProfile = compactObject({
    taskType,
    risk,
    scope: changedFiles,
    contextBudget,
    reasoningDepth,
    evidenceRequirements: inferAdaptiveEvidenceRequirements(options.query, risk),
    preferredProfileStrengths,
    notes: [
      "Generated by snipara-companion as recommendation-only routing metadata.",
      "The worker must be resolved against a runtime catalog before execution.",
    ],
  });
  const requirements: AdaptiveModelRequirements = compactObject({
    workerRole,
    reasoning: reasoningDepth,
    plannerRetainsReasoning,
    speed: preferredEndpointTypes.includes("local") ? "high" : "normal",
    cost: preferredEndpointTypes.includes("local") ? "minimal" : "balanced",
    contextBudget,
    capabilities,
    forbiddenCapabilities,
    writeScope: changedFiles,
    structuredOutputRequired: structuredOutputRequired ? true : undefined,
    preferredEndpointTypes,
    allowedEndpointTypes,
    dailyBudgetCents: options.dailyBudgetCents,
    monthlyBudgetCents: options.monthlyBudgetCents,
    fallback: "main_agent" as const,
  });
  const warnings = [
    "Recommendation-only dry run; companion does not launch or claim workers.",
    "Declare local runtimes with `snipara-companion workers local add ...` before expecting a local worker route.",
    ...(preferredEndpointTypes.includes("local")
      ? ["Local endpoint preference requires a runtime catalog or gateway to confirm availability."]
      : []),
  ];
  const routingCard: AdaptiveRoutingCard = {
    mode: "dry_run",
    workProfile,
    requirements,
    recommendedWorkerClass: workerRole,
    costEstimate: {
      currency: "USD",
      confidence: "low",
    },
    humanApprovalRequired: true,
    fallback: "main_agent",
    reasons: [
      `task profile classified as ${taskType}`,
      `worker role ${workerRole} is suggested from task shape`,
      plannerRetainsReasoning
        ? "planner retains reasoning while worker executes scoped work"
        : "worker must satisfy reasoning requirement directly",
      "runtime catalog resolution happens before any delegated execution",
    ],
    warnings,
  };

  return {
    workProfile,
    requirements,
    routingCard,
    ...(options.strongRepair
      ? {
          strongRepair: {
            enabled: true,
            maxAttempts: 1,
            finalAuthority: "strong_adapter",
            proofRequired: true,
            scopePreserved: true,
            fallback: "main_agent",
          },
        }
      : {}),
  };
}

function inferAdaptiveTaskType(query: string, changedFiles: string[]): string {
  const normalizedQuery = query.toLowerCase();
  if (
    /\b(doc|docs|documentation|readme|changelog|guide|manual)\b/i.test(query) ||
    changedFiles.some((file) => /(^|\/)(docs|documentation)\//.test(file) || /\.mdx?$/i.test(file))
  ) {
    return "documentation";
  }
  if (/\b(test|tests|pytest|unit|integration|e2e|smoke|verify|verification)\b/i.test(query)) {
    return "tests";
  }
  if (/\b(release|deploy|deployment|production|prod|rollout)\b/i.test(query)) {
    return "release";
  }
  if (/\b(schema|migration|database|prisma|auth|billing|secret|credential)\b/i.test(query)) {
    return "critical_code";
  }
  if (
    /\b(code|coding|implement|fix|refactor|patch|edit)\b/i.test(query) ||
    changedFiles.some((file) => /\.(ts|tsx|js|jsx|py|go|rs|java|kt|swift|rb|php)$/i.test(file))
  ) {
    return "coding";
  }
  return normalizedQuery.trim() ? "general" : "unknown";
}

function inferAdaptiveRisk(query: string, changedFiles: string[]): string {
  if (
    /\b(prod|production|deploy|release|migration|schema|database|prisma|auth|billing|secret|credential|security)\b/i.test(
      query
    ) ||
    changedFiles.some((file) =>
      /(schema\.prisma|migration|auth|billing|secret|credential|security|deploy)/i.test(file)
    )
  ) {
    return "high";
  }
  if (
    changedFiles.length > 5 ||
    changedFiles.some((file) => /\.(ts|tsx|js|jsx|py|go|rs|java)$/i.test(file))
  ) {
    return "medium";
  }
  return "low";
}

function inferAdaptiveContextBudget(
  mode: string | undefined,
  risk: string,
  changedFiles: string[]
): string {
  if (mode === "full" || mode === "orchestrate" || risk === "high" || changedFiles.length > 8) {
    return "large";
  }
  if (changedFiles.length > 3 || risk === "medium") {
    return "medium";
  }
  return "small";
}

function inferAdaptiveReasoningDepth(risk: string, taskType: string): string {
  if (risk === "high" || taskType === "critical_code" || taskType === "release") {
    return "high";
  }
  if (taskType === "documentation") {
    return "low";
  }
  return "medium";
}

function inferAdaptiveWorkerRole(taskType: string): string {
  switch (taskType) {
    case "documentation":
      return "documentation";
    case "tests":
      return "testing";
    case "release":
      return "validation";
    case "critical_code":
    case "coding":
      return "coding";
    default:
      return "execution";
  }
}

function inferAdaptiveCapabilities(taskType: string, workerRole: string): string[] {
  if (workerRole === "coding") {
    return ["code_edit"];
  }
  if (workerRole === "documentation" || taskType === "documentation") {
    return ["docs_write"];
  }
  if (workerRole === "testing" || taskType === "tests") {
    return ["test_execute"];
  }
  if (workerRole === "validation" || taskType === "release") {
    return ["validation"];
  }
  return ["execution"];
}

function inferAdaptivePreferredProfileStrengths(
  taskType: string,
  query: string,
  changedFiles: string[],
  workerRole: string
): string[] {
  const normalizedQuery = query.toLowerCase();
  const strengths = new Set<string>();
  const codeLikeScope =
    workerRole === "coding" ||
    workerRole === "testing" ||
    taskType === "coding" ||
    taskType === "critical_code" ||
    changedFiles.some((file) => /\.(ts|tsx|js|jsx|py|go|rs|java|kt|swift|rb|php)$/i.test(file));

  if (codeLikeScope) {
    strengths.add("code");
  }
  if (
    /\b(structured|json|schema|signature|serialization|contract|patch|file operations?)\b/i.test(
      normalizedQuery
    ) ||
    codeLikeScope
  ) {
    strengths.add("structured_output");
  }
  if (
    /\b(refactor|rewrite|rename|sweep|cross-file|multi-file)\b/i.test(normalizedQuery) ||
    changedFiles.length > 8
  ) {
    strengths.add("refactor");
  }
  if (
    /\b(repo|repository|codebase|explore|scan|survey|context|continuity|architecture)\b/i.test(
      normalizedQuery
    ) ||
    changedFiles.length > 5
  ) {
    strengths.add("long_context");
    strengths.add("repo_scan");
  }
  if (/\b(agent|workflow|checkpoint|handoff|delegate|orchestrat)\b/i.test(normalizedQuery)) {
    strengths.add("agentic_exploration");
  }
  if (taskType === "release" || taskType === "critical_code" || workerRole === "validation") {
    strengths.add("execution_safe");
  }

  return Array.from(strengths).sort();
}

function inferAdaptiveStructuredOutputRequirement(
  taskType: string,
  query: string,
  changedFiles: string[],
  workerRole: string
): boolean {
  if (workerRole === "documentation" && taskType === "documentation") {
    return false;
  }
  if (workerRole === "coding" || workerRole === "testing") {
    return true;
  }
  if (taskType === "coding" || taskType === "critical_code" || taskType === "tests") {
    return true;
  }
  if (
    /\b(structured|json|schema|signature|serialization|contract|patch|file operations?)\b/i.test(
      query
    )
  ) {
    return true;
  }
  return changedFiles.some((file) =>
    /\.(ts|tsx|js|jsx|py|go|rs|java|kt|swift|rb|php)$/i.test(file)
  );
}

function inferAdaptiveEvidenceRequirements(query: string, risk: string): string[] {
  const evidence = new Set<string>();
  if (/\b(test|tests|pytest|unit|integration|e2e|smoke|verify|verification)\b/i.test(query)) {
    evidence.add("tests");
  }
  if (/\b(proof|evidence|gate|production|prod|deploy|release|drift)\b/i.test(query)) {
    evidence.add("proof");
  }
  if (risk === "high") {
    evidence.add("review");
  }
  return Array.from(evidence).sort();
}

function normalizeProfileStrengths(values: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (values ?? [])
        .map((value) => stringValue(value)?.toLowerCase())
        .filter((value): value is string => Boolean(value))
    )
  ).sort();
}

function normalizeEndpointTypes(values: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (values ?? [])
        .map((value) => stringValue(value)?.toLowerCase())
        .filter((value): value is string => Boolean(value))
    )
  ).sort();
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, item]) => item !== undefined && !(Array.isArray(item) && item.length === 0)
    )
  ) as T;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeStringList(values: unknown[] | undefined): string[] {
  return Array.from(
    new Set(
      (values ?? [])
        .map((value) => stringValue(value))
        .filter((value): value is string => Boolean(value))
    )
  ).sort();
}
