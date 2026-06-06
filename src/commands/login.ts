import { saveConfig, loadConfig, getConfigPath } from "../config/store";
import { execSync } from "child_process";
import {
  addExplicitProjectHint,
  collectLocalProjectHints,
  runProjectDeviceAuthorization,
  writeProjectBinding,
} from "./project-auth";

const USER_KEY_CLIENT_ID = "snipara-cli";
const CLIENT_VERSION = "1.1.20";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const MAX_POLL_DURATION_MS = 15 * 60 * 1000; // 15 min

interface LoginCommandOptions {
  apiUrl?: string;
  client?: string;
  project?: string;
  dir?: string;
  userKey?: boolean;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval?: number;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  key_type?: "user" | "team";
  user?: { id: string; email: string; name: string | null };
  team?: { id: string; slug: string; name: string };
  server_url?: string;
}

/**
 * Best-effort browser open. Silent if unavailable — we also print the URL.
 */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? `open ${JSON.stringify(url)}`
      : process.platform === "win32"
        ? `start "" ${JSON.stringify(url)}`
        : `xdg-open ${JSON.stringify(url)}`;
  try {
    execSync(cmd, { stdio: "ignore" });
  } catch {
    // User will open the URL manually from the printed output
  }
}

async function startDeviceFlow(apiUrl: string): Promise<DeviceCodeResponse> {
  const res = await fetch(`${apiUrl}/api/oauth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: USER_KEY_CLIENT_ID, auto_provision: true }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`device/code failed (${res.status}): ${body}`);
  }
  return (await res.json()) as DeviceCodeResponse;
}

async function pollForToken(
  apiUrl: string,
  deviceCode: string,
  intervalSeconds: number
): Promise<TokenResponse> {
  const deadline = Date.now() + MAX_POLL_DURATION_MS;
  let interval = intervalSeconds * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));

    const res = await fetch(`${apiUrl}/api/oauth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: GRANT_TYPE,
        device_code: deviceCode,
        client_id: USER_KEY_CLIENT_ID,
        client_version: CLIENT_VERSION,
      }),
    });

    if (res.ok) {
      return (await res.json()) as TokenResponse;
    }

    const body = (await res.json().catch(() => ({}))) as { error?: string };
    switch (body.error) {
      case "authorization_pending":
        // Keep polling at the same cadence
        continue;
      case "slow_down":
        interval += 5000;
        continue;
      case "access_denied":
        throw new Error("Authorization denied by user");
      case "expired_token":
        throw new Error("Code expired. Run `snipara-companion login --user-key` again.");
      default:
        throw new Error(`Unexpected error: ${body.error ?? res.statusText}`);
    }
  }

  throw new Error("Login timed out (15 min). Run `snipara-companion login --user-key` again.");
}

function createSessionId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * `snipara-companion login` — project-scoped browser device-code flow that
 * writes auth and project selection to the active companion config.
 */
export async function loginCommand(options: LoginCommandOptions = {}): Promise<void> {
  const projectDir = options.dir || process.cwd();
  const config = loadConfig({ cwd: projectDir });
  const apiUrl = options.apiUrl ?? config.apiUrl;

  if (options.userKey) {
    await userKeyLoginCommand(apiUrl);
    return;
  }

  console.log("\nSnipara project login\n");

  const localProjectHints = addExplicitProjectHint(
    collectLocalProjectHints(projectDir),
    options.project ?? config.projectId
  );
  const authorization = await runProjectDeviceAuthorization({
    apiUrl,
    client: options.client ?? config.client,
    localProjectHints,
  });

  saveConfig(
    {
      apiKey: authorization.apiKey,
      apiUrl: authorization.serverUrl ?? apiUrl,
      projectId: authorization.projectId,
      sessionId: createSessionId(),
      ...(options.client ? { client: options.client } : {}),
    },
    { cwd: projectDir, scope: "auto" }
  );
  writeProjectBinding(projectDir, authorization.projectSlug);

  console.log(`✓ API key and project saved to ${getConfigPath({ cwd: projectDir })}`);
  console.log(`✓ Workspace project binding: ${authorization.projectSlug}`);
  console.log(
    "\nYou can now run `npx -y snipara-companion@latest init --with-hooks` for this workspace.\n"
  );
}

async function userKeyLoginCommand(apiUrl: string): Promise<void> {
  console.log("\nSnipara user-key login\n");

  const device = await startDeviceFlow(apiUrl);

  console.log("Opening browser to authorize this device...");
  console.log(`\n  Verification URL: ${device.verification_uri_complete}`);
  console.log(`  If it doesn't open, paste the code: ${device.user_code}\n`);

  openBrowser(device.verification_uri_complete);

  console.log("Waiting for authorization...");
  const token = await pollForToken(
    apiUrl,
    device.device_code,
    device.interval ?? DEFAULT_POLL_INTERVAL_SECONDS
  );

  if (token.key_type !== "user" && token.key_type !== "team") {
    throw new Error("Server returned an unexpected token shape. Expected a user API key.");
  }

  // Write to the active companion config so auth and project selection do not
  // split across multiple local files.
  saveConfig(
    {
      apiKey: token.access_token,
      sessionId: createSessionId(),
    },
    { scope: "auto" }
  );

  if (token.key_type === "team" && token.team) {
    console.log(`\n✓ Logged in with legacy team key "${token.team.name}" (${token.team.slug})`);
  } else if (token.user) {
    console.log(`\n✓ Logged in as ${token.user.email}`);
  } else {
    console.log("\n✓ Logged in");
  }
  console.log(`✓ API key saved to ${getConfigPath()}`);
  console.log("\nThis legacy user key is not project-bound.");
  console.log("For agent setup, prefer `npx -y snipara-companion@latest init` or project login.\n");
}
