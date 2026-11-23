/**
 * Companion's own local state (`.snipara/` folders) is not part of the work being changed.
 * One helper so every dirty-file count agrees: a `.snipara` segment at any depth
 * (top level or nested, e.g. `packages/cli/.snipara/collaboration/`) is ignored.
 */
export function isLocalStatePath(filePath: string): boolean {
  return filePath.replace(/\\/g, "/").replace(/^"|"$/g, "").split("/").includes(".snipara");
}

/** True when a `git status --short|--porcelain` line (`XY path` or `XY from -> to`) only concerns local state. */
export function isLocalStateStatusLine(line: string): boolean {
  const body = line.replace(/^[ MADRCTU?!]{1,2}\s+/, "");
  const target = body.includes(" -> ") ? body.slice(body.lastIndexOf(" -> ") + 4) : body;
  return isLocalStatePath(target.trim());
}

/** Drop status lines that only concern `.snipara` local state, at any depth. */
export function withoutLocalStateStatusLines(lines: string[]): string[] {
  return lines.filter((line) => !isLocalStateStatusLine(line));
}

/** Drop paths that have a `.snipara` segment at any depth. */
export function withoutLocalStatePaths(paths: string[]): string[] {
  return paths.filter((file) => !isLocalStatePath(file));
}

/**
 * Pathspec tail for `git status`: keeps `.snipara` local state out at any depth, and, unlike a
 * line filter alone, stops git from collapsing an untracked parent folder into one dirty entry.
 */
export const LOCAL_STATE_STATUS_PATHSPEC = ["--", ":(top)", ":(top,exclude,glob)**/.snipara/**"];
