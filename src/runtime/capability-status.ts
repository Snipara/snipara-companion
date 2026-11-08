/** Discovery is an observation, never authority to execute or proof of qualification. */
import type { RuntimeDetectionReport } from "./detection";

type DiscoveryState = "found" | "missing" | "not_checked";

export interface RuntimeCapabilityStatus {
  schema_version: "snipara.runtime.capability_status.v1";
  execution_authorized: false;
  surfaces: Array<{
    id: "restricted_python" | "deterministic_validation" | "provider_native" | "orchestrator";
    executable: DiscoveryState;
    configuration: "observed" | "not_observed" | "not_checked";
    endpoint: "not_checked";
    authentication: "not_checked" | "not_required";
    permissions: "not_checked";
    task_qualification: "unqualified";
    execution_authorized: false;
    docker_cli?: DiscoveryState;
    prepared_image?: "not_checked";
    workspace_binding?: "not_checked";
    verified_test?: "not_checked";
    qualification_scope?: "macOS/Linux with a local Docker daemon";
    next_action: string;
  }>;
}

/** Only non-secret process settings are passed to local discovery subprocesses. */
export function diagnosticProbeEnvironment(
  env: Record<string, string | undefined> = process.env
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT"]) {
    if (env[name] !== undefined) result[name] = env[name];
  }
  return result;
}

export function summarizeRuntimeCapabilities(report: RuntimeDetectionReport): RuntimeCapabilityStatus {
  const common = {
    endpoint: "not_checked" as const,
    permissions: "not_checked" as const,
    task_qualification: "unqualified" as const,
    execution_authorized: false as const,
  };
  const validationCli = report.runtime.cliAvailable && report.runtime.legacyCommand !== true;
  return {
    schema_version: "snipara.runtime.capability_status.v1",
    execution_authorized: false,
    surfaces: [
      {
        ...common, id: "restricted_python", executable: "not_checked",
        configuration: report.runtime.mcpConfigured ? "observed" : "not_observed",
        authentication: "not_checked",
        next_action: "Probe the configured Sandbox MCP execute_python surface; restricted snippets do not qualify repository tests.",
      },
      {
        ...common, id: "deterministic_validation", executable: validationCli ? "found" : "missing",
        configuration: "not_checked", authentication: "not_required",
        docker_cli: report.docker.available ? "found" : "missing",
        prepared_image: "not_checked", workspace_binding: "not_checked", verified_test: "not_checked",
        qualification_scope: "macOS/Linux with a local Docker daemon",
        next_action: !validationCli
          ? "Locate the standalone snipara-sandbox validation CLI; installing or configuring it requires an explicit choice."
          : !report.docker.available
            ? "Locate the Docker CLI and explicitly configure a local daemon, or choose another test environment."
            : "Review an immutable request, then run validation diagnose --request <file> and validation gate --request <file> --scope <lot>; readiness is not a passing test.",
      },
      {
        ...common, id: "provider_native", executable: "not_checked", configuration: "not_checked",
        authentication: "not_checked",
        next_action: "Discover the selected native client, then separately verify its endpoint, authentication, permissions and a bounded task receipt.",
      },
      {
        ...common, id: "orchestrator", executable: report.orchestrator.cliAvailable ? "found" : "missing",
        configuration: "not_checked", authentication: "not_checked",
        next_action: report.orchestrator.cliAvailable
          ? "Inspect the selected adapter and its exact task preflight; CLI discovery grants no endpoint, permission or execution qualification."
          : "Locate snipara-orchestrator on PATH or in the workspace environment; installation remains an explicit choice.",
      },
    ],
  };
}
