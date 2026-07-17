import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import {
  buildDecisionRequest,
  buildWorkerTrustCandidate,
  buildWorkerTrustEvent,
  hashWorkerProfileContent,
  isWorkerTrustEvent,
  normalizeWorkerProfile,
  stableDecisionJsonStringify,
  stableWorkerProfileJsonStringify,
  WORKER_TRUST_CATEGORIES,
  type WorkerProfile,
  type WorkerTrustCandidate,
  type WorkerTrustCategory,
  type WorkerTrustEvent,
} from "../contracts/project-intelligence";
import { findWorkspaceRoot } from "../config/store";
import {
  listPendingDecisionRequests,
  resolveDecisionRequest,
  writeDecisionRequest,
} from "./decision-requests";
import { buildProducerLoopReport } from "./workflows";

const WORKER_TRUST_RELATIVE_DIR = path.join(".snipara", "worker-trust");

export interface WorkerTrustCandidateOptions {
  workerId?: string;
  workCategory?: string;
  emitDecisionRequests?: boolean;
  dir?: string;
  json?: boolean;
}

export interface WorkerTrustReviewOptions {
  requestId: string;
  choice: "approve" | "keep_supervised" | "demote";
  reviewer: string;
  note?: string;
  expiresInDays?: number;
  dir?: string;
  json?: boolean;
}

export interface WorkerTrustStatusOptions {
  workerId?: string;
  workCategory?: string;
  dir?: string;
  json?: boolean;
}

export function workerTrustCandidateCommand(options: WorkerTrustCandidateOptions = {}): unknown {
  const cwd = workspaceRoot(options.dir);
  const category = normalizeCategory(options.workCategory);
  const candidates = buildWorkerTrustCandidates(cwd).filter(
    (candidate) =>
      (!options.workerId || candidate.workerId === options.workerId) &&
      (!category || candidate.workCategory === category)
  );
  const decisions = options.emitDecisionRequests
    ? candidates
        .filter((candidate) => candidate.eligible && candidate.targetState)
        .map((candidate) => {
          const request = buildDecisionRequest({
            producer: {
              kind: "worker_trust_promotion",
              command: "workers trust candidate",
              sourceRef: `${candidate.workerId}:${candidate.workCategory}`,
            },
            decision: "Review scoped worker trust promotion",
            question: `Approve ${candidate.targetState} for ${candidate.workerId} on ${candidate.workCategory}?`,
            evidence: {
              summary: `${candidate.evidence.verifiedSamples}/${candidate.evidence.reviewedSamples} verified/reviewed samples with ${candidate.evidence.blockedSamples} blocked samples.`,
              refs: candidate.evidence.receiptRefs,
              reasonCodes: candidate.reasonCodes,
              applyPath: "workers trust review",
              applyCommand:
                "snipara-companion workers trust review --request-id <id> --choice approve --reviewer <name>",
              items: [
                {
                  ref: `${candidate.workerId}:${candidate.workCategory}`,
                  kind: "worker_trust_candidate",
                  status: candidate.targetState ?? "supervised",
                  metadata: {
                    workerId: candidate.workerId,
                    workCategory: candidate.workCategory,
                    profileHash: candidate.profileHash,
                    targetState: candidate.targetState ?? "probation_supervised",
                    reviewedSamples: candidate.evidence.reviewedSamples,
                    verifiedSamples: candidate.evidence.verifiedSamples,
                  },
                },
              ],
            },
            options: ["approve", "keep_supervised", "demote"],
            recommendation: "approve",
            rationale:
              "Eligibility is mechanical, but a human reviewer must confirm the exact worker profile, category, ceilings, and rollback conditions.",
            blocking: false,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            fingerprintParts: [
              candidate.workerId,
              candidate.workCategory,
              candidate.profileHash,
              candidate.targetState,
              candidate.evidence.receiptRefs,
            ],
          });
          return { request, write: writeDecisionRequest(request, cwd) };
        })
    : [];
  const result = {
    version: "snipara.worker_trust_candidates.v1",
    generatedAt: new Date().toISOString(),
    candidates,
    decisions,
    caveats: [
      "Candidates never change gate behavior until an explicit reviewed decision writes a trust event.",
      "Benchmark and fixture samples do not count as real workflow evidence.",
    ],
  };
  if (options.json) {
    printJson(result);
  } else {
    console.log(chalk.bold("Worker Trust Candidates"));
    if (candidates.length === 0) console.log("No matching worker evidence.");
    for (const candidate of candidates) {
      console.log(
        `- ${candidate.workerId} / ${candidate.workCategory}: ${candidate.targetState ?? "supervised"} (${candidate.evidence.verifiedSamples}/${candidate.evidence.reviewedSamples} verified/reviewed)`
      );
    }
    if (decisions.length > 0) console.log(`Decision requests: ${decisions.length}`);
  }
  return result;
}

export function workerTrustReviewCommand(options: WorkerTrustReviewOptions): unknown {
  const cwd = workspaceRoot(options.dir);
  const entry = listPendingDecisionRequests(cwd).find(
    (candidate) => candidate.request.requestId === options.requestId
  );
  if (!entry || entry.request.producer.kind !== "worker_trust_promotion") {
    throw new Error(`No pending worker trust decision matched '${options.requestId}'.`);
  }
  const metadata = entry.request.evidence.items?.[0]?.metadata ?? {};
  const workerId = stringValue(metadata.workerId);
  const workCategory = normalizeCategory(stringValue(metadata.workCategory));
  if (!workerId || !workCategory) throw new Error("Worker trust request metadata is incomplete.");
  const currentCandidate = buildWorkerTrustCandidates(cwd).find(
    (candidate) => candidate.workerId === workerId && candidate.workCategory === workCategory
  );
  if (!currentCandidate) throw new Error("Current worker trust evidence is unavailable.");
  if (options.choice === "approve" && !currentCandidate.eligible) {
    throw new Error("Current evidence no longer qualifies for promotion.");
  }
  if (
    options.choice === "approve" &&
    stringValue(metadata.profileHash) !== currentCandidate.profileHash
  ) {
    throw new Error("Worker profile changed after candidate generation; create a new decision.");
  }
  const profile = readWorkerProfile(cwd, workerId);
  if (!profile) throw new Error(`Worker profile '${workerId}' is missing or invalid.`);
  const resolved = resolveDecisionRequest({
    requestId: options.requestId,
    choice: options.choice,
    reviewer: options.reviewer,
    note: options.note,
    appliedActions:
      options.choice === "approve"
        ? ["worker_trust_event_written"]
        : ["worker_trust_kept_supervised"],
    cwd,
  });
  let event: WorkerTrustEvent | null = null;
  let eventPath: string | null = null;
  if (options.choice !== "keep_supervised") {
    const requestedExpiryDays = Number.isFinite(options.expiresInDays)
      ? Math.floor(options.expiresInDays as number)
      : 30;
    const expiryDays = Math.min(90, Math.max(1, requestedExpiryDays));
    const previous = readWorkerTrustEvent(cwd, workerId, workCategory);
    event = buildWorkerTrustEvent({
      candidate: currentCandidate,
      previousState: previous?.state,
      targetState:
        options.choice === "approve"
          ? (currentCandidate.targetState as "advisory_earned" | "delegated_earned")
          : "demoted",
      requestId: resolved.request.requestId,
      responseChoice: options.choice === "approve" ? "approve" : "demote",
      reviewer: options.reviewer,
      resolvedAt: resolved.response.resolvedAt,
      writeScope: profile.ceilings.writeScope,
      expiresAt: new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000),
    });
    eventPath = pathForWorkerTrustEvent(cwd, workerId, workCategory);
    writePrivateJson(eventPath, event);
  }
  const result = { resolved, event, eventPath };
  if (options.json) printJson(result);
  else {
    console.log(chalk.bold("Worker Trust Review"));
    console.log(`Decision: ${options.choice}`);
    console.log(`Worker: ${workerId} / ${workCategory}`);
    console.log(`Gate state: ${event?.state ?? "probation_supervised"}`);
  }
  return result;
}

export function workerTrustStatusCommand(options: WorkerTrustStatusOptions = {}): unknown {
  const cwd = workspaceRoot(options.dir);
  const category = normalizeCategory(options.workCategory);
  const events = listWorkerTrustEvents(cwd).filter(
    (event) =>
      (!options.workerId || event.workerId === options.workerId) &&
      (!category || event.workCategory === category)
  );
  const result = {
    version: "snipara.worker_trust_status.v1",
    generatedAt: new Date().toISOString(),
    events,
  };
  if (options.json) printJson(result);
  else {
    console.log(chalk.bold("Worker Trust Status"));
    if (events.length === 0) console.log("No reviewed worker trust events.");
    for (const event of events) {
      console.log(
        `- ${event.workerId} / ${event.workCategory}: ${event.state}, expires ${event.ceilings.expiresAt}`
      );
    }
  }
  return result;
}

export function buildWorkerTrustCandidates(cwd: string): WorkerTrustCandidate[] {
  const report = buildProducerLoopReport({ cwd });
  return report.workerTrust.map((row) => {
    const profile = readWorkerProfile(cwd, row.workerId);
    const profileHash = profile ? hashWorkerProfile(profile) : "sha256:missing";
    const acceptedRealSamples = report.workerReceipts.samples.filter(
      (sample) =>
        sample.workerId === row.workerId &&
        sample.workCategory === row.workCategory &&
        sample.reviewStatus === "accepted" &&
        Boolean(sample.workflowFingerprint)
    );
    const distinctSessions = new Set(
      acceptedRealSamples
        .map((sample) => sample.workflowFingerprint)
        .filter((value): value is string => Boolean(value))
    ).size;
    return buildWorkerTrustCandidate({
      workerId: row.workerId,
      workCategory: normalizeCategory(row.workCategory) ?? "unknown",
      profileHash,
      evidence: {
        reviewedSamples: row.reviewedSampleSize,
        verifiedSamples: row.verifiedSampleSize,
        blockedSamples: row.blockedSampleSize,
        incompleteReceiptSamples: row.incompleteReceiptSampleSize,
        realWorkflowSamples: acceptedRealSamples.length,
        distinctSessionsOrDays: distinctSessions,
        since: report.generatedAt,
        receiptRefs: report.workerReceipts.samples
          .filter(
            (sample) => sample.workerId === row.workerId && sample.workCategory === row.workCategory
          )
          .map((sample) => sample.relativePath),
        safetyViolations: profile ? [] : ["worker_profile_missing"],
      },
    });
  });
}

export function readWorkerTrustEvent(
  cwd: string,
  workerId: string,
  workCategory: WorkerTrustCategory
): WorkerTrustEvent | null {
  const filePath = pathForWorkerTrustEvent(cwd, workerId, workCategory);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return isWorkerTrustEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function listWorkerTrustEvents(cwd: string): WorkerTrustEvent[] {
  const root = path.resolve(cwd, WORKER_TRUST_RELATIVE_DIR);
  if (!fs.existsSync(root)) return [];
  const events: WorkerTrustEvent[] = [];
  for (const workerEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!workerEntry.isDirectory()) continue;
    const workerDir = path.join(root, workerEntry.name);
    for (const entry of fs.readdirSync(workerDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const parsed: unknown = JSON.parse(
          fs.readFileSync(path.join(workerDir, entry.name), "utf8")
        );
        if (isWorkerTrustEvent(parsed)) events.push(parsed);
      } catch {
        continue;
      }
    }
  }
  return events.sort((left, right) => left.generatedAt.localeCompare(right.generatedAt));
}

function readWorkerProfile(cwd: string, workerId: string): WorkerProfile | null {
  const filePath = path.resolve(cwd, ".snipara", "workers", `${workerId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return normalizeWorkerProfile(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

export function hashWorkerProfile(profile: WorkerProfile): string {
  const content = stableWorkerProfileJsonStringify(profile);
  return `sha256:${hashWorkerProfileContent(content)}`;
}

function pathForWorkerTrustEvent(
  cwd: string,
  workerId: string,
  workCategory: WorkerTrustCategory
): string {
  return path.resolve(cwd, WORKER_TRUST_RELATIVE_DIR, workerId, `${workCategory}.json`);
}

function workspaceRoot(dir?: string): string {
  const requested = path.resolve(dir ?? process.cwd());
  return findWorkspaceRoot(requested, true) ?? requested;
}

function normalizeCategory(value?: string): WorkerTrustCategory | undefined {
  return WORKER_TRUST_CATEGORIES.includes(value as WorkerTrustCategory)
    ? (value as WorkerTrustCategory)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

function writePrivateJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${stableDecisionJsonStringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
