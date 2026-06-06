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
