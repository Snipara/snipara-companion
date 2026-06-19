/**
 * Orchestrator handoff artifact — build and persist.
 *
 * Serializes the current workflow into a handoff document
 * (.snipara/orchestrator/handoff.json): workflow phases, runtime/sandbox
 * phases, files, gates, and checkpoints. snipara-orchestrator (or another
 * agent) reads this to resume multi-step work with full context. Pure builder
 * (`buildOrchestratorHandoff`) plus a writer.
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import type { OrchestratorRecommendation } from "./detection";

export const ORCHESTRATOR_HANDOFF_RELATIVE_PATH = path.join(
  ".snipara",
  "orchestrator",
  "handoff.json"
);

export interface OrchestratorHandoffWorkflowPhase {
  id: string;
  title: string;
  query: string;
  status: string;
  acceptance?: string;
  files: string[];
  gates: string[];
  needsRuntime: boolean;
}

export interface OrchestratorHandoffRuntimeSandboxPhase {
  phaseId: string;
  title: string;
  bootstrapQuery: string;
  files: string[];
  artifacts: string[];
  sessionId: string | null;
  environment: string | null;
  profile: string | null;
  hasCheckpoint: boolean;
  checkpointSummary: string | null;
  checkpointCapturedAt: string | null;
}

export interface AdaptiveWorkProfile {
  taskType: string;
  risk: string;
  scope: string[];
  contextBudget: string;
  reasoningDepth: string;
  evidenceRequirements?: string[];
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
  preferredEndpointTypes?: string[];
  allowedEndpointTypes?: string[];
  catalogLimit?: number;
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
  humanApprovalRequired: true;
  fallback: "main_agent";
  reasons: string[];
  warnings: string[];
}

export interface AdaptiveRoutingGatewayStatus {
  source: "hosted_mcp";
  success: boolean;
  resolutionStatus?: string;
  candidateCount: number;
  fallback?: string;
  warnings: string[];
}

export interface AdaptiveRoutingRuntimeCatalog {
  version?: string;
  candidates: Array<Record<string, unknown>>;
}

export interface AdaptiveWorkRoutingRecommendation {
  workProfile: AdaptiveWorkProfile;
  requirements: AdaptiveModelRequirements;
  routingCard: AdaptiveRoutingCard;
  gateway?: AdaptiveRoutingGatewayStatus;
  runtimeCatalog?: AdaptiveRoutingRuntimeCatalog;
}

export interface AdaptiveWorkRoutingOptions {
  query: string;
  mode?: string;
  changedFiles?: string[];
  preferredEndpointTypes?: string[];
  allowedEndpointTypes?: string[];
  workerRole?: string;
  plannerRetainsReasoning?: boolean;
  catalogLimit?: number;
}

export interface OrchestratorHandoffArtifact {
  schemaVersion: "snipara.orchestrator.handoff.v1";
  source: {
    client: "snipara-companion";
    command: string;
    generatedAt: string;
  };
  workflow: {
    mode: string;
    workflowId: string | null;
    currentPhaseId: string | null;
    phases: OrchestratorHandoffWorkflowPhase[];
  };
  runtime: {
    sandbox: {
      provider: "snipara-sandbox";
      phases: OrchestratorHandoffRuntimeSandboxPhase[];
    } | null;
  };
  routing: {
    level: OrchestratorRecommendation["level"];
    reasons: OrchestratorRecommendation["reasons"];
    policySource: string | null;
    workProfile?: AdaptiveWorkProfile;
    requirements?: AdaptiveModelRequirements;
    routingCard?: AdaptiveRoutingCard;
    gateway?: AdaptiveRoutingGatewayStatus;
    runtimeCatalog?: AdaptiveRoutingRuntimeCatalog;
  };
  task: {
    title: string;
    query: string;
    summary: string;
  };
  repo: {
    root: string;
    branch: string | null;
    headSha: string | null;
    changedFiles: string[];
  };
  coordination: {
    swarmId: string | null;
    claimScope: {
      files: string[];
      symbols: string[];
    };
    htask: {
      featureTitle: string | null;
      workstreams: string[];
    };
  };
  validation: {
    requiresProofGate: boolean;
    requiresDriftCheck: boolean;
    liveChecks: string[];
    requiredEvidence: Array<{
      type: string;
      description: string;
    }>;
  };
  memory: {
    decisionIds: string[];
    contextRefs: string[];
    resumeSummary: string | null;
  };
}

export interface OrchestratorHandoffOptions {
  sourceCommand: string;
  recommendation: OrchestratorRecommendation;
  query: string;
  summary: string;
  title?: string;
  mode?: string;
  rootDir?: string;
  changedFiles?: string[];
  contextRefs?: string[];
  resumeSummary?: string;
  featureTitle?: string;
  workstreams?: string[];
  adaptiveRouting?: AdaptiveWorkRoutingRecommendation | null;
}

export interface WrittenOrchestratorHandoff {
  handoff: OrchestratorHandoffArtifact;
  path: string;
  relativePath: string;
  command: string;
}

export function buildOrchestratorHandoff(
  options: OrchestratorHandoffOptions
): OrchestratorHandoffArtifact {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const workflowState = readWorkflowState(rootDir);
  const changedFiles = normalizeStringList(
    options.changedFiles ??
      (Array.isArray(workflowState?.currentPhase?.files) ? workflowState.currentPhase.files : [])
  );
  const requiresProofGate =
    options.recommendation.reasons.includes("proof_gate_intent") ||
    options.recommendation.reasons.includes("team_sync_collision");
  const requiresDriftCheck =
    options.recommendation.reasons.includes("production_validation_intent") ||
    options.recommendation.reasons.includes("workflow_mode_orchestrate");

  return {
    schemaVersion: "snipara.orchestrator.handoff.v1",
    source: {
      client: "snipara-companion",
      command: options.sourceCommand,
      generatedAt: new Date().toISOString(),
    },
    workflow: {
      mode: options.mode ?? "full",
      workflowId: workflowState?.workflowId ?? null,
      currentPhaseId: workflowState?.currentPhaseId ?? null,
      phases: workflowState?.phases ?? [],
    },
    runtime: {
      sandbox:
        workflowState && workflowState.runtimeSandboxPhases.length > 0
          ? {
              provider: "snipara-sandbox",
              phases: workflowState.runtimeSandboxPhases,
            }
          : null,
    },
    routing: {
      level: options.recommendation.level,
      reasons: options.recommendation.reasons,
      policySource: options.recommendation.policySource ?? null,
      ...(options.adaptiveRouting
        ? {
            workProfile: options.adaptiveRouting.workProfile,
            requirements: options.adaptiveRouting.requirements,
            routingCard: options.adaptiveRouting.routingCard,
            ...(options.adaptiveRouting.gateway
              ? { gateway: options.adaptiveRouting.gateway }
              : {}),
            ...(options.adaptiveRouting.runtimeCatalog
              ? { runtimeCatalog: options.adaptiveRouting.runtimeCatalog }
              : {}),
          }
        : {}),
    },
    task: {
      title: options.title ?? options.summary,
      query: options.query,
      summary: options.summary,
    },
    repo: {
      root: rootDir,
      branch: readGitValue(rootDir, ["branch", "--show-current"]),
      headSha: readGitValue(rootDir, ["rev-parse", "HEAD"]),
      changedFiles,
    },
    coordination: {
      swarmId: null,
      claimScope: {
        files: changedFiles,
        symbols: [],
      },
      htask: {
        featureTitle: options.featureTitle ?? null,
        workstreams: normalizeStringList(options.workstreams),
      },
    },
    validation: {
      requiresProofGate,
      requiresDriftCheck,
      liveChecks: [],
      requiredEvidence: requiresProofGate
        ? [
            {
              type: "proof",
              description: "Collect explicit validation evidence before completion.",
            },
          ]
        : [],
    },
    memory: {
      decisionIds: ["DEC-002"],
      contextRefs: normalizeStringList(options.contextRefs),
      resumeSummary: options.resumeSummary ?? null,
    },
  };
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
  const capabilities = inferAdaptiveCapabilities(taskType, workerRole);
  const forbiddenCapabilities = risk === "high" ? ["secrets", "prod_write"] : ["secrets"];
  const workProfile: AdaptiveWorkProfile = compactObject({
    taskType,
    risk,
    scope: changedFiles,
    contextBudget,
    reasoningDepth,
    evidenceRequirements: inferAdaptiveEvidenceRequirements(options.query, risk),
    notes: [
      "Generated by snipara-companion as recommendation-only routing metadata.",
      "snipara-orchestrator must resolve the worker against the runtime catalog before execution.",
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
    preferredEndpointTypes,
    allowedEndpointTypes,
    catalogLimit: options.catalogLimit,
    fallback: "main_agent" as const,
  });
  const warnings = [
    "Recommendation-only dry run; companion does not launch or claim workers.",
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
      "runtime catalog resolution remains delegated to snipara-orchestrator",
    ],
    warnings,
  };

  return {
    workProfile,
    requirements,
    routingCard,
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

export function writeOrchestratorHandoff(
  options: OrchestratorHandoffOptions
): WrittenOrchestratorHandoff {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const handoff = buildOrchestratorHandoff({ ...options, rootDir });
  const absolutePath = path.join(rootDir, ORCHESTRATOR_HANDOFF_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(handoff, null, 2)}\n`, "utf8");

  return {
    handoff,
    path: absolutePath,
    relativePath: ORCHESTRATOR_HANDOFF_RELATIVE_PATH,
    command: `snipara-orchestrator agents coordinate --plan ${ORCHESTRATOR_HANDOFF_RELATIVE_PATH}`,
  };
}

function readWorkflowState(rootDir: string): {
  workflowId?: string;
  currentPhaseId?: string;
  currentPhase?: OrchestratorHandoffWorkflowPhase;
  phases: OrchestratorHandoffWorkflowPhase[];
  runtimeSandboxPhases: OrchestratorHandoffRuntimeSandboxPhase[];
} | null {
  const workflowPath = path.join(rootDir, ".snipara", "workflow", "current.json");
  if (!fs.existsSync(workflowPath)) {
    return null;
  }

  const parsed = JSON.parse(fs.readFileSync(workflowPath, "utf8")) as {
    workflowId?: string;
    currentPhaseId?: string;
    phases?: unknown[];
    runtime?: {
      sandbox?: {
        bindings?: unknown[];
      };
    };
  };
  const phases = Array.isArray(parsed.phases)
    ? parsed.phases.filter(isRecord).map((phase, index) => normalizeWorkflowPhase(phase, index))
    : [];
  const currentPhase = phases.find((phase) => phase.id === parsed.currentPhaseId);
  const runtimeBindings = Array.isArray(parsed.runtime?.sandbox?.bindings)
    ? parsed.runtime?.sandbox?.bindings.filter(isRecord)
    : [];
  const runtimeSandboxPhases = phases
    .filter((phase) => phase.needsRuntime)
    .map((phase) => {
      const binding = runtimeBindings.find(
        (candidate) => stringValue(candidate.phaseId) === phase.id
      );
      const checkpoint = isRecord(binding?.lastCheckpoint) ? binding.lastCheckpoint : undefined;
      return {
        phaseId: phase.id,
        title: phase.title,
        bootstrapQuery: stringValue(binding?.bootstrapQuery) ?? phase.query,
        files: phase.files,
        artifacts: normalizeStringList(
          Array.isArray(binding?.artifacts)
            ? binding.artifacts
            : Array.isArray(checkpoint?.artifacts)
              ? checkpoint.artifacts
              : undefined
        ),
        sessionId: stringValue(binding?.sessionId) ?? null,
        environment:
          stringValue(binding?.environment) ?? stringValue(checkpoint?.environment) ?? null,
        profile: stringValue(binding?.profile) ?? stringValue(checkpoint?.profile) ?? null,
        hasCheckpoint: Boolean(checkpoint),
        checkpointSummary: stringValue(checkpoint?.summary) ?? null,
        checkpointCapturedAt: stringValue(checkpoint?.capturedAt) ?? null,
      };
    });

  return {
    workflowId: parsed.workflowId,
    currentPhaseId: parsed.currentPhaseId,
    currentPhase,
    phases,
    runtimeSandboxPhases,
  };
}

function normalizeWorkflowPhase(
  phase: Record<string, unknown>,
  index: number
): OrchestratorHandoffWorkflowPhase {
  const id = stringValue(phase.id) ?? `phase-${index + 1}`;
  const title = stringValue(phase.title) ?? id;
  return {
    id,
    title,
    query: stringValue(phase.query) ?? title,
    status: stringValue(phase.status) ?? "pending",
    ...(stringValue(phase.acceptance) ? { acceptance: stringValue(phase.acceptance) } : {}),
    files: normalizeStringList(Array.isArray(phase.files) ? phase.files : undefined),
    gates: normalizeStringList(Array.isArray(phase.gates) ? phase.gates : undefined),
    needsRuntime: Boolean(phase.needsRuntime),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readGitValue(rootDir: string, args: string[]): string | null {
  try {
    const value = execFileSync("git", ["-C", rootDir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value || null;
  } catch {
    return null;
  }
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
