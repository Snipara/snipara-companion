import crypto from "crypto";
import { execFileSync } from "node:child_process";
import fs from "fs";
import path from "path";
import type { MinimumChangeAdapterReceipt, MinimumChangeEvidenceCheck } from "../api/client";

export const MINIMUM_SAFE_CHANGE_ADAPTER_VERSION = "snipara.minimum-safe-change-adapter.v1";

type EvidenceSource = "lockfile" | "manifest" | "caller_assertion";

interface DependencyFact {
  source: EvidenceSource;
  path: string;
  detail: string;
  version?: string;
}

interface ManifestFact {
  path: string;
  field: string;
  specifier: string;
}

function normalizePythonName(value: string): string {
  return value.trim().toLowerCase().replaceAll("_", "-").replaceAll(".", "-");
}

function dependencyNameFromRequirement(value: string): string | undefined {
  const match = value.trim().match(/^([A-Za-z0-9][A-Za-z0-9_.-]*)/);
  return match?.[1];
}

function readText(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function readJsonRecord(filePath: string): Record<string, unknown> | undefined {
  const content = readText(filePath);
  if (!content) return undefined;
  try {
    const value: unknown = JSON.parse(content);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readJavaScriptManifest(cwd: string, dependencyName: string): ManifestFact | undefined {
  const relativePath = "package.json";
  const packageJson = readJsonRecord(path.join(cwd, relativePath));
  if (!packageJson) return undefined;

  const fields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  for (const field of fields) {
    const dependencies = packageJson[field];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      continue;
    }
    const specifier = (dependencies as Record<string, unknown>)[dependencyName];
    if (typeof specifier === "string" && specifier.trim()) {
      return { path: relativePath, field: `${field}.${dependencyName}`, specifier };
    }
  }
  return undefined;
}

function readPackageLock(cwd: string, dependencyName: string): DependencyFact | undefined {
  for (const relativePath of ["package-lock.json", "npm-shrinkwrap.json"]) {
    const lockfile = readJsonRecord(path.join(cwd, relativePath));
    if (!lockfile) continue;

    const packages = lockfile.packages;
    if (packages && typeof packages === "object" && !Array.isArray(packages)) {
      const record = (packages as Record<string, unknown>)[`node_modules/${dependencyName}`];
      if (record && typeof record === "object" && !Array.isArray(record)) {
        const version = (record as Record<string, unknown>).version;
        return {
          source: "lockfile",
          path: relativePath,
          detail: `packages.node_modules/${dependencyName}`,
          ...(typeof version === "string" ? { version } : {}),
        };
      }
    }

    const dependencies = lockfile.dependencies;
    if (dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)) {
      const record = (dependencies as Record<string, unknown>)[dependencyName];
      if (record && typeof record === "object" && !Array.isArray(record)) {
        const version = (record as Record<string, unknown>).version;
        return {
          source: "lockfile",
          path: relativePath,
          detail: `dependencies.${dependencyName}`,
          ...(typeof version === "string" ? { version } : {}),
        };
      }
    }
  }
  return undefined;
}

function readPnpmLock(cwd: string, dependencyName: string): DependencyFact | undefined {
  const relativePath = "pnpm-lock.yaml";
  const content = readText(path.join(cwd, relativePath));
  if (!content) return undefined;

  const escaped = dependencyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`^\\s{2,}['"]?/?${escaped}@([^:\\s]+):`, "m"));
  if (!match) return undefined;
  return {
    source: "lockfile",
    path: relativePath,
    detail: `packages.${dependencyName}@${match[1]}`,
    version: match[1].split("(")[0],
  };
}

function readYarnLock(cwd: string, dependencyName: string): DependencyFact | undefined {
  const relativePath = "yarn.lock";
  const content = readText(path.join(cwd, relativePath));
  if (!content) return undefined;

  const escaped = dependencyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`^['"]?${escaped}@[^:]+:\\s*$`, "m"));
  if (!match) return undefined;
  const block = content.slice(match.index ?? 0, content.indexOf("\n\n", match.index ?? 0));
  const version = block.match(/^\s+version\s+["']([^"']+)["']/m)?.[1];
  return {
    source: "lockfile",
    path: relativePath,
    detail: `${dependencyName} lock entry`,
    ...(version ? { version } : {}),
  };
}

function readPythonManifest(cwd: string, dependencyName: string): ManifestFact | undefined {
  const relativePath = "pyproject.toml";
  const content = readText(path.join(cwd, relativePath));
  if (!content) return undefined;

  const target = normalizePythonName(dependencyName);
  let section = "";
  let collectingProjectDependencies = false;
  let collected = "";
  const lines = content.split(/\r?\n/);

  const checkRequirement = (value: string, field: string): ManifestFact | undefined => {
    const name = dependencyNameFromRequirement(value);
    if (name && normalizePythonName(name) === target) {
      return { path: relativePath, field, specifier: value.trim() };
    }
    return undefined;
  };

  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      collectingProjectDependencies = false;
      collected = "";
      continue;
    }

    if (section === "project" && /^\s*dependencies\s*=\s*\[/.test(line)) {
      collectingProjectDependencies = !line.includes("]");
      collected = line;
      if (!collectingProjectDependencies) {
        const values = [...collected.matchAll(/["']([^"']+)["']/g)];
        for (const value of values) {
          const fact = checkRequirement(value[1], "project.dependencies");
          if (fact) return fact;
        }
      }
      continue;
    }

    if (collectingProjectDependencies) {
      collected += ` ${line}`;
      if (line.includes("]")) {
        collectingProjectDependencies = false;
        const values = [...collected.matchAll(/["']([^"']+)["']/g)];
        for (const value of values) {
          const fact = checkRequirement(value[1], "project.dependencies");
          if (fact) return fact;
        }
      }
      continue;
    }

    if (section === "project.optional-dependencies" || section.endsWith(".dependencies")) {
      const assignment = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
      if (!assignment) continue;
      const values = [...assignment[2].matchAll(/["']([^"']+)["']/g)];
      for (const value of values) {
        const fact = checkRequirement(value[1], `${section}.${assignment[1]}`);
        if (fact) return fact;
      }
      const fact = checkRequirement(assignment[1], `${section}.${assignment[1]}`);
      if (fact) return fact;
    }
  }
  return undefined;
}

function readUvLock(cwd: string, dependencyName: string): DependencyFact | undefined {
  const relativePath = "uv.lock";
  const content = readText(path.join(cwd, relativePath));
  if (!content) return undefined;

  const target = normalizePythonName(dependencyName);
  const blocks = content.split(/(?=^\[\[package\]\])/m);
  for (const block of blocks) {
    const name = block.match(/^name\s*=\s*["']([^"']+)["']/m)?.[1];
    if (!name || normalizePythonName(name) !== target) continue;
    const version = block.match(/^version\s*=\s*["']([^"']+)["']/m)?.[1];
    return {
      source: "lockfile",
      path: relativePath,
      detail: `package.${name}`,
      ...(version ? { version } : {}),
    };
  }
  return undefined;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 32);
}

function runGit(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

function normalizeRepoPath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function readWorkingTreeDiff(cwd: string): Array<Record<string, string>> | undefined {
  const status = runGit(cwd, ["status", "--porcelain=v1", "-z"]);
  if (status === undefined) return undefined;

  const paths = new Set<string>();
  for (const entry of status.split("\0")) {
    if (entry.length < 4) continue;
    const filePath = normalizeRepoPath(entry.slice(3));
    if (filePath) paths.add(filePath);
  }

  const facts = new Map<string, string>();
  const numstat = runGit(cwd, ["diff", "--numstat", "HEAD", "--"]);
  if (numstat !== undefined) {
    for (const line of numstat.split(/\r?\n/)) {
      const fields = line.split("\t");
      if (fields.length < 3) continue;
      const filePath = normalizeRepoPath(fields.slice(2).join("\t"));
      if (!filePath) continue;
      facts.set(filePath, `${fields[0]} additions, ${fields[1]} deletions`);
      paths.add(filePath);
    }
  }

  return [...paths].sort().map((filePath) => ({
    source: "git_diff",
    kind: facts.has(filePath) ? "changed_file" : "untracked_file",
    path: filePath,
    detail: facts.get(filePath) ?? "untracked working-tree file",
  }));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sameStringSet(left: string[], right: string[]): boolean {
  const leftSet = new Set(left.map(normalizeRepoPath));
  const rightSet = new Set(right.map(normalizeRepoPath));
  return leftSet.size === rightSet.size && [...leftSet].every((item) => rightSet.has(item));
}

function gitDiffAdapterReceipt(
  scope: string,
  evidence: Array<Record<string, string>>
): MinimumChangeAdapterReceipt {
  return {
    name: "git_diff",
    version: MINIMUM_SAFE_CHANGE_ADAPTER_VERSION,
    status: "verified",
    claim: "smallest_safe_diff",
    fingerprint: fingerprint({ scope, evidence }),
  };
}

export function buildSmallestSafeDiffEvidence(
  cwd: string,
  changedFiles?: string[],
  impact?: unknown
): MinimumChangeEvidenceCheck {
  const diffEvidence = readWorkingTreeDiff(cwd);
  if (diffEvidence === undefined) {
    return { status: "unknown", source: "caller_assertion", evidence: [] };
  }
  if (diffEvidence.length === 0) {
    return { status: "unknown", source: "git_diff", evidence: [] };
  }

  const diffFiles = diffEvidence.map((item) => item.path);
  const requestedFiles = (changedFiles ?? []).map(normalizeRepoPath).filter(Boolean);
  const impactRecord = record(impact);
  const impactFiles = stringArray(impactRecord.changedFiles).map(normalizeRepoPath);
  const risk = record(impactRecord.risk);
  const traversal = record(impactRecord.traversal);
  const missingTargets = stringArray(impactRecord.missingTargetFiles);
  const warnings = Array.isArray(impactRecord.warnings) ? impactRecord.warnings : [];
  const evidence = [
    ...diffEvidence,
    {
      source: "code_impact",
      kind: "blast_radius",
      detail: `risk=${String(risk.level ?? "unknown")}; impacted_files=${stringArray(impactRecord.impactedFiles).length}; traversal_truncated=${String(traversal.truncated === true)}`,
    },
  ];
  const scope = "working_tree";
  const coherent =
    requestedFiles.length > 0 &&
    sameStringSet(requestedFiles, diffFiles) &&
    sameStringSet(impactFiles, diffFiles) &&
    risk.level === "low" &&
    missingTargets.length === 0 &&
    warnings.length === 0 &&
    traversal.truncated !== true;

  if (!coherent) {
    return {
      status: "needs_review",
      source: "git_diff",
      scope,
      evidence,
    };
  }

  return {
    status: "confirmed",
    source: "git_diff",
    scope,
    evidence,
    adapter_receipt: gitDiffAdapterReceipt(scope, evidence),
  };
}

function adapterReceipt(
  dependencyName: string,
  evidence: Array<Record<string, string>>
): MinimumChangeAdapterReceipt {
  return {
    name: "lockfile_manifest",
    version: MINIMUM_SAFE_CHANGE_ADAPTER_VERSION,
    status: "verified",
    claim: "installed_dependency",
    fingerprint: fingerprint({ scope: dependencyName, evidence }),
  };
}

export function buildInstalledDependencyEvidence(
  cwd: string,
  dependencyName: string
): MinimumChangeEvidenceCheck {
  const normalizedName = dependencyName.trim();
  if (!normalizedName) {
    return {
      status: "unknown",
      source: "caller_assertion",
      evidence: [],
    };
  }

  const jsManifest = readJavaScriptManifest(cwd, normalizedName);
  const jsLockfile =
    readPackageLock(cwd, normalizedName) ??
    readPnpmLock(cwd, normalizedName) ??
    readYarnLock(cwd, normalizedName);
  const pythonManifest = readPythonManifest(cwd, normalizedName);
  const pythonLockfile = readUvLock(cwd, normalizedName);
  // Keep evidence paired to one package ecosystem. A mixed repository can
  // legitimately contain the same name in JavaScript and Python surfaces;
  // crossing those surfaces would fabricate an installed-dependency proof.
  const javascriptSurface = Boolean(jsManifest || jsLockfile);
  const manifest = javascriptSurface ? jsManifest : pythonManifest;
  const lockfile = javascriptSurface ? jsLockfile : pythonLockfile;
  const evidence: Array<Record<string, string>> = [];

  if (manifest) {
    evidence.push({
      source: "manifest",
      kind: "declared_dependency",
      path: manifest.path,
      detail: `${manifest.field}: ${manifest.specifier}`,
    });
  }
  if (lockfile) {
    evidence.push({
      source: "lockfile",
      kind: "locked_dependency",
      path: lockfile.path,
      detail: `${lockfile.detail}${lockfile.version ? `=${lockfile.version}` : ""}`,
    });
  }

  if (manifest && lockfile) {
    return {
      status: "confirmed",
      source: "lockfile",
      scope: normalizedName,
      evidence,
      adapter_receipt: adapterReceipt(normalizedName, evidence),
    };
  }

  if (manifest || lockfile) {
    return {
      status: "needs_review",
      source: manifest ? "manifest" : (lockfile?.source ?? "manifest"),
      scope: normalizedName,
      evidence,
    };
  }

  return {
    status: "unknown",
    source: "caller_assertion",
    scope: normalizedName,
    evidence: [],
  };
}
