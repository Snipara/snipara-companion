import * as fs from "node:fs";
import * as path from "node:path";
import {
  resolveAgentContext,
  stableDecisionJsonStringify,
  validateAgentContextManifest,
  type AgentContextResolution,
  type AgentContextValidationFinding,
  type AgentContextValidationReport,
} from "../contracts/project-intelligence";

export const AGENT_CONTEXT_MANIFEST_DEFAULT_PATH = "snipara.agent-context.json";

export interface AgentContextValidateCommandOptions {
  manifest?: string;
  json?: boolean;
  cwd?: string;
}

export interface AgentContextResolveCommandOptions {
  manifest?: string;
  agent: string;
  task: string;
  json?: boolean;
  cwd?: string;
}

function readManifest(manifestPath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read Agent Context manifest ${manifestPath}: ${message}`);
  }
}

function localSourceFinding(
  sourceId: string,
  sourcePath: string,
  summary: string
): AgentContextValidationFinding {
  return {
    id: "source_file_missing",
    severity: "error",
    summary,
    refs: [sourceId, sourcePath],
    reasonCodes: ["source_file_missing", "local_context_unavailable"],
  };
}

export function buildLocalAgentContextValidationReport(options: {
  cwd?: string;
  manifest: unknown;
  generatedAt?: string | Date;
}): AgentContextValidationReport {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const report = validateAgentContextManifest({
    manifest: options.manifest,
    generatedAt: options.generatedAt,
  });
  if (!report.manifest) return report;

  const localFindings = report.manifest.sources.flatMap((source) => {
    const absolutePath = path.resolve(cwd, source.path);
    if (!fs.existsSync(absolutePath)) {
      return [
        localSourceFinding(
          source.id,
          source.path,
          `Source "${source.id}" does not exist at ${source.path}.`
        ),
      ];
    }
    if (!fs.statSync(absolutePath).isFile()) {
      return [
        localSourceFinding(
          source.id,
          source.path,
          `Source "${source.id}" must resolve to a regular file: ${source.path}.`
        ),
      ];
    }
    return [];
  });
  if (localFindings.length === 0) return report;
  return {
    ...report,
    status: "invalid",
    findings: [...report.findings, ...localFindings],
  };
}

function manifestPath(cwd: string, candidate?: string): string {
  return path.resolve(cwd, candidate ?? AGENT_CONTEXT_MANIFEST_DEFAULT_PATH);
}

export interface LocalAgentContextResolutionOptions {
  manifest?: string;
  agent: string;
  task: string;
  cwd?: string;
}

export interface LocalAgentContextResolution {
  manifestPath: string;
  resolution: AgentContextResolution;
}

/**
 * Resolve the local Agent Context policy without printing or calling Hosted MCP.
 *
 * Workflow commands use this helper to attach a bounded, manifest-hashed policy
 * to task envelopes. Retrieval remains visible to the agent runtime, which must
 * call Hosted MCP with the returned scopes and source plan.
 */
export function resolveLocalAgentContext(
  options: LocalAgentContextResolutionOptions
): LocalAgentContextResolution {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const resolvedManifestPath = manifestPath(cwd, options.manifest);
  const manifest = readManifest(resolvedManifestPath);
  const validation = buildLocalAgentContextValidationReport({ cwd, manifest });
  if (validation.status === "invalid") {
    const errors = validation.findings
      .filter((finding) => finding.severity === "error")
      .map((finding) => finding.summary)
      .join(" ");
    throw new Error(`Invalid Agent Context manifest. ${errors}`.trim());
  }

  return {
    manifestPath: path.relative(cwd, resolvedManifestPath) || path.basename(resolvedManifestPath),
    resolution: resolveAgentContext({
      manifest,
      agent: options.agent,
      task: options.task,
    }),
  };
}

function formatValidationReport(report: AgentContextValidationReport, manifest: string): string {
  const lines = [
    `Agent Context manifest: ${manifest}`,
    `Status: ${report.status}`,
    `Hash: ${report.manifestHash}`,
  ];
  if (report.manifest) {
    lines.push(
      `Sources: ${report.manifest.sources.length}`,
      `Roles: ${Object.keys(report.manifest.roles).join(", ")}`,
      `Agents: ${Object.keys(report.manifest.agents).join(", ")}`
    );
  }
  if (report.findings.length > 0) {
    lines.push("", "Findings:");
    for (const finding of report.findings) {
      lines.push(`- [${finding.severity}] ${finding.summary}`);
    }
  }
  return lines.join("\n");
}

export function formatAgentContextResolution(resolution: AgentContextResolution): string {
  const lines = [
    `# Agent Context — ${resolution.agent.displayName}`,
    "",
    `Task: ${resolution.task}`,
    `Identity: ${resolution.agent.agentId} (${resolution.agent.alias})`,
    `Roles: ${resolution.agent.roles.join(", ")}`,
    `Token budget: ${resolution.budget.totalTokens} total; ${resolution.budget.memoryTokens} memory`,
    "",
    "## Context sources",
    "",
  ];
  for (const source of resolution.sources) {
    lines.push(
      `- ${source.path} — ${source.authority}/${source.tier}; included by ${source.includedBy.join(
        " + "
      )}`
    );
  }
  lines.push("", "## Memory plan", "");
  for (const request of resolution.memory.recall) {
    const identity = request.agentId ? `; agent=${request.agentId}` : "";
    lines.push(`- Recall scope=${request.scope}; category=${request.category}${identity}`);
  }
  lines.push(
    `- Default write: scope=agent; category=${resolution.memory.defaultWrite.category}; agent=${resolution.memory.defaultWrite.agentId}`,
    ...resolution.memory.promotion.map(
      (target) =>
        `- Reviewed promotion allowed: scope=${target.scope}; category=${target.category} (human review required)`
    )
  );
  if (resolution.boundaries.length > 0) {
    lines.push("", "## Boundaries", "", ...resolution.boundaries.map((entry) => `- ${entry}`));
  }
  if (resolution.queryHints.length > 0) {
    lines.push("", "## Retrieval hints", "", ...resolution.queryHints.map((entry) => `- ${entry}`));
  }
  lines.push(
    "",
    "## Isolation",
    "",
    resolution.excludedRoleSourceIds.length > 0
      ? `Excluded role-only sources: ${resolution.excludedRoleSourceIds.join(", ")}`
      : "No additional role-only sources were excluded.",
    "",
    ...resolution.explanation.map((entry) => `- ${entry}`)
  );
  return lines.join("\n");
}

export async function agentContextValidateCommand(
  options: AgentContextValidateCommandOptions = {}
): Promise<AgentContextValidationReport> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const resolvedManifestPath = manifestPath(cwd, options.manifest);
  const report = buildLocalAgentContextValidationReport({
    cwd,
    manifest: readManifest(resolvedManifestPath),
  });
  console.log(
    options.json
      ? stableDecisionJsonStringify(report)
      : formatValidationReport(report, path.relative(cwd, resolvedManifestPath))
  );
  if (report.status === "invalid") {
    process.exitCode = 1;
  }
  return report;
}

export async function agentContextResolveCommand(
  options: AgentContextResolveCommandOptions
): Promise<AgentContextResolution> {
  const { resolution } = resolveLocalAgentContext({
    cwd: options.cwd,
    manifest: options.manifest,
    agent: options.agent,
    task: options.task,
  });
  console.log(
    options.json
      ? stableDecisionJsonStringify(resolution)
      : formatAgentContextResolution(resolution)
  );
  return resolution;
}
