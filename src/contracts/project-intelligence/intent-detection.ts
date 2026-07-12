export const INTENT_DETECTION_VERSION = "snipara.intent_detection.v0" as const;

export const PROJECT_INTENT_DETECTION_INTENTS = [
  "debugging",
  "implementing_feature",
  "refactoring",
  "reviewing",
  "investigating",
  "release_deploy",
  "unknown",
] as const;

export const PROJECT_INTENT_DETECTION_ACTIONS = [
  "read",
  "write",
  "test",
  "build",
  "deploy",
  "review",
  "decision",
  "handoff",
  "unknown",
] as const;

export type ProjectIntentDetectionIntent = (typeof PROJECT_INTENT_DETECTION_INTENTS)[number];
export type ProjectIntentDetectionAction = (typeof PROJECT_INTENT_DETECTION_ACTIONS)[number];
export type ProjectIntentDetectionConfidence = "low" | "medium" | "high";
export type ProjectIntentDetectionSuggestedMode = "lite" | "standard" | "full" | "orchestrate";

export interface ProjectIntentDetectionTimelineEvent {
  kind?: string;
  source?: string;
  title?: string;
  summary?: string;
  detail?: string;
  outcome?: string;
  files?: string[];
  metadata?: Record<string, unknown>;
}

export interface ProjectIntentDetectionSignal {
  code: string;
  intent: ProjectIntentDetectionIntent;
  weight: number;
  detail?: string;
}

export interface ProjectIntentDetectionEvidence {
  eventCount: number;
  fileCount: number;
  uniqueTouchedFiles: string[];
  actionCounts: Partial<Record<ProjectIntentDetectionAction, number>>;
}

export interface ProjectIntentDetectionAdvisoryRouting {
  hardRoutingAllowed: false;
  suggestedWorkflowMode: ProjectIntentDetectionSuggestedMode;
  reasonCodes: string[];
  caveats: string[];
}

export interface ProjectIntentDetectionResult {
  version: typeof INTENT_DETECTION_VERSION;
  intent: ProjectIntentDetectionIntent;
  confidence: ProjectIntentDetectionConfidence;
  signals: string[];
  signalDetails: ProjectIntentDetectionSignal[];
  reasonCodes: string[];
  evidence: ProjectIntentDetectionEvidence;
  advisoryRouting: ProjectIntentDetectionAdvisoryRouting;
  hardRoutingAllowed: false;
  caveats: string[];
}

type IntentScore = {
  intent: ProjectIntentDetectionIntent;
  score: number;
  signals: ProjectIntentDetectionSignal[];
};

type NormalizedEvent = {
  text: string;
  files: string[];
  action: ProjectIntentDetectionAction;
  outcome?: string;
};

const INTENT_PRIORITY: Record<ProjectIntentDetectionIntent, number> = {
  release_deploy: 60,
  debugging: 50,
  implementing_feature: 40,
  refactoring: 30,
  reviewing: 20,
  investigating: 10,
  unknown: 0,
};

function textMatches(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function compactSignals(signals: ProjectIntentDetectionSignal[]): ProjectIntentDetectionSignal[] {
  const byCode = new Map<string, ProjectIntentDetectionSignal>();
  for (const signal of signals) {
    const existing = byCode.get(signal.code);
    if (!existing || signal.weight > existing.weight) {
      byCode.set(signal.code, signal);
    }
  }
  return [...byCode.values()];
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value : "";
}

function inferAction(event: ProjectIntentDetectionTimelineEvent): ProjectIntentDetectionAction {
  const explicitAction = metadataString(event.metadata, "action");
  if (PROJECT_INTENT_DETECTION_ACTIONS.includes(explicitAction as ProjectIntentDetectionAction)) {
    return explicitAction as ProjectIntentDetectionAction;
  }

  const text = [event.kind, event.source, event.title, event.summary, event.detail, event.outcome]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (textMatches(text, [/\b(test|tests|spec|vitest|jest|pytest|node --test)\b/i])) return "test";
  if (textMatches(text, [/\b(build|type-?check|lint|compile)\b/i])) return "build";
  if (textMatches(text, [/\b(deploy|release|publish|rollout|production)\b/i])) return "deploy";
  if (textMatches(text, [/\b(review|audit|inspect|read|look(ed)? at|rg|grep)\b/i])) return "read";
  if (textMatches(text, [/\b(decision|decide|policy suggestion|manual apply)\b/i]))
    return "decision";
  if (textMatches(text, [/\b(handoff|resume|final-commit|phase-commit)\b/i])) return "handoff";
  if (textMatches(text, [/\b(edit|write|add(ed)?|implement|fix|refactor|change(d)?)\b/i])) {
    return "write";
  }
  return "unknown";
}

function normalizeEvent(event: ProjectIntentDetectionTimelineEvent): NormalizedEvent {
  return {
    text: [event.kind, event.source, event.title, event.summary, event.detail, event.outcome]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
    files: uniqueStrings(event.files ?? []),
    action: inferAction(event),
    outcome: event.outcome?.toLowerCase(),
  };
}

function actionCount(events: NormalizedEvent[], action: ProjectIntentDetectionAction): number {
  return events.filter((event) => event.action === action).length;
}

function addSignal(
  scores: Map<ProjectIntentDetectionIntent, ProjectIntentDetectionSignal[]>,
  intent: ProjectIntentDetectionIntent,
  code: string,
  weight: number,
  detail?: string
): void {
  const signals = scores.get(intent) ?? [];
  signals.push({ code, intent, weight, ...(detail ? { detail } : {}) });
  scores.set(intent, signals);
}

function confidenceFor(score: number, signalCount: number): ProjectIntentDetectionConfidence {
  if (score >= 7 && signalCount >= 3) return "high";
  if (score >= 4 && signalCount >= 2) return "medium";
  return "low";
}

function suggestedModeFor(
  intent: ProjectIntentDetectionIntent,
  confidence: ProjectIntentDetectionConfidence,
  files: string[]
): ProjectIntentDetectionSuggestedMode {
  if (intent === "release_deploy") return "full";
  if (intent === "refactoring" && (confidence !== "low" || files.length >= 5)) return "full";
  if (intent === "debugging" && confidence === "high") return "standard";
  if (intent === "investigating" || intent === "reviewing") return "lite";
  return files.length >= 5 ? "standard" : "lite";
}

export function buildIntentDetectionFromTimeline(
  events: ProjectIntentDetectionTimelineEvent[]
): ProjectIntentDetectionResult {
  const normalized = events.map(normalizeEvent);
  const text = normalized.map((event) => event.text).join("\n");
  const files = uniqueStrings(normalized.flatMap((event) => event.files));
  const testFiles = files.filter((file) => /(test|spec)\.|__tests__|tests?\//i.test(file));
  const docsFiles = files.filter((file) => /(^|\/)(docs?|README|CHANGELOG)|\.md$/i.test(file));
  const packageFiles = files.filter((file) =>
    /package\.json|CHANGELOG|README|pyproject|setup\.py|publish/i.test(file)
  );
  const sourceFiles = files.filter((file) => /\.(ts|tsx|js|jsx|py|go|rs|java|rb)$/i.test(file));
  const failureEvents = normalized.filter(
    (event) =>
      event.outcome === "failed" ||
      textMatches(event.text, [/\b(fail(ed|ure)?|error|timeout|retry|regression)\b/i])
  );
  const scores = new Map<ProjectIntentDetectionIntent, ProjectIntentDetectionSignal[]>();

  if (failureEvents.length > 0) {
    addSignal(scores, "debugging", "failure_signal", 3, `${failureEvents.length} failure event(s)`);
  }
  if (testFiles.length > 0 && (failureEvents.length > 0 || actionCount(normalized, "test") > 0)) {
    addSignal(scores, "debugging", "test_loop_signal", 3, `${testFiles.length} test file(s)`);
  }
  if (
    failureEvents.length > 0 &&
    actionCount(normalized, "write") > 0 &&
    files.some((file) => failureEvents.some((event) => event.files.includes(file)))
  ) {
    addSignal(scores, "debugging", "same_file_edited_after_failure", 2);
  }

  if (textMatches(text, [/\b(deploy|deployment|release|publish|production|rollout)\b/i])) {
    addSignal(scores, "release_deploy", "release_or_deploy_terms", 3);
  }
  if (packageFiles.length > 0) {
    addSignal(scores, "release_deploy", "package_or_release_files", 2);
  }
  if (docsFiles.length > 0 && packageFiles.length > 0) {
    addSignal(scores, "release_deploy", "docs_plus_package_surface", 2);
  }
  if (actionCount(normalized, "deploy") > 0) {
    addSignal(scores, "release_deploy", "deploy_action", 3);
  }

  if (textMatches(text, [/\b(feature|implement(ed|ing)?|add(ed|s)?|new behavior|ship)\b/i])) {
    addSignal(scores, "implementing_feature", "feature_language", 3);
  }
  if (testFiles.length > 0 && sourceFiles.length > 0) {
    addSignal(scores, "implementing_feature", "tests_plus_product_files", 2);
  }
  if (actionCount(normalized, "write") > 0 && sourceFiles.length > 0) {
    addSignal(scores, "implementing_feature", "source_write_signal", 2);
  }

  if (textMatches(text, [/\b(refactor|restructure|cleanup|rename|dedupe|simplif(y|ied))\b/i])) {
    addSignal(scores, "refactoring", "refactor_language", 3);
  }
  if (files.length >= 5 && !textMatches(text, [/\b(feature|deploy|release|publish)\b/i])) {
    addSignal(scores, "refactoring", "broad_change_without_feature_or_release_terms", 2);
  }
  if (sourceFiles.length >= 4 && testFiles.length === 0) {
    addSignal(scores, "refactoring", "many_source_files_without_tests", 1);
  }

  if (textMatches(text, [/\b(review|audit|inspect|triage|assessment|verdict)\b/i])) {
    addSignal(scores, "reviewing", "review_language", 3);
  }
  if (actionCount(normalized, "decision") > 0) {
    addSignal(scores, "reviewing", "decision_review_signal", 2);
  }
  if (textMatches(text, [/\b(policy suggestion|manual apply|required|reject|approve)\b/i])) {
    addSignal(scores, "reviewing", "human_decision_signal", 2);
  }

  if (textMatches(text, [/\b(investigat(e|ing)|look into|find out|read|rg|grep|search)\b/i])) {
    addSignal(scores, "investigating", "investigation_language", 3);
  }
  if (actionCount(normalized, "read") >= 2 && actionCount(normalized, "write") === 0) {
    addSignal(scores, "investigating", "read_heavy_no_write_signal", 2);
  }
  if (events.length > 0 && files.length === 0) {
    addSignal(scores, "investigating", "activity_without_file_changes", 1);
  }

  const ranked: IntentScore[] = PROJECT_INTENT_DETECTION_INTENTS.map((intent) => {
    const signals = compactSignals(scores.get(intent) ?? []);
    return {
      intent,
      signals,
      score: signals.reduce((sum, signal) => sum + signal.weight, 0),
    };
  }).sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return INTENT_PRIORITY[right.intent] - INTENT_PRIORITY[left.intent];
  });

  const best = ranked[0];
  const intent = best.score > 0 ? best.intent : "unknown";
  const signalDetails =
    best.score > 0
      ? best.signals
      : [{ code: "insufficient_timeline_signals", intent: "unknown" as const, weight: 0 }];
  const confidence = confidenceFor(best.score, signalDetails.length);
  const actionCounts = PROJECT_INTENT_DETECTION_ACTIONS.reduce<
    Partial<Record<ProjectIntentDetectionAction, number>>
  >((counts, action) => {
    const count = actionCount(normalized, action);
    if (count > 0) counts[action] = count;
    return counts;
  }, {});
  const suggestedWorkflowMode = suggestedModeFor(intent, confidence, files);
  const reasonCodes = uniqueStrings([
    ...signalDetails.map((signal) => signal.code),
    `intent_${intent}`,
    `confidence_${confidence}`,
  ]);

  return {
    version: INTENT_DETECTION_VERSION,
    intent,
    confidence,
    signals: signalDetails.map((signal) => signal.code),
    signalDetails,
    reasonCodes,
    evidence: {
      eventCount: events.length,
      fileCount: files.length,
      uniqueTouchedFiles: files,
      actionCounts,
    },
    advisoryRouting: {
      hardRoutingAllowed: false,
      suggestedWorkflowMode,
      reasonCodes,
      caveats: [
        "Suggested workflow mode is advisory only.",
        "Explicit user choice, policy, and receipts are required before routing work.",
      ],
    },
    hardRoutingAllowed: false,
    caveats: [
      "Intent Detection V0 is advisory only.",
      "It must not trigger workers, merges, canonical memory writes, or blocking gates by itself.",
      "Confidence is heuristic and derived from local timeline evidence.",
    ],
  };
}
