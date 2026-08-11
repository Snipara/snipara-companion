import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const VERSION_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const VERSION_CHECK_TIMEOUT_MS = 1800;

interface VersionCheckCache {
  checkedAt: string;
  latestVersion: string;
}

function cachePath(): string {
  return path.join(os.homedir(), ".snipara", "companion", "version-check.json");
}

function hardenCachePath(file: string): void {
  if (process.platform === "win32") {
    return;
  }
  try {
    fs.chmodSync(path.dirname(file), 0o700);
    if (fs.existsSync(file)) {
      fs.chmodSync(file, 0o600);
    }
  } catch {
    // Version checks are advisory and must never block the requested command.
  }
}

function readFreshCache(file: string): VersionCheckCache | null {
  try {
    hardenCachePath(file);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<VersionCheckCache>;
    const checkedAt = Date.parse(parsed.checkedAt || "");
    if (
      !Number.isFinite(checkedAt) ||
      Date.now() - checkedAt > VERSION_CHECK_TTL_MS ||
      typeof parsed.latestVersion !== "string"
    ) {
      return null;
    }
    return {
      checkedAt: parsed.checkedAt!,
      latestVersion: parsed.latestVersion,
    };
  } catch {
    return null;
  }
}

function writeCache(file: string, latestVersion: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      file,
      JSON.stringify({ checkedAt: new Date().toISOString(), latestVersion }, null, 2),
      { encoding: "utf8", mode: 0o600 }
    );
    hardenCachePath(file);
  } catch {
    // A read-only home directory should not make the CLI command fail.
  }
}

function versionTuple(version: string): [number, number, number] | null {
  const match = version
    .trim()
    .replace(/^v/, "")
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isNewerVersion(candidate: string, current: string): boolean {
  const next = versionTuple(candidate);
  const installed = versionTuple(current);
  if (!next || !installed) {
    return false;
  }
  for (let index = 0; index < next.length; index += 1) {
    if (next[index] !== installed[index]) {
      return next[index] > installed[index];
    }
  }
  return false;
}

function resolveLatestVersion(): string | null {
  const file = cachePath();
  const cached = readFreshCache(file);
  if (cached) {
    return cached.latestVersion;
  }

  try {
    const latestVersion = execFileSync("npm", ["view", "snipara-companion", "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: VERSION_CHECK_TIMEOUT_MS,
    }).trim();
    if (latestVersion) {
      writeCache(file, latestVersion);
      return latestVersion;
    }
  } catch {
    // Offline and registry failures are intentionally silent.
  }
  return null;
}

export function warnIfCompanionUpdateAvailable(currentVersion: string): void {
  if (process.env.SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK === "1" || Boolean(process.env.CI)) {
    return;
  }

  const latestVersion = resolveLatestVersion();
  if (!latestVersion || !isNewerVersion(latestVersion, currentVersion)) {
    return;
  }

  process.stderr.write(
    `\n⚠️  snipara-companion ${currentVersion} is outdated; ${latestVersion} is available. ` +
      "Run `npx -y snipara-companion@latest --help` before debugging unexpected behavior.\n\n"
  );
}
