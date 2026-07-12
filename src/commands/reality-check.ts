import { execFileSync } from "node:child_process";
import path from "node:path";
import chalk from "chalk";
import {
  buildProjectRealityCheck,
  renderProjectRealityCheckMarkdown,
  type ProjectRealityCheckDecisionInput,
  type ProjectRealityCheckDocumentInput,
  type ProjectRealityCheckResult,
} from "../contracts/project-intelligence";
import { findWorkspaceRoot } from "../config/store";

export interface RealityCheckCommandOptions {
  task?: string;
  branch?: string;
  base?: string;
  changedFiles?: string[];
  diffSummary?: string;
  decision?: string[];
  document?: string[];
  verification?: string[];
  includeDirty?: boolean;
  enforce?: boolean;
  dir?: string;
  json?: boolean;
}

interface LocalRealityCheckGitScope {
  root: string;
  branch?: string;
  baseRef?: string;
  headRef?: string;
  changedFiles: string[];
  dirtyFiles: string[];
  diffSummary?: string;
  caveats: string[];
}

function runGit(
  args: string[],
  cwd: string,
  options: { preserveLeadingWhitespace?: boolean } = {}
): string | undefined {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return options.preserveLeadingWhitespace ? output.trimEnd() : output.trim();
  } catch {
    return undefined;
  }
}

function splitLines(value: string | undefined): string[] {
  return value
    ? value
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

function unique(values: Array<string | undefined>): string[] {
  return [
    ...new Set(
      values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))
    ),
  ];
}

function parseDirtyFile(line: string): string | undefined {
  if (!line.trim()) return undefined;
  const withoutStatus = line.length >= 3 ? line.slice(3).trim() : line.trim();
  const renameParts = withoutStatus.split(" -> ");
  return renameParts[renameParts.length - 1]?.replace(/^"|"$/g, "");
}

function resolveGitRoot(cwd: string): string {
  return runGit(["rev-parse", "--show-toplevel"], cwd) ?? cwd;
}

function resolveBaseRef(root: string, explicitBase?: string): string | undefined {
  if (explicitBase) return explicitBase;
  return runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root) ?? undefined;
}

function buildLocalGitScope(options: RealityCheckCommandOptions): LocalRealityCheckGitScope {
  const requestedRoot = path.resolve(options.dir ?? process.cwd());
  const workspaceRoot = findWorkspaceRoot(requestedRoot, true) ?? requestedRoot;
  const root = resolveGitRoot(workspaceRoot);
  const branch = options.branch ?? runGit(["rev-parse", "--abbrev-ref", "HEAD"], root);
  const baseRef = resolveBaseRef(root, options.base);
  const headRef = runGit(["rev-parse", "--verify", "HEAD"], root);
  const statusLines =
    runGit(["status", "--short"], root, { preserveLeadingWhitespace: true })
      ?.split(/\r?\n/g)
      .filter((line) => line.trim()) ?? [];
  const dirtyFiles = unique(statusLines.map(parseDirtyFile));
  const committedFiles = baseRef
    ? splitLines(runGit(["diff", "--name-only", `${baseRef}...HEAD`], root))
    : [];
  const cachedFiles = splitLines(runGit(["diff", "--cached", "--name-only"], root));
  const unstagedFiles = splitLines(runGit(["diff", "--name-only"], root));
  const changedFiles = unique([
    ...(options.changedFiles ?? []),
    ...committedFiles,
    ...cachedFiles,
    ...(options.includeDirty === false ? [] : unstagedFiles),
  ]);
  const diffSummary =
    options.diffSummary ??
    [
      baseRef ? runGit(["diff", "--stat", `${baseRef}...HEAD`], root) : undefined,
      options.includeDirty === false ? undefined : runGit(["diff", "--stat"], root),
    ]
      .filter(Boolean)
      .join("\n");
  const caveats = [
    baseRef
      ? undefined
      : "No upstream/base ref was resolved; local reality check used dirty/cached files only.",
    dirtyFiles.length > 0 && options.includeDirty === false
      ? "Dirty files were detected but excluded by --no-include-dirty."
      : undefined,
  ].filter((item): item is string => Boolean(item));

  return {
    root,
    ...(branch && branch !== "HEAD" ? { branch } : {}),
    ...(baseRef ? { baseRef } : {}),
    ...(headRef ? { headRef } : {}),
    changedFiles,
    dirtyFiles: options.includeDirty === false ? [] : dirtyFiles,
    ...(diffSummary ? { diffSummary } : {}),
    caveats,
  };
}

function parseDecision(value: string, index: number): ProjectRealityCheckDecisionInput {
  const [rawId, ...rest] = value.split(":");
  const hasExplicitId = rest.length > 0 && rawId.trim().length > 0;
  const id = hasExplicitId ? rawId.trim() : `local-decision-${index + 1}`;
  const title = hasExplicitId ? rest.join(":").trim() : value.trim();
  return {
    id,
    title: title || id,
    decision: title || value,
    confidenceScore: 0.75,
  };
}

function parseDocument(value: string): ProjectRealityCheckDocumentInput {
  const [rawPath, ...rest] = value.split(":");
  return {
    path: rawPath.trim() || value,
    contentPreview: rest.join(":").trim() || null,
  };
}

export function buildLocalProjectRealityCheck(
  options: RealityCheckCommandOptions
): ProjectRealityCheckResult {
  const scope = buildLocalGitScope(options);
  const result = buildProjectRealityCheck({
    source: "local",
    task: options.task,
    branch: scope.branch,
    baseRef: scope.baseRef,
    headRef: scope.headRef,
    changedFiles: scope.changedFiles,
    dirtyFiles: scope.dirtyFiles,
    diffSummary: scope.diffSummary,
    decisions: (options.decision ?? []).map(parseDecision),
    documents: (options.document ?? []).map(parseDocument),
    verificationChecklist: options.verification ?? [],
  });

  if (scope.caveats.length === 0) {
    return result;
  }

  return {
    ...result,
    caveats: [...result.caveats, ...scope.caveats],
  };
}

function printRealityCheck(result: ProjectRealityCheckResult): void {
  console.log(chalk.bold("Project Reality Check"));
  console.log(`Status: ${result.status}`);
  console.log(`Score: ${result.score}/100`);
  console.log(`Changed files: ${result.changedFileCount}`);
  console.log(`Findings: ${result.findingCount}`);
  console.log("");
  console.log(renderProjectRealityCheckMarkdown(result));
}

export async function realityCheckCommand(options: RealityCheckCommandOptions): Promise<void> {
  const result = buildLocalProjectRealityCheck(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printRealityCheck(result);
  }

  if (options.enforce && (result.status === "review_required" || result.status === "blocking")) {
    process.exitCode = 1;
  }
}
