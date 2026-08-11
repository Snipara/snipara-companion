/**
 * Companion configuration store + workspace resolution.
 *
 * Loads and saves the companion config (RLMConfig: apiKey, projectId, apiUrl,
 * sessionId, client) and resolves the active workspace root by walking up from
 * the cwd for WORKSPACE_MARKERS (.git, .snipara, package.json, …). Config can be
 * scoped auto / workspace / global. `isConfigured()` is the gate most commands
 * use before making hosted calls.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface RLMConfig {
  apiKey?: string;
  projectId?: string;
  apiUrl: string;
  sessionId?: string;
  client?: string;
}

export type ConfigScope = "auto" | "workspace" | "global";

export interface ConfigResolutionOptions {
  cwd?: string;
  scope?: ConfigScope;
}

const DEFAULT_CONFIG: RLMConfig = {
  apiUrl: "https://api.snipara.com",
};

const WORKSPACE_MARKERS = [
  ".git",
  ".snipara",
  ".claude",
  ".cursor",
  ".kimi-code",
  ".vibe",
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
];

function defaultCwd(): string {
  return process.env.SNIPARA_WORKSPACE_DIR || process.cwd();
}

function getGlobalConfigDir(): string {
  return path.join(os.homedir(), ".snipara", "companion");
}

function getGlobalConfigFile(): string {
  return path.join(getGlobalConfigDir(), "config.json");
}

function getLegacyGlobalConfigFile(): string {
  return path.join(os.homedir(), ".rlmsaas", "config.json");
}

/**
 * Ensure the config directory exists
 */
function ensureConfigDir(configFile: string): void {
  const configDir = path.dirname(configFile);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(configDir, 0o700);
    } catch {
      // Best effort on filesystems that do not expose POSIX permission bits.
    }
  }
}

function hardenConfigPermissions(configFile: string): void {
  if (process.platform === "win32" || !fs.existsSync(configFile)) {
    return;
  }

  try {
    fs.chmodSync(path.dirname(configFile), 0o700);
    fs.chmodSync(configFile, 0o600);
  } catch {
    // Reading existing configuration should not fail on non-POSIX filesystems.
  }
}

function hasWorkspaceMarker(dir: string): boolean {
  return WORKSPACE_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker)));
}

export function findWorkspaceRoot(
  startDir: string,
  allowCurrentDirFallback: boolean = false
): string | null {
  let current = path.resolve(startDir);

  if (!fs.existsSync(current)) {
    current = path.dirname(current);
  }

  while (true) {
    if (hasWorkspaceMarker(current)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return allowCurrentDirFallback ? path.resolve(startDir) : null;
}

function getWorkspaceConfigFile(
  cwd: string = process.cwd(),
  allowCurrentDirFallback: boolean = false
): string | null {
  const workspaceRoot = findWorkspaceRoot(cwd, allowCurrentDirFallback);
  if (!workspaceRoot) {
    return null;
  }

  return path.join(workspaceRoot, ".snipara", "companion", "config.json");
}

function readConfigFile(configFile: string): Partial<RLMConfig> {
  if (fs.existsSync(configFile)) {
    try {
      hardenConfigPermissions(configFile);
      const content = fs.readFileSync(configFile, "utf-8");
      const config = JSON.parse(content);
      return typeof config === "object" && config !== null ? (config as Partial<RLMConfig>) : {};
    } catch {
      return {};
    }
  }

  return {};
}

function readWorkspaceProjectFile(cwd: string = process.cwd()): string | undefined {
  const workspaceRoot = findWorkspaceRoot(cwd);
  if (!workspaceRoot) {
    return undefined;
  }

  const projectFile = path.join(workspaceRoot, ".snipara", "project");
  if (!fs.existsSync(projectFile)) {
    return undefined;
  }

  try {
    const content = fs.readFileSync(projectFile, "utf-8").trim();
    if (!content) {
      return undefined;
    }

    if (content.startsWith("{")) {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const projectId = parsed.projectId ?? parsed.project_id ?? parsed.slug ?? parsed.project;
      return typeof projectId === "string" && projectId.trim() ? projectId.trim() : undefined;
    }

    return content.split(/\r?\n/)[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function envOverride(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function applyEnvOverrides(
  config: RLMConfig,
  options: { protectApiKey?: boolean; protectProjectId?: boolean } = {}
): RLMConfig {
  return {
    ...config,
    apiKey: options.protectApiKey
      ? config.apiKey
      : (envOverride("SNIPARA_API_KEY") ?? config.apiKey),
    projectId: options.protectProjectId
      ? config.projectId
      : (envOverride("SNIPARA_PROJECT_ID") ?? config.projectId),
    apiUrl: envOverride("SNIPARA_API_URL") ?? config.apiUrl,
    sessionId: envOverride("SNIPARA_SESSION_ID") ?? config.sessionId,
    client: envOverride("SNIPARA_AUTOMATION_CLIENT") ?? config.client,
  };
}

function resolveConfigFile(options: ConfigResolutionOptions = {}): string {
  const scope = options.scope ?? "auto";
  if (scope === "global") {
    return getGlobalConfigFile();
  }

  const workspaceFile = getWorkspaceConfigFile(options.cwd ?? defaultCwd(), scope === "workspace");
  if (workspaceFile) {
    return workspaceFile;
  }

  return getGlobalConfigFile();
}

/**
 * Load configuration from disk
 */
export function loadConfig(options: ConfigResolutionOptions = {}): RLMConfig {
  const cwd = options.cwd ?? defaultCwd();
  const globalConfig = readConfigFile(getGlobalConfigFile());
  const legacyGlobalConfig = readConfigFile(getLegacyGlobalConfigFile());
  const workspaceConfigFile = getWorkspaceConfigFile(cwd);
  const workspaceConfig = workspaceConfigFile ? readConfigFile(workspaceConfigFile) : {};
  const workspaceProjectId = readWorkspaceProjectFile(cwd);

  return applyEnvOverrides(
    {
      ...DEFAULT_CONFIG,
      ...legacyGlobalConfig,
      ...globalConfig,
      ...workspaceConfig,
      projectId:
        workspaceConfig.projectId ??
        workspaceProjectId ??
        globalConfig.projectId ??
        legacyGlobalConfig.projectId,
    },
    {
      protectApiKey:
        typeof workspaceConfig.apiKey === "string" && workspaceConfig.apiKey.length > 0,
      protectProjectId:
        (typeof workspaceConfig.projectId === "string" && workspaceConfig.projectId.length > 0) ||
        Boolean(workspaceProjectId),
    }
  );
}

/**
 * Save configuration to disk
 */
export function saveConfig(
  config: Partial<RLMConfig>,
  options: ConfigResolutionOptions = {}
): void {
  const configFile = resolveConfigFile(options);
  ensureConfigDir(configFile);

  const existing = readConfigFile(configFile);
  const merged = { ...existing, ...config };

  fs.writeFileSync(configFile, JSON.stringify(merged, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  hardenConfigPermissions(configFile);
}

/**
 * Get a specific config value
 */
export function getConfig<K extends keyof RLMConfig>(
  key: K,
  options: ConfigResolutionOptions = {}
): RLMConfig[K] {
  const config = loadConfig(options);
  return config[key];
}

/**
 * Set a specific config value
 */
export function setConfig<K extends keyof RLMConfig>(
  key: K,
  value: RLMConfig[K],
  options: ConfigResolutionOptions = {}
): void {
  saveConfig({ [key]: value }, options);
}

/**
 * Clear all configuration
 */
export function clearConfig(options: ConfigResolutionOptions = {}): void {
  const configFile = resolveConfigFile(options);
  if (fs.existsSync(configFile)) {
    fs.unlinkSync(configFile);
  }
}

/**
 * Check if the CLI is configured
 */
export function isConfigured(options: ConfigResolutionOptions = {}): boolean {
  const config = loadConfig(options);
  return !!(config.apiKey && config.projectId);
}

/**
 * Get config file path (for display purposes)
 */
export function getConfigPath(options: ConfigResolutionOptions = {}): string {
  if (options.scope === "global") {
    return getGlobalConfigFile();
  }

  const workspaceFile = getWorkspaceConfigFile(
    options.cwd ?? defaultCwd(),
    options.scope === "workspace"
  );

  if (workspaceFile && fs.existsSync(workspaceFile)) {
    return workspaceFile;
  }

  if (options.scope === "workspace" && workspaceFile) {
    return workspaceFile;
  }

  return getGlobalConfigFile();
}
