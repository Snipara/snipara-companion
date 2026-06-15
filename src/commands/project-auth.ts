/**
 * Project authorization and binding helpers.
 *
 * Runs the project-scoped device-code OAuth flow, collects local project hints
 * (to preselect a project), and writes the resolved project binding next to the
 * companion config. Shared by `login` and `init` so project resolution behaves
 * identically across both entry points.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { getConfigPath } from "../config/store";

const PROJECT_DEVICE_CLIENT_ID = "snipara-companion";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEVICE_POLL_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_DEVICE_POLL_INTERVAL_SECONDS = 5;

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri_complete: string;
  expires_in: number;
  interval?: number;
}

interface ProjectDeviceTokenResponse {
  api_key?: string;
  project_id?: string;
  project_slug?: string;
  project_name?: string;
  server_url?: string;
}

export interface LocalProjectSignal {
  source: string;
  value: string;
}

export interface LocalProjectHints {
  identifiers: LocalProjectSignal[];
  githubRepo: string | null;
}

export interface ProjectDeviceAuthorizationResult {
  apiKey: string;
  projectId: string;
  projectSlug: string;
  projectName?: string;
  serverUrl?: string;
}

interface SniparaStoredToken {
  project_slug?: string;
  project_id?: string;
  api_key?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openBrowser(url: string): void {
  try {
    if (process.platform === "darwin") {
      execFileSync("open", [url], { stdio: "ignore" });
    } else if (process.platform === "win32") {
      execFileSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
    } else {
      execFileSync("xdg-open", [url], { stdio: "ignore" });
    }
  } catch {
    // The URL is printed for manual opening.
  }
}

function getSniparaTokenStorePath(): string {
  return path.join(os.homedir(), ".snipara", "tokens.json");
}

function rememberProjectApiKey(projectId: string, projectSlug: string, apiKey: string): void {
  const tokensPath = getSniparaTokenStorePath();
  let tokens: Record<string, SniparaStoredToken> = {};

  if (fs.existsSync(tokensPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(tokensPath, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        tokens = parsed as Record<string, SniparaStoredToken>;
      }
    } catch {
      tokens = {};
    }
  }

  tokens[projectId] = {
    ...(tokens[projectId] ?? {}),
    project_id: projectId,
    project_slug: projectSlug,
    api_key: apiKey,
  };

  fs.mkdirSync(path.dirname(tokensPath), { recursive: true });
  fs.writeFileSync(tokensPath, `${JSON.stringify(tokens, null, 2)}\n`, "utf8");
}

export function writeProjectBinding(projectDir: string, projectSlug: string): void {
  const bindingDir = path.join(projectDir, ".snipara");
  const bindingPath = path.join(bindingDir, "project");
  fs.mkdirSync(bindingDir, { recursive: true });
  fs.writeFileSync(bindingPath, `${projectSlug}\n`, "utf8");
}

function normalizeLocalProjectValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().replace(/^["']|["']$/g, "");
  if (
    !trimmed ||
    /^your_/i.test(trimmed) ||
    /^YOUR_/.test(trimmed) ||
    trimmed.includes("<") ||
    trimmed.includes(">")
  ) {
    return null;
  }

  return trimmed;
}

function slugifyProjectValue(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return slug || null;
}

function addLocalIdentifier(
  identifiers: LocalProjectSignal[],
  seen: Set<string>,
  source: string,
  value: unknown
): void {
  const normalized = normalizeLocalProjectValue(value);
  if (!normalized) {
    return;
  }

  const key = normalized.toLowerCase();
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  identifiers.push({ source, value: normalized });
}

function readWorkspaceCompanionProject(projectDir: string): string | null {
  const configPath = getConfigPath({ cwd: projectDir, scope: "workspace" });
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    return normalizeLocalProjectValue(parsed.projectId ?? parsed.project_id ?? parsed.project);
  } catch {
    return null;
  }
}

function readProjectBinding(projectDir: string): string | null {
  const bindingPath = path.join(projectDir, ".snipara", "project");
  if (!fs.existsSync(bindingPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(bindingPath, "utf8").trim();
    if (!content) {
      return null;
    }

    if (content.startsWith("{")) {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      return normalizeLocalProjectValue(
        parsed.projectId ?? parsed.project_id ?? parsed.slug ?? parsed.projectSlug ?? parsed.project
      );
    }

    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const keyed = trimmed.match(
        /^(?:id|projectId|project_id|slug|project|projectSlug|project_slug)\s*[:=]\s*(.+)$/i
      );
      if (keyed?.[1]) {
        return normalizeLocalProjectValue(keyed[1].replace(/\s+#.*$/, ""));
      }
    }

    return normalizeLocalProjectValue(
      content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith("#"))
    );
  } catch {
    return null;
  }
}

function extractProjectSlugFromMcpUrl(value: unknown): string | null {
  const endpoint = normalizeLocalProjectValue(value);
  if (!endpoint) {
    return null;
  }

  const match = endpoint.match(/\/mcp\/([^/?#\s"']+)/);
  return match?.[1] ? normalizeLocalProjectValue(decodeURIComponent(match[1])) : null;
}

function readProjectFromMcpJson(projectDir: string): string | null {
  const configPath = path.join(projectDir, ".mcp.json");
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      mcpServers?: Record<string, { url?: unknown }>;
    };

    for (const [serverName, serverConfig] of Object.entries(parsed.mcpServers ?? {})) {
      const endpointSlug = extractProjectSlugFromMcpUrl(serverConfig?.url);
      if (endpointSlug) {
        return endpointSlug;
      }

      const serverSlug = normalizeLocalProjectValue(serverName);
      if (serverSlug && !["snipara", "snipara-sandbox", "rlm-runtime"].includes(serverSlug)) {
        return serverSlug;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeGitHubRepo(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  const patterns = [
    /^git@github\.com:(.+?)(?:\.git)?$/i,
    /^https?:\/\/github\.com\/(.+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/(.+?)(?:\.git)?$/i,
    /^git:\/\/github\.com\/(.+?)(?:\.git)?$/i,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (!match?.[1]) {
      continue;
    }

    const normalized = match[1].replace(/^\/+/, "").replace(/\/+$/, "");
    return normalized || null;
  }

  return null;
}

function detectGitHubRepo(projectDir: string): string | null {
  try {
    const remoteUrl = execFileSync(
      "git",
      ["-C", projectDir, "config", "--get", "remote.origin.url"],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    ).trim();
    return remoteUrl ? normalizeGitHubRepo(remoteUrl) : null;
  } catch {
    return null;
  }
}

function repoSlugFromGitHubRepo(githubRepo: string | null): string | null {
  if (!githubRepo) {
    return null;
  }

  const repoName = githubRepo.split("/").pop() || "";
  return slugifyProjectValue(repoName.replace(/\.git$/i, ""));
}

export function collectLocalProjectHints(projectDir: string): LocalProjectHints {
  const identifiers: LocalProjectSignal[] = [];
  const seen = new Set<string>();
  const githubRepo = detectGitHubRepo(projectDir);

  addLocalIdentifier(
    identifiers,
    seen,
    ".snipara/companion/config.json",
    readWorkspaceCompanionProject(projectDir)
  );
  addLocalIdentifier(identifiers, seen, ".snipara/project", readProjectBinding(projectDir));
  addLocalIdentifier(identifiers, seen, ".mcp.json", readProjectFromMcpJson(projectDir));
  addLocalIdentifier(identifiers, seen, "git remote repo slug", repoSlugFromGitHubRepo(githubRepo));

  return { identifiers, githubRepo };
}

export function addExplicitProjectHint(
  hints: LocalProjectHints,
  value?: string
): LocalProjectHints {
  const normalized = normalizeLocalProjectValue(value);
  if (!normalized) {
    return hints;
  }

  const identifiers = [
    { source: "--project", value: normalized },
    ...hints.identifiers.filter(
      (signal) => signal.value.toLowerCase() !== normalized.toLowerCase()
    ),
  ];
  return { ...hints, identifiers };
}

function appendDeviceFlowHints(url: string, hints: LocalProjectHints): string {
  try {
    const parsed = new URL(url);
    const projectHint = hints.identifiers[0]?.value;
    if (projectHint) {
      parsed.searchParams.set("project_hint", projectHint);
    }
    if (hints.githubRepo) {
      parsed.searchParams.set("repo_hint", hints.githubRepo);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function setupClientToDeviceClientId(client?: string): string {
  const normalized = typeof client === "string" ? client.trim().toLowerCase() : undefined;
  if (
    normalized === "claude-code" ||
    normalized === "cursor" ||
    normalized === "windsurf" ||
    normalized === "gemini" ||
    normalized === "codex" ||
    normalized === "mistral" ||
    normalized === "continue"
  ) {
    return normalized;
  }

  return PROJECT_DEVICE_CLIENT_ID;
}

async function startProjectDeviceFlow(args: {
  apiUrl: string;
  clientId: string;
}): Promise<DeviceCodeResponse> {
  const response = await fetch(`${args.apiUrl}/api/oauth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: args.clientId,
      scope: "mcp:read mcp:write",
      auto_provision: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`device/code failed (${response.status}): ${body}`);
  }

  return (await response.json()) as DeviceCodeResponse;
}

async function pollForProjectDeviceToken(args: {
  apiUrl: string;
  clientId: string;
  deviceCode: string;
  intervalSeconds?: number;
}): Promise<ProjectDeviceTokenResponse> {
  const deadline = Date.now() + DEVICE_POLL_TIMEOUT_MS;
  let intervalMs = Math.max(1, args.intervalSeconds ?? DEFAULT_DEVICE_POLL_INTERVAL_SECONDS) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    const response = await fetch(`${args.apiUrl}/api/oauth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: DEVICE_GRANT_TYPE,
        device_code: args.deviceCode,
        client_id: args.clientId,
      }),
    });

    if (response.ok) {
      return (await response.json()) as ProjectDeviceTokenResponse;
    }

    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      error_description?: string;
    };

    switch (body.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalMs += 5000;
        continue;
      case "access_denied":
        throw new Error("Authorization denied in browser");
      case "expired_token":
        throw new Error("Device code expired. Run `npx -y snipara-companion@latest init` again.");
      default:
        throw new Error(body.error_description || body.error || response.statusText);
    }
  }

  throw new Error("Authorization timed out. Run `npx -y snipara-companion@latest init` again.");
}

export async function runProjectDeviceAuthorization(args: {
  apiUrl: string;
  client?: string;
  localProjectHints: LocalProjectHints;
}): Promise<ProjectDeviceAuthorizationResult> {
  const clientId = setupClientToDeviceClientId(args.client);
  const device = await startProjectDeviceFlow({ apiUrl: args.apiUrl, clientId });
  const verificationUrl = appendDeviceFlowHints(
    device.verification_uri_complete,
    args.localProjectHints
  );

  console.log("Opening browser to authorize this workspace...");
  console.log(`\n  Verification URL: ${verificationUrl}`);
  console.log("  Select the project/repo this workspace should use.");
  console.log(`  If it doesn't open, paste the code: ${device.user_code}\n`);

  openBrowser(verificationUrl);

  console.log("Waiting for browser authorization...");
  const token = await pollForProjectDeviceToken({
    apiUrl: args.apiUrl,
    clientId,
    deviceCode: device.device_code,
    intervalSeconds: device.interval,
  });

  if (!token.api_key) {
    throw new Error("Device authorization completed but no Snipara API key was returned.");
  }
  if (!token.project_id || !token.project_slug) {
    throw new Error("Device authorization completed but no project was selected.");
  }

  console.log(
    token.project_name
      ? `✓ Authorized project: ${token.project_name}`
      : `✓ Authorized project: ${token.project_slug}`
  );
  rememberProjectApiKey(token.project_id, token.project_slug, token.api_key);

  return {
    apiKey: token.api_key,
    projectId: token.project_id,
    projectSlug: token.project_slug,
    projectName: token.project_name,
    serverUrl: token.server_url,
  };
}
