import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { findWorkspaceRoot, getConfigPath, isConfigured } from "../config/store";
import type { WorkflowMode } from "../commands/workflows";

type RuntimeEnvironment = Record<string, string | undefined>;
type ProviderKeyName = "OPENAI_API_KEY" | "ANTHROPIC_API_KEY";
type ProviderKeySource = "environment" | "env-file";
export type OrchestratorRecommendationLevel = "suggest" | "confirm" | "auto";
export type OrchestratorRecommendationReason =
  | "workflow_mode_orchestrate"
  | "production_validation_intent"
  | "proof_gate_intent"
  | "htask_or_swarm_intent"
  | "multi_agent_intent"
  | "parallel_worker_intent"
  | "changed_files_threshold"
  | "team_sync_collision"
  | "policy_auto_route";

export interface OrchestratorRecommendation {
  level: OrchestratorRecommendationLevel;
  reasons: OrchestratorRecommendationReason[];
  score: number;
  orchestratorRequired: boolean;
  policySource?: string;
}

export interface OrchestratorRecommendationOptions {
  changedFilesCount?: number;
  hasActiveCollisions?: boolean;
  policyAutoRoute?: boolean;
  policySource?: string;
}

export interface RuntimeDetectionReport {
  cwd: string;
  workspaceRoot: string | null;
  companion: {
    configured: boolean;
    configPath: string;
  };
  runtime: {
    cliAvailable: boolean;
    command?: string;
    legacyCommand?: boolean;
    version?: string;
    cliVersion?: string;
    installedPackageVersion?: string;
    versionMismatch?: boolean;
    mcpConfigured: boolean;
    mcpConfigPaths: string[];
  };
  orchestrator: {
    cliAvailable: boolean;
    command?: string;
    version?: string;
  };
  providerKeys: {
    openai: boolean;
    anthropic: boolean;
    any: boolean;
    sources: {
      openai?: ProviderKeySource;
      anthropic?: ProviderKeySource;
    };
    envFilesLoaded: string[];
  };
  docker: {
    available: boolean;
  };
}

const RUNTIME_INTENT_PATTERN =
  /\b(test|tests|validate|validation|verify|evaluate|eval|execute|execution|run|sandbox|sandboxed|isolated|isolation|simulate|script|python|csv|dataframe|notebook|generate report|lint|type-?check|build|benchmark|parse|transform|repeatable|reproducible)\b/i;
const ORCHESTRATOR_PRODUCTION_PATTERN =
  /\b(prod|production|deploy|deployment|release|rollout|cutover|drift|live validation|live check|live checks)\b/i;
const ORCHESTRATOR_PROOF_PATTERN =
  /\b(proof|proofs|gate|gates|gatekeeper|evidence|proof[- ]?required)\b/i;
const ORCHESTRATOR_HTASK_PATTERN = /\b(htask|hierarchical task|task queue|shared queue|swarm)\b/i;
const ORCHESTRATOR_MULTI_AGENT_PATTERN =
  /\b(multi-agent|multi agent|parallel agent|parallel agents|agent coordination|coordinate agents)\b/i;
const ORCHESTRATOR_PARALLEL_WORKER_PATTERN = /\b(worker|workers|parallel work)\b/i;
const SANDBOX_COMMANDS = ["snipara-sandbox", "rlm"] as const;
const SANDBOX_MCP_SERVER_NAMES = new Set(["snipara-sandbox", "rlm-runtime", "rlm"]);
const ORCHESTRATOR_COMMAND = "snipara-orchestrator";

export function commandExists(command: string): boolean {
  try {
    execFileSync(command, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    return true;
  } catch {
    try {
      execFileSync("sh", ["-c", `command -v ${shellQuote(command)}`], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      });
      return true;
    } catch {
      return false;
    }
  }
}

export function detectRuntimeEnvironment(
  cwd: string = process.cwd(),
  env: RuntimeEnvironment = process.env
): RuntimeDetectionReport {
  const workspaceRoot = findWorkspaceRoot(cwd);
  const mcpConfigPaths = findRuntimeMcpConfigPaths(cwd, workspaceRoot);
  const sandboxCli = detectSandboxCli();
  const orchestratorCli = detectOrchestratorCli();
  const parsedVersion = parseRuntimeVersion(sandboxCli.version);
  const providerKeys = detectProviderKeys(cwd, workspaceRoot, env);

  return {
    cwd,
    workspaceRoot,
    companion: {
      configured: isConfigured({ cwd }),
      configPath: getConfigPath({ cwd }),
    },
    runtime: {
      cliAvailable: Boolean(sandboxCli.command),
      command: sandboxCli.command,
      legacyCommand: sandboxCli.legacyCommand,
      version: sandboxCli.version,
      cliVersion: parsedVersion.cliVersion,
      installedPackageVersion: parsedVersion.installedPackageVersion,
      versionMismatch: parsedVersion.versionMismatch,
      mcpConfigured: mcpConfigPaths.length > 0,
      mcpConfigPaths,
    },
    orchestrator: {
      cliAvailable: Boolean(orchestratorCli.command),
      command: orchestratorCli.command,
      version: orchestratorCli.version,
    },
    providerKeys,
    docker: {
      available: commandExists("docker"),
    },
  };
}

export function shouldSuggestRuntimeForWorkflow(query: string, mode: WorkflowMode): boolean {
  return mode === "full" || mode === "orchestrate" || RUNTIME_INTENT_PATTERN.test(query);
}

export function getOrchestratorRecommendation(
  query: string,
  mode: WorkflowMode,
  options: OrchestratorRecommendationOptions = {}
): OrchestratorRecommendation | null {
  const reasons: OrchestratorRecommendationReason[] = [];
  let score = 0;

  const addReason = (reason: OrchestratorRecommendationReason, points: number): void => {
    if (!reasons.includes(reason)) {
      reasons.push(reason);
      score += points;
    }
  };

  if (mode === "orchestrate") {
    addReason("workflow_mode_orchestrate", 70);
  }
  if (ORCHESTRATOR_PRODUCTION_PATTERN.test(query)) {
    addReason("production_validation_intent", 25);
  }
  if (ORCHESTRATOR_PROOF_PATTERN.test(query)) {
    addReason("proof_gate_intent", 30);
  }
  if (ORCHESTRATOR_HTASK_PATTERN.test(query)) {
    addReason("htask_or_swarm_intent", 30);
  }
  if (ORCHESTRATOR_MULTI_AGENT_PATTERN.test(query)) {
    addReason("multi_agent_intent", 35);
  }
  if (ORCHESTRATOR_PARALLEL_WORKER_PATTERN.test(query)) {
    addReason("parallel_worker_intent", 20);
  }
  if ((options.changedFilesCount ?? 0) >= 5) {
    addReason("changed_files_threshold", 15);
  }
  if (options.hasActiveCollisions) {
    addReason("team_sync_collision", 25);
  }
  if (options.policyAutoRoute) {
    addReason("policy_auto_route", 100);
  }

  if (reasons.length === 0) {
    return null;
  }

  const requiresExplicitOrchestrator =
    mode === "orchestrate" ||
    reasons.includes("policy_auto_route") ||
    reasons.includes("proof_gate_intent") ||
    reasons.includes("htask_or_swarm_intent") ||
    reasons.includes("multi_agent_intent") ||
    reasons.includes("team_sync_collision");

  let level: OrchestratorRecommendationLevel = "suggest";
  if (options.policyAutoRoute) {
    level = "auto";
  } else if (requiresExplicitOrchestrator || score >= 70) {
    level = "confirm";
  }

  return {
    level,
    reasons,
    score,
    orchestratorRequired: level !== "suggest",
    policySource: options.policySource,
  };
}

export function formatOrchestratorRecommendationReason(
  reason: OrchestratorRecommendationReason
): string {
  switch (reason) {
    case "workflow_mode_orchestrate":
      return "explicit orchestrated workflow mode";
    case "production_validation_intent":
      return "production, deploy, rollout, or live-validation intent";
    case "proof_gate_intent":
      return "proof, gate, or evidence requirements";
    case "htask_or_swarm_intent":
      return "htask, shared queue, or swarm coordination intent";
    case "multi_agent_intent":
      return "explicit multi-agent coordination intent";
    case "parallel_worker_intent":
      return "parallel worker execution language";
    case "changed_files_threshold":
      return "changed file count crossed the escalation threshold";
    case "team_sync_collision":
      return "Team Sync overlap or collision signals";
    case "policy_auto_route":
      return "workspace policy requires orchestrator routing";
    default:
      return reason;
  }
}

export function shouldSuggestOrchestratorForWorkflow(query: string, mode: WorkflowMode): boolean {
  return getOrchestratorRecommendation(query, mode) !== null;
}

function getCommandVersion(command: string): string | undefined {
  try {
    const output = execFileSync(command, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    })
      .trim()
      .replace(/\s+/g, " ");
    return output || undefined;
  } catch {
    return undefined;
  }
}

function detectSandboxCli(): { command?: string; legacyCommand?: boolean; version?: string } {
  for (const command of SANDBOX_COMMANDS) {
    const version = getCommandVersion(command);
    if (version || commandExists(command)) {
      return {
        command,
        legacyCommand: command === "rlm",
        version,
      };
    }
  }

  return {};
}

function detectOrchestratorCli(): { command?: string; version?: string } {
  const version = getCommandVersion(ORCHESTRATOR_COMMAND);
  if (version || commandExists(ORCHESTRATOR_COMMAND)) {
    return {
      command: ORCHESTRATOR_COMMAND,
      version,
    };
  }

  return {};
}

function parseRuntimeVersion(version: string | undefined): {
  cliVersion?: string;
  installedPackageVersion?: string;
  versionMismatch?: boolean;
} {
  if (!version) {
    return {};
  }

  const match = version.match(
    /^(?:snipara-sandbox|rlm-runtime)\s+([^\s(]+)(?:\s+\(installed:\s*([^)]+)\))?/i
  );
  if (!match) {
    return {};
  }

  const cliVersion = match[1];
  const installedPackageVersion = match[2];
  return {
    cliVersion,
    installedPackageVersion,
    versionMismatch:
      Boolean(cliVersion && installedPackageVersion) && cliVersion !== installedPackageVersion,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function detectProviderKeys(
  cwd: string,
  workspaceRoot: string | null,
  env: RuntimeEnvironment
): RuntimeDetectionReport["providerKeys"] {
  const envFileResult = loadEnvFiles(cwd, workspaceRoot);
  const openai = resolveProviderKey("OPENAI_API_KEY", env, envFileResult.values);
  const anthropic = resolveProviderKey("ANTHROPIC_API_KEY", env, envFileResult.values);

  return {
    openai: openai.present,
    anthropic: anthropic.present,
    any: openai.present || anthropic.present,
    sources: {
      openai: openai.source,
      anthropic: anthropic.source,
    },
    envFilesLoaded: envFileResult.files,
  };
}

function resolveProviderKey(
  key: ProviderKeyName,
  env: RuntimeEnvironment,
  fileEnv: RuntimeEnvironment
): { present: boolean; source?: ProviderKeySource } {
  if (hasValue(env[key])) {
    return { present: true, source: "environment" };
  }
  if (hasValue(fileEnv[key])) {
    return { present: true, source: "env-file" };
  }
  return { present: false };
}

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function loadEnvFiles(
  cwd: string,
  workspaceRoot: string | null
): { values: RuntimeEnvironment; files: string[] } {
  const values: RuntimeEnvironment = {};
  const files: string[] = [];

  for (const envFile of findEnvFilePaths(cwd, workspaceRoot)) {
    if (!fs.existsSync(envFile)) {
      continue;
    }
    const parsed = parseEnvFile(envFile);
    Object.assign(values, parsed);
    files.push(envFile);
  }

  return { values, files };
}

function findEnvFilePaths(cwd: string, workspaceRoot: string | null): string[] {
  const names = [".env", ".env.local", ".env.development", ".env.development.local"];
  const roots = [workspaceRoot, path.resolve(cwd)].filter((value): value is string =>
    Boolean(value)
  );

  const candidates = roots.flatMap((root) => names.map((name) => path.join(root, name)));
  return Array.from(new Set(candidates));
}

function parseEnvFile(filePath: string): RuntimeEnvironment {
  const values: RuntimeEnvironment = {};
  let content: string;

  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return values;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(rawLine);
    if (parsed) {
      values[parsed.key] = parsed.value;
    }
  }

  return values;
}

function parseEnvLine(line: string): { key: string; value: string } | null {
  const withoutWhitespace = line.trim();
  if (!withoutWhitespace || withoutWhitespace.startsWith("#")) {
    return null;
  }

  const withoutExport = withoutWhitespace.startsWith("export ")
    ? withoutWhitespace.slice("export ".length).trim()
    : withoutWhitespace;
  const separatorIndex = withoutExport.indexOf("=");
  if (separatorIndex <= 0) {
    return null;
  }

  const key = withoutExport.slice(0, separatorIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return null;
  }

  const value = parseEnvValue(withoutExport.slice(separatorIndex + 1).trim());
  return { key, value };
}

function parseEnvValue(rawValue: string): string {
  if (rawValue.length >= 2) {
    const quote = rawValue[0];
    if ((quote === `"` || quote === `'`) && rawValue[rawValue.length - 1] === quote) {
      const unquoted = rawValue.slice(1, -1);
      if (quote === `"`) {
        return unquoted
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, `"`)
          .replace(/\\\\/g, "\\");
      }
      return unquoted;
    }
  }

  return rawValue.replace(/\s+#.*$/, "").trim();
}

function findRuntimeMcpConfigPaths(cwd: string, workspaceRoot: string | null): string[] {
  const candidatePaths = [
    workspaceRoot ? path.join(workspaceRoot, ".mcp.json") : null,
    path.join(cwd, ".mcp.json"),
    path.join(os.homedir(), ".mcp.json"),
    path.join(os.homedir(), ".claude", "claude_desktop_config.json"),
    path.join(os.homedir(), ".codex", "config.toml"),
  ].filter((value): value is string => Boolean(value));

  const uniquePaths = Array.from(new Set(candidatePaths));
  return uniquePaths.filter((configPath) => configHasRuntimeServer(configPath));
}

function configHasRuntimeServer(configPath: string): boolean {
  if (!fs.existsSync(configPath)) {
    return false;
  }

  if (configPath.endsWith(".toml")) {
    return tomlConfigHasRuntimeServer(configPath);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
    if (!isRecord(parsed)) {
      return false;
    }

    const servers = parsed.mcpServers;
    if (!isRecord(servers)) {
      return false;
    }

    return Object.entries(servers).some(([name, server]) => {
      const normalizedName = name.toLowerCase();
      if (SANDBOX_MCP_SERVER_NAMES.has(normalizedName)) {
        return true;
      }

      if (!isRecord(server)) {
        return false;
      }

      const command = stringValue(server.command);
      const args = Array.isArray(server.args) ? server.args.map(String) : [];
      return (
        SANDBOX_COMMANDS.includes(command as (typeof SANDBOX_COMMANDS)[number]) &&
        args.includes("mcp-serve")
      );
    });
  } catch {
    return false;
  }
}

function tomlConfigHasRuntimeServer(configPath: string): boolean {
  let content: string;
  try {
    content = fs.readFileSync(configPath, "utf-8");
  } catch {
    return false;
  }

  const sections = content.split(/^\s*\[/m);
  for (const rawSection of sections) {
    const section = rawSection.trim();
    if (!section) {
      continue;
    }

    const closingIndex = section.indexOf("]");
    if (closingIndex < 0) {
      continue;
    }

    const sectionName = section.slice(0, closingIndex).trim().replace(/^"|"$/g, "");
    if (!sectionName.startsWith("mcp_servers.")) {
      continue;
    }

    const serverName = sectionName.slice("mcp_servers.".length).replace(/^"|"$/g, "");
    const body = section.slice(closingIndex + 1);
    if (SANDBOX_MCP_SERVER_NAMES.has(serverName.toLowerCase())) {
      return true;
    }

    if (
      /^\s*command\s*=\s*["'](?:snipara-sandbox|rlm)["']\s*$/m.test(body) &&
      /^\s*args\s*=\s*\[[^\]]*["']mcp-serve["'][^\]]*\]\s*$/m.test(body)
    ) {
      return true;
    }
  }

  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const text = String(value).trim();
  return text || undefined;
}
