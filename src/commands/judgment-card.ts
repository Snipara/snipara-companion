/**
 * Project Intelligence Judgment Card.
 *
 * Pure scoring and explanation layer for agent-facing "can I proceed?"
 * decisions. It intentionally consumes already-fetched surfaces instead of
 * adding network calls, so commands can use it in production paths without
 * changing hosted behavior.
 */

export type ProjectJudgmentCanProceed = "yes" | "review" | "block";
export type ProjectJudgmentState = "ready" | "watch" | "review" | "proof_required" | "blocked";
export type ProjectJudgmentSeverity = "info" | "low" | "medium" | "high" | "critical";
export type ProjectJudgmentActionType =
  | "run_check"
  | "inspect"
  | "handoff"
  | "acknowledge"
  | "package_review"
  | "deploy_review"
  | "resolve_blocker";

export interface ProjectJudgmentReason {
  code: string;
  severity: ProjectJudgmentSeverity;
  message: string;
  points: number;
  source: string;
}

export interface ProjectJudgmentAction {
  type: ProjectJudgmentActionType;
  title: string;
  command?: string;
  reason?: string;
  severity: ProjectJudgmentSeverity;
  safeToAck?: boolean;
}

export interface ProjectJudgmentEvidence {
  source: string;
  label: string;
  detail?: string;
}

export interface ProjectIntelligenceJudgmentCard {
  version: "project-intelligence.judgment-card.v1";
  generatedAt: string;
  task?: string;
  target: {
    branch?: string;
    changedFiles: string[];
  };
  score: number;
  band: "high" | "medium" | "low" | "blocked";
  state: ProjectJudgmentState;
  canProceed: ProjectJudgmentCanProceed;
  summary: string;
  reasons: ProjectJudgmentReason[];
  requiredActions: ProjectJudgmentAction[];
  advisories: ProjectJudgmentAction[];
  evidence: ProjectJudgmentEvidence[];
  caveats: string[];
}

export interface BuildProjectJudgmentCardInput {
  task?: string;
  branch?: string;
  changedFiles?: string[];
  resumeContext?: Record<string, unknown>;
  memoryHealth?: Record<string, unknown>;
  codeImpact?: Record<string, unknown>;
  verificationPlan?: Record<string, unknown>;
  guard?: Record<string, unknown>;
  advisoryObservability?: Record<string, unknown>;
  teamSyncReadiness?: Record<string, unknown>;
  errors?: Array<{ surface: string; message: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nestedRecord(root: unknown, keys: string[]): Record<string, unknown> {
  let current: unknown = root;
  for (const key of keys) {
    if (!isRecord(current) || !isRecord(current[key])) {
      return {};
    }
    current = current[key];
  }
  return isRecord(current) ? current : {};
}

function firstNonEmptyRecord(...records: Record<string, unknown>[]): Record<string, unknown> {
  return records.find((record) => Object.keys(record).length > 0) ?? {};
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeSeverity(value: unknown): ProjectJudgmentSeverity {
  const severity = stringValue(value)?.toLowerCase();
  if (
    severity === "info" ||
    severity === "low" ||
    severity === "medium" ||
    severity === "high" ||
    severity === "critical"
  ) {
    return severity;
  }
  return "medium";
}

function severityPenalty(severity: ProjectJudgmentSeverity): number {
  return {
    info: 1,
    low: 4,
    medium: 10,
    high: 18,
    critical: 35,
  }[severity];
}

function addReason(
  reasons: ProjectJudgmentReason[],
  input: Omit<ProjectJudgmentReason, "points"> & { points?: number }
): void {
  const points = input.points ?? severityPenalty(input.severity);
  if (points <= 0 && input.severity !== "info") {
    return;
  }
  reasons.push({ ...input, points });
}

function addAction(actions: ProjectJudgmentAction[], action: ProjectJudgmentAction): void {
  const key = `${action.type}:${action.command ?? action.title}`;
  if (
    actions.some((existing) => `${existing.type}:${existing.command ?? existing.title}` === key)
  ) {
    return;
  }
  actions.push(action);
}

function changedFilesFromInput(input: BuildProjectJudgmentCardInput): string[] {
  return [...new Set((input.changedFiles ?? []).map((file) => file.trim()).filter(Boolean))];
}

function codeImpactRisk(impact: Record<string, unknown> | undefined): {
  level?: string;
  score?: number;
} {
  const risk = isRecord(impact?.risk) ? impact?.risk : {};
  return {
    level: stringValue(risk.level),
    score: numberValue(risk.score),
  };
}

function memoryHealthScore(memoryHealth: Record<string, unknown> | undefined): number | undefined {
  return (
    numberValue(memoryHealth?.health_score) ??
    numberValue(memoryHealth?.healthScore) ??
    numberValue(memoryHealth?.score) ??
    numberValue(nestedRecord(memoryHealth, ["summary"]).health_score)
  );
}

function guardEvaluation(guard: Record<string, unknown> | undefined): Record<string, unknown> {
  return firstNonEmptyRecord(
    nestedRecord(guard, ["hosted", "data", "evaluation"]),
    nestedRecord(guard, ["data", "evaluation"]),
    nestedRecord(guard, ["evaluation"])
  );
}

function readinessFromTeamSync(input: BuildProjectJudgmentCardInput): Record<string, unknown> {
  if (input.teamSyncReadiness) {
    return input.teamSyncReadiness;
  }
  return nestedRecord(input.resumeContext, [
    "resumeContext",
    "whatChanged",
    "teamSync",
    "readiness",
  ]);
}

function collectVerificationChecks(plan: Record<string, unknown> | undefined): {
  recommendedChecks: unknown[];
  missingChecks: unknown[];
} {
  return {
    recommendedChecks: arrayValue(plan?.recommendedChecks),
    missingChecks: arrayValue(plan?.missingChecks),
  };
}

function gapCode(gap: unknown): string {
  return isRecord(gap) ? (stringValue(gap.code) ?? "verification_gap") : "verification_gap";
}

function gapMessage(gap: unknown): string {
  if (!isRecord(gap)) {
    return String(gap);
  }
  return (
    stringValue(gap.message) ??
    stringValue(gap.reason) ??
    stringValue(gap.title) ??
    "Verification gap"
  );
}

function checkCommand(check: unknown): string | undefined {
  return isRecord(check) ? stringValue(check.command) : undefined;
}

function checkTitle(check: unknown): string {
  if (!isRecord(check)) {
    return String(check);
  }
  return (
    stringValue(check.title) ??
    stringValue(check.command) ??
    stringValue(check.file) ??
    "verification check"
  );
}

function buildSummary(state: ProjectJudgmentState, score: number): string {
  if (state === "blocked") {
    return `Blocked (${score}/100): resolve blocking guard or verification findings before proceeding.`;
  }
  if (state === "proof_required") {
    return `Proof required (${score}/100): run the required checks before release or deploy.`;
  }
  if (state === "review") {
    return `Review required (${score}/100): inspect the listed risks and acknowledge only review-only guard findings.`;
  }
  if (state === "watch") {
    return `Proceed with watch (${score}/100): low-risk advisories are present.`;
  }
  return `Ready (${score}/100): no material blockers detected by the available surfaces.`;
}

export function buildProjectJudgmentCard(
  input: BuildProjectJudgmentCardInput
): ProjectIntelligenceJudgmentCard {
  const changedFiles = changedFilesFromInput(input);
  const reasons: ProjectJudgmentReason[] = [];
  const requiredActions: ProjectJudgmentAction[] = [];
  const advisories: ProjectJudgmentAction[] = [];
  const evidence: ProjectJudgmentEvidence[] = [];
  const caveats = new Set<string>();

  const risk = codeImpactRisk(input.codeImpact);
  if (input.codeImpact) {
    evidence.push({
      source: "code_impact",
      label: `Code impact risk ${risk.level ?? "unknown"}`,
      ...(risk.score !== undefined ? { detail: `score ${risk.score}` } : {}),
    });
  }
  if (risk.level === "critical" || risk.level === "high") {
    addReason(reasons, {
      code: "code_impact_high_risk",
      severity: risk.level === "critical" ? "critical" : "high",
      message: `Code impact reports ${risk.level} risk.`,
      source: "code_impact",
    });
    addAction(requiredActions, {
      type: "inspect",
      title: "Inspect code impact blast radius",
      command:
        changedFiles.length > 0
          ? `snipara-companion code impact --changed-files ${changedFiles.join(
              " "
            )} --diff-summary '<change summary>'`
          : undefined,
      reason: "High-risk code impact should be reviewed before proceeding.",
      severity: risk.level === "critical" ? "critical" : "high",
    });
  } else if (risk.level === "medium") {
    addReason(reasons, {
      code: "code_impact_medium_risk",
      severity: "medium",
      message: "Code impact reports medium risk.",
      source: "code_impact",
    });
  }

  if (input.codeImpact?.degraded === true) {
    addReason(reasons, {
      code: "code_impact_degraded",
      severity: "high",
      message: "Code impact returned degraded results.",
      source: "code_impact",
    });
    caveats.add(
      "Code impact was degraded; local reads and broader checks should override confidence."
    );
  }

  const freshness = isRecord(input.codeImpact?.index_freshness)
    ? input.codeImpact?.index_freshness
    : {};
  if (freshness.is_stale === true || freshness.commit_match === false) {
    addReason(reasons, {
      code: "code_graph_stale",
      severity: "medium",
      message: "Code graph freshness does not fully match the working tree.",
      source: "code_impact",
    });
    caveats.add("Hosted code graph may not include local or uncommitted edits.");
  }

  const { recommendedChecks, missingChecks } = collectVerificationChecks(input.verificationPlan);
  if (input.verificationPlan) {
    evidence.push({
      source: "verification_plan",
      label: `${recommendedChecks.length} recommended check(s)`,
      detail: `${missingChecks.length} missing check signal(s)`,
    });
  }
  for (const check of recommendedChecks.slice(0, 6)) {
    addAction(requiredActions, {
      type: "run_check",
      title: checkTitle(check),
      command: checkCommand(check),
      reason: isRecord(check) ? stringValue(check.reason) : undefined,
      severity: "medium",
    });
  }
  for (const gap of missingChecks) {
    const severity = normalizeSeverity(isRecord(gap) ? gap.severity : undefined);
    const code = gapCode(gap);
    addReason(reasons, {
      code,
      severity,
      message: gapMessage(gap),
      source: "verification_plan",
    });
    if (severity === "high" || code === "no_direct_tests" || code === "impact_unavailable") {
      addAction(requiredActions, {
        type: "inspect",
        title: "Close verification gap",
        reason: gapMessage(gap),
        severity,
      });
    }
  }

  const guardEval = guardEvaluation(input.guard);
  const guardDecision = stringValue(guardEval.decision)?.toUpperCase();
  const guardSeverity = normalizeSeverity(guardEval.severity);
  if (guardDecision) {
    evidence.push({
      source: "collaboration_guard",
      label: `Guard decision ${guardDecision}`,
      detail: stringValue(guardEval.summary),
    });
  }
  if (guardDecision === "BLOCKED") {
    addReason(reasons, {
      code: "guard_blocked",
      severity: "critical",
      message: "Collaboration guard returned BLOCKED.",
      source: "collaboration_guard",
      points: 100,
    });
    addAction(requiredActions, {
      type: "resolve_blocker",
      title: "Resolve collaboration guard blocker",
      reason: "Hosted collaboration guard blocked this work.",
      severity: "critical",
    });
  } else if (guardDecision === "REVIEW_REQUIRED" || guardDecision === "REQUIRES_ACK") {
    addReason(reasons, {
      code: "guard_review_required",
      severity: guardSeverity === "info" ? "medium" : guardSeverity,
      message: `Collaboration guard returned ${guardDecision}.`,
      source: "collaboration_guard",
    });
    addAction(requiredActions, {
      type: "acknowledge",
      title: "Review and acknowledge guard finding",
      reason: "Only acknowledge if findings are review-only and no active conflict remains.",
      severity: guardSeverity === "info" ? "medium" : guardSeverity,
      safeToAck: guardDecision === "REVIEW_REQUIRED",
    });
  }

  const healthScore = memoryHealthScore(input.memoryHealth);
  if (healthScore !== undefined) {
    evidence.push({
      source: "memory_health",
      label: `Memory health ${Math.round(healthScore <= 1 ? healthScore * 100 : healthScore)}%`,
    });
    if (healthScore < 0.6 || (healthScore < 60 && healthScore > 1)) {
      addReason(reasons, {
        code: "memory_health_low",
        severity: "high",
        message: "Memory health is low.",
        source: "memory_health",
      });
    } else if (healthScore < 0.8 || (healthScore < 80 && healthScore > 1)) {
      addReason(reasons, {
        code: "memory_health_watch",
        severity: "low",
        message: "Memory health has advisory issues.",
        source: "memory_health",
      });
    }
  }

  const resumeFocus = nestedRecord(input.resumeContext, ["resumeContext", "focus"]);
  const overlapCount = numberValue(resumeFocus.overlapCount);
  if (overlapCount && overlapCount > 0) {
    addReason(reasons, {
      code: "team_overlap",
      severity: overlapCount > 1 ? "high" : "medium",
      message: `${overlapCount} team overlap(s) detected.`,
      source: "resume_context",
    });
    addAction(requiredActions, {
      type: "handoff",
      title: "Run Team Sync handoff",
      command: "snipara-companion team-sync handoff --summary '<handoff>' --next '<next action>'",
      reason: "Overlapping work needs explicit coordination.",
      severity: overlapCount > 1 ? "high" : "medium",
    });
  }

  const readiness = readinessFromTeamSync(input);
  const readinessLevel = stringValue(readiness.level);
  if (readinessLevel) {
    evidence.push({
      source: "team_sync_readiness",
      label: readinessLevel,
      detail: stringValue(readiness.label),
    });
    if (readinessLevel === "proof_required") {
      addReason(reasons, {
        code: "team_sync_proof_required",
        severity: "high",
        message: "Team Sync readiness requires proof evidence.",
        source: "team_sync_readiness",
      });
    } else if (readinessLevel === "review") {
      addReason(reasons, {
        code: "team_sync_review",
        severity: "medium",
        message: "Team Sync readiness needs attention.",
        source: "team_sync_readiness",
      });
    } else if (readinessLevel === "watch") {
      addReason(reasons, {
        code: "team_sync_watch",
        severity: "low",
        message: "Team Sync readiness has watch signals.",
        source: "team_sync_readiness",
      });
    }
  }

  if (input.advisoryObservability) {
    const demotedCount = numberValue(input.advisoryObservability.demotedCount) ?? 0;
    const advisoryCount = numberValue(input.advisoryObservability.advisoryCount) ?? 0;
    evidence.push({
      source: "advisory_observability",
      label: `${advisoryCount} advisory reason code(s)`,
      detail: `${demotedCount} demoted`,
    });
    if (demotedCount > 0) {
      addReason(reasons, {
        code: "advisory_demotions",
        severity: "medium",
        message: `${demotedCount} advisory reason code(s) were demoted by outcome evidence.`,
        source: "advisory_observability",
      });
    } else if (advisoryCount > 0) {
      addAction(advisories, {
        type: "inspect",
        title: "Inspect promoted advisories",
        reason: "Outcome evidence promoted advisory reason codes for visibility.",
        severity: "low",
      });
    }
  }

  for (const error of input.errors ?? []) {
    addReason(reasons, {
      code: `surface_unavailable_${error.surface}`,
      severity: "medium",
      message: `${error.surface} unavailable: ${error.message}`,
      source: error.surface,
    });
    caveats.add(`${error.surface} unavailable: ${error.message}`);
  }

  if (changedFiles.some((file) => file.includes("package.json") || file.startsWith("packages/"))) {
    addAction(requiredActions, {
      type: "package_review",
      title: "Review package release surface",
      command: "npm view snipara-companion version bin dist-tags --json",
      reason: "Package-facing files changed.",
      severity: "medium",
    });
  }
  if (changedFiles.some((file) => file.startsWith("deploy/") || file.includes("migrations/"))) {
    addAction(requiredActions, {
      type: "deploy_review",
      title: "Run deployment surface review",
      command: "snipara-companion collaboration guard --profile pre-deploy --enforce",
      reason: "Deployment or migration surface changed.",
      severity: "high",
    });
  }

  const totalPenalty = reasons.reduce((total, reason) => total + reason.points, 0);
  const score = clamp(Math.round(100 - totalPenalty), 0, 100);
  const hasCritical = reasons.some((reason) => reason.severity === "critical");
  const hasHigh = reasons.some((reason) => reason.severity === "high");
  const state: ProjectJudgmentState = hasCritical
    ? "blocked"
    : score < 50 || hasHigh
      ? "proof_required"
      : score < 75
        ? "review"
        : score < 90 || advisories.length > 0
          ? "watch"
          : "ready";
  const canProceed: ProjectJudgmentCanProceed =
    state === "blocked" ? "block" : state === "ready" || state === "watch" ? "yes" : "review";
  const band =
    state === "blocked" ? "blocked" : score >= 80 ? "high" : score >= 55 ? "medium" : "low";

  return {
    version: "project-intelligence.judgment-card.v1",
    generatedAt: new Date().toISOString(),
    ...(input.task ? { task: input.task } : {}),
    target: {
      ...(input.branch ? { branch: input.branch } : {}),
      changedFiles,
    },
    score,
    band,
    state,
    canProceed,
    summary: buildSummary(state, score),
    reasons: reasons.sort((a, b) => b.points - a.points),
    requiredActions,
    advisories,
    evidence,
    caveats: [...caveats],
  };
}

export function formatProjectJudgmentCard(card: ProjectIntelligenceJudgmentCard): string[] {
  const lines = [
    `State: ${card.state}`,
    `Can proceed: ${card.canProceed}`,
    `Score: ${card.score}/100 (${card.band})`,
    `Summary: ${card.summary}`,
  ];

  if (card.reasons.length > 0) {
    lines.push("Reasons:");
    for (const reason of card.reasons.slice(0, 6)) {
      lines.push(`- [${reason.severity}] ${reason.code}: ${reason.message}`);
    }
  }

  if (card.requiredActions.length > 0) {
    lines.push("Required actions:");
    for (const action of card.requiredActions.slice(0, 6)) {
      lines.push(`- [${action.severity}] ${action.command ?? action.title}`);
    }
  }

  if (card.advisories.length > 0) {
    lines.push("Advisories:");
    for (const action of card.advisories.slice(0, 4)) {
      lines.push(`- [${action.severity}] ${action.title}`);
    }
  }

  if (card.caveats.length > 0) {
    lines.push("Caveats:");
    for (const caveat of card.caveats.slice(0, 4)) {
      lines.push(`- ${caveat}`);
    }
  }

  return lines;
}
