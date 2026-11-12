import { execFileSync } from "node:child_process";
import path from "node:path";

/** Preserve hook index selection when pnpm changes cwd to packages/cli. */
export function hookGitEnvironment(cwd: string, source = process.env): Record<string, string | undefined> {
  const env = { ...source };
  const origin = source.SNIPARA_WORKSPACE_DIR || source.INIT_CWD || source.PWD || cwd;
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) {
    if (env[key]) env[key] = path.resolve(origin, env[key]!);
  }
  return env;
}

export function readStagedPaths(cwd: string, source = process.env): string[] {
  try {
    return execFileSync("git", ["diff", "--cached", "--name-only", "--no-relative", "-z", "--diff-filter=ACDMRTUXB"], {
      cwd, env: hookGitEnvironment(cwd, source), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).split("\0").filter(Boolean);
  } catch {
    throw new Error("Cannot read staged files from the hook index; check GIT_DIR and GIT_INDEX_FILE.");
  }
}
