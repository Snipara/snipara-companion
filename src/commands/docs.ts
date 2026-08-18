/**
 * Documentation bootstrap commands.
 *
 * The bootstrap is intentionally local and evidence-linked: it inventories the
 * repository, records what was observed, and leaves interpretation for a human
 * review. It never overwrites an existing document unless --force is explicit.
 */
import fs from "fs";
import path from "path";
import chalk from "chalk";
import { buildLocalSourceSnapshot, type LocalSourceFile, type LocalSourceSnapshot } from "./source";

export const DOCS_BOOTSTRAP_VERSION = "snipara.docs_bootstrap.v1" as const;
export const DEFAULT_DOCS_BOOTSTRAP_OUTPUT = path.join("docs", "PROJECT.md");

export interface DocsBootstrapOptions {
  dir?: string;
  output?: string;
  apply?: boolean;
  force?: boolean;
  preview?: boolean;
  maxFiles?: number;
  maxFileBytes?: number;
  json?: boolean;
}

export interface DocsBootstrapResult {
  version: typeof DOCS_BOOTSTRAP_VERSION;
  root: string;
  outputPath: string;
  relativeOutputPath: string;
  applied: boolean;
  overwritten: boolean;
  sourceRevision: string;
  generatedAt: string;
  source: {
    totalFiles: number;
    totalBytes: number;
    docs: number;
    code: number;
    config: number;
    binary: number;
    other: number;
    skipped: number;
  };
  documentation: {
    existingFiles: string[];
    outputPath: string;
  };
  content: string;
  warnings: string[];
}

interface PackageMetadata {
  name: string | null;
  scripts: string[];
}

function normalizeRepoPath(value: string): string {
  return value.split(path.sep).join("/");
}

function resolveProjectRoot(dir?: string): string {
  return path.resolve(dir ?? process.cwd());
}

function resolveOutputPath(
  root: string,
  output?: string
): {
  outputPath: string;
  relativeOutputPath: string;
} {
  const outputPath = path.resolve(root, output ?? DEFAULT_DOCS_BOOTSTRAP_OUTPUT);
  const relative = path.relative(root, outputPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Documentation bootstrap output must stay inside the project folder.");
  }
  return {
    outputPath,
    relativeOutputPath: normalizeRepoPath(relative),
  };
}

function fileIsOutput(file: LocalSourceFile, relativeOutputPath: string): boolean {
  return normalizeRepoPath(file.path) === relativeOutputPath;
}

function reportFiles(snapshot: LocalSourceSnapshot, relativeOutputPath: string): LocalSourceFile[] {
  return snapshot.files.filter((file) => !fileIsOutput(file, relativeOutputPath));
}

function isDocumentationFile(file: LocalSourceFile): boolean {
  const base = path.posix.basename(normalizeRepoPath(file.path)).toLowerCase();
  return file.kind === "DOC" || /^(readme|agents|claude|gemini|cursor)(\.|$)/.test(base);
}

function listDocumentationFiles(files: LocalSourceFile[]): string[] {
  return files.filter(isDocumentationFile).map((file) => file.path);
}

function listTopLevelAreas(files: LocalSourceFile[]): string[] {
  return Array.from(
    new Set(
      files
        .map((file) => file.path.split("/")[0])
        .filter(Boolean)
        .filter((area) => !area.startsWith("."))
    )
  ).slice(0, 20);
}

function listLanguages(files: LocalSourceFile[]): string[] {
  return Array.from(
    new Set(
      files
        .filter((file) => file.kind === "CODE" && file.format)
        .map((file) => file.format as string)
    )
  ).sort();
}

function readPackageMetadata(root: string, files: LocalSourceFile[]): PackageMetadata {
  if (!files.some((file) => file.path === "package.json")) {
    return { name: null, scripts: [] };
  }
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { name: null, scripts: [] };
    }
    const record = value as Record<string, unknown>;
    const scripts =
      record.scripts && typeof record.scripts === "object" && !Array.isArray(record.scripts)
        ? Object.keys(record.scripts as Record<string, unknown>).sort()
        : [];
    return {
      name: typeof record.name === "string" ? record.name : null,
      scripts,
    };
  } catch {
    return { name: null, scripts: [] };
  }
}

function readMarkdownTitle(root: string, files: LocalSourceFile[]): string | null {
  const readme = files.find((file) => /^readme(?:\.|$)/i.test(path.posix.basename(file.path)));
  if (!readme) {
    return null;
  }
  try {
    const firstHeading = fs
      .readFileSync(path.join(root, readme.path), "utf8")
      .split(/\r?\n/)
      .find((line) => /^#\s+/.test(line.trim()));
    return firstHeading ? firstHeading.replace(/^#\s+/, "").trim() : null;
  } catch {
    return null;
  }
}

function listEvidenceFiles(files: LocalSourceFile[]): string[] {
  const preferred = files
    .map((file) => file.path)
    .filter((filePath) => {
      const base = path.posix.basename(filePath).toLowerCase();
      return (
        /^(readme|agents|claude|gemini|cursor)(\.|$)/.test(base) ||
        ["package.json", "pyproject.toml", "go.mod", "cargo.toml", "dockerfile"].includes(base) ||
        filePath.startsWith(".github/") ||
        filePath.startsWith(".gitlab/")
      );
    });
  return preferred.slice(0, 30);
}

function renderList(items: string[], empty = "None observed."): string[] {
  return items.length > 0 ? items.map((item) => `- \`${item}\``) : [`- ${empty}`];
}

export function buildProjectBriefMarkdown(
  snapshot: LocalSourceSnapshot,
  options: { relativeOutputPath?: string } = {}
): string {
  const relativeOutputPath = options.relativeOutputPath ?? DEFAULT_DOCS_BOOTSTRAP_OUTPUT;
  const files = reportFiles(snapshot, relativeOutputPath);
  const documentationFiles = listDocumentationFiles(files);
  const packageMetadata = readPackageMetadata(snapshot.root, files);
  const readmeTitle = readMarkdownTitle(snapshot.root, files);
  const languages = listLanguages(files);
  const topLevelAreas = listTopLevelAreas(files);
  const representativeFiles = files
    .filter((file) => file.kind === "CODE" || file.kind === "CONFIG")
    .map((file) => file.path)
    .slice(0, 40);
  const evidenceFiles = listEvidenceFiles(files);
  const byKind = files.reduce(
    (counts, file) => ({ ...counts, [file.kind]: counts[file.kind] + 1 }),
    { DOC: 0, CODE: 0, CONFIG: 0, BINARY: 0, OTHER: 0 } as Record<string, number>
  );
  const lines = [
    "# Project Brief",
    "",
    "> Generated by `snipara-companion docs bootstrap`. This is a reviewable local inventory, not an authoritative specification.",
    "",
    `- Generated at: \`${snapshot.generatedAt}\``,
    `- Source revision: \`${snapshot.revision}\``,
    `- Output: \`${relativeOutputPath}\``,
    "",
    "## What was observed",
    "",
    `- Files inspected: **${files.length}** (${files.reduce((total, file) => total + file.sizeBytes, 0).toLocaleString()} bytes)`,
    `- Documentation-like files: **${documentationFiles.length}**`,
    `- Code files: **${byKind.CODE}**`,
    `- Configuration files: **${byKind.CONFIG}**`,
    `- Binary files: **${byKind.BINARY}**`,
    `- Other files: **${byKind.OTHER}**`,
    `- Skipped files: **${snapshot.skipped.total}**`,
    ...(readmeTitle ? [`- README title: **${readmeTitle}** (observed in \`README*\`)`] : []),
    ...(packageMetadata.name
      ? [`- Package name: **${packageMetadata.name}** (observed in \`package.json\`)`]
      : []),
    "",
    "## Repository shape",
    "",
    `- Languages detected from file extensions: ${languages.length > 0 ? languages.map((language) => `\`${language}\``).join(", ") : "none"}`,
    `- Top-level areas observed: ${topLevelAreas.length > 0 ? topLevelAreas.map((area) => `\`${area}\``).join(", ") : "none"}`,
    "",
    "## Representative files inspected",
    "",
    ...(representativeFiles.length > 0
      ? renderList(representativeFiles)
      : ["- No code or configuration files were observed in the scan."]),
    "",
    "## Existing documentation",
    "",
    ...(documentationFiles.length > 0
      ? renderList(documentationFiles)
      : [
          "- No documentation files found in the scanned folder. This brief is a starting point for a human-authored project guide.",
        ]),
    "",
    "## Entrypoints and scripts",
    "",
    ...(packageMetadata.scripts.length > 0
      ? packageMetadata.scripts.map(
          (script) =>
            `- Script \`${script}\` is declared in \`package.json\` (command value intentionally omitted).`
        )
      : [
          "- No package scripts were observed in `package.json`. Review the project-specific build and test entrypoints manually.",
        ]),
    "",
    "## Evidence to review next",
    "",
    ...(evidenceFiles.length > 0
      ? renderList(evidenceFiles)
      : ["- No conventional repository guide or package manifest was observed."]),
    "",
    "## Needs review",
    "",
    "- This file records paths, classifications, and a small amount of safe metadata observed locally.",
    "- Architecture, ownership, current work, release procedures, and business rules remain **needs_review** until a person validates them.",
    "- The generator does not invent missing documentation and does not overwrite `README.md` automatically.",
    "",
    "## Suggested next step",
    "",
    "Review this brief, add the project-specific context that matters to agents, then run `npx -y snipara-companion source sync --apply --reindex` when hosted Snipara is configured.",
    "",
  ];
  return lines.join("\n");
}

export function buildDocsBootstrapResult(options: DocsBootstrapOptions = {}): DocsBootstrapResult {
  const root = resolveProjectRoot(options.dir);
  const { outputPath, relativeOutputPath } = resolveOutputPath(root, options.output);
  const snapshot = buildLocalSourceSnapshot({
    dir: root,
    recursive: true,
    maxFiles: options.maxFiles,
    maxFileBytes: options.maxFileBytes,
  });
  const files = reportFiles(snapshot, relativeOutputPath);
  const documentationFiles = listDocumentationFiles(files);
  const outputExists = fs.existsSync(outputPath);
  if (options.force && !options.apply) {
    throw new Error("--force only applies when writing with --apply.");
  }
  if (options.apply && outputExists && !options.force) {
    throw new Error(
      `Output already exists at ${relativeOutputPath}. Review it first or rerun with --force.`
    );
  }
  if (options.apply && outputExists && fs.statSync(outputPath).isDirectory()) {
    throw new Error(
      `Output path is a directory: ${relativeOutputPath}. Choose a file path with --output.`
    );
  }

  const content = buildProjectBriefMarkdown(snapshot, { relativeOutputPath });
  if (options.apply) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, content, "utf8");
  }

  return {
    version: DOCS_BOOTSTRAP_VERSION,
    root,
    outputPath,
    relativeOutputPath,
    applied: Boolean(options.apply),
    overwritten: Boolean(options.apply && outputExists),
    sourceRevision: snapshot.revision,
    generatedAt: snapshot.generatedAt,
    source: {
      totalFiles: files.length,
      totalBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
      docs: files.filter((file) => file.kind === "DOC").length,
      code: files.filter((file) => file.kind === "CODE").length,
      config: files.filter((file) => file.kind === "CONFIG").length,
      binary: files.filter((file) => file.kind === "BINARY").length,
      other: files.filter((file) => file.kind === "OTHER").length,
      skipped: snapshot.skipped.total,
    },
    documentation: {
      existingFiles: documentationFiles,
      outputPath: relativeOutputPath,
    },
    content,
    warnings: snapshot.warnings,
  };
}

export async function docsBootstrapCommand(options: DocsBootstrapOptions = {}): Promise<void> {
  if (options.preview && options.apply) {
    throw new Error("Use either --preview or --apply, not both.");
  }
  const result = buildDocsBootstrapResult({ ...options, apply: options.apply === true });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.applied) {
    console.log(chalk.green(`Project Brief written to ${result.relativeOutputPath}.`));
    console.log(
      "Review it, then run `npx -y snipara-companion source sync --apply --reindex` to index the approved context."
    );
    if (result.overwritten) {
      console.log(
        chalk.yellow("The previous output was overwritten because --force was explicit.")
      );
    }
    return;
  }

  console.log(chalk.bold(`Project Brief preview for ${result.root} (not written)`));
  console.log(`Output if applied: ${result.relativeOutputPath}`);
  console.log("Run with --apply to write it; use --force only to replace an existing output.");
  console.log("");
  console.log(result.content);
}
