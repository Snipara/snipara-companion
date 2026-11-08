/** Saved Sandbox verification is historical context; this pure projection never runs a verifier. */
import { createHash } from "node:crypto";
import { checkpointText } from "../session/checkpoint";

type Data = Record<string, unknown>;
const record = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const runId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const imageId = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const SCHEMA = "snipara.sandbox.validation.v1";

export interface SandboxEvidenceOptions {
  expectedRunId?: string;
  requestPath?: string;
  storePath?: string;
  current?: { requestSha256?: string; snapshotSha256?: string; imageId?: string };
}
export interface SandboxEvidenceCard {
  schemaVersion: "snipara.task.sandbox_evidence_card.v1";
  status: "not_observed" | "saved_observation" | "malformed";
  authority: "editable_saved_observation";
  savedVerifierClaim: "valid" | "invalid" | "unknown";
  verificationFresh: false;
  executionAuthorized: false;
  receipt: { runId?: string; requestSha256?: string; snapshotSha256?: string; imageId?: string; commandSha256?: string };
  verifierReasons: string[];
  reuse: { status: "requires_fresh_verification"; eligible: false; denialReasons: string[] };
  nextAction?: { argv: string[]; automaticExecution: false; dispatchesTests: false };
}
function safeRelative(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !value.startsWith("-") && !value.startsWith("/") && !/[\\:]/.test(value) &&
    !Array.from(value).some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code <= 31 || code === 127);
    }) &&
    !value.split("/").some((part) => part === ".." || part === "") && checkpointText(value, 512) === value;
}

export function projectSandboxEvidenceCard(saved: unknown, options: SandboxEvidenceOptions = {}): SandboxEvidenceCard {
  const result: SandboxEvidenceCard = {
    schemaVersion: "snipara.task.sandbox_evidence_card.v1", status: saved == null ? "not_observed" : "malformed",
    authority: "editable_saved_observation", savedVerifierClaim: "unknown", verificationFresh: false,
    executionAuthorized: false, receipt: {}, verifierReasons: [],
    reuse: { status: "requires_fresh_verification", eligible: false, denialReasons: ["fresh_verification_required"] },
  };
  const denied = result.reuse.denialReasons;
  if (saved == null) { denied.push("saved_verification_not_observed"); return result; }
  if (!record(saved) || saved.schema_version !== SCHEMA || !runId(saved.run_id) ||
      typeof saved.valid !== "boolean" || !Array.isArray(saved.reasons) || saved.reasons.length > 32 ||
      saved.reasons.some((reason) => typeof reason !== "string" || reason.length > 512)) {
    denied.push("saved_verification_malformed"); return result;
  }
  result.verifierReasons = saved.reasons.map((reason) => checkpointText(reason as string, 256));
  denied.push(...result.verifierReasons);
  result.savedVerifierClaim = saved.valid ? "valid" : "invalid";
  result.receipt.runId = saved.run_id;
  const receipt = record(saved.receipt) ? saved.receipt : null;
  const snapshot = receipt && record(receipt.snapshot) ? receipt.snapshot : null;
  // Same public verifier success floor as the CLI adapter; saved JSON still grants no proof.
  const accepted = receipt?.schema_version === SCHEMA && receipt.run_id === saved.run_id &&
    receipt.status === "passed" && receipt.cleanup_complete === true && receipt.exit_code === 0 && receipt.backend === "docker";
  if (saved.valid && (saved.reasons.length > 0 || !accepted)) {
    denied.push("saved_verification_contradictory"); return result;
  }
  result.status = "saved_observation";
  if (!saved.valid) denied.push("saved_verification_rejected");
  if (!options.expectedRunId) denied.push("task_run_binding_not_observed");
  else if (!runId(options.expectedRunId) || options.expectedRunId !== saved.run_id) denied.push("run_identity_mismatch");
  const identities = [
    ["requestSha256", receipt?.request_sha256, options.current?.requestSha256, "request_changed", "current_request_not_observed", digest],
    ["snapshotSha256", snapshot?.sha256, options.current?.snapshotSha256, "snapshot_changed", "current_snapshot_not_observed", digest],
    ["imageId", receipt?.image_id, options.current?.imageId, "image_changed", "current_image_not_observed", imageId],
  ] as const;
  for (const [key, previous, current, changed, missing, valid] of identities) {
    if (valid(previous)) result.receipt[key] = previous;
    else denied.push(`saved_${key}_invalid`);
    if (current === undefined) denied.push(missing);
    else if (!valid(current)) denied.push(`current_${key}_invalid`);
    else if (valid(previous) && current !== previous) denied.push(changed);
  }
  if (digest(receipt?.command_sha256)) result.receipt.commandSha256 = receipt.command_sha256;
  if (options.expectedRunId !== undefined && options.expectedRunId !== saved.run_id) {
    denied.push("verify_action_requires_matching_task_run");
  } else if (safeRelative(options.requestPath) && (options.storePath === undefined || safeRelative(options.storePath))) {
    result.nextAction = { argv: ["snipara-companion", "validation", "verify", "--request", options.requestPath,
      "--run-id", saved.run_id, ...(options.storePath ? ["--store", options.storePath] : [])],
      automaticExecution: false, dispatchesTests: false };
  } else denied.push(options.requestPath === undefined ? "request_reference_required" : "unsafe_request_or_store_reference");
  result.reuse.denialReasons = [...new Set(denied)];
  return result;
}

/** A review aid for request-file bytes; Sandbox remains the authoritative request validator. */
export function previewSandboxValidationRequest(text: string): {
  schemaVersion: "snipara.validation.request_preview.v1"; requestFileSha256: string;
  canonicalRequestIdentity: false; validatedBySandbox: false; executionAuthorized: false;
  summary: { workspace: string; image: string; immutableImageReference: boolean; profile: string;
    argv: string[]; limits: Data; requirements: Data };
} {
  if (Buffer.byteLength(text, "utf8") > 65536) throw new Error("Request preview exceeds 64KiB");
  const value: unknown = JSON.parse(text);
  if (!record(value) || typeof value.workspace !== "string" || typeof value.image !== "string" ||
      !Array.isArray(value.argv) || !value.argv.length || value.argv.length > 256 ||
      value.argv.some((arg) => typeof arg !== "string" || arg.length > 4000)) throw new Error("Invalid request preview structure");
  const limits: Data = {};
  for (const key of ["timeout_seconds", "cpus", "memory_mb", "pids", "disk_mb"]) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) limits[key] = value[key];
  }
  const requirements: Data = {};
  if (record(value.requirements)) for (const key of ["commands", "python_modules", "node_modules"]) {
    const names = value.requirements[key];
    if (Array.isArray(names)) requirements[key] = names.slice(0, 64).filter((name) => typeof name === "string")
      .map((name) => checkpointText(name, 128));
  }
  return { schemaVersion: "snipara.validation.request_preview.v1", requestFileSha256: createHash("sha256").update(text).digest("hex"),
    canonicalRequestIdentity: false, validatedBySandbox: false, executionAuthorized: false,
    summary: { workspace: checkpointText(value.workspace, 512), image: checkpointText(value.image, 256),
      immutableImageReference: imageId(value.image) || /@sha256:[a-f0-9]{64}$/.test(value.image),
      profile: typeof value.profile === "string" ? checkpointText(value.profile, 32) : "python",
      argv: value.argv.map((arg) => checkpointText(arg as string, 2000)), limits, requirements } };
}
