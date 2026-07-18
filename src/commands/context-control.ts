import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import chalk from "chalk";
import {
  buildDecisionRequest,
  buildContextMutationApplyReceipt,
  buildContextMutationPlan,
  buildProjectDriftReport,
  isContextMutationApplyReceipt,
  isContextMutationPlan,
  isHostedContextControlApplyReceipt,
  isHostedContextControlPlan,
  stableDecisionJsonStringify,
  validateProjectContextManifest,
  type ContextMutationAppliedOperation,
  type ContextMutationApplyReceipt,
  type ContextMutationBaseRevision,
  type ContextMutationOperation,
  type ContextMutationPlan,
  type HostedContextControlApplyReceipt,
  type HostedContextControlPlan,
  type HostedContextControlSource,
  type ProjectContextValidationReport,
  type ProjectDriftReport,
  type ProjectDriftSignal,
} from "../contracts/project-intelligence";
import { createClient } from "../api/client";
import { writeDecisionRequest } from "./decision-requests";

export const CONTEXT_CONTROL_RELATIVE_DIR = path.join(
  ".snipara",
  "context-control",
);
export const CONTEXT_CONTROL_PLANS_RELATIVE_DIR = path.join(
  CONTEXT_CONTROL_RELATIVE_DIR,
  "plans",
);
export const CONTEXT_CONTROL_APPLIED_RELATIVE_DIR = path.join(
  CONTEXT_CONTROL_RELATIVE_DIR,
  "applied",
);
export const CONTEXT_CONTROL_STATE_RELATIVE_DIR = path.join(
  CONTEXT_CONTROL_RELATIVE_DIR,
  "state",
);
export const PROJECT_CONTEXT_MANIFEST_DEFAULT_PATH =
  "snipara.project-context.json";

export interface ContextControlPlanCommandOptions {
  summary?: string;
  target?: string;
  manifest?: string;
  output?: string;
  projectId?: string;
  expiresAt?: string;
  approvalRequired?: boolean;
  json?: boolean;
}

export interface ContextControlApplyCommandOptions {
  plan: string;
  allowStaleBase?: boolean;
  approved?: boolean;
  json?: boolean;
}

export interface ContextControlHostedDiffCommandOptions {
  manifest?: string;
  output?: string;
  emitDecisionRequest?: boolean;
  json?: boolean;
}

export interface ContextControlHostedApplyCommandOptions {
  plan: string;
  approval?: string;
  output?: string;
  json?: boolean;
}

export interface ContextControlDriftCommandOptions {
  json?: boolean;
}

export interface ContextControlValidateCommandOptions {
  manifest?: string;
  json?: boolean;
}

export interface LocalContextMutationPlanResult {
  plan: ContextMutationPlan;
  planPath?: string;
}

export interface LocalContextMutationApplyResult {
  plan: ContextMutationPlan;
  receipt: ContextMutationApplyReceipt;
  receiptPath?: string;
  writtenFiles: string[];
}

export interface HostedContextControlDiffResult {
  project: { id: string; name: string; slug: string };
  plan: HostedContextControlPlan;
  planPath?: string;
  decisionRequest?: ReturnType<typeof writeDecisionRequest>;
}

export interface HostedContextControlApplyResult {
  project: { id: string; name: string; slug: string };
  receipt: HostedContextControlApplyReceipt;
  receiptPath?: string;
}

const DEFAULT_PLAN_SUMMARY = "Record local context-control state";

function runGit(
  args: string[],
  cwd: string,
  options: { preserveLeadingWhitespace?: boolean } = {},
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

function resolveGitBaseRevision(cwd: string): ContextMutationBaseRevision {
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const headSha = runGit(["rev-parse", "--verify", "HEAD"], cwd);
  const dirtyFiles =
    runGit(["status", "--short"], cwd, { preserveLeadingWhitespace: true })
      ?.split(/\r?\n/g)
      .map(parseDirtyFile)
      .filter((file): file is string => Boolean(file)) ?? [];

  return {
    kind: headSha ? "git" : "unknown",
    ...(branch && branch !== "HEAD" ? { branch } : {}),
    ...(headSha ? { headSha } : {}),
    dirty: dirtyFiles.length > 0,
    dirtyFiles: uniqueStrings(dirtyFiles),
  };
}

function parseDirtyFile(line: string): string | undefined {
  if (!line.trim()) return undefined;
  const withoutStatus = line.length >= 3 ? line.slice(3).trim() : line.trim();
  const renameParts = withoutStatus.split(" -> ");
  return renameParts[renameParts.length - 1]?.replace(/^"|"$/g, "");
}

function resolveGitDriftScopePaths(cwd: string): string[] {
  const scopePaths = [
    PROJECT_CONTEXT_MANIFEST_DEFAULT_PATH,
    CONTEXT_CONTROL_RELATIVE_DIR,
    path.join(".snipara", "decisions"),
  ];
  const manifestPath = resolveManifestPath(cwd);
  if (!fs.existsSync(manifestPath)) {
    return normalizeScopePaths(scopePaths, cwd);
  }

  const manifestRead = readJsonFileSafe(manifestPath);
  if (!manifestRead.value) {
    return normalizeScopePaths(scopePaths, cwd);
  }

  const validation = validateProjectContextManifest({
    manifest: manifestRead.value,
  });
  const manifestSourcePaths =
    validation.manifest?.sources.map((source) => source.path) ?? [];
  return normalizeScopePaths([...scopePaths, ...manifestSourcePaths], cwd);
}

function normalizeScopePaths(scopePaths: string[], cwd: string): string[] {
  return uniqueStrings(
    scopePaths.map((scopePath) =>
      normalizeProjectRelativePath(scopePath, cwd).replace(/\/+$/g, ""),
    ),
  );
}

function isPathInsideScope(filePath: string, scopePaths: string[]): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/g, "");
  return scopePaths.some(
    (scopePath) =>
      normalized === scopePath || normalized.startsWith(`${scopePath}/`),
  );
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return slug || "context-control-state";
}

function toProjectRelativePath(absolutePath: string, cwd: string): string {
  const relative = path.relative(cwd, absolutePath);
  return relative && !relative.startsWith("..") ? relative : absolutePath;
}

function normalizeProjectRelativePath(filePath: string, cwd: string): string {
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(cwd, filePath);
  return toProjectRelativePath(absolute, cwd).split(path.sep).join("/");
}

function assertContextControlTarget(target: string, cwd: string): string {
  const relative = normalizeProjectRelativePath(target, cwd);
  if (
    path.isAbsolute(relative) ||
    relative.startsWith("../") ||
    relative === ".." ||
    !relative.startsWith(".snipara/context-control/")
  ) {
    throw new Error(
      `Context-control apply can only write under ${CONTEXT_CONTROL_RELATIVE_DIR}; got ${target}`,
    );
  }
  return relative;
}

function defaultTargetPath(summary: string): string {
  return path.join(
    CONTEXT_CONTROL_STATE_RELATIVE_DIR,
    `${slugify(summary)}.json`,
  );
}

function receiptPathFor(
  receipt: ContextMutationApplyReceipt,
  cwd: string,
): string {
  return path.resolve(
    cwd,
    CONTEXT_CONTROL_APPLIED_RELATIVE_DIR,
    `${receipt.receiptId}.json`,
  );
}

function writeStableJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${stableDecisionJsonStringify(value)}\n`, "utf8");
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function buildStateOperation(options: {
  cwd: string;
  summary: string;
  target?: string;
  baseRevision: ContextMutationBaseRevision;
  now: Date;
}): ContextMutationOperation {
  const target = assertContextControlTarget(
    options.target ?? defaultTargetPath(options.summary),
    options.cwd,
  );
  return {
    opId: "write-context-control-state",
    kind: "write_file",
    target,
    summary: `Write local context-control state for: ${options.summary}`,
    mode: "create_or_replace",
    content: {
      schemaVersion: "snipara.context_control.state_record.v0",
      summary: options.summary,
      recordedAt: options.now.toISOString(),
      baseRevision: options.baseRevision,
      source: "snipara-companion context-control plan",
    },
    reasonCodes: ["context_control_plan", "preview_before_apply"],
  };
}

function resolveManifestPath(cwd: string, manifest?: string): string {
  return path.resolve(cwd, manifest ?? PROJECT_CONTEXT_MANIFEST_DEFAULT_PATH);
}

export function buildLocalProjectContextValidationReport(
  options: ContextControlValidateCommandOptions & {
    cwd?: string;
    now?: Date;
  } = {},
): ProjectContextValidationReport {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const manifestPath = resolveManifestPath(cwd, options.manifest);
  const manifest = readJsonFile(manifestPath);
  return validateProjectContextManifest({
    manifest,
    generatedAt: options.now,
  });
}

function buildManifestOperation(options: {
  cwd: string;
  manifestPath: string;
  validation: ProjectContextValidationReport;
  target?: string;
}): ContextMutationOperation {
  const relativeManifestPath = toProjectRelativePath(
    options.manifestPath,
    options.cwd,
  );
  const target = assertContextControlTarget(
    options.target ??
      path.join(
        CONTEXT_CONTROL_STATE_RELATIVE_DIR,
        "project-context-manifest.json",
      ),
    options.cwd,
  );
  return {
    opId: "write-project-context-manifest-state",
    kind: "write_file",
    target,
    summary: `Record validated ProjectContext manifest ${relativeManifestPath}`,
    mode: "create_or_replace",
    content: {
      schemaVersion: "snipara.project_context_state.v0",
      manifestPath: relativeManifestPath,
      validation: options.validation,
      source: "snipara-companion context-control plan --manifest",
    },
    reasonCodes: [
      "project_context_manifest",
      "context_as_code",
      "preview_before_apply",
    ],
  };
}

export function buildLocalContextMutationPlan(
  options: ContextControlPlanCommandOptions & { cwd?: string; now?: Date } = {},
): LocalContextMutationPlanResult {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const now = options.now ?? new Date();
  const manifestPath = options.manifest
    ? resolveManifestPath(cwd, options.manifest)
    : undefined;
  const validation = manifestPath
    ? buildLocalProjectContextValidationReport({
        cwd,
        manifest: manifestPath,
        now,
      })
    : undefined;
  if (validation?.status === "invalid") {
    throw new Error(
      "ProjectContext manifest is invalid; run context-control validate first.",
    );
  }
  const summary =
    options.summary?.trim() ||
    (manifestPath
      ? `Reconcile ProjectContext manifest ${toProjectRelativePath(manifestPath, cwd)}`
      : DEFAULT_PLAN_SUMMARY);
  const baseRevision = resolveGitBaseRevision(cwd);
  const operation =
    validation && manifestPath
      ? buildManifestOperation({
          cwd,
          manifestPath,
          validation,
          target: options.target,
        })
      : buildStateOperation({
          cwd,
          summary,
          target: options.target,
          baseRevision,
          now,
        });
  const warnings = [
    baseRevision.dirty
      ? "Working tree has local changes; apply checks the previewed Git HEAD and records the dirty-file list for review."
      : undefined,
    ...(validation?.findings
      .filter((finding) => finding.severity === "warning")
      .map((finding) => finding.summary) ?? []),
  ].filter((warning): warning is string => Boolean(warning));
  const plan = buildContextMutationPlan({
    createdAt: now,
    producer: {
      kind: validation
        ? "project_context_manifest"
        : "companion_context_control",
      command: validation
        ? "context-control plan --manifest"
        : "context-control plan",
      ...(manifestPath
        ? { sourceRef: toProjectRelativePath(manifestPath, cwd) }
        : {}),
    },
    projectId: options.projectId,
    baseRevision,
    summary,
    operations: [operation],
    preconditions: [
      {
        kind: "base_revision_matches",
        summary:
          "Apply only when the current Git HEAD still matches the previewed base revision.",
        required: true,
      },
      {
        kind: "target_inside_context_control",
        summary: "Local writes are restricted to .snipara/context-control/.",
        required: true,
      },
    ],
    warnings,
    approvalRequired: options.approvalRequired ?? true,
    expiresAt: options.expiresAt,
  });
  const planPath = options.output
    ? path.resolve(cwd, options.output)
    : undefined;
  if (planPath) {
    writeStableJsonFile(planPath, plan);
  }
  return { plan, ...(planPath ? { planPath } : {}) };
}

export function applyLocalContextMutationPlan(
  options: ContextControlApplyCommandOptions & { cwd?: string; now?: Date },
): LocalContextMutationApplyResult {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const planPath = path.resolve(cwd, options.plan);
  const rawPlan = readJsonFile(planPath);
  if (!isContextMutationPlan(rawPlan)) {
    throw new Error(`Invalid context mutation plan: ${options.plan}`);
  }
  const plan = rawPlan;
  const rebuilt = buildContextMutationPlan({
    createdAt: plan.createdAt,
    producer: plan.producer,
    projectId: plan.projectId,
    baseRevision: plan.baseRevision,
    summary: plan.summary,
    operations: plan.operations,
    preconditions: plan.preconditions,
    warnings: plan.warnings,
    approvalRequired: plan.approvalRequired,
    expiresAt: plan.expiresAt,
  });
  if (rebuilt.planHash !== plan.planHash || rebuilt.planId !== plan.planId) {
    const receipt = buildContextMutationApplyReceipt({
      plan,
      appliedAt: options.now,
      status: "blocked",
      baseRevisionAtApply: resolveGitBaseRevision(cwd),
      skippedOperations: plan.operations.map((operation) => ({
        opId: operation.opId,
        kind: operation.kind,
        target: operation.target,
        status: "skipped",
        message: "Plan hash does not match plan content.",
      })),
      caveats: ["The plan file may have been edited after preview."],
    });
    return { plan, receipt, writtenFiles: [] };
  }

  if (plan.approvalRequired && !options.approved) {
    const receipt = buildContextMutationApplyReceipt({
      plan,
      appliedAt: options.now,
      status: "blocked",
      baseRevisionAtApply: resolveGitBaseRevision(cwd),
      skippedOperations: plan.operations.map((operation) => ({
        opId: operation.opId,
        kind: operation.kind,
        target: operation.target,
        status: "skipped",
        contentHash: operation.contentHash,
        message: "Explicit --approve acknowledgement was not provided.",
      })),
      caveats: [
        "Re-run context-control apply with --approve after reviewing the plan.",
      ],
    });
    return { plan, receipt, writtenFiles: [] };
  }

  const currentRevision = resolveGitBaseRevision(cwd);
  const staleBase =
    Boolean(plan.baseRevision.headSha && currentRevision.headSha) &&
    plan.baseRevision.headSha !== currentRevision.headSha;
  if (staleBase && !options.allowStaleBase) {
    const receipt = buildContextMutationApplyReceipt({
      plan,
      appliedAt: options.now,
      status: "stale_base",
      baseRevisionAtApply: currentRevision,
      skippedOperations: plan.operations.map((operation) => ({
        opId: operation.opId,
        kind: operation.kind,
        target: operation.target,
        status: "skipped",
        contentHash: operation.contentHash,
        message:
          "Current Git HEAD no longer matches the previewed base revision.",
      })),
      caveats: [
        "Re-run context-control plan before applying on the new base revision.",
      ],
    });
    return { plan, receipt, writtenFiles: [] };
  }

  const pendingReceipt = buildContextMutationApplyReceipt({
    plan,
    appliedAt: options.now,
    status: "applied",
    baseRevisionAtApply: currentRevision,
  });
  const receiptPath = receiptPathFor(pendingReceipt, cwd);
  if (fs.existsSync(receiptPath)) {
    const receipt = buildContextMutationApplyReceipt({
      plan,
      appliedAt: options.now,
      status: "already_applied",
      baseRevisionAtApply: currentRevision,
      skippedOperations: plan.operations.map((operation) => ({
        opId: operation.opId,
        kind: operation.kind,
        target: operation.target,
        status: "skipped",
        contentHash: operation.contentHash,
        message: "Apply receipt already exists for this plan hash.",
      })),
      caveats: [`Existing receipt: ${toProjectRelativePath(receiptPath, cwd)}`],
    });
    return {
      plan,
      receipt,
      receiptPath: toProjectRelativePath(receiptPath, cwd),
      writtenFiles: [],
    };
  }

  const appliedOperations: ContextMutationAppliedOperation[] = [];
  const writtenFiles: string[] = [];
  for (const operation of plan.operations) {
    const target = assertContextControlTarget(operation.target, cwd);
    if (operation.kind === "record_receipt") {
      appliedOperations.push({
        opId: operation.opId,
        kind: operation.kind,
        target,
        status: "applied",
        contentHash: operation.contentHash,
      });
      continue;
    }
    const absoluteTarget = path.resolve(cwd, target);
    if (operation.mode === "create" && fs.existsSync(absoluteTarget)) {
      throw new Error(
        `Refusing to overwrite existing context-control file: ${target}`,
      );
    }
    writeStableJsonFile(absoluteTarget, operation.content ?? {});
    writtenFiles.push(target);
    appliedOperations.push({
      opId: operation.opId,
      kind: operation.kind,
      target,
      status: "applied",
      contentHash: operation.contentHash,
    });
  }

  const receipt = buildContextMutationApplyReceipt({
    plan,
    appliedAt: options.now,
    status: "applied",
    baseRevisionAtApply: currentRevision,
    appliedOperations,
    caveats: [
      "Apply is idempotent by plan hash; re-running the same plan records already_applied.",
      "V0 only writes local .snipara/context-control artifacts.",
    ],
  });
  writeStableJsonFile(receiptPath, receipt);
  writtenFiles.push(toProjectRelativePath(receiptPath, cwd));

  return {
    plan,
    receipt,
    receiptPath: toProjectRelativePath(receiptPath, cwd),
    writtenFiles,
  };
}

function listJsonFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name))
    .sort((left, right) => left.localeCompare(right));
}

function readJsonFileSafe(filePath: string): {
  value?: unknown;
  error?: string;
} {
  try {
    return { value: readJsonFile(filePath) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function collectGitDriftSignals(cwd: string): ProjectDriftSignal[] {
  const revision = resolveGitBaseRevision(cwd);
  const scopePaths = resolveGitDriftScopePaths(cwd);
  const relevantDirtyFiles = revision.dirtyFiles.filter((file) =>
    isPathInsideScope(file, scopePaths),
  );
  const upstream = runGit(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    cwd,
  );
  const upstreamCounts = upstream
    ? runGit(["rev-list", "--left-right", "--count", `${upstream}...HEAD`], cwd)
    : undefined;
  const [behind = 0, ahead = 0] = upstreamCounts
    ? upstreamCounts.split(/\s+/g).map((part) => Number.parseInt(part, 10) || 0)
    : [];
  const dirtySignal: ProjectDriftSignal = revision.dirty
    ? relevantDirtyFiles.length > 0
      ? {
          id: "git-working-tree-dirty-relevant",
          surface: "git",
          state: "DRIFT_DETECTED",
          summary:
            "Working tree has uncommitted changes in context-control or ProjectContext scope.",
          expected:
            "Manifest, manifest sources, Decision Requests, and context-control artifacts are clean.",
          observed: relevantDirtyFiles.join(", "),
          refs: relevantDirtyFiles,
          severity: "watch",
          reasonCodes: ["git_working_tree_dirty_relevant"],
        }
      : {
          id: "git-working-tree-dirty-out-of-scope",
          surface: "git",
          state: "IN_SYNC",
          summary:
            "Working tree has uncommitted changes, but none are in context-control or ProjectContext scope.",
          expected: `Only scoped dirty paths affect context-control drift: ${scopePaths.join(", ")}.`,
          observed: `${revision.dirtyFiles.length} out-of-scope dirty file(s)`,
          refs: revision.dirtyFiles,
          severity: "info",
          reasonCodes: ["git_working_tree_dirty_out_of_scope"],
        }
    : {
        id: "git-working-tree-clean",
        surface: "git",
        state: "IN_SYNC",
        summary: "Working tree has no uncommitted changes.",
        refs: scopePaths,
        severity: "info",
        reasonCodes: ["git_working_tree_clean"],
      };
  const upstreamSignal: ProjectDriftSignal =
    upstream === undefined
      ? {
          id: "git-upstream-unknown",
          surface: "git",
          state: "UNKNOWN",
          summary: "No Git upstream was resolved.",
          expected:
            "A branch upstream is available for ahead/behind drift checks.",
          refs: [],
          severity: "watch",
          reasonCodes: ["git_upstream_unknown"],
        }
      : ahead > 0 || behind > 0
        ? {
            id: "git-upstream-diverged",
            surface: "git",
            state: "DRIFT_DETECTED",
            summary: "Local branch differs from its upstream.",
            expected: `${upstream} and HEAD point at the same commit for release.`,
            observed: `${ahead} ahead, ${behind} behind`,
            refs: [upstream],
            severity: behind > 0 ? "risk" : "watch",
            reasonCodes: ["git_upstream_drift"],
          }
        : {
            id: "git-upstream-in-sync",
            surface: "git",
            state: "IN_SYNC",
            summary: "Local branch matches its upstream.",
            refs: [upstream],
            severity: "info",
            reasonCodes: ["git_upstream_in_sync"],
          };
  return [dirtySignal, upstreamSignal];
}

function collectWorkflowDriftSignals(cwd: string): ProjectDriftSignal[] {
  const workflowPath = path.join(cwd, ".snipara", "workflow", "current.json");
  if (!fs.existsSync(workflowPath)) {
    return [
      {
        id: "workflow-state-missing",
        surface: "workflow",
        state: "UNKNOWN",
        summary: "No managed workflow state file was found.",
        expected: "FULL work keeps .snipara/workflow/current.json current.",
        refs: [".snipara/workflow/current.json"],
        severity: "watch",
        reasonCodes: ["workflow_state_missing"],
      },
    ];
  }
  const read = readJsonFileSafe(workflowPath);
  if (!read.value || read.error || typeof read.value !== "object") {
    return [
      {
        id: "workflow-state-unreadable",
        surface: "workflow",
        state: "UNKNOWN",
        summary: "Managed workflow state could not be read.",
        observed: read.error,
        refs: [".snipara/workflow/current.json"],
        severity: "watch",
        reasonCodes: ["workflow_state_unreadable"],
      },
    ];
  }
  const record = read.value as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status : "unknown";
  const currentPhaseId =
    typeof record.currentPhaseId === "string"
      ? record.currentPhaseId
      : undefined;
  return [
    {
      id: "workflow-state-present",
      surface: "workflow",
      state: status === "active" ? "IN_SYNC" : "UNKNOWN",
      summary:
        status === "active"
          ? `Managed workflow is active${currentPhaseId ? ` on ${currentPhaseId}` : ""}.`
          : `Managed workflow status is ${status}.`,
      refs: [".snipara/workflow/current.json"],
      severity: status === "active" ? "info" : "watch",
      reasonCodes: [
        status === "active"
          ? "workflow_state_active"
          : "workflow_state_unknown",
      ],
    },
  ];
}

function collectDecisionDriftSignals(cwd: string): ProjectDriftSignal[] {
  const pendingDir = path.join(cwd, ".snipara", "decisions", "pending");
  const pending = listJsonFiles(pendingDir).map((file) =>
    toProjectRelativePath(file, cwd),
  );
  return [
    pending.length > 0
      ? {
          id: "decision-requests-pending",
          surface: "decision_requests",
          state: "DRIFT_DETECTED",
          summary: `${pending.length} pending Decision Request artifact(s) need human resolution.`,
          expected:
            "Decision Requests are resolved with workflow decide or explicitly deferred.",
          observed: `${pending.length} pending`,
          refs: pending,
          severity: "risk",
          reasonCodes: ["decision_requests_pending"],
        }
      : {
          id: "decision-requests-clear",
          surface: "decision_requests",
          state: "IN_SYNC",
          summary: "No pending local Decision Requests were found.",
          refs: [],
          severity: "info",
          reasonCodes: ["decision_requests_clear"],
        },
  ];
}

function collectContextControlDriftSignals(cwd: string): ProjectDriftSignal[] {
  const planFiles = listJsonFiles(
    path.join(cwd, CONTEXT_CONTROL_PLANS_RELATIVE_DIR),
  );
  const receiptFiles = listJsonFiles(
    path.join(cwd, CONTEXT_CONTROL_APPLIED_RELATIVE_DIR),
  );
  const receiptPlanHashes = new Set(
    receiptFiles
      .map((file) => readJsonFileSafe(file).value)
      .filter(isContextMutationApplyReceipt)
      .map((receipt) => receipt.planHash),
  );
  if (planFiles.length === 0) {
    return [
      {
        id: "context-control-no-plans",
        surface: "context_control",
        state: "IN_SYNC",
        summary: "No saved context mutation plans were found.",
        refs: [],
        severity: "info",
        reasonCodes: ["context_control_no_saved_plans"],
      },
    ];
  }

  const currentRevision = resolveGitBaseRevision(cwd);
  return planFiles.map((file) => {
    const relative = toProjectRelativePath(file, cwd);
    const read = readJsonFileSafe(file);
    if (!read.value || !isContextMutationPlan(read.value)) {
      return {
        id: `context-control-plan-invalid-${path.basename(file, ".json")}`,
        surface: "context_control",
        state: "UNKNOWN",
        summary: "A saved context mutation plan is invalid or unreadable.",
        observed: read.error,
        refs: [relative],
        severity: "watch",
        reasonCodes: ["context_control_plan_invalid"],
      };
    }
    const plan = read.value;
    if (receiptPlanHashes.has(plan.planHash)) {
      return {
        id: `context-control-plan-applied-${plan.planId}`,
        surface: "context_control",
        state: "IN_SYNC",
        summary: `Context mutation plan ${plan.planId} has an apply receipt.`,
        refs: [relative],
        severity: "info",
        reasonCodes: ["context_control_plan_applied"],
      };
    }
    const staleBase =
      Boolean(plan.baseRevision.headSha && currentRevision.headSha) &&
      plan.baseRevision.headSha !== currentRevision.headSha;
    return staleBase
      ? {
          id: `context-control-plan-stale-${plan.planId}`,
          surface: "context_control",
          state: "STALE_EVIDENCE",
          summary: `Context mutation plan ${plan.planId} was previewed against an older Git HEAD.`,
          expected: plan.baseRevision.headSha,
          observed: currentRevision.headSha,
          refs: [relative],
          severity: "watch",
          reasonCodes: ["context_control_plan_stale_base"],
        }
      : {
          id: `context-control-plan-pending-${plan.planId}`,
          surface: "context_control",
          state: "DRIFT_DETECTED",
          summary: `Context mutation plan ${plan.planId} has not been applied.`,
          expected:
            "Saved plans have matching apply receipts or are superseded.",
          observed: "No apply receipt for plan hash.",
          refs: [relative],
          severity: "risk",
          reasonCodes: ["context_control_plan_pending_apply"],
        };
  });
}

function collectProjectContextManifestDriftSignals(
  cwd: string,
): ProjectDriftSignal[] {
  const manifestPath = resolveManifestPath(cwd);
  const relative = toProjectRelativePath(manifestPath, cwd);
  if (!fs.existsSync(manifestPath)) {
    return [
      {
        id: "project-context-manifest-missing",
        surface: "project_context_manifest",
        state: "UNKNOWN",
        summary: "No ProjectContext manifest was found.",
        expected: PROJECT_CONTEXT_MANIFEST_DEFAULT_PATH,
        refs: [relative],
        severity: "watch",
        reasonCodes: ["project_context_manifest_missing"],
      },
    ];
  }
  const validation = buildLocalProjectContextValidationReport({
    cwd,
    manifest: manifestPath,
  });
  if (validation.status === "invalid") {
    return [
      {
        id: "project-context-manifest-invalid",
        surface: "project_context_manifest",
        state: "DRIFT_DETECTED",
        summary: "ProjectContext manifest is invalid.",
        observed: validation.findings
          .map((finding) => finding.summary)
          .join("; "),
        refs: [relative],
        severity: "risk",
        reasonCodes: ["project_context_manifest_invalid"],
      },
    ];
  }
  if (validation.status === "review_required") {
    return [
      {
        id: "project-context-manifest-review-required",
        surface: "project_context_manifest",
        state: "STALE_EVIDENCE",
        summary: "ProjectContext manifest is valid but needs review.",
        observed: validation.findings
          .map((finding) => finding.summary)
          .join("; "),
        refs: [relative],
        severity: "watch",
        reasonCodes: ["project_context_manifest_review_required"],
      },
    ];
  }
  return [
    {
      id: "project-context-manifest-valid",
      surface: "project_context_manifest",
      state: "IN_SYNC",
      summary: "ProjectContext manifest validates.",
      refs: [relative],
      severity: "info",
      reasonCodes: ["project_context_manifest_valid"],
    },
  ];
}

export function buildLocalProjectDriftReport(
  options: ContextControlDriftCommandOptions & {
    cwd?: string;
    now?: Date;
  } = {},
): ProjectDriftReport {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  return buildProjectDriftReport({
    generatedAt: options.now,
    signals: [
      ...collectGitDriftSignals(cwd),
      ...collectWorkflowDriftSignals(cwd),
      ...collectDecisionDriftSignals(cwd),
      ...collectContextControlDriftSignals(cwd),
      ...collectProjectContextManifestDriftSignals(cwd),
    ],
    caveats: [
      "Project Drift V0 is a read-only local report.",
      "Git dirty-file drift is scoped to the ProjectContext manifest, manifest sources, Decision Requests, and .snipara/context-control artifacts; use git status for full working-tree release readiness.",
      "Project Drift V0 validates manifest health locally but does not refresh hosted context state; hosted manifest-vs-context reconciliation is V1 work.",
      "UNKNOWN is never treated as IN_SYNC; verify missing or unreadable evidence before applying changes.",
    ],
  });
}

function printPlan(result: LocalContextMutationPlanResult): void {
  console.log(chalk.bold("Context Mutation Plan"));
  console.log(`Plan: ${result.plan.planId}`);
  console.log(`Hash: ${result.plan.planHash}`);
  console.log(`Summary: ${result.plan.summary}`);
  console.log(
    `Approval required: ${result.plan.approvalRequired ? "yes" : "no"}`,
  );
  if (result.planPath) {
    console.log(`Written: ${result.planPath}`);
  }
  if (result.plan.warnings.length > 0) {
    console.log("");
    console.log(chalk.yellow("Warnings"));
    for (const warning of result.plan.warnings) {
      console.log(`- ${warning}`);
    }
  }
  console.log("");
  console.log(chalk.bold("Operations"));
  for (const operation of result.plan.operations) {
    console.log(
      `- ${operation.kind} ${operation.target}: ${operation.summary}`,
    );
  }
}

function printValidation(report: ProjectContextValidationReport): void {
  console.log(chalk.bold("ProjectContext Validation"));
  console.log(`Status: ${report.status}`);
  console.log(`Manifest hash: ${report.manifestHash}`);
  if (report.findings.length > 0) {
    console.log("");
    console.log(chalk.bold("Findings"));
    for (const finding of report.findings) {
      console.log(`- ${finding.severity}: ${finding.summary}`);
    }
  }
  if (report.caveats.length > 0) {
    console.log("");
    console.log(chalk.yellow("Caveats"));
    for (const caveat of report.caveats) {
      console.log(`- ${caveat}`);
    }
  }
}

function printApply(result: LocalContextMutationApplyResult): void {
  console.log(chalk.bold("Context Mutation Apply"));
  console.log(`Plan: ${result.plan.planId}`);
  console.log(`Status: ${result.receipt.status}`);
  if (result.receiptPath) {
    console.log(`Receipt: ${result.receiptPath}`);
  }
  if (result.writtenFiles.length > 0) {
    console.log("");
    console.log(chalk.bold("Written files"));
    for (const file of result.writtenFiles) {
      console.log(`- ${file}`);
    }
  }
  if (result.receipt.caveats.length > 0) {
    console.log("");
    console.log(chalk.yellow("Caveats"));
    for (const caveat of result.receipt.caveats) {
      console.log(`- ${caveat}`);
    }
  }
}

function printDrift(report: ProjectDriftReport): void {
  console.log(chalk.bold("Project Drift"));
  console.log(`State: ${report.state}`);
  console.log(`Report: ${report.reportId}`);
  console.log(report.summary);
  console.log("");
  console.log(chalk.bold("Signals"));
  for (const signal of report.signals) {
    console.log(`- ${signal.state} [${signal.surface}] ${signal.summary}`);
    if (signal.observed) {
      console.log(`  observed: ${signal.observed}`);
    }
    if (signal.expected) {
      console.log(`  expected: ${signal.expected}`);
    }
  }
  if (report.caveats.length > 0) {
    console.log("");
    console.log(chalk.yellow("Caveats"));
    for (const caveat of report.caveats) {
      console.log(`- ${caveat}`);
    }
  }
}

export async function contextControlPlanCommand(
  options: ContextControlPlanCommandOptions,
): Promise<void> {
  const result = buildLocalContextMutationPlan(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printPlan(result);
}

export async function contextControlApplyCommand(
  options: ContextControlApplyCommandOptions,
): Promise<void> {
  const result = applyLocalContextMutationPlan(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printApply(result);
  }
  if (
    result.receipt.status === "stale_base" ||
    result.receipt.status === "blocked"
  ) {
    process.exitCode = 1;
  }
}

export async function contextControlDriftCommand(
  options: ContextControlDriftCommandOptions,
): Promise<void> {
  const report = buildLocalProjectDriftReport(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printDrift(report);
}

export async function contextControlValidateCommand(
  options: ContextControlValidateCommandOptions,
): Promise<void> {
  const report = buildLocalProjectContextValidationReport(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printValidation(report);
  }
  if (report.status === "invalid") {
    process.exitCode = 1;
  }
}

function resolveHostedContextSources(
  cwd: string,
  manifestPath: string,
  report: ProjectContextValidationReport,
): HostedContextControlSource[] {
  if (!report.manifest || report.status === "invalid") {
    throw new Error(
      "ProjectContext manifest is invalid; run context-control validate first.",
    );
  }
  const workspaceRoot = fs.realpathSync(cwd);
  return report.manifest.sources.map((source) => {
    const candidate = path.resolve(cwd, source.path);
    if (!fs.existsSync(candidate)) {
      throw new Error(`ProjectContext source is missing: ${source.path}`);
    }
    if (fs.lstatSync(candidate).isSymbolicLink()) {
      throw new Error(
        `ProjectContext source symlinks are not allowed: ${source.path}`,
      );
    }
    const canonical = fs.realpathSync(candidate);
    if (
      canonical !== workspaceRoot &&
      !canonical.startsWith(`${workspaceRoot}${path.sep}`)
    ) {
      throw new Error(
        `ProjectContext source escapes the workspace: ${source.path}`,
      );
    }
    if (!fs.statSync(canonical).isFile()) {
      throw new Error(`ProjectContext source must be a file: ${source.path}`);
    }
    const content = fs.readFileSync(canonical, "utf8");
    if (Buffer.byteLength(content, "utf8") > 1_000_000) {
      throw new Error(`ProjectContext source exceeds 1 MB: ${source.path}`);
    }
    return { ...source, content };
  });
}

export async function contextControlHostedDiffCommand(
  options: ContextControlHostedDiffCommandOptions,
): Promise<void> {
  const cwd = process.cwd();
  const manifestPath = resolveManifestPath(cwd, options.manifest);
  const report = buildLocalProjectContextValidationReport({
    cwd,
    manifest: manifestPath,
  });
  const sources = resolveHostedContextSources(cwd, manifestPath, report);
  const response = await createClient(60_000, { cwd }).diffHostedContextControl(
    {
      manifestHash: report.manifestHash,
      sources,
    },
  );
  const result: HostedContextControlDiffResult = {
    project: response.project,
    plan: response.plan,
  };
  if (options.output) {
    const planPath = path.resolve(cwd, options.output);
    writeStableJsonFile(planPath, response.plan);
    result.planPath = toProjectRelativePath(planPath, cwd);
  }
  if (options.emitDecisionRequest && response.plan.approvalRequired) {
    if (
      response.plan.operations.some(
        (operation) => operation.action === "blocked",
      )
    ) {
      throw new Error(
        "Blocked hosted operations must be removed before requesting approval.",
      );
    }
    const request = buildDecisionRequest({
      producer: {
        kind: "hosted_context_control",
        command: "context-control hosted-diff --emit-decision-request",
        sourceRef: response.plan.planId,
      },
      decision: "Apply reviewed ProjectContext sources to hosted context",
      question: `Approve hosted Context Control plan ${response.plan.planId}?`,
      evidence: {
        summary: `${response.plan.operations.filter((operation) => operation.action === "create").length} create, ${response.plan.operations.filter((operation) => operation.action === "update").length} update, zero deletes.`,
        refs: [
          response.plan.planHash,
          toProjectRelativePath(manifestPath, cwd),
        ],
        items: [
          {
            ref: response.plan.planId,
            title: "Hosted Context Control plan",
            kind: "hosted_context_control_plan",
            metadata: {
              planHash: response.plan.planHash,
              projectId: response.plan.projectId,
            },
          },
        ],
        reasonCodes: [
          "hosted_context_control_apply",
          "human_approval_required",
          "no_delete",
        ],
        files: response.plan.sources.map((source) => source.path),
        applyPath: "context-control hosted-apply",
        applyCommand: `snipara-companion context-control hosted-apply --plan ${options.output ?? "<plan.json>"} --approval <resolved-decision.json>`,
      },
      options: ["approve_hosted_apply", "reject_hosted_apply"],
      recommendation: "approve_hosted_apply",
      rationale:
        "The plan is bounded to reviewed add/update operations and contains no deletes.",
      blocking: true,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      fingerprintParts: [
        "hosted_context_control",
        response.plan.projectId,
        response.plan.planHash,
        response.plan.operations.map((operation) => ({
          path: operation.path,
          action: operation.action,
          contentHash: operation.contentHash,
          previousHash: operation.previousHash ?? null,
        })),
      ],
    });
    result.decisionRequest = writeDecisionRequest(request, cwd);
  }
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(chalk.bold("Hosted Context Control Diff"));
  console.log(`Project: ${response.project.name} (${response.project.id})`);
  console.log(`Plan: ${response.plan.planId}`);
  console.log(`Hash: ${response.plan.planHash}`);
  for (const operation of response.plan.operations) {
    console.log(`- ${operation.action} ${operation.path}`);
  }
  if (result.planPath) console.log(`Plan written: ${result.planPath}`);
  if (result.decisionRequest?.relativePath) {
    console.log(`Decision Request: ${result.decisionRequest.relativePath}`);
  }
}

export async function contextControlHostedApplyCommand(
  options: ContextControlHostedApplyCommandOptions,
): Promise<void> {
  const cwd = process.cwd();
  const rawPlan = readJsonFile(path.resolve(cwd, options.plan));
  if (!isHostedContextControlPlan(rawPlan)) {
    throw new Error(`Invalid hosted Context Control plan: ${options.plan}`);
  }
  const approval = options.approval
    ? readJsonFile(path.resolve(cwd, options.approval))
    : undefined;
  const response = await createClient(120_000, {
    cwd,
  }).applyHostedContextControl({
    plan: rawPlan,
    approval,
  });
  if (!isHostedContextControlApplyReceipt(response.receipt)) {
    throw new Error(
      "Hosted Context Control apply returned an invalid receipt.",
    );
  }
  const result: HostedContextControlApplyResult = {
    project: response.project,
    receipt: response.receipt,
  };
  if (options.output) {
    const receiptPath = path.resolve(cwd, options.output);
    writeStableJsonFile(receiptPath, response.receipt);
    result.receiptPath = toProjectRelativePath(receiptPath, cwd);
  }
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(chalk.bold("Hosted Context Control Apply"));
  console.log(`Status: ${response.receipt.status}`);
  console.log(`Receipt: ${response.receipt.receiptId}`);
  for (const source of response.receipt.sources) {
    console.log(`- ${source.action} ${source.path}`);
  }
  if (result.receiptPath) console.log(`Receipt written: ${result.receiptPath}`);
  if (response.receipt.reindex.warning) {
    console.log(
      chalk.yellow(`Reindex warning: ${response.receipt.reindex.warning}`),
    );
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
