/**
 * Feature work-item commands.
 *
 * This is Companion's native Spec Kit-style layer. It owns durable product and
 * engineering artifacts (spec.md, plan.md, tasks.md), while the existing
 * workflow engine remains the only runtime state machine under .snipara/.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { createClient } from "../api/client";
import { findWorkspaceRoot, isConfigured } from "../config/store";
import {
  buildGeneratedWorkflowPlanDocument,
  normalizeWorkflowPlanInput,
  validatePlanResult,
  workflowStartCommand,
  type GeneratedWorkflowPlanDocument,
  type ManagedWorkflowPhase,
} from "./workflows";

export const FEATURE_WORK_ITEM_VERSION = "snipara.feature_work_item.v1" as const;
export const FEATURE_DEFAULT_OUTPUT_DIR = path.join("docs", "specs");

export interface FeatureWorkItemManifest {
  schemaVersion: typeof FEATURE_WORK_ITEM_VERSION;
  source: "snipara-companion";
  slug: string;
  goal: string;
  why?: string;
  users: string[];
  constraints: string[];
  nonGoals: string[];
  acceptanceCriteria: string[];
  createdAt: string;
  updatedAt: string;
  artifacts: {
    spec: "spec.md";
    plan: "plan.md";
    tasks: "tasks.md";
    workflowPlan: "workflow-plan.json";
  };
  status: {
    spec: "draft" | "ready";
    plan: "missing" | "ready";
    tasks: "missing" | "ready";
  };
}

export interface FeatureArtifactPaths {
  root: string;
  manifest: string;
  spec: string;
  plan: string;
  tasks: string;
  workflowPlan: string;
}

export interface FeatureSpecifyOptions {
  slug: string;
  goal?: string;
  why?: string;
  users?: string[];
  constraints?: string[];
  nonGoals?: string[];
  acceptanceCriteria?: string[];
  outputDir?: string;
  force?: boolean;
  cwd?: string;
  json?: boolean;
}

export interface FeatureCommandOptions {
  slug: string;
  force?: boolean;
  cwd?: string;
  outputDir?: string;
  maxTokens?: number;
  fromPlan?: boolean;
  json?: boolean;
}

export interface FeatureStartOptions {
  slug: string;
  workflowId?: string;
  force?: boolean;
  json?: boolean;
  cwd?: string;
  outputDir?: string;
}

function compact(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function unique(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map(compact).filter(Boolean))];
}

function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeFeatureSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!slug) {
    throw new Error("Feature slug must contain at least one letter or number.");
  }
  return slug;
}

export function resolveFeatureArtifactPaths(
  slug: string,
  options: { cwd?: string; outputDir?: string } = {}
): FeatureArtifactPaths {
  const normalizedSlug = normalizeFeatureSlug(slug);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const workspaceRoot = findWorkspaceRoot(cwd, true) ?? cwd;
  const outputDir = options.outputDir ?? FEATURE_DEFAULT_OUTPUT_DIR;
  const root = path.resolve(workspaceRoot, outputDir, normalizedSlug);
  return {
    root,
    manifest: path.join(root, "feature.json"),
    spec: path.join(root, "spec.md"),
    plan: path.join(root, "plan.md"),
    tasks: path.join(root, "tasks.md"),
    workflowPlan: path.join(root, "workflow-plan.json"),
  };
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureParent(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function assertWritable(filePath: string, force: boolean, allowGeneratedPlaceholder = false): void {
  if (!fs.existsSync(filePath) || force) {
    return;
  }
  if (allowGeneratedPlaceholder && isGeneratedPlaceholder(fs.readFileSync(filePath, "utf8"))) {
    return;
  }
  throw new Error(
    `Refusing to overwrite existing artifact: ${filePath}. Use --force to replace it.`
  );
}

function writeArtifact(
  filePath: string,
  content: string,
  force: boolean,
  allowGeneratedPlaceholder = false
): void {
  assertWritable(filePath, force, allowGeneratedPlaceholder);
  ensureParent(filePath);
  fs.writeFileSync(filePath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
}

function isGeneratedPlaceholder(content: string): boolean {
  return content.includes("<!-- Generated placeholder by snipara-companion");
}

function createManifest(
  options: FeatureSpecifyOptions,
  paths: FeatureArtifactPaths
): FeatureWorkItemManifest {
  const timestamp = nowIso();
  return {
    schemaVersion: FEATURE_WORK_ITEM_VERSION,
    source: "snipara-companion",
    slug: normalizeFeatureSlug(options.slug),
    goal: compact(options.goal),
    ...(compact(options.why) ? { why: compact(options.why) } : {}),
    users: unique(options.users),
    constraints: unique(options.constraints),
    nonGoals: unique(options.nonGoals),
    acceptanceCriteria: unique(options.acceptanceCriteria),
    createdAt: timestamp,
    updatedAt: timestamp,
    artifacts: {
      spec: "spec.md",
      plan: "plan.md",
      tasks: "tasks.md",
      workflowPlan: "workflow-plan.json",
    },
    status: {
      spec: compact(options.goal).length > 0 ? "ready" : "draft",
      plan:
        fs.existsSync(paths.plan) && !isGeneratedPlaceholder(fs.readFileSync(paths.plan, "utf8"))
          ? "ready"
          : "missing",
      tasks:
        fs.existsSync(paths.tasks) && !isGeneratedPlaceholder(fs.readFileSync(paths.tasks, "utf8"))
          ? "ready"
          : "missing",
    },
  };
}

function readManifest(paths: FeatureArtifactPaths): FeatureWorkItemManifest {
  if (!fs.existsSync(paths.manifest)) {
    throw new Error(`Feature '${path.basename(paths.root)}' is not initialized at ${paths.root}.`);
  }
  const manifest = readJsonFile<FeatureWorkItemManifest>(paths.manifest);
  if (manifest.schemaVersion !== FEATURE_WORK_ITEM_VERSION) {
    throw new Error(`Unsupported feature manifest schema in ${paths.manifest}.`);
  }
  return manifest;
}

function writeManifest(paths: FeatureArtifactPaths, manifest: FeatureWorkItemManifest): void {
  ensureParent(paths.manifest);
  writeJsonFile(paths.manifest, manifest);
}

function renderList(values: string[], empty: string): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : `- ${empty}`;
}

export function buildFeatureSpecMarkdown(manifest: FeatureWorkItemManifest): string {
  return `# Feature Specification: ${manifest.slug}

<!-- Generated by snipara-companion. Edit this artifact, then use --force only when intentionally regenerating it. -->

## Goal

${manifest.goal}

## Why now

${manifest.why ?? "<!-- Explain the user or business reason for this change. -->"}

## Users and outcomes

${renderList(manifest.users, "<!-- Name the user, team, or system affected. -->")}

## User stories

- As a \`<user>\`, I want \`<capability>\` so that \`<outcome>\`.

## Acceptance criteria

${manifest.acceptanceCriteria.length > 0 ? manifest.acceptanceCriteria.map((item) => `- [ ] ${item}`).join("\n") : "- [ ] <!-- State observable behavior that proves the goal is met. -->"}

## Constraints

${renderList(manifest.constraints, "<!-- List technical, security, operational, or product constraints. -->")}

## Non-goals

${renderList(manifest.nonGoals, "<!-- State what this change deliberately does not cover. -->")}

## Open questions

- <!-- Record unresolved decisions before implementation starts. -->
`;
}

function renderPlanPlaceholder(manifest: FeatureWorkItemManifest): string {
  return `# Technical Plan: ${manifest.slug}

<!-- Generated placeholder by snipara-companion. Run \`snipara-companion feature plan ${manifest.slug}\` to replace it. -->

## Goal

${manifest.goal}

## Implementation phases

- <!-- Run the hosted planner after reviewing spec.md. -->
`;
}

function renderTasksPlaceholder(manifest: FeatureWorkItemManifest): string {
  return `# Implementation Tasks: ${manifest.slug}

<!-- Generated placeholder by snipara-companion. Run \`snipara-companion feature tasks ${manifest.slug}\` after generating plan.md. -->

## Tasks

- [ ] <!-- Tasks will be derived from the technical plan. -->
`;
}

function quoteMarkdown(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

export function buildFeaturePlanMarkdown(
  manifest: FeatureWorkItemManifest,
  plan: GeneratedWorkflowPlanDocument
): string {
  const steps = plan.steps
    .map((step, index) => {
      const files = step.files?.length ? `\n- Files: ${step.files.join(", ")}` : "";
      const acceptance = step.acceptance ? `\n- Done when: ${quoteMarkdown(step.acceptance)}` : "";
      return `### ${index + 1}. ${step.title}\n\n- Scope: ${quoteMarkdown(step.query)}${acceptance}${files}`;
    })
    .join("\n\n");
  return `# Technical Plan: ${manifest.slug}

<!-- Generated by snipara-companion from Hosted Snipara planning. Review before implementation. -->

## Goal

${manifest.goal}

## Source

- Planner: Hosted Snipara \`snipara_plan\`
- Plan ID: ${plan.plan_id ?? "not provided"}
- Generated at: ${plan.generatedAt}

## Implementation phases

${steps || "- No implementation phases were returned."}
`;
}

export function buildFeatureTasksMarkdown(
  manifest: FeatureWorkItemManifest,
  plan: GeneratedWorkflowPlanDocument
): string {
  const tasks = plan.steps
    .map((step, index) => {
      const files = step.files?.length ? `\n  - Files: ${step.files.join(", ")}` : "";
      const acceptance = step.acceptance
        ? `\n  - Done when: ${quoteMarkdown(step.acceptance)}`
        : "";
      const dependency = index > 0 ? `\n  - Depends on: ${plan.steps[index - 1].id}` : "";
      return `- [ ] ${index + 1}. ${step.title}\n  - ID: ${step.id}\n  - Scope: ${quoteMarkdown(step.query)}${acceptance}${files}${dependency}`;
    })
    .join("\n");
  return `# Implementation Tasks: ${manifest.slug}

<!-- Generated by snipara-companion. Each task maps to one managed workflow phase. -->

## Source

- Plan ID: ${plan.plan_id ?? "not provided"}
- Generated at: ${plan.generatedAt}

## Tasks

${tasks || "- [ ] No tasks were returned by the planner."}
`;
}

function buildPlanQuery(manifest: FeatureWorkItemManifest, spec: string): string {
  return [
    `Create a technical implementation plan for the Snipara feature '${manifest.slug}'.`,
    "Use the project context and code graph when available.",
    "Return executable phases with useful titles, scope/query, acceptance criteria, and likely files.",
    "Do not silently expand the feature beyond the specification.",
    "\nFeature specification:",
    spec.slice(0, 50_000),
  ].join("\n");
}

function buildLocalWorkflowPlan(
  manifest: FeatureWorkItemManifest,
  planText: string
): GeneratedWorkflowPlanDocument {
  const phases: ManagedWorkflowPhase[] = normalizeWorkflowPlanInput(planText, manifest.goal);
  return {
    mode: "full",
    goal: manifest.goal,
    source: "local_plan",
    generatedAt: nowIso(),
    steps: phases.map((phase) => ({
      id: phase.id,
      title: phase.title,
      query: phase.query,
      ...(phase.acceptance ? { acceptance: phase.acceptance } : {}),
      ...(phase.files ? { files: phase.files } : {}),
      ...(phase.needsRuntime ? { needs_runtime: true } : {}),
    })),
  };
}

export function featureInitCommand(options: FeatureSpecifyOptions): void {
  const paths = resolveFeatureArtifactPaths(options.slug, options);
  const normalizedGoal = compact(options.goal);
  if (!normalizedGoal) {
    throw new Error("Feature initialization requires --goal.");
  }
  if (fs.existsSync(paths.manifest) && !options.force) {
    throw new Error(`Feature already exists at ${paths.root}. Use --force to reinitialize it.`);
  }

  const manifest = createManifest(options, paths);
  fs.mkdirSync(paths.root, { recursive: true });
  writeManifest(paths, manifest);
  writeArtifact(paths.spec, buildFeatureSpecMarkdown(manifest), Boolean(options.force));
  writeArtifact(paths.plan, renderPlanPlaceholder(manifest), Boolean(options.force));
  writeArtifact(paths.tasks, renderTasksPlaceholder(manifest), Boolean(options.force));

  if (options.json) {
    console.log(JSON.stringify({ manifest, paths }, null, 2));
    return;
  }
  console.log(chalk.bold("Feature work item initialized"));
  console.log(`Directory: ${paths.root}`);
  console.log("Artifacts: spec.md, plan.md, tasks.md");
  console.log(`Next: snipara-companion feature plan ${manifest.slug}`);
}

export function featureSpecifyCommand(options: FeatureSpecifyOptions): void {
  const paths = resolveFeatureArtifactPaths(options.slug, options);
  const existing = fs.existsSync(paths.manifest) ? readManifest(paths) : undefined;
  const manifest = createManifest(
    {
      ...options,
      goal: compact(options.goal) || existing?.goal || "",
      why: compact(options.why) || existing?.why,
      users: options.users?.length ? options.users : existing?.users,
      constraints: options.constraints?.length ? options.constraints : existing?.constraints,
      nonGoals: options.nonGoals?.length ? options.nonGoals : existing?.nonGoals,
      acceptanceCriteria: options.acceptanceCriteria?.length
        ? options.acceptanceCriteria
        : existing?.acceptanceCriteria,
    },
    paths
  );
  if (!manifest.goal) {
    throw new Error("Feature specification requires --goal when no existing manifest is present.");
  }
  if (
    fs.existsSync(paths.spec) &&
    !options.force &&
    !isGeneratedPlaceholder(fs.readFileSync(paths.spec, "utf8"))
  ) {
    throw new Error(`Refusing to overwrite existing specification: ${paths.spec}. Use --force.`);
  }
  fs.mkdirSync(paths.root, { recursive: true });
  writeArtifact(paths.spec, buildFeatureSpecMarkdown(manifest), Boolean(options.force), true);
  manifest.updatedAt = nowIso();
  writeManifest(paths, manifest);

  if (options.json) {
    console.log(JSON.stringify({ manifest, paths }, null, 2));
    return;
  }
  console.log(chalk.bold("Feature specification written"));
  console.log(`Spec: ${paths.spec}`);
  console.log(`Next: snipara-companion feature plan ${manifest.slug}`);
}

export async function featurePlanCommand(options: FeatureCommandOptions): Promise<void> {
  const paths = resolveFeatureArtifactPaths(options.slug, options);
  const manifest = readManifest(paths);
  if (!fs.existsSync(paths.spec)) {
    throw new Error(`Missing specification: ${paths.spec}`);
  }
  if (!isConfigured({ cwd: options.cwd })) {
    throw new Error(
      "Hosted planning requires Companion configuration. Run 'snipara-companion init' first."
    );
  }
  const spec = fs.readFileSync(paths.spec, "utf8");
  const query = buildPlanQuery(manifest, spec);
  const result = await createClient(30_000, { cwd: options.cwd }).plan(query, options.maxTokens);
  const quality = validatePlanResult(result, { query, cwd: options.cwd ?? process.cwd() });
  if (!quality.valid) {
    const detail = quality.issues.join("; ");
    throw new Error(`Hosted planner returned an invalid plan: ${detail}`);
  }
  const plan = buildGeneratedWorkflowPlanDocument(result, manifest.goal);
  assertWritable(paths.plan, Boolean(options.force), true);
  assertWritable(paths.workflowPlan, Boolean(options.force));
  writeArtifact(paths.plan, buildFeaturePlanMarkdown(manifest, plan), Boolean(options.force), true);
  ensureParent(paths.workflowPlan);
  writeJsonFile(paths.workflowPlan, plan);
  manifest.updatedAt = nowIso();
  manifest.status.plan = "ready";
  manifest.status.tasks = "missing";
  writeManifest(paths, manifest);

  const payload = { manifest, paths, plan, plan_quality: quality };
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(chalk.bold("Technical plan generated"));
  console.log(`Plan: ${paths.plan}`);
  console.log(`Workflow plan: ${paths.workflowPlan}`);
  if (quality.warnings.length > 0) {
    console.log(`Warnings: ${quality.warnings.join(" | ")}`);
  }
  console.log(`Next: snipara-companion feature tasks ${manifest.slug}`);
}

export function featureTasksCommand(options: FeatureCommandOptions): void {
  const paths = resolveFeatureArtifactPaths(options.slug, options);
  const manifest = readManifest(paths);
  const useLocalPlan = Boolean(options.fromPlan) || !fs.existsSync(paths.workflowPlan);
  if (
    useLocalPlan &&
    (!fs.existsSync(paths.plan) || isGeneratedPlaceholder(fs.readFileSync(paths.plan, "utf8")))
  ) {
    throw new Error(`Missing workflow plan: ${paths.workflowPlan}. Run feature plan first.`);
  }
  const plan = useLocalPlan
    ? buildLocalWorkflowPlan(manifest, fs.readFileSync(paths.plan, "utf8"))
    : readJsonFile<GeneratedWorkflowPlanDocument>(paths.workflowPlan);
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new Error(`Workflow plan has no executable phases: ${paths.workflowPlan}`);
  }
  if (useLocalPlan) {
    assertWritable(paths.workflowPlan, Boolean(options.force));
    ensureParent(paths.workflowPlan);
    writeJsonFile(paths.workflowPlan, plan);
  }
  writeArtifact(
    paths.tasks,
    buildFeatureTasksMarkdown(manifest, plan),
    Boolean(options.force),
    true
  );
  manifest.updatedAt = nowIso();
  manifest.status.plan = "ready";
  manifest.status.tasks = "ready";
  writeManifest(paths, manifest);

  const payload = { manifest, paths, task_count: plan.steps.length };
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(chalk.bold("Implementation tasks generated"));
  console.log(`Tasks: ${paths.tasks}`);
  console.log(`Task count: ${plan.steps.length}`);
  if (useLocalPlan) {
    console.log("Source: local plan.md");
  }
  console.log(`Next: snipara-companion feature start ${manifest.slug}`);
}

export async function featureStartCommand(options: FeatureStartOptions): Promise<void> {
  const paths = resolveFeatureArtifactPaths(options.slug, {
    cwd: options.cwd,
    outputDir: options.outputDir,
  });
  const manifest = readManifest(paths);
  if (manifest.status.tasks !== "ready" || !fs.existsSync(paths.tasks)) {
    throw new Error(
      `Tasks are not ready. Run 'snipara-companion feature tasks ${manifest.slug}' first.`
    );
  }
  const currentWorkspace = findWorkspaceRoot(process.cwd(), true);
  const targetWorkspace = findWorkspaceRoot(options.cwd ?? process.cwd(), true);
  if (currentWorkspace !== targetWorkspace) {
    throw new Error(
      "Feature workflow start must run from the target workspace so .snipara/workflow/current.json stays scoped correctly."
    );
  }
  await workflowStartCommand({
    goal: manifest.goal,
    planFile: paths.workflowPlan,
    id: options.workflowId ?? `feature-${manifest.slug}`,
    force: options.force,
    json: options.json,
  });
}

export function featureStatusCommand(options: FeatureCommandOptions): void {
  const paths = resolveFeatureArtifactPaths(options.slug, options);
  const manifest = readManifest(paths);
  const payload = { manifest, paths };
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(chalk.bold(`Feature: ${manifest.slug}`));
  console.log(`Goal: ${manifest.goal}`);
  console.log(`Spec: ${manifest.status.spec}`);
  console.log(`Plan: ${manifest.status.plan}`);
  console.log(`Tasks: ${manifest.status.tasks}`);
  console.log(`Directory: ${paths.root}`);
}
