/**
 * Companion Engineering Lead Plan - local, fail-closed planning artifact.
 *
 * This command gives Companion a visible engineering-lead surface without
 * turning it into an autonomous worker launcher. It can synthesize a plan from
 * local workflow inputs, or normalize an exported Project Health cockpit JSON.
 */
import * as fs from "fs";
import * as path from "path";
import {
  collectAgentReadinessLocalSignals,
  type AgentReadinessLocalSignals,
  type AgentReadinessTarget,
} from "./agent-readiness";

export const ENGINEERING_LEAD_STATUSES = ["healthy", "watch", "risk", "unknown"] as const;
export const ENGINEERING_LEAD_POSTURES = [
  "lead_ready",
  "lead_watch",
  "lead_blocked",
  "lead_cold_start",
] as const;
export const ENGINEERING_LEAD_WORKER_ROLES = [
  "main_agent",
  "coding_worker",
  "test_worker",
  "reviewer",
  "documentation_worker",
  "human_approver",
] as const;
export const ENGINEERING_LEAD_ROUTING_MODES = [
  "hold",
  "main_agent_execute",
  "explicit_handoff_ready",
  "needs_contract",
] as const;

export type EngineeringLeadStatus = (typeof ENGINEERING_LEAD_STATUSES)[number];
export type EngineeringLeadPosture = (typeof ENGINEERING_LEAD_POSTURES)[number];
export type EngineeringLeadWorkerRole = (typeof ENGINEERING_LEAD_WORKER_ROLES)[number];
export type EngineeringLeadRoutingMode = (typeof ENGINEERING_LEAD_ROUTING_MODES)[number];

export interface EngineeringLeadEvidenceRef {
  id: string;
  kind:
    | "memory"
    | "project_decision"
    | "shadow_signal"
    | "context_graph"
    | "outcome_signal"
    | "retrieval_event"
    | "workflow"
    | "repository"
    | "manual";
  label: string;
  sourceRef?: string | null;
  strength?: number | null;
  reviewStatus?: string | null;
  authorityStatus?: string | null;
  freshness?: string | null;
}

export interface EngineeringLeadWorkerContract {
  writeScope: string[];
  contextRefs: EngineeringLeadEvidenceRef[];
  acceptanceCriteria: string[];
  proofRequired: string[];
  approvalRequired: boolean;
  fallback: "main_agent";
}

export interface EngineeringLeadWorkerRecommendation {
  id: string;
  role: EngineeringLeadWorkerRole;
  label: string;
  status: EngineeringLeadStatus;
  routingMode: EngineeringLeadRoutingMode;
  workPackageId: string | null;
  workPackageTitle: string | null;
  owner: string | null;
  rationale: string;
  contract: EngineeringLeadWorkerContract;
  proofGates: string[];
  brainUpdateCandidates: string[];
  evidence: EngineeringLeadEvidenceRef[];
  reasonCodes: string[];
}

export interface EngineeringLeadPlanSummary {
  version: "project-intelligence-engineering-lead-plan-v0";
  posture: EngineeringLeadPosture;
  status: EngineeringLeadStatus;
  score: number;
  headline: string;
  operatingMode: "advisory_fail_closed";
  nextAction: string;
  workersSpawned: 0;
  failClosedFallback: "main_agent";
  workerRecommendations: EngineeringLeadWorkerRecommendation[];
  proofGates: string[];
  brainUpdateActions: string[];
  metrics: Array<{ label: string; value: string | number }>;
  evidence: EngineeringLeadEvidenceRef[];
  caveats: string[];
  reasonCodes: string[];
}

export interface CompanionEngineeringLeadPlanReport {
  version: "snipara.companion_engineering_lead_plan.v1";
  generatedAt: string;
  source: "local_companion_inputs" | "project_health_cockpit";
  target: {
    id: AgentReadinessTarget;
    label: string;
  };
  task?: string;
  engineeringLeadPlan: EngineeringLeadPlanSummary;
  explicitInputs: {
    changedFiles: string[];
    contextRefs: string[];
    proofGates: string[];
    acceptanceCriteria: string[];
    declaredRisks: string[];
  };
  localSignals: AgentReadinessLocalSignals;
  suggestedCommands: string[];
  caveats: string[];
}

export interface LeadPlanCommandOptions {
  task?: string;
  target?: string;
  changedFiles?: string[];
  context?: string[];
  proof?: string[];
  acceptance?: string[];
  risk?: string[];
  fromCockpit?: string;
  dir?: string;
  output?: string;
  json?: boolean;
}

interface BuildCompanionEngineeringLeadPlanOptions extends LeadPlanCommandOptions {
  cwd?: string;
  now?: Date;
  localSignals?: AgentReadinessLocalSignals;
  cockpit?: Record<string, unknown>;
}

const TARGET_LABELS: Record<AgentReadinessTarget, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  orca: "Orca",
  windsurf: "Windsurf",
  custom: "Custom worker",
};

function normalizeTarget(target: string | undefined): AgentReadinessTarget {
  const normalized = (target ?? "codex").trim().toLowerCase();
  if (normalized === "claude" || normalized === "claude_code") {
    return "claude-code";
  }
  if (normalized in TARGET_LABELS) {
    return normalized as AgentReadinessTarget;
  }
  return "custom";
}

function normalizeTask(task: string | undefined): string | undefined {
  const normalized = task?.trim();
  return normalized ? normalized : undefined;
}

function unique(values: string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? [])
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const normalized = stringValue(item);
    return normalized ? [normalized] : [];
  });
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function enumValue<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function statusValue(value: unknown, fallback: EngineeringLeadStatus): EngineeringLeadStatus {
  return enumValue(ENGINEERING_LEAD_STATUSES, value, fallback);
}

function postureValue(value: unknown, fallback: EngineeringLeadPosture): EngineeringLeadPosture {
  return enumValue(ENGINEERING_LEAD_POSTURES, value, fallback);
}

function roleValue(value: unknown, fallback: EngineeringLeadWorkerRole): EngineeringLeadWorkerRole {
  return enumValue(ENGINEERING_LEAD_WORKER_ROLES, value, fallback);
}

function routingModeValue(
  value: unknown,
  fallback: EngineeringLeadRoutingMode
): EngineeringLeadRoutingMode {
  return enumValue(ENGINEERING_LEAD_ROUTING_MODES, value, fallback);
}

function slug(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || fallback;
}

function evidenceRef(
  id: string,
  kind: EngineeringLeadEvidenceRef["kind"],
  label: string,
  sourceRef?: string
): EngineeringLeadEvidenceRef {
  return {
    id,
    kind,
    label,
    ...(sourceRef ? { sourceRef } : {}),
    strength: 0.7,
    freshness: "local",
  };
}

function normalizeEvidence(value: unknown): EngineeringLeadEvidenceRef[] {
  return recordList(value).flatMap((item, index) => {
    const label = stringValue(item.label);
    if (!label) {
      return [];
    }
    return [
      {
        id: stringValue(item.id) ?? `evidence:${index + 1}`,
        kind:
          item.kind === "memory" ||
          item.kind === "project_decision" ||
          item.kind === "shadow_signal" ||
          item.kind === "context_graph" ||
          item.kind === "outcome_signal" ||
          item.kind === "retrieval_event" ||
          item.kind === "workflow" ||
          item.kind === "repository" ||
          item.kind === "manual"
            ? item.kind
            : "manual",
        label,
        sourceRef: stringValue(item.sourceRef) ?? null,
        strength: typeof item.strength === "number" ? item.strength : null,
        reviewStatus: stringValue(item.reviewStatus) ?? null,
        authorityStatus: stringValue(item.authorityStatus) ?? null,
        freshness: stringValue(item.freshness) ?? null,
      },
    ];
  });
}

function localSignalEvidence(
  localSignals: AgentReadinessLocalSignals
): EngineeringLeadEvidenceRef[] {
  const refs: EngineeringLeadEvidenceRef[] = [];
  if (localSignals.workflow.present) {
    refs.push(
      evidenceRef(
        "local:workflow",
        "workflow",
        `Companion workflow ${localSignals.workflow.workflowId ?? "present"} status=${
          localSignals.workflow.status ?? "unknown"
        }`,
        localSignals.workflow.path
      )
    );
  }
  if (localSignals.teamSync.present) {
    refs.push(
      evidenceRef(
        "local:team-sync",
        "workflow",
        `${localSignals.teamSync.activeWorkCount} active Team Sync item(s), ${localSignals.teamSync.handoffCount} handoff(s)`,
        localSignals.teamSync.path
      )
    );
  }
  if (localSignals.projectInstructions.present) {
    refs.push(
      evidenceRef(
        "local:project-instructions",
        "repository",
        "Project instructions are present",
        localSignals.projectInstructions.path
      )
    );
  }
  return refs;
}

function contextEvidence(contextRefs: string[]): EngineeringLeadEvidenceRef[] {
  return contextRefs.map((ref, index) =>
    evidenceRef(`context:${index + 1}`, "manual", ref, ref.includes("/") ? ref : undefined)
  );
}

function statusForScore(score: number): EngineeringLeadStatus {
  if (score >= 80) {
    return "healthy";
  }
  if (score >= 60) {
    return "watch";
  }
  return score > 0 ? "risk" : "unknown";
}

function inferWorkerRole(input: {
  changedFiles: string[];
  proofGates: string[];
  acceptanceCriteria: string[];
}): EngineeringLeadWorkerRole {
  const fileText = input.changedFiles.join(" ").toLowerCase();
  const allText = `${fileText} ${input.proofGates.join(" ")} ${input.acceptanceCriteria.join(
    " "
  )}`.toLowerCase();
  const hasOnlyDocs =
    input.changedFiles.length > 0 &&
    input.changedFiles.every((file) => file.endsWith(".md") || file.includes("/docs/"));
  if (hasOnlyDocs) {
    return "documentation_worker";
  }
  if (/\b(test|spec|vitest|jest|playwright|proof)\b/.test(allText) && /test|spec/.test(fileText)) {
    return "test_worker";
  }
  if (/\b(review|audit|approve|approval)\b/.test(allText)) {
    return "reviewer";
  }
  return "coding_worker";
}

function workerLabel(role: EngineeringLeadWorkerRole): string {
  switch (role) {
    case "main_agent":
      return "Main agent";
    case "coding_worker":
      return "Coding worker";
    case "test_worker":
      return "Test worker";
    case "reviewer":
      return "Reviewer";
    case "documentation_worker":
      return "Documentation worker";
    case "human_approver":
      return "Human approver";
  }
}

function computeScore(input: {
  task?: string;
  changedFiles: string[];
  contextRefs: string[];
  proofGates: string[];
  acceptanceCriteria: string[];
  declaredRisks: string[];
  localSignals: AgentReadinessLocalSignals;
}): number {
  const hasScope = Boolean(input.task) && input.changedFiles.length > 0;
  const hasPartialScope = Boolean(input.task) || input.changedFiles.length > 0;
  const hasContext = input.contextRefs.length > 0 || input.localSignals.projectInstructions.present;
  const hasWorkflow =
    input.localSignals.workflow.present && input.localSignals.workflow.status === "active";
  const hasTeamSync =
    input.localSignals.teamSync.present &&
    (input.localSignals.teamSync.activeWorkCount > 0 ||
      input.localSignals.teamSync.handoffCount > 0);
  const hasProof = input.proofGates.length > 0 && input.acceptanceCriteria.length > 0;
  const score =
    (hasScope ? 18 : hasPartialScope ? 9 : 0) +
    (hasContext ? 14 : 0) +
    (hasWorkflow ? 16 : input.localSignals.workflow.present ? 8 : 0) +
    (hasTeamSync ? 12 : input.localSignals.teamSync.present ? 6 : 0) +
    (hasProof ? 26 : input.proofGates.length > 0 || input.acceptanceCriteria.length > 0 ? 13 : 0) +
    10 +
    (input.declaredRisks.length > 0 ? 4 : 0);

  const capped = !hasPartialScope ? Math.min(score, 42) : !hasProof ? Math.min(score, 58) : score;
  return Math.min(100, Math.max(0, capped));
}

function postureForLocalPlan(input: {
  score: number;
  task?: string;
  changedFiles: string[];
  proofGates: string[];
  acceptanceCriteria: string[];
}): EngineeringLeadPosture {
  if (!input.task && input.changedFiles.length === 0) {
    return "lead_cold_start";
  }
  if (input.proofGates.length === 0 || input.acceptanceCriteria.length === 0) {
    return "lead_blocked";
  }
  if (input.score >= 76) {
    return "lead_ready";
  }
  return "lead_watch";
}

function routingModeForLocalPlan(input: {
  posture: EngineeringLeadPosture;
  hasActiveWorkflow: boolean;
  hasProof: boolean;
}): EngineeringLeadRoutingMode {
  if (input.posture === "lead_cold_start") {
    return "hold";
  }
  if (!input.hasProof) {
    return "needs_contract";
  }
  return input.hasActiveWorkflow ? "explicit_handoff_ready" : "main_agent_execute";
}

function brainUpdateCandidates(input: {
  task?: string;
  proofGates: string[];
  acceptanceCriteria: string[];
  declaredRisks: string[];
}): string[] {
  const candidates = [
    input.task
      ? `Record lead-plan task outcome for "${input.task}" after verification.`
      : undefined,
    input.proofGates.length > 0
      ? "Attach proof receipts to the Project Brain before closing delegated work."
      : undefined,
    input.acceptanceCriteria.length > 0
      ? "Persist accepted acceptance criteria and completion evidence after review."
      : undefined,
    input.declaredRisks.length > 0
      ? "Review declared risks before promoting candidate Brain updates."
      : undefined,
  ];
  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

function suggestedCommands(input: {
  target: AgentReadinessTarget;
  task?: string;
  changedFiles: string[];
  proofGates: string[];
  acceptanceCriteria: string[];
}): string[] {
  const task = input.task ?? "<task>";
  const files = input.changedFiles.length > 0 ? input.changedFiles.join(" ") : "<relevant-files>";
  const commands = [
    `snipara-companion lead-plan --task "${task}" --changed-files ${files} --target ${input.target} --json`,
    `snipara-companion verify --task "${task}" --changed-files ${files} --skip-impact`,
  ];
  if (input.proofGates.length > 0 && input.acceptanceCriteria.length > 0) {
    commands.push(
      `snipara-companion handoff --adapter-pack --target ${input.target} --summary "${task}" --next "execute bounded worker contract" --files ${files}`
    );
  } else {
    commands.push(
      `snipara-companion handoff --summary "${task}" --next "define proof gates before worker handoff" --attention proof --files ${files}`
    );
  }
  return commands;
}

function buildLocalEngineeringLeadPlan(input: {
  target: AgentReadinessTarget;
  task?: string;
  changedFiles: string[];
  contextRefs: string[];
  proofGates: string[];
  acceptanceCriteria: string[];
  declaredRisks: string[];
  localSignals: AgentReadinessLocalSignals;
}): EngineeringLeadPlanSummary {
  const score = computeScore(input);
  const posture = postureForLocalPlan({ ...input, score });
  const status = statusForScore(score);
  const hasActiveWorkflow =
    input.localSignals.workflow.present && input.localSignals.workflow.status === "active";
  const hasProof = input.proofGates.length > 0 && input.acceptanceCriteria.length > 0;
  const routingMode = routingModeForLocalPlan({ posture, hasActiveWorkflow, hasProof });
  const role =
    posture === "lead_cold_start"
      ? "main_agent"
      : inferWorkerRole({
          changedFiles: input.changedFiles,
          proofGates: input.proofGates,
          acceptanceCriteria: input.acceptanceCriteria,
        });
  const workPackageTitle = input.task ?? "Local Companion work package";
  const evidence = [
    ...localSignalEvidence(input.localSignals),
    ...contextEvidence(input.contextRefs),
  ].slice(0, 10);
  const brainCandidates = brainUpdateCandidates(input);
  const workPackageId =
    posture === "lead_cold_start" ? null : `lead-plan:${slug(workPackageTitle, "work-package")}`;
  const worker: EngineeringLeadWorkerRecommendation = {
    id: workPackageId ?? "engineering-lead:cold-start",
    role,
    label: workerLabel(role),
    status,
    routingMode,
    workPackageId,
    workPackageTitle: posture === "lead_cold_start" ? null : workPackageTitle,
    owner: posture === "lead_cold_start" ? "main_agent" : TARGET_LABELS[input.target],
    rationale:
      routingMode === "explicit_handoff_ready"
        ? "Local scope, workflow continuity, acceptance, and proof gates are present for an explicit handoff."
        : routingMode === "main_agent_execute"
          ? "The contract is usable, but no active Companion workflow is present; keep execution with the main agent."
          : routingMode === "needs_contract"
            ? "Proof gates or acceptance criteria are incomplete; hold worker launch until the contract is explicit."
            : "No bounded work package exists yet; the main agent must define scope before delegation.",
    contract: {
      writeScope: input.changedFiles,
      contextRefs: evidence,
      acceptanceCriteria: input.acceptanceCriteria,
      proofRequired: input.proofGates,
      approvalRequired: routingMode !== "explicit_handoff_ready" || input.declaredRisks.length > 0,
      fallback: "main_agent",
    },
    proofGates: input.proofGates,
    brainUpdateCandidates: brainCandidates,
    evidence,
    reasonCodes: [
      "companion_engineering_lead_plan",
      `engineering_lead_${posture}`,
      `routing_${routingMode}`,
    ],
  };

  return {
    version: "project-intelligence-engineering-lead-plan-v0",
    posture,
    status,
    score,
    headline:
      posture === "lead_ready"
        ? "Companion can act as an advisory engineering lead for this bounded work package."
        : posture === "lead_watch"
          ? "Companion has a partial lead plan; tighten workflow continuity before delegation."
          : posture === "lead_blocked"
            ? "Companion should hold delegation until the worker contract has proof and acceptance gates."
            : "Companion needs a task and file scope before it can form an engineering lead plan.",
    operatingMode: "advisory_fail_closed",
    nextAction:
      routingMode === "explicit_handoff_ready"
        ? "Generate a handoff or adapter pack, then require proof receipts before closure."
        : routingMode === "main_agent_execute"
          ? "Start or resume a Companion workflow before assigning this to another worker."
          : routingMode === "needs_contract"
            ? "Define proof gates and acceptance criteria before worker handoff."
            : "Define task scope, files, context refs, and proof gates.",
    workersSpawned: 0,
    failClosedFallback: "main_agent",
    workerRecommendations: [worker],
    proofGates: input.proofGates,
    brainUpdateActions: brainCandidates,
    metrics: [
      { label: "Work packages", value: workPackageId ? 1 : 0 },
      { label: "Ready packages", value: routingMode === "explicit_handoff_ready" ? 1 : 0 },
      { label: "Blocked packages", value: posture === "lead_blocked" ? 1 : 0 },
      { label: "Context refs", value: input.contextRefs.length },
      { label: "Proof gates", value: input.proofGates.length },
      { label: "Acceptance criteria", value: input.acceptanceCriteria.length },
      { label: "Workers spawned", value: 0 },
    ],
    evidence,
    caveats: [
      "Engineering Lead Plan V0 is advisory and fail-closed; it does not launch, approve, or complete workers.",
      "Worker recommendations require explicit policy, approval, handoff receipts, and proof receipts before delegated execution.",
      "The Project Brain update list is a candidate queue; durable memory and source-truth changes still need review.",
      "Local Companion signals do not prove hosted Project Health, dashboard freshness, or production state.",
    ],
    reasonCodes: [
      "project_intelligence_engineering_lead_plan_v0",
      "companion_local_lead_plan",
      `engineering_lead_${posture}`,
    ],
  };
}

function normalizeWorkerRecommendation(
  value: Record<string, unknown>,
  index: number
): EngineeringLeadWorkerRecommendation {
  const contract = isRecord(value.contract) ? value.contract : {};
  return {
    id: stringValue(value.id) ?? `worker:${index + 1}`,
    role: roleValue(value.role, "main_agent"),
    label: stringValue(value.label) ?? workerLabel(roleValue(value.role, "main_agent")),
    status: statusValue(value.status, "unknown"),
    routingMode: routingModeValue(value.routingMode, "hold"),
    workPackageId: stringValue(value.workPackageId) ?? null,
    workPackageTitle: stringValue(value.workPackageTitle) ?? null,
    owner: stringValue(value.owner) ?? null,
    rationale: stringValue(value.rationale) ?? "No rationale provided in cockpit export.",
    contract: {
      writeScope: stringList(contract.writeScope),
      contextRefs: normalizeEvidence(contract.contextRefs),
      acceptanceCriteria: stringList(contract.acceptanceCriteria),
      proofRequired: stringList(contract.proofRequired),
      approvalRequired: booleanValue(contract.approvalRequired, true),
      fallback: "main_agent",
    },
    proofGates: stringList(value.proofGates),
    brainUpdateCandidates: stringList(value.brainUpdateCandidates),
    evidence: normalizeEvidence(value.evidence),
    reasonCodes: stringList(value.reasonCodes),
  };
}

function normalizeCockpitPlan(cockpit: Record<string, unknown>): EngineeringLeadPlanSummary {
  const rawPlan = isRecord(cockpit.engineeringLeadPlan) ? cockpit.engineeringLeadPlan : cockpit;
  const score = Math.round(numberValue(rawPlan.score, 0));
  const workerRecommendations = recordList(rawPlan.workerRecommendations).map(
    normalizeWorkerRecommendation
  );
  return {
    version: "project-intelligence-engineering-lead-plan-v0",
    posture: postureValue(rawPlan.posture, "lead_cold_start"),
    status: statusValue(rawPlan.status, statusForScore(score)),
    score,
    headline: stringValue(rawPlan.headline) ?? "Imported Project Health Engineering Lead Plan.",
    operatingMode: "advisory_fail_closed",
    nextAction:
      stringValue(rawPlan.nextAction) ??
      "Review the imported cockpit plan before creating worker handoffs.",
    workersSpawned: 0,
    failClosedFallback: "main_agent",
    workerRecommendations,
    proofGates: stringList(rawPlan.proofGates),
    brainUpdateActions: stringList(rawPlan.brainUpdateActions),
    metrics: recordList(rawPlan.metrics).flatMap((metric) => {
      const label = stringValue(metric.label);
      const value = stringValue(metric.value) ?? numberValue(metric.value, Number.NaN);
      return label && !(typeof value === "number" && Number.isNaN(value)) ? [{ label, value }] : [];
    }),
    evidence: normalizeEvidence(rawPlan.evidence),
    caveats: [
      ...new Set([
        ...stringList(rawPlan.caveats),
        "Imported cockpit plans remain advisory and fail-closed inside Companion.",
      ]),
    ],
    reasonCodes: [
      ...new Set([
        "companion_imported_project_health_lead_plan",
        ...stringList(rawPlan.reasonCodes),
      ]),
    ],
  };
}

function readJsonFile(filePath: string): Record<string, unknown> {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return parsed;
}

export function buildCompanionEngineeringLeadPlanReport(
  options: BuildCompanionEngineeringLeadPlanOptions = {}
): CompanionEngineeringLeadPlanReport {
  const cwd = options.cwd ?? process.cwd();
  const target = normalizeTarget(options.target);
  const localSignals = options.localSignals ?? collectAgentReadinessLocalSignals(cwd);
  const task = normalizeTask(options.task);
  const changedFiles = unique(options.changedFiles);
  const contextRefs = unique(options.context);
  const proofGates = unique(options.proof);
  const acceptanceCriteria = unique(options.acceptance);
  const declaredRisks = unique(options.risk);
  const cockpit =
    options.cockpit ?? (options.fromCockpit ? readJsonFile(options.fromCockpit) : undefined);
  const engineeringLeadPlan = cockpit
    ? normalizeCockpitPlan(cockpit)
    : buildLocalEngineeringLeadPlan({
        target,
        task,
        changedFiles,
        contextRefs,
        proofGates,
        acceptanceCriteria,
        declaredRisks,
        localSignals,
      });

  return {
    version: "snipara.companion_engineering_lead_plan.v1",
    generatedAt: (options.now ?? new Date()).toISOString(),
    source: cockpit ? "project_health_cockpit" : "local_companion_inputs",
    target: {
      id: target,
      label: TARGET_LABELS[target],
    },
    ...(task ? { task } : {}),
    engineeringLeadPlan,
    explicitInputs: {
      changedFiles,
      contextRefs,
      proofGates,
      acceptanceCriteria,
      declaredRisks,
    },
    localSignals,
    suggestedCommands: suggestedCommands({
      target,
      task,
      changedFiles,
      proofGates,
      acceptanceCriteria,
    }),
    caveats: [
      "Companion Engineering Lead Plan does not spawn workers or approve work.",
      "Use this artifact as a contract for handoff, verification, and candidate Project Brain updates.",
      "For autonomous execution, use the orchestrator surface only behind explicit policy and approval gates.",
    ],
  };
}

function formatList(values: string[], empty = "none"): string {
  return values.length > 0 ? values.join(", ") : empty;
}

export function formatCompanionEngineeringLeadPlanReport(
  report: CompanionEngineeringLeadPlanReport
): string {
  const plan = report.engineeringLeadPlan;
  const lines: string[] = [];
  lines.push("Companion Engineering Lead Plan");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Source: ${report.source}`);
  lines.push(`Target: ${report.target.label}`);
  if (report.task) {
    lines.push(`Task: ${report.task}`);
  }
  lines.push(`Score: ${plan.score}/100 (${plan.status})`);
  lines.push(`Posture: ${plan.posture}`);
  lines.push(`Mode: ${plan.operatingMode}`);
  lines.push(`Workers spawned: ${plan.workersSpawned}`);
  lines.push(`Fallback: ${plan.failClosedFallback}`);
  lines.push(`Headline: ${plan.headline}`);
  lines.push(`Next action: ${plan.nextAction}`);
  lines.push("");
  lines.push("Worker Recommendations");
  for (const worker of plan.workerRecommendations) {
    lines.push(`- [${worker.status}] ${worker.label} (${worker.role}, ${worker.routingMode})`);
    if (worker.workPackageTitle) {
      lines.push(`  package: ${worker.workPackageTitle}`);
    }
    if (worker.owner) {
      lines.push(`  owner: ${worker.owner}`);
    }
    lines.push(`  rationale: ${worker.rationale}`);
    lines.push(`  scope: ${formatList(worker.contract.writeScope)}`);
    lines.push(`  proof: ${formatList(worker.proofGates)}`);
    lines.push(`  acceptance: ${formatList(worker.contract.acceptanceCriteria)}`);
  }
  lines.push("");
  lines.push("Brain Update Candidates");
  if (plan.brainUpdateActions.length === 0) {
    lines.push("- none");
  } else {
    for (const action of plan.brainUpdateActions) {
      lines.push(`- ${action}`);
    }
  }
  lines.push("");
  lines.push("Suggested Commands");
  for (const command of report.suggestedCommands) {
    lines.push(`- ${command}`);
  }
  lines.push("");
  lines.push("Caveats");
  for (const caveat of [...plan.caveats, ...report.caveats]) {
    lines.push(`- ${caveat}`);
  }
  return lines.join("\n");
}

function writeReport(outputPath: string, report: CompanionEngineeringLeadPlanReport): void {
  const absolute = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const content = outputPath.endsWith(".json")
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${formatCompanionEngineeringLeadPlanReport(report)}\n`;
  fs.writeFileSync(absolute, content, "utf8");
}

export async function leadPlanCommand(options: LeadPlanCommandOptions): Promise<void> {
  const cwd = path.resolve(options.dir ?? process.cwd());
  const report = buildCompanionEngineeringLeadPlanReport({
    ...options,
    cwd,
    localSignals: collectAgentReadinessLocalSignals(cwd),
  });

  if (options.output) {
    writeReport(options.output, report);
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(formatCompanionEngineeringLeadPlanReport(report));
}
