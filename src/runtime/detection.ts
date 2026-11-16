/**
 * Runtime environment detection.
 *
 * Inspects the local environment — companion config, workspace root, the
 * Sandbox and Orchestrator CLIs, and provider keys (OPENAI/ANTHROPIC, from
 * process env or a project env-file). Pure logic: it reads state and routes
 * nothing.
 *
 * Orchestrator was folded into Companion on 2026-11-15 and its handoff to the
 * frozen Controller left with phase 3, so Companion recommends it nowhere. The
 * Orchestrator CLI is still detected because scoped Sandbox validation
 * (`validation run --scope`) delegates to it until the Sandbox CLI accepts
 * `--scope` itself.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { findWorkspaceRoot, getConfigPath, isConfigured } from "../config/store";
import type { WorkflowMode } from "../commands/workflows";
import { diagnosticProbeEnvironment } from "./capability-status";

type RuntimeEnvironment = Record<string, string | undefined>;
type ProviderKeyName = "OPENAI_API_KEY" | "ANTHROPIC_API_KEY";
type ProviderKeySource = "environment" | "env-file";
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
    source?: "path" | "workspace_venv";
    workspacePackageVersion?: string;
    versionMismatch?: boolean;
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
const SANDBOX_COMMANDS = ["snipara-sandbox", "rlm"] as const;
const SANDBOX_MCP_SERVER_NAMES = new Set(["snipara-sandbox", "rlm-runtime", "rlm"]);
const ORCHESTRATOR_COMMAND = "snipara-orchestrator";

export function commandExists(command: string, env: RuntimeEnvironment = process.env): boolean {
  try {
    execFileSync(command, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      env: diagnosticProbeEnvironment(env),
    });
    return true;
  } catch {
    try {
      execFileSync("sh", ["-c", `command -v ${shellQuote(command)}`], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
        env: diagnosticProbeEnvironment(env),
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
  const sandboxCli = detectSandboxCli(env);
  const orchestratorCli = detectOrchestratorCli(cwd, workspaceRoot, env);
  const workspaceOrchestratorVersion = findWorkspaceOrchestratorVersion(cwd, workspaceRoot);
  const orchestratorCliVersion = parseOrchestratorVersion(orchestratorCli.version);
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
      source: orchestratorCli.source,
      workspacePackageVersion: workspaceOrchestratorVersion,
      versionMismatch: Boolean(
        orchestratorCliVersion &&
        workspaceOrchestratorVersion &&
        orchestratorCliVersion !== workspaceOrchestratorVersion
      ),
    },
    providerKeys,
    docker: {
      available: commandExists("docker", env),
    },
  };
}

export function shouldSuggestRuntimeForWorkflow(query: string, mode: WorkflowMode): boolean {
  return mode === "full" || mode === "orchestrate" || RUNTIME_INTENT_PATTERN.test(query);
}

function getCommandVersion(
  command: string,
  env: RuntimeEnvironment = process.env
): string | undefined {
  try {
    const output = execFileSync(command, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      env: diagnosticProbeEnvironment(env),
    })
      .trim()
      .replace(/\s+/g, " ");
    return output || undefined;
  } catch {
    return undefined;
  }
}

function executableExists(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform === "win32") {
      return true;
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function detectSandboxCli(env: RuntimeEnvironment): {
  command?: string;
  legacyCommand?: boolean;
  version?: string;
} {
  for (const command of SANDBOX_COMMANDS) {
    const version = getCommandVersion(command, env);
    if (version || commandExists(command, env)) {
      return {
        command,
        legacyCommand: command === "rlm",
        version,
      };
    }
  }

  return {};
}

function detectOrchestratorCli(
  cwd: string,
  workspaceRoot: string | null,
  env: RuntimeEnvironment
): { command?: string; version?: string; source?: "path" | "workspace_venv" } {
  const version = getCommandVersion(ORCHESTRATOR_COMMAND, env);
  if (version || commandExists(ORCHESTRATOR_COMMAND, env)) {
    return {
      command: ORCHESTRATOR_COMMAND,
      version,
      source: "path",
    };
  }

  for (const candidate of findWorkspaceExecutableCandidates(
    ORCHESTRATOR_COMMAND,
    cwd,
    workspaceRoot
  )) {
    if (!executableExists(candidate)) {
      continue;
    }
    return {
      command: candidate,
      version: getCommandVersion(candidate, env),
      source: "workspace_venv",
    };
  }

  return {};
}

function findWorkspaceOrchestratorVersion(
  cwd: string,
  workspaceRoot: string | null
): string | undefined {
  const roots = Array.from(
    new Set([workspaceRoot, path.resolve(cwd)].filter((value): value is string => Boolean(value)))
  );
  for (const root of roots) {
    const version = readPyprojectVersion(
      path.join(root, "packages", "agentic-orchestrator", "pyproject.toml"),
      "snipara-orchestrator"
    );
    if (version) {
      return version;
    }
  }
  return undefined;
}

function readPyprojectVersion(filePath: string, packageName: string): string | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const content = fs.readFileSync(filePath, "utf-8");
  const nameMatch = content.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
  if (nameMatch && nameMatch[1] !== packageName) {
    return undefined;
  }
  const versionMatch = content.match(/^\s*version\s*=\s*["']([^"']+)["']/m);
  return versionMatch?.[1];
}

function parseOrchestratorVersion(version: string | undefined): string | undefined {
  if (!version) {
    return undefined;
  }
  const match = version.match(/snipara-orchestrator\s+([^\s]+)/i);
  return match?.[1];
}

function findWorkspaceExecutableCandidates(
  command: string,
  cwd: string,
  workspaceRoot: string | null
): string[] {
  const executableName = process.platform === "win32" ? `${command}.exe` : command;
  const roots = Array.from(
    new Set([workspaceRoot, path.resolve(cwd)].filter((value): value is string => Boolean(value)))
  );

  return roots.flatMap((root) => [
    path.join(root, ".venv", "bin", executableName),
    path.join(root, "venv", "bin", executableName),
    path.join(root, "packages", "agentic-orchestrator", ".venv", "bin", executableName),
    path.join(root, "apps", "mcp-server", ".venv", "bin", executableName),
  ]);
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
