/**
 * `doctor` command — environment diagnostics.
 *
 * Runs read-only probes and prints (or returns as JSON) a health report:
 * runtime/companion configuration, Snipara authentication, and the hosted tool
 * catalog (including htask/swarm completeness). Meant for debugging setup
 * before filing issues — it changes nothing.
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "node:child_process";
import chalk from "chalk";
import { createClient, type ConnectionProbeResult } from "../api/client";
import { detectRuntimeEnvironment, type RuntimeDetectionReport } from "../runtime/detection";

export async function doctorCommand(options: { json?: boolean } = {}): Promise<void> {
  const report = detectRuntimeEnvironment();
  const companionVersion = probeCompanionVersion(report);
  const auth = await probeSniparaAuth(report);
  const toolCatalog = await probeToolCatalog(report, auth);

  if (options.json) {
    console.log(JSON.stringify({ ...report, companionVersion, auth, toolCatalog }, null, 2));
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
  htaskToolCount?: number;
  swarmToolCount?: number;
  htaskComplete?: boolean;
  swarmComplete?: boolean;
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
    const toolNames = tools
      .map((tool) =>
        tool && typeof tool === "object" && typeof tool.tool === "string" ? tool.tool : null
      )
      .filter((tool): tool is string => Boolean(tool));
    const expectedHtaskTools = [
      "snipara_htask_create",
      "snipara_htask_create_feature",
      "snipara_htask_tree",
      "snipara_htask_complete",
      "snipara_htask_recommend_batch",
    ];
    const expectedSwarmTools = ["snipara_swarm_create", "snipara_swarm_join"];
    const htaskToolCount = expectedHtaskTools.filter((tool) => toolNames.includes(tool)).length;
    const swarmToolCount = expectedSwarmTools.filter((tool) => toolNames.includes(tool)).length;
    return {
      checked: true,
      available: true,
      toolCount,
      htaskToolCount,
      swarmToolCount,
      htaskComplete: htaskToolCount === expectedHtaskTools.length,
      swarmComplete: swarmToolCount === expectedSwarmTools.length,
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
      : "not found on PATH (optional; install only for production gates or htasks)"
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
    if (toolCatalog.available) {
      printCheck(
        "Hosted htask family",
        Boolean(toolCatalog.htaskComplete),
        `${toolCatalog.htaskToolCount ?? 0}/5 expected htask tools present in hosted catalog`
      );
      printCheck(
        "Hosted swarm family",
        Boolean(toolCatalog.swarmComplete),
        `${toolCatalog.swarmToolCount ?? 0}/2 expected swarm tools present in hosted catalog`
      );
    }
  }
  printCheck(
    "Docker",
    report.docker.available,
    report.docker.available ? "available for isolated Sandbox execution" : "not found on PATH"
  );

  console.log("");
  console.log(chalk.bold("Hosted MCP guidance"));
  console.log(
    "- This doctor confirms local auth and hosted reachability; it does not prove how a specific agent UI ranked or exposed tools."
  );
  console.log(
    "- If an agent session shows only a subset of Snipara tools, call snipara_help(list_all=true) in that session before concluding a tool is unavailable."
  );
  if (toolCatalog.available && toolCatalog.htaskToolCount) {
    console.log(
      "- If the hosted catalog includes htask tools but Codex only exposed the core trio, reference snipara_htask_create, snipara_htask_create_feature, snipara_htask_tree, or snipara_htask_recommend_batch explicitly in the session to trigger lazy discovery."
    );
  }

  console.log("");
  console.log(chalk.bold("Snipara Sandbox guidance"));
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
    console.log("- Manual install: pip install 'snipara-sandbox[all]'.");
  }

  console.log("");
  console.log(chalk.bold("Snipara Orchestrator guidance"));
  if (report.orchestrator.cliAvailable) {
    console.log("- Use snipara-orchestrator explicitly for production proof gates.");
    console.log(
      "- For shared task queues or multi-agent coordination, prefer snipara-orchestrator as the primary path."
    );
    console.log(
      "- Bootstrap or resume the shared coordination layer with snipara-orchestrator swarm-create | swarm-join when a swarm does not already exist."
    );
    console.log(
      "- Primary multi-agent path: snipara-orchestrator swarm-create | swarm-join | htask-create-feature | htask-create | htask-next | htask-tree | htask-complete."
    );
    console.log(
      "- Companion may retain legacy direct hosted passthrough commands, but htasks belong to the orchestrator workflow surface."
    );
  } else {
    console.log("- Existing project: npx create-snipara repair --with-orchestrator.");
    console.log("- Manual install: pip install snipara-orchestrator.");
    console.log("- Companion does not install or run orchestrator automatically.");
    console.log(
      "- Install orchestrator before using hosted htasks or swarm coordination as a workflow surface."
    );
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
  return report.orchestrator.version ? `available (${report.orchestrator.version})` : "available";
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
