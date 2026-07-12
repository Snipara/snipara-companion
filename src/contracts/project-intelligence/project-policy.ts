import { hashDecisionJsonValue } from "./decision-request";

export const PROJECT_POLICY_DECISION_VERSION = "snipara.project_policy.decision.v0" as const;
export const PROJECT_POLICY_RECEIPT_VERSION = "snipara.project_policy.receipt.v0" as const;

export type ProjectPolicyVerdict = "allow" | "warn" | "require_review" | "block";

export type ProjectPolicyRuleScope =
  | "release"
  | "schema"
  | "auth"
  | "billing"
  | "deploy"
  | "package_surface"
  | "memory"
  | "routing"
  | "custom";

export type ProjectPolicyRuleStrength = "advisory" | "review_required" | "blocking";

export interface ProjectPolicyRule {
  id: string;
  title: string;
  scope: ProjectPolicyRuleScope;
  strength: ProjectPolicyRuleStrength;
  confidence: number;
  source: {
    kind: "decision_memory" | "project_policy" | "manual_override" | "receipt";
    ref: string;
    reviewStatus?: "approved" | "pending" | "rejected";
  };
  anchors: string[];
  requirement: string;
  forbiddenActions?: string[];
  requiredActions?: string[];
  rationale?: string;
}

export interface ProjectPolicyAction {
  summary: string;
  surface?: ProjectPolicyRuleScope;
  changedFiles?: string[];
  commands?: string[];
  metadata?: Record<string, unknown>;
}

export interface ProjectPolicyDecision {
  version: typeof PROJECT_POLICY_DECISION_VERSION;
  generatedAt: string;
  verdict: ProjectPolicyVerdict;
  confidence: number;
  matchedRules: ProjectPolicyRule[];
  reasonCodes: string[];
  requiredActions: string[];
  warnings: string[];
  receipt: ProjectPolicyReceipt;
}

export interface ProjectPolicyReceipt {
  version: typeof PROJECT_POLICY_RECEIPT_VERSION;
  receiptId: string;
  generatedAt: string;
  verdict: ProjectPolicyVerdict;
  actionFingerprint: string;
  ruleRefs: string[];
  confidence: number;
  reasonCodes: string[];
  overrideAllowed: boolean;
  overrideRequiresReason: boolean;
}

export interface EvaluateProjectPolicyDecisionInput {
  action: ProjectPolicyAction;
  rules: ProjectPolicyRule[];
  now?: string | Date;
}

const VERDICT_RANK: Record<ProjectPolicyVerdict, number> = {
  allow: 0,
  warn: 1,
  require_review: 2,
  block: 3,
};

export function evaluateProjectPolicyDecision(
  input: EvaluateProjectPolicyDecisionInput
): ProjectPolicyDecision {
  const generatedAt = isoTimestamp(input.now);
  const actionText = normalizeText(
    [
      input.action.summary,
      input.action.surface,
      ...(input.action.changedFiles ?? []),
      ...(input.action.commands ?? []),
      metadataToText(input.action.metadata),
    ].filter((item): item is string => Boolean(item))
  );
  const matchedRules = normalizeRules(input.rules).filter((rule) =>
    ruleMatchesAction(rule, actionText, input.action)
  );
  const verdict = matchedRules.reduce<ProjectPolicyVerdict>(
    (current, rule) => strongerVerdict(current, verdictForRule(rule, actionText)),
    "allow"
  );
  const confidence =
    matchedRules.length === 0
      ? 1
      : Math.max(...matchedRules.map((rule) => normalizeConfidence(rule.confidence)));
  const reasonCodes = buildReasonCodes(matchedRules, verdict);
  const requiredActions = uniqueStrings(
    matchedRules.flatMap((rule) => rule.requiredActions ?? [rule.requirement])
  );
  const warnings = matchedRules
    .filter((rule) => verdictForRule(rule, actionText) === "warn")
    .map((rule) => rule.requirement);
  const actionFingerprint = hashDecisionJsonValue(input.action);
  const receipt: ProjectPolicyReceipt = {
    version: PROJECT_POLICY_RECEIPT_VERSION,
    receiptId: buildReceiptId(actionFingerprint, matchedRules),
    generatedAt,
    verdict,
    actionFingerprint,
    ruleRefs: matchedRules.map((rule) => rule.source.ref),
    confidence,
    reasonCodes,
    overrideAllowed: verdict !== "block",
    overrideRequiresReason: verdict !== "allow",
  };

  return {
    version: PROJECT_POLICY_DECISION_VERSION,
    generatedAt,
    verdict,
    confidence,
    matchedRules,
    reasonCodes,
    requiredActions,
    warnings,
    receipt,
  };
}

export function projectPolicyVerdictToGateSeverity(
  verdict: ProjectPolicyVerdict
): "advisory" | "required_action" | "block" {
  if (verdict === "block") return "block";
  if (verdict === "require_review") return "required_action";
  return "advisory";
}

function normalizeRules(rules: ProjectPolicyRule[]): ProjectPolicyRule[] {
  return rules.filter(
    (rule) =>
      rule.id.trim() &&
      rule.title.trim() &&
      rule.requirement.trim() &&
      rule.source.reviewStatus !== "rejected" &&
      normalizeConfidence(rule.confidence) >= 0.5
  );
}

function ruleMatchesAction(
  rule: ProjectPolicyRule,
  actionText: string,
  action: ProjectPolicyAction
): boolean {
  if (action.surface && rule.scope !== "custom" && action.surface !== rule.scope) {
    return false;
  }
  const anchors = uniqueStrings([
    rule.scope,
    ...rule.anchors,
    ...(rule.forbiddenActions ?? []),
    ...(rule.requiredActions ?? []),
  ]);
  return anchors.some((anchor) => actionText.includes(normalizeText(anchor)));
}

function verdictForRule(rule: ProjectPolicyRule, actionText: string): ProjectPolicyVerdict {
  const forbidden = (rule.forbiddenActions ?? []).some((item) =>
    actionText.includes(normalizeText(item))
  );
  if (rule.strength === "blocking" && forbidden && normalizeConfidence(rule.confidence) >= 0.8) {
    return "block";
  }
  if (rule.strength === "blocking" || rule.strength === "review_required") {
    return "require_review";
  }
  return "warn";
}

function strongerVerdict(left: ProjectPolicyVerdict, right: ProjectPolicyVerdict) {
  return VERDICT_RANK[right] > VERDICT_RANK[left] ? right : left;
}

function buildReasonCodes(rules: ProjectPolicyRule[], verdict: ProjectPolicyVerdict): string[] {
  if (rules.length === 0) {
    return ["project_policy_no_match"];
  }
  return uniqueStrings([
    `project_policy_${verdict}`,
    ...rules.map((rule) => `project_policy_${rule.scope}`),
    ...rules.map((rule) => `project_policy_${rule.strength}`),
  ]);
}

function buildReceiptId(actionFingerprint: string, rules: ProjectPolicyRule[]) {
  const hash = hashDecisionJsonValue({
    actionFingerprint,
    rules: rules.map((rule) => [rule.id, rule.source.ref]),
  }).replace(/^sha256:/, "");
  return `project-policy-${hash.slice(0, 16)}`;
}

function isoTimestamp(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) return new Date(value).toISOString();
  return new Date().toISOString();
}

function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeText(value: string | string[] | undefined): string {
  const text = Array.isArray(value) ? value.filter(Boolean).join("\n") : (value ?? "");
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function metadataToText(metadata: Record<string, unknown> | undefined) {
  if (!metadata) return "";
  try {
    return JSON.stringify(metadata).slice(0, 12_000);
  } catch {
    return "";
  }
}
