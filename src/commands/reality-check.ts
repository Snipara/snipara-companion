import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import {
  buildProjectRealityCheck,
  renderProjectRealityCheckMarkdown,
  type ProjectRealityCheckDecisionInput,
  type ProjectRealityCheckDocumentInput,
  type ProjectRealityCheckEvidenceRef,
  type ProjectRealityCheckResult,
} from "../contracts/project-intelligence";
import {
  createClient,
  type ContextQueryOptions,
  type ContextQueryResult,
  type TeamSyncChangesResponse,
} from "../api/client";
import { findWorkspaceRoot, isConfigured } from "../config/store";

export interface RealityCheckCommandOptions {
  task?: string;
  branch?: string;
  base?: string;
  changedFiles?: string[];
  diffSummary?: string;
  decision?: string[];
  document?: string[];
  verification?: string[];
  autoContext?: boolean;
  autoContextTimeoutMs?: number;
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

interface RealityCheckAutoContext {
  decisions: ProjectRealityCheckDecisionInput[];
  documents: ProjectRealityCheckDocumentInput[];
  evidence: ProjectRealityCheckEvidenceRef[];
  verification: string[];
  caveats: string[];
}

export interface RealityCheckAutoContextClient {
  queryContext(
    query: string,
    maxTokens?: number,
    options?: ContextQueryOptions
  ): Promise<ContextQueryResult>;
  getTeamSyncWhatChanged(args: {
    limit?: number;
    branch?: string;
    paths?: string[];
    recentFiles?: string[];
  }): Promise<TeamSyncChangesResponse>;
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

function emptyAutoContext(): RealityCheckAutoContext {
  return {
    decisions: [],
    documents: [],
    evidence: [],
    verification: [],
    caveats: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? unique(value.map((item) => (typeof item === "string" ? item : undefined)))
    : [];
}

function readJsonRecord(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const GENERIC_SCOPE_TOKENS = new Set([
  "apps",
  "packages",
  "src",
  "test",
  "tests",
  "index",
  "server",
  "project",
  "snipara",
  "file",
  "files",
  "change",
  "changed",
]);

function scopeTokens(value: string): Set<string> {
  const tokens = new Set(
    (value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [])
      .flatMap((token) => token.split(/[-_]/g))
      .filter((token) => token.length >= 3 && !GENERIC_SCOPE_TOKENS.has(token))
  );
  if (/packages\/cli\//i.test(value)) {
    tokens.add("cli");
    tokens.add("companion");
  }
  if (/project-intelligence-contracts/i.test(value)) {
    tokens.add("intelligence");
    tokens.add("intent");
    tokens.add("reality");
  }
  if (/mcp-server/i.test(value)) {
    tokens.add("mcp");
    tokens.add("context");
    tokens.add("retrieval");
  }
  if (/prisma|migration|document_chunks/i.test(value)) {
    tokens.add("database");
    tokens.add("schema");
    tokens.add("pgvector");
  }
  return tokens;
}

function matchingAnchors(text: string, changedFiles: string[]): string[] {
  const textTokens = scopeTokens(text);
  return changedFiles.filter((file) => {
    const fileTokens = scopeTokens(file);
    return [...fileTokens].some((token) => textTokens.has(token));
  });
}

function hasFileOverlap(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some((item) => rightSet.has(item));
}

function collectLocalReceiptContext(scope: LocalRealityCheckGitScope): RealityCheckAutoContext {
  const context = emptyAutoContext();
  const workflowRef = ".snipara/workflow/current.json";
  const workflow = readJsonRecord(path.join(scope.root, workflowRef));
  if (workflow) {
    const workflowId = stringValue(workflow.workflowId) ?? "managed workflow";
    const phases = Array.isArray(workflow.phases) ? workflow.phases.filter(isRecord) : [];
    for (const phase of phases) {
      const phaseFiles = stringList(phase.files);
      if (!hasFileOverlap(phaseFiles, scope.changedFiles)) continue;
      const title = stringValue(phase.title) ?? stringValue(phase.id) ?? "workflow phase";
      const status = stringValue(phase.status) ?? "unknown";
      context.evidence.push({
        kind: "workflow",
        label: `${workflowId}: ${title} (${status})`,
        sourceRef: workflowRef,
        strength: status === "completed" ? 0.78 : 0.62,
      });
    }
  }

  const finalReportRef = ".snipara/workflow/final-report.json";
  const finalReport = readJsonRecord(path.join(scope.root, finalReportRef));
  const changed = isRecord(finalReport?.changed) ? finalReport.changed : undefined;
  const reportFiles = stringList(changed?.files);
  const overlappingFiles = reportFiles.filter((file) => scope.changedFiles.includes(file));
  if (finalReport && overlappingFiles.length > 0) {
    const workflowId = stringValue(finalReport.workflowId) ?? "completed workflow";
    const outcome = stringValue(finalReport.outcome) ?? "unknown";
    context.evidence.push({
      kind: "workflow",
      label: `${workflowId}: final report (${outcome})`,
      sourceRef: finalReportRef,
      strength: outcome === "completed" ? 0.82 : 0.6,
    });

    const repository = isRecord(changed?.repository) ? changed.repository : undefined;
    const reportHead = stringValue(repository?.head);
    const dirtyOverlap = hasFileOverlap(scope.dirtyFiles, overlappingFiles);
    const receiptMatchesCurrentHead = Boolean(reportHead && reportHead === scope.headRef);
    const evidence = isRecord(finalReport.evidence) ? finalReport.evidence : undefined;
    const items = Array.isArray(evidence?.items) ? evidence.items.filter(isRecord) : [];
    if (receiptMatchesCurrentHead && !dirtyOverlap) {
      for (const [index, item] of items.entries()) {
        if (stringValue(item.status)?.toLowerCase() !== "passed") continue;
        const label = stringValue(item.text);
        if (!label) continue;
        context.verification.push(label);
        context.evidence.push({
          kind: "test",
          label,
          sourceRef: `${finalReportRef}#evidence-${index + 1}`,
          strength: 0.88,
        });
      }
    } else if (items.length > 0) {
      context.caveats.push(
        "A prior workflow report overlaps this scope, but its passed checks were not counted as current verification because the receipt does not cover the current dirty/HEAD state."
      );
    }
  }

  return context;
}

function isReviewedDecisionSignal(
  signal: TeamSyncChangesResponse["whatChanged"]["decisions"][number]
): boolean {
  const status = signal.status.toUpperCase();
  if (!["ACTIVE", "APPROVED", "ACCEPTED", "CONFIRMED"].includes(status)) return false;
  const tags = signal.tags.map((tag) => tag.toLowerCase());
  if (
    tags.some(
      (tag) =>
        tag === "workflow-phase" ||
        tag === "release" ||
        tag === "auto-captured" ||
        tag === "review-pending" ||
        tag.startsWith("journal:")
    )
  ) {
    return false;
  }
  return /decision/i.test(signal.recommendedAction);
}

function decisionsFromTeamSync(
  response: TeamSyncChangesResponse,
  changedFiles: string[]
): ProjectRealityCheckDecisionInput[] {
  const decisions: ProjectRealityCheckDecisionInput[] = [];
  for (const signal of response.whatChanged.decisions.filter(isReviewedDecisionSignal)) {
    const affectedAnchors = matchingAnchors(
      [signal.title, signal.summary, ...signal.tags].join(" "),
      changedFiles
    );
    if (affectedAnchors.length === 0) continue;
    decisions.push({
      id: signal.id,
      title: signal.title,
      decision: signal.summary,
      status: "approved",
      confidenceScore: signal.impact?.toUpperCase() === "HIGH" ? 0.9 : 0.84,
      affectedAnchors,
      evidence: [
        {
          kind: "decision",
          label: `${signal.id}: ${signal.title}`,
          sourceRef: signal.id,
          strength: signal.impact?.toUpperCase() === "HIGH" ? 0.9 : 0.84,
        },
      ],
    });
  }
  return decisions.slice(0, 8);
}

function contextQueryText(options: RealityCheckCommandOptions, scope: LocalRealityCheckGitScope) {
  const task = options.task?.trim() || "Project Reality Check governing intent";
  const tokens = unique([
    ...scopeTokens(task),
    ...scope.changedFiles.slice(0, 12).flatMap((file) => [...scopeTokens(file)]),
    "decision",
    "constraint",
  ]).slice(0, 8);
  return tokens.join(" ");
}

function documentsFromContext(
  result: ContextQueryResult,
  changedFiles: string[]
): ProjectRealityCheckDocumentInput[] {
  return result.sections
    .filter((section) => section.file && section.file !== "(unknown)")
    .map((section) => ({
      path: section.file,
      title: section.title,
      contentPreview: section.content.slice(0, 1_600),
      kind: /adr|decision/i.test(`${section.file} ${section.title}`) ? "ADR" : "DOC",
      sourceRef: `${section.file}#L${section.lines[0]}-L${section.lines[1]}`,
      affectedAnchors: matchingAnchors(
        `${section.file} ${section.title} ${section.content.slice(0, 800)}`,
        changedFiles
      ),
    }))
    .slice(0, 8);
}

async function collectHostedAutoContext(
  client: RealityCheckAutoContextClient,
  options: RealityCheckCommandOptions,
  scope: LocalRealityCheckGitScope
): Promise<RealityCheckAutoContext> {
  const context = emptyAutoContext();
  const [teamSync, documents] = await Promise.allSettled([
    client.getTeamSyncWhatChanged({
      limit: 50,
      branch: scope.branch,
      paths: scope.changedFiles.slice(0, 20),
      recentFiles: scope.changedFiles.slice(0, 10),
    }),
    client.queryContext(contextQueryText(options, scope), 1_200, {
      searchMode: "keyword",
      includeMetadata: true,
      includeAnswerPack: false,
      autoDecompose: false,
      includeSharedContext: false,
      includeAllTiers: false,
    }),
  ]);

  if (teamSync.status === "fulfilled") {
    context.decisions = decisionsFromTeamSync(teamSync.value, scope.changedFiles);
  } else {
    context.caveats.push(
      "Hosted reviewed-decision auto-linking was unavailable; explicit --decision inputs remain authoritative."
    );
  }

  if (documents.status === "fulfilled") {
    context.documents = documentsFromContext(documents.value, scope.changedFiles);
  } else {
    context.caveats.push(
      "Hosted document auto-context was unavailable; Reality Check continued with local and explicit evidence."
    );
  }

  return context;
}

function mergeAutoContext(
  local: RealityCheckAutoContext,
  hosted: RealityCheckAutoContext
): RealityCheckAutoContext {
  return {
    decisions: [...local.decisions, ...hosted.decisions],
    documents: [...local.documents, ...hosted.documents],
    evidence: [...local.evidence, ...hosted.evidence],
    verification: unique([...local.verification, ...hosted.verification]),
    caveats: unique([...local.caveats, ...hosted.caveats]),
  };
}

function buildProjectRealityCheckForScope(
  options: RealityCheckCommandOptions,
  scope: LocalRealityCheckGitScope,
  autoContext: RealityCheckAutoContext = emptyAutoContext()
): ProjectRealityCheckResult {
  const decisionsById = new Map(
    autoContext.decisions.map((decision) => [decision.id, decision] as const)
  );
  for (const [index, value] of (options.decision ?? []).entries()) {
    const decision = parseDecision(value, index);
    decisionsById.set(decision.id, decision);
  }

  const documentsByPath = new Map(
    autoContext.documents.map((document) => [document.path, document] as const)
  );
  for (const value of options.document ?? []) {
    const document = parseDocument(value);
    documentsByPath.set(document.path, document);
  }

  const result = buildProjectRealityCheck({
    source: "local",
    task: options.task,
    branch: scope.branch,
    baseRef: scope.baseRef,
    headRef: scope.headRef,
    changedFiles: scope.changedFiles,
    dirtyFiles: scope.dirtyFiles,
    diffSummary: scope.diffSummary,
    decisions: [...decisionsById.values()],
    documents: [...documentsByPath.values()],
    evidence: autoContext.evidence,
    verificationChecklist: unique([...autoContext.verification, ...(options.verification ?? [])]),
  });

  const caveats = unique([...result.caveats, ...scope.caveats, ...autoContext.caveats]);
  return { ...result, caveats };
}

export function buildLocalProjectRealityCheck(
  options: RealityCheckCommandOptions
): ProjectRealityCheckResult {
  const scope = buildLocalGitScope(options);
  return buildProjectRealityCheckForScope(options, scope);
}

export async function buildLocalProjectRealityCheckWithAutoContext(
  options: RealityCheckCommandOptions,
  clientOverride?: RealityCheckAutoContextClient
): Promise<ProjectRealityCheckResult> {
  const scope = buildLocalGitScope(options);
  let autoContext = collectLocalReceiptContext(scope);
  const configured = Boolean(clientOverride) || isConfigured({ cwd: scope.root });

  if (configured) {
    const timeoutMs = Math.max(1_000, Math.min(options.autoContextTimeoutMs ?? 12_000, 30_000));
    const client = clientOverride ?? createClient(timeoutMs, { cwd: scope.root });
    autoContext = mergeAutoContext(
      autoContext,
      await collectHostedAutoContext(client, options, scope)
    );
  } else {
    autoContext.caveats.push(
      "Hosted auto-context was skipped because this workspace is not configured; use --decision, --document, and --verification for explicit evidence."
    );
  }

  return buildProjectRealityCheckForScope(options, scope, autoContext);
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
  const result =
    options.autoContext === false
      ? buildLocalProjectRealityCheck(options)
      : await buildLocalProjectRealityCheckWithAutoContext(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printRealityCheck(result);
  }

  if (options.enforce && (result.status === "review_required" || result.status === "blocking")) {
    process.exitCode = 1;
  }
}
