/**
 * `doctor` command — environment diagnostics.
 *
 * Runs read-only probes and prints (or returns as JSON) a health report:
 * runtime/companion configuration, Snipara authentication, and the hosted tool
 * catalog. Meant for debugging setup
 * before filing issues — it changes nothing.
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "node:child_process";
import chalk from "chalk";
import { createClient, type ConnectionProbeResult } from "../api/client";
import { detectRuntimeEnvironment, type RuntimeDetectionReport } from "../runtime/detection";
import { diagnosticProbeEnvironment, summarizeRuntimeCapabilities } from "../runtime/capability-status";
import {inspectManagedToolchain} from "../runtime/managed-toolchain";

export async function doctorCommand(options: { json?: boolean; deep?: boolean } = {}): Promise<void> {
  const managed = inspectManagedToolchain();
  if (!options.deep || managed.status !== "not_configured") {
    if (options.json) console.log(JSON.stringify(managed, null, 2));
    else {
      console.log(managed.status === "available" ? "Snipara local work is prepared." : managed.status === "not_configured" ? "Snipara local work is not installed." : "Snipara local work needs attention.");
      console.log(String(managed.detail));
      if (managed.nextAction) console.log(`Next: ${String(managed.nextAction)}`);
    }
    if (managed.status === "needs_attention") process.exitCode = 2;
    return;
  }
  const report = detectRuntimeEnvironment();
  const companionVersion = probeCompanionVersion(report);
  const auth = await probeSniparaAuth(report);
  const toolCatalog = await probeToolCatalog(report, auth);

  if (options.json) {
    console.log(JSON.stringify({ ...report, companionVersion, auth, toolCatalog, capabilities: summarizeRuntimeCapabilities(report) }, null, 2));
    return;
  }

  printDoctorReport(report, companionVersion, auth, toolCatalog);
}

interface DoctorCompanionVersionReport {
  checked: boolean;
  currentVersion?: string;
  workspacePackageVersion?: string;
  latestNpmVersion?: string;
  workspaceMismatch: boolean;
  npmUpdateAvailable: boolean;
  npmLatestChecked: boolean;
  detail: string;
  warnings: string[];
}

interface DoctorAuthReport {
  checked: boolean;
  valid: boolean;
  detail: string;
  statusCode?: number;
  tool?: string;
}

interface DoctorToolCatalogReport {
  checked: boolean;
  available: boolean;
  detail: string;
  toolCount?: number;
}

function probeCompanionVersion(report: RuntimeDetectionReport): DoctorCompanionVersionReport {
  const currentVersion = readPackageVersion(path.resolve(__dirname, "../package.json"));
  const workspacePackageVersion = findWorkspaceCompanionVersion(report);
  const latestNpm = probeLatestNpmVersion();
  const warnings: string[] = [];
  const workspaceMismatch = Boolean(
    currentVersion &&
    workspacePackageVersion &&
    isVersionNewer(workspacePackageVersion, currentVersion)
  );
  const npmUpdateAvailable = Boolean(
    currentVersion && latestNpm.version && isVersionNewer(latestNpm.version, currentVersion)
  );

  if (workspaceMismatch) {
    warnings.push(
      `workspace packages/cli is ${workspacePackageVersion}, but the running CLI is ${currentVersion}`
    );
  }
  if (npmUpdateAvailable) {
    warnings.push(`npm latest is ${latestNpm.version}, but the running CLI is ${currentVersion}`);
  }
  if (latestNpm.error) {
    warnings.push(`npm latest check skipped or failed: ${latestNpm.error}`);
  }

  const detailParts = [
    currentVersion ? `running ${currentVersion}` : "running version unknown",
    workspacePackageVersion ? `workspace ${workspacePackageVersion}` : null,
    latestNpm.version ? `npm latest ${latestNpm.version}` : null,
  ].filter((value): value is string => Boolean(value));

  return {
    checked: true,
    currentVersion,
    workspacePackageVersion,
    latestNpmVersion: latestNpm.version,
    workspaceMismatch,
    npmUpdateAvailable,
    npmLatestChecked: latestNpm.checked,
    detail: detailParts.join(", "),
    warnings,
  };
}

function readPackageVersion(packageJsonPath: string): string | undefined {
  try {
    const raw = fs.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0
      ? parsed.version
      : undefined;
  } catch {
    return undefined;
  }
}

function findWorkspaceCompanionVersion(report: RuntimeDetectionReport): string | undefined {
  const candidates = [
    path.join(report.cwd, "packages", "cli", "package.json"),
    report.workspaceRoot
      ? path.join(report.workspaceRoot, "packages", "cli", "package.json")
      : undefined,
    path.basename(report.cwd) === "cli" ? path.join(report.cwd, "package.json") : undefined,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const version = readPackageVersion(candidate);
    if (version) {
      return version;
    }
  }

  return undefined;
}

function probeLatestNpmVersion(): { checked: boolean; version?: string; error?: string } {
  if (process.env.SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK === "1") {
    return {
      checked: false,
      error: "disabled by SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK",
    };
  }

  try {
    const output = execFileSync("npm", ["view", "snipara-companion", "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3000,
      env: diagnosticProbeEnvironment(),
    }).trim();
    return {
      checked: true,
      version: output || undefined,
      ...(output ? {} : { error: "npm returned an empty version" }),
    };
  } catch (error) {
    return {
      checked: true,
      error: formatErrorDetail(error),
    };
  }
}

function parseVersion(value: string | undefined): number[] | null {
  if (!value) {
    return null;
  }
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isVersionNewer(candidate: string, baseline: string): boolean {
  const candidateParts = parseVersion(candidate);
  const baselineParts = parseVersion(baseline);
  if (!candidateParts || !baselineParts) {
    return candidate !== baseline;
  }
  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index] > baselineParts[index]) {
      return true;
    }
    if (candidateParts[index] < baselineParts[index]) {
      return false;
    }
  }
  return false;
}

async function probeSniparaAuth(report: RuntimeDetectionReport): Promise<DoctorAuthReport> {
  if (!report.companion.configured) {
    return {
      checked: false,
      valid: false,
      detail: "skipped (missing Snipara companion config)",
    };
  }

  const client = createClient(15000);
  const probe: ConnectionProbeResult = await client.probeConnection();

  if (probe.connected) {
    return {
      checked: true,
      valid: true,
      detail: probe.detail,
      tool: probe.tool,
    };
  }

  if (probe.statusCode === 401) {
    return {
      checked: true,
      valid: false,
      statusCode: probe.statusCode,
      detail: `invalid credentials or stale project mapping (${probe.detail})`,
      tool: probe.tool,
    };
  }

  if (probe.statusCode === 403) {
    return {
      checked: true,
      valid: false,
      statusCode: probe.statusCode,
      detail: `authenticated but not authorized (${probe.detail})`,
      tool: probe.tool,
    };
  }

  return {
    checked: true,
    valid: false,
    statusCode: probe.statusCode,
    detail: probe.detail,
    tool: probe.tool,
  };
}

async function probeToolCatalog(
  report: RuntimeDetectionReport,
  auth: DoctorAuthReport
): Promise<DoctorToolCatalogReport> {
  if (!report.companion.configured) {
    return {
      checked: false,
      available: false,
      detail: "skipped (missing Snipara companion config)",
    };
  }

  if (!auth.valid) {
    return {
      checked: false,
      available: false,
      detail: "skipped (hosted auth probe did not confirm access)",
    };
  }

  const client = createClient(15000);

  try {
    const result = await client.callTool<Record<string, unknown>>("snipara_help", {
      list_all: true,
    });
    const tools = Array.isArray(result.tools) ? result.tools : null;
    if (!tools) {
      return {
        checked: true,
        available: false,
        detail: "snipara_help(list_all=true) returned an unexpected payload",
      };
    }

    const toolCount =
      typeof result.count === "number" && Number.isFinite(result.count)
        ? result.count
        : tools.length;
    return {
      checked: true,
      available: true,
      toolCount,
      detail: `snipara_help(list_all=true) returned ${toolCount} tools`,
    };
  } catch (error) {
    return {
      checked: true,
      available: false,
      detail: `snipara_help(list_all=true) failed (${formatErrorDetail(error)})`,
    };
  }
}

function printDoctorReport(
  report: RuntimeDetectionReport,
  companionVersion: DoctorCompanionVersionReport,
  auth: DoctorAuthReport,
  toolCatalog: DoctorToolCatalogReport
): void {
  console.log(chalk.bold("Snipara Companion Doctor"));
  console.log("");

  printCheck(
    "Snipara auth",
    report.companion.configured,
    report.companion.configured
      ? `configured (${report.companion.configPath})`
      : `missing (run npx -y snipara-companion@latest init or npx create-snipara)`
  );
  printCheck(
    "Snipara Companion version",
    !companionVersion.workspaceMismatch && !companionVersion.npmUpdateAvailable,
    companionVersion.detail
  );
  for (const warning of companionVersion.warnings) {
    console.log(`${chalk.yellow("[warn]")} Companion version detail: ${warning}`);
  }
  printCheck(
    "Snipara Sandbox CLI",
    report.runtime.cliAvailable,
    report.runtime.cliAvailable ? runtimeVersionSummary(report) : "not found on PATH"
  );
  printCheck(
    "Snipara Sandbox MCP",
    report.runtime.mcpConfigured,
    report.runtime.mcpConfigured
      ? `configured in ${report.runtime.mcpConfigPaths.join(", ")}`
      : "not configured in local/global MCP files"
  );
  printCheck(
    "Snipara Orchestrator CLI",
    report.orchestrator.cliAvailable,
    report.orchestrator.cliAvailable
      ? orchestratorVersionSummary(report)
      : "not found on PATH (optional; install only for production gates)"
  );
  printCheck(
    "LLM provider key",
    report.providerKeys.any,
    report.providerKeys.any
      ? providerKeySummary(report)
      : "missing for standalone snipara-sandbox run / snipara-sandbox agent"
  );
  if (auth.checked) {
    printCheck("Snipara API auth", auth.valid, auth.detail);
  }
  if (toolCatalog.checked) {
    printCheck("Hosted tool catalog", toolCatalog.available, toolCatalog.detail);
  }
  printCheck(
    "Docker",
    report.docker.available,
    report.docker.available ? "CLI found; daemon, prepared image and validation readiness have not been checked" : "CLI not found on PATH"
  );

  console.log("");
  console.log(chalk.bold("Hosted MCP guidance"));
  console.log(
    "- This doctor confirms local auth and hosted reachability; it does not prove how a specific agent UI ranked or exposed tools."
  );
  console.log(
    "- A lean Snipara tool set is expected in normal agent sessions. Use snipara_help(query=...) for routed guidance and snipara_help(list_all=true) to inspect specialist opt-in surfaces."
  );

  console.log("");
  console.log(chalk.bold("Snipara Sandbox guidance"));
  console.log("- Restricted Python snippets, deterministic Docker validation and provider-native sandboxes are separate capabilities.");
  console.log("- Deterministic validation needs no Snipara account or provider key. CLI or MCP configuration discovery proves no working engine or passing test.");
  for (const capability of summarizeRuntimeCapabilities(report).surfaces) {
    console.log(`- ${capability.id}: executable ${capability.executable}; task ${capability.task_qualification}. ${capability.next_action}`);
  }
  if (report.runtime.cliAvailable) {
    console.log("- Use MCP execute_python for sandboxed code execution from your AI client.");
    console.log(
      '- Use snipara-sandbox run "your task" or snipara-sandbox agent "your task" for standalone Sandbox jobs.'
    );
    if (!report.providerKeys.any) {
      console.log(
        "- Set OPENAI_API_KEY or ANTHROPIC_API_KEY before standalone snipara-sandbox run / snipara-sandbox agent."
      );
    } else if (hasEnvFileOnlyProviderKey(report)) {
      console.log(
        "- Provider key was found in a local .env file; export it first if standalone snipara-sandbox run does not load .env in your shell."
      );
    }
    if (!report.runtime.mcpConfigured) {
      console.log(
        "- Add Snipara Sandbox MCP config with npx create-snipara repair --with-runtime."
      );
    }
  } else {
    console.log("- Existing project: npx create-snipara repair --with-runtime.");
    console.log("- Fresh setup: npx create-snipara --profile full-stack --advanced.");
    console.log(
      '- Manual install: python -m pip install "snipara-sandbox[all]" (`[all]` is the pip extra, not a separate argument).'
    );
  }

  console.log("");
  console.log(chalk.bold("Snipara Orchestrator guidance"));
  if (report.orchestrator.cliAvailable) {
    console.log("- Use snipara-orchestrator explicitly for production proof gates.");
  } else {
    console.log("- Existing project: npx create-snipara repair --with-orchestrator.");
    console.log("- Manual install: pip install snipara-orchestrator.");
    console.log("- Companion does not install or run orchestrator automatically.");
  }
}

function printCheck(label: string, ok: boolean, detail: string): void {
  const prefix = ok ? chalk.green("[ok]") : chalk.yellow("[warn]");
  console.log(`${prefix} ${label}: ${detail}`);
}

function providerKeySummary(report: RuntimeDetectionReport): string {
  const keys = [
    report.providerKeys.openai
      ? `OPENAI_API_KEY (${sourceLabel(report.providerKeys.sources.openai)})`
      : null,
    report.providerKeys.anthropic
      ? `ANTHROPIC_API_KEY (${sourceLabel(report.providerKeys.sources.anthropic)})`
      : null,
  ].filter((value): value is string => Boolean(value));

  return `${keys.join(", ")} detected`;
}

function runtimeVersionSummary(report: RuntimeDetectionReport): string {
  if (!report.runtime.cliVersion) {
    return report.runtime.version ? `available (${report.runtime.version})` : "available";
  }

  if (!report.runtime.installedPackageVersion) {
    return `available (CLI ${report.runtime.cliVersion})`;
  }

  if (report.runtime.versionMismatch) {
    return `available (CLI ${report.runtime.cliVersion}, package metadata ${report.runtime.installedPackageVersion}; mismatch)`;
  }

  return `available (CLI ${report.runtime.cliVersion})`;
}

function orchestratorVersionSummary(report: RuntimeDetectionReport): string {
  const parts = [
    report.orchestrator.version ?? "version unknown",
    report.orchestrator.command ? `path ${report.orchestrator.command}` : null,
    report.orchestrator.source ? `source ${report.orchestrator.source}` : null,
    report.orchestrator.workspacePackageVersion
      ? `workspace ${report.orchestrator.workspacePackageVersion}`
      : null,
    report.orchestrator.versionMismatch ? "source/install mismatch" : null,
  ].filter((value): value is string => Boolean(value));
  return `available (${parts.join(", ")})`;
}

function sourceLabel(source: string | undefined): string {
  return source === "env-file" ? ".env" : "environment";
}

function hasEnvFileOnlyProviderKey(report: RuntimeDetectionReport): boolean {
  return (
    report.providerKeys.sources.openai === "env-file" ||
    report.providerKeys.sources.anthropic === "env-file"
  );
}

function formatErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
