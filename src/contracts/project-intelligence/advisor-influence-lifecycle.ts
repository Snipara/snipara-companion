import { hashDecisionJsonValue } from "./decision-request";

export const ADVISOR_INFLUENCE_LIFECYCLE_VERSION =
  "snipara.advisor_influence.lifecycle.v1" as const;
export const ADVISOR_INFLUENCE_PLAN_MAX_CHARS = 4_000;

export type AdvisorInfluenceLifecycleState = "proposed" | "acknowledged" | "applied" | "verified";

export type AdvisorInfluenceLifecycleEvidenceKind = "execution" | "outcome";
export type AdvisorInfluenceLifecycleEvidenceStatus = "passed" | "failed" | "warning";

export interface AdvisorInfluenceLifecycleEvidence {
  kind: AdvisorInfluenceLifecycleEvidenceKind;
  ref: string;
  status: AdvisorInfluenceLifecycleEvidenceStatus;
  detail?: string;
}

export interface AdvisorInfluenceLifecyclePlanChange {
  method: "stable_hash_v1";
  before: string | null;
  after: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  beforeTruncated: boolean;
  afterTruncated: boolean;
  changed: boolean;
}

export interface AdvisorInfluenceLifecycleTransition {
  state: AdvisorInfluenceLifecycleState;
  at: string;
  evidenceRefs: string[];
}

export interface AdvisorInfluenceLifecycle {
  version: typeof ADVISOR_INFLUENCE_LIFECYCLE_VERSION;
  recommendationId: string;
  state: AdvisorInfluenceLifecycleState;
  generatedAt: string;
  planChange: AdvisorInfluenceLifecyclePlanChange;
  evidence: AdvisorInfluenceLifecycleEvidence[];
  transitions: AdvisorInfluenceLifecycleTransition[];
  caveats: string[];
}

export interface BuildAdvisorInfluenceLifecycleInput {
  recommendationId: string;
  generatedAt?: string | Date;
  acknowledged?: boolean;
  planBefore?: string | null;
  planAfter?: string | null;
  evidence?: AdvisorInfluenceLifecycleEvidence[];
}

interface BoundedPlanSnapshot {
  value: string | null;
  truncated: boolean;
}

/**
 * Build the evidence-backed lifecycle for an Advisor recommendation.
 *
 * `expectedBehaviorChange` is intentionally absent from this input. A proposal
 * can explain what should change, but only two explicit, bounded plan snapshots
 * with distinct stable hashes can prove that a plan was applied.
 */
export function buildAdvisorInfluenceLifecycle(
  input: BuildAdvisorInfluenceLifecycleInput
): AdvisorInfluenceLifecycle {
  const generatedAt = isoTimestamp(input.generatedAt);
  const before = boundedPlanSnapshot(input.planBefore);
  const after = boundedPlanSnapshot(input.planAfter);
  const beforeHash = before.value === null ? null : hashDecisionJsonValue(before.value);
  const afterHash = after.value === null ? null : hashDecisionJsonValue(after.value);
  const changed = beforeHash !== null && afterHash !== null && beforeHash !== afterHash;
  const evidence = normalizeEvidence(input.evidence ?? []);

  let state: AdvisorInfluenceLifecycleState = "proposed";
  if (input.acknowledged || changed) state = "acknowledged";
  if (changed) state = "applied";
  if (changed && evidence.length > 0) state = "verified";

  const orderedStates: AdvisorInfluenceLifecycleState[] = [
    "proposed",
    "acknowledged",
    "applied",
    "verified",
  ];
  const stateRank = orderedStates.indexOf(state);
  const evidenceRefs = evidence.map((item) => item.ref);
  const transitions = orderedStates.slice(0, stateRank + 1).map((transitionState) => ({
    state: transitionState,
    at: generatedAt,
    evidenceRefs: transitionState === "verified" ? evidenceRefs : [],
  }));

  const caveats = [
    "Expected behavior is proposal evidence only; it never proves plan adaptation.",
    "Applied requires two explicit bounded plan snapshots with distinct stable hashes.",
    "Verified requires an applied plan change plus recommendation-scoped execution or outcome evidence.",
  ];
  if (before.truncated || after.truncated) {
    caveats.push(
      `Plan comparison is limited to ${ADVISOR_INFLUENCE_PLAN_MAX_CHARS} normalized characters per snapshot.`
    );
  }

  return {
    version: ADVISOR_INFLUENCE_LIFECYCLE_VERSION,
    recommendationId: compactText(input.recommendationId) || "unknown-recommendation",
    state,
    generatedAt,
    planChange: {
      method: "stable_hash_v1",
      before: before.value,
      after: after.value,
      beforeHash,
      afterHash,
      beforeTruncated: before.truncated,
      afterTruncated: after.truncated,
      changed,
    },
    evidence,
    transitions,
    caveats,
  };
}

function boundedPlanSnapshot(value: string | null | undefined): BoundedPlanSnapshot {
  if (typeof value !== "string") return { value: null, truncated: false };
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  if (!normalized) return { value: null, truncated: false };
  return {
    value: normalized.slice(0, ADVISOR_INFLUENCE_PLAN_MAX_CHARS),
    truncated: normalized.length > ADVISOR_INFLUENCE_PLAN_MAX_CHARS,
  };
}

function normalizeEvidence(
  evidence: AdvisorInfluenceLifecycleEvidence[]
): AdvisorInfluenceLifecycleEvidence[] {
  const normalized = new Map<string, AdvisorInfluenceLifecycleEvidence>();
  for (const item of evidence) {
    const ref = compactText(item.ref);
    if (!ref) continue;
    const detail = compactText(item.detail);
    const value: AdvisorInfluenceLifecycleEvidence = {
      kind: item.kind,
      ref,
      status: item.status,
      ...(detail ? { detail } : {}),
    };
    normalized.set(`${value.kind}:${value.ref}:${value.status}`, value);
  }
  return [...normalized.values()];
}

function compactText(value: string | undefined): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function isoTimestamp(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) return new Date(value).toISOString();
  return new Date().toISOString();
}
