/**
 * Project identifier resolution.
 *
 * Resolves which Snipara project the current workspace maps to via a documented
 * cascade (flag → env → .snipara/project → package.json#name → git remote → cwd
 * basename); see `resolveProject` for the precise order. Returns both the
 * identifier and which source won, for diagnostics and `init`.
 */
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

export interface ResolveOptions {
  /** Explicit value passed via CLI flag (--project). Highest priority. */
  flag?: string;
  /** Directory to start resolution from. Defaults to process.cwd(). */
  cwd?: string;
}

export interface ResolvedProject {
  /** The identifier sent to the server (slug, owner/repo, or cuid). */
  identifier: string;
  /** Which source won the cascade. Useful for diagnostics and `snipara init`. */
  source: "flag" | "env" | "snipara-file" | "package-json" | "git-remote" | "cwd-basename";
}

const SNIPARA_PROJECT_FILENAME = "project";
const SNIPARA_DIR = ".snipara";

/**
 * Resolve the project identifier for the current workspace.
 *
 * Cascade (first hit wins):
 *   1. Explicit --project flag
 *   2. SNIPARA_PROJECT env var
 *   3. .snipara/project file (walks up from cwd to find one)
 *   4. package.json#name (walks up)
 *   5. git remote origin URL → "owner/repo"
 *   6. basename(cwd)
 */
export function resolveProject(opts: ResolveOptions = {}): ResolvedProject {
  const cwd = opts.cwd ?? process.cwd();

  if (opts.flag && opts.flag.trim()) {
    return { identifier: opts.flag.trim(), source: "flag" };
  }

  const envValue = process.env.SNIPARA_PROJECT;
  if (envValue && envValue.trim()) {
    return { identifier: envValue.trim(), source: "env" };
  }

  const sniparaFile = findUpward(cwd, path.join(SNIPARA_DIR, SNIPARA_PROJECT_FILENAME));
  if (sniparaFile) {
    try {
      const value = fs.readFileSync(sniparaFile, "utf-8").trim();
      if (value) return { identifier: value, source: "snipara-file" };
    } catch {
      // Ignore read errors, fall through
    }
  }

  const pkgJsonName = readPackageJsonName(cwd);
  if (pkgJsonName) {
    return { identifier: pkgJsonName, source: "package-json" };
  }

  const gitRepo = readGitRemote(cwd);
  if (gitRepo) {
    return { identifier: gitRepo, source: "git-remote" };
  }

  return { identifier: path.basename(cwd), source: "cwd-basename" };
}

/**
 * Walk up the directory tree looking for a relative file path. Returns the
 * absolute path if found, otherwise null. Stops at the filesystem root.
 */
function findUpward(startDir: string, relative: string): string | null {
  let dir = path.resolve(startDir);
  // Resolve real path once to handle symlinks
  try {
    dir = fs.realpathSync(dir);
  } catch {
    // fallback to lexical path
  }

  while (true) {
    const candidate = path.join(dir, relative);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Walk up to find a package.json with a non-empty "name" field. Returns the
 * name slug-ified to lowercase and scoped names stripped (e.g. "@org/foo" → "foo").
 */
function readPackageJsonName(cwd: string): string | null {
  const pkgPath = findUpward(cwd, "package.json");
  if (!pkgPath) return null;
  try {
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as { name?: unknown };
    if (typeof pkg.name !== "string" || !pkg.name.trim()) return null;
    const name = pkg.name.trim();
    // Strip npm scope: "@scope/name" → "name"
    const unscoped = name.startsWith("@") ? name.split("/")[1] : name;
    return unscoped || null;
  } catch {
    return null;
  }
}

/**
 * Read `git remote origin` and parse it into "owner/repo" form. Supports:
 *   - git@github.com:owner/repo.git
 *   - https://github.com/owner/repo.git
 *   - ssh://git@github.com/owner/repo
 * Returns null on any failure (not a git repo, no remote, unrecognized format).
 */
function readGitRemote(cwd: string): string | null {
  let url: string;
  try {
    url = execSync("git config --get remote.origin.url", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }

  if (!url) return null;

  // Match the final two path segments before an optional .git suffix
  const match = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

/**
 * Human-readable explanation of which source produced the identifier.
 * Used by `snipara init` (dry-run) to show the user what will be sent.
 */
export function describeSource(source: ResolvedProject["source"]): string {
  switch (source) {
    case "flag":
      return "CLI flag --project";
    case "env":
      return "environment variable SNIPARA_PROJECT";
    case "snipara-file":
      return ".snipara/project file";
    case "package-json":
      return "package.json#name";
    case "git-remote":
      return "git remote origin";
    case "cwd-basename":
      return "current directory name";
  }
}
