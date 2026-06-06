import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import chalk from "chalk";

export interface GitCompanionSummaryOptions {
  cwd?: string;
  recentLimit?: number;
}

export interface GitCompanionSummary {
  version: "snipara.git_companion.v1";
  generatedAt: string;
  repository?: {
    root: string;
    branch?: string;
    head?: string;
    upstream?: string;
    ahead?: number;
    behind?: number;
  };
  status: {
    clean: boolean;
    total: number;
    staged: string[];
    unstaged: string[];
    untracked: string[];
    conflicted: string[];
    lines: string[];
  };
  recentCommits: Array<{
    sha: string;
    shortSha: string;
    author: string;
    date: string;
    subject: string;
  }>;
  hosted: {
    status: "not_required";
    note: string;
  };
  suggestedCommands: string[];
  error?: string;
}

function gitOptions(cwd: string): ExecFileSyncOptionsWithStringEncoding {
  return {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  };
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, gitOptions(cwd)).trim();
}

function tryGit(cwd: string, args: string[]): string | undefined {
  try {
    return runGit(cwd, args);
  } catch {
    return undefined;
  }
}

function parseAheadBehind(value: string | undefined): { ahead?: number; behind?: number } {
  if (!value) {
    return {};
  }
  const [ahead, behind] = value
    .split(/\s+/)
    .map((item) => Number.parseInt(item, 10))
    .filter((item) => Number.isFinite(item));
  return {
    ...(ahead !== undefined ? { ahead } : {}),
    ...(behind !== undefined ? { behind } : {}),
  };
}

function statusPath(line: string): string {
  return line.slice(2).trim();
}

function isConflicted(indexStatus: string, worktreeStatus: string): boolean {
  return (
    indexStatus === "U" ||
    worktreeStatus === "U" ||
    ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(`${indexStatus}${worktreeStatus}`)
  );
}

function parseStatus(lines: string[]): GitCompanionSummary["status"] {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  const conflicted: string[] = [];

  for (const line of lines) {
    const indexStatus = line[0] ?? " ";
    const worktreeStatus = line[1] ?? " ";
    const filePath = statusPath(line);

    if (line.startsWith("??")) {
      untracked.push(filePath);
      continue;
    }
    if (isConflicted(indexStatus, worktreeStatus)) {
      conflicted.push(filePath);
      continue;
    }
    if (indexStatus !== " ") {
      staged.push(filePath);
    }
    if (worktreeStatus !== " ") {
      unstaged.push(filePath);
    }
  }

  return {
    clean: lines.length === 0,
    total: lines.length,
    staged,
    unstaged,
    untracked,
    conflicted,
    lines,
  };
}

function readRecentCommits(
  cwd: string,
  limit: number
): GitCompanionSummary["recentCommits"] {
  const output = tryGit(cwd, [
    "log",
    `-${Math.max(1, limit)}`,
    "--date=iso-strict",
    "--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s",
  ]);
  if (!output) {
    return [];
  }

  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha = "", shortSha = "", author = "", date = "", subject = ""] = line.split("\x1f");
      return { sha, shortSha, author, date, subject };
    });
}

function suggestedCommands(status: GitCompanionSummary["status"]): string[] {
  const commands = [
    "snipara-companion status",
    "snipara-companion timeline",
    "snipara-companion code sync --working-tree",
  ];
  if (!status.clean) {
    commands.push("git diff --stat");
    commands.push(
      "snipara-companion team-sync handoff --summary '<what changed>' --next '<next step>' --files <files...>"
    );
  }
  return commands;
}

export function buildGitCompanionSummary(
  options: GitCompanionSummaryOptions = {}
): GitCompanionSummary {
  const cwd = options.cwd ?? process.cwd();
  const recentLimit = options.recentLimit ?? 5;
  const generatedAt = new Date().toISOString();

  try {
    const root = runGit(cwd, ["rev-parse", "--show-toplevel"]);
    const branch = tryGit(root, ["branch", "--show-current"]);
    const head = tryGit(root, ["rev-parse", "HEAD"]);
    const upstream = tryGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    const aheadBehind = parseAheadBehind(
      upstream ? tryGit(root, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`]) : undefined
    );
    const statusLines = (tryGit(root, ["status", "--short"]) ?? "")
      .split(/\r?\n/)
      .filter(Boolean);
    const status = parseStatus(statusLines);

    return {
      version: "snipara.git_companion.v1",
      generatedAt,
      repository: {
        root,
        ...(branch ? { branch } : {}),
        ...(head ? { head } : {}),
        ...(upstream ? { upstream } : {}),
        ...aheadBehind,
      },
      status,
      recentCommits: readRecentCommits(root, recentLimit),
      hosted: {
        status: "not_required",
        note: "Git companion summary is local-only and does not require a Snipara account.",
      },
      suggestedCommands: suggestedCommands(status),
    };
  } catch (error) {
    return {
      version: "snipara.git_companion.v1",
      generatedAt,
      status: {
        clean: true,
        total: 0,
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
        lines: [],
      },
      recentCommits: [],
      hosted: {
        status: "not_required",
        note: "Git companion summary is local-only and does not require a Snipara account.",
      },
      suggestedCommands: ["git init", "snipara-companion status"],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function gitSummaryCommand(options: {
  recent?: number;
  json?: boolean;
}): Promise<void> {
  const summary = buildGitCompanionSummary({ recentLimit: options.recent });
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(chalk.bold("Git Companion"));
  if (summary.error) {
    console.log(`Git unavailable: ${summary.error}`);
    console.log("");
    return;
  }

  if (summary.repository?.branch) {
    console.log(`Branch: ${summary.repository.branch}`);
  }
  if (summary.repository?.head) {
    console.log(`HEAD: ${summary.repository.head.slice(0, 12)}`);
  }
  if (summary.repository?.upstream) {
    const ahead = summary.repository.ahead ?? 0;
    const behind = summary.repository.behind ?? 0;
    console.log(`Upstream: ${summary.repository.upstream} (${ahead} ahead, ${behind} behind)`);
  }
  console.log(`Dirty files: ${summary.status.total}`);
  if (summary.status.staged.length > 0) {
    console.log(`Staged: ${summary.status.staged.slice(0, 8).join(", ")}`);
  }
  if (summary.status.unstaged.length > 0) {
    console.log(`Unstaged: ${summary.status.unstaged.slice(0, 8).join(", ")}`);
  }
  if (summary.status.untracked.length > 0) {
    console.log(`Untracked: ${summary.status.untracked.slice(0, 8).join(", ")}`);
  }
  if (summary.status.conflicted.length > 0) {
    console.log(`Conflicted: ${summary.status.conflicted.slice(0, 8).join(", ")}`);
  }

  if (summary.recentCommits.length > 0) {
    console.log("");
    console.log(chalk.bold("Recent Commits"));
    for (const commit of summary.recentCommits.slice(0, 5)) {
      console.log(`${commit.shortSha}  ${commit.subject}`);
    }
  }

  console.log("");
  console.log(chalk.bold("Suggested Commands"));
  for (const command of summary.suggestedCommands) {
    console.log(`- ${command}`);
  }
  console.log("");
}
