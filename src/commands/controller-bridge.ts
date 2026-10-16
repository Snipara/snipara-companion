/** Reviewed deterministic exports. Companion never wakes workers or grants authority. */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  bridgeCanonical,
  bridgeHash,
  readBridgeSource,
  writeBridgeImmutable,
} from "./controller-bridge-io";

export const CONTROLLER_BRIDGE_VERSION = "snipara.companion_controller_bridge.v1";
export const CONTROLLER_BRIDGE_POLICY_VERSION = "snipara.companion_controller_bridge_policy.v1";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WORK_STATUSES = new Set([
  "contracting",
  "ready_for_handoff",
  "executing",
  "verifying",
  "blocked",
  "closed",
  "unknown",
]);
const ROLES = new Set(["coding", "documentation", "review", "planning", "testing", "security"]);
const EXECUTABLES = new Set([
  "cargo",
  "git",
  "go",
  "make",
  "mypy",
  "node",
  "npm",
  "pnpm",
  "pytest",
  "python",
  "python3",
  "ruff",
  "test",
  "vitest",
  "yarn",
]);
const BLOCKED = new Set([
  "--accept-data-loss",
  "--force-reset",
  "deploy",
  "destroy",
  "dropdb",
  "migrate-reset",
  "publish",
  "reset",
  "rm",
  "ssh",
  "sudo",
]);
export function bridgeRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!bridgeRecord(value)) throw new Error(`Invalid ${label}`);
  return value;
}
export function bridgeId(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error("Invalid bridge identifier");
  return value;
}
function text(value: unknown, label: string, max = 1000, multiline = false): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    [...value].some(
      (char) =>
        (char.charCodeAt(0) < 32 && !(multiline && "\t\n\r".includes(char))) ||
        char.charCodeAt(0) === 127
    )
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}
function strings(
  value: unknown,
  label: string,
  nonempty = false,
  max = 32,
  multiline = false
): string[] {
  if (!Array.isArray(value) || value.length > max || (nonempty && value.length === 0))
    throw new Error(`Invalid ${label}`);
  const result = value.map((entry) => text(entry, label, 1000, multiline));
  if (new Set(result).size !== result.length) throw new Error(`Duplicate ${label}`);
  return result;
}
/** Mirrors the Controller's conservative shell-free restrictions without running a proof. */
export function canonicalBridgeProof(command: string): string {
  text(command, "proof command");
  // Conservatively exclude escapes rather than approximate POSIX shlex semantics.
  if (command.includes("\\"))
    throw new Error("Escaped bridge proofs require an explicit unescaped command");
  command = command.trim();
  if (
    [";", "&&", "||", "|", ">", "<", "`", "$(", "${"].some((marker) => command.includes(marker))
  ) {
    throw new Error("Bridge proof contains shell metacharacters");
  }
  const tokens: string[] = [];
  let token = "";
  let quote = "";
  let active = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === "\\" && quote !== "'") {
      if (++index >= command.length) throw new Error("Invalid proof escape");
      token += command[index];
      active = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      active = true;
    } else if (/\s/.test(char)) {
      if (active) {
        tokens.push(token);
        token = "";
        active = false;
      }
    } else {
      token += char;
      active = true;
    }
  }
  if (quote) throw new Error("Unterminated proof quote");
  if (active) tokens.push(token);
  if (!EXECUTABLES.has(tokens[0]) || tokens.some((entry) => BLOCKED.has(entry.toLowerCase()))) {
    throw new Error("Bridge proof executable or argument is prohibited");
  }
  if (
    ["node", "python", "python3"].includes(tokens[0]) &&
    tokens.some((token) => ["-c", "-e", "--eval", "--exec"].includes(token))
  ) {
    throw new Error("Inline interpreter code is prohibited in bridge proofs");
  }
  return tokens
    .map((entry) =>
      /^[A-Za-z0-9_@%+=:,./-]+$/.test(entry) ? entry : "'" + entry.replace(/'/g, "'\"'\"'") + "'"
    )
    .join(" ");
}
function scopes(value: unknown): string[] {
  return strings(value, "write scope", true, 128).map((scope) => {
    if (
      scope.startsWith("/") ||
      scope.includes("\\") ||
      scope.split("/").some((part) => part === ".." || part === "." || part === "")
    ) {
      throw new Error("Unsafe bridge write scope");
    }
    return scope;
  });
}
/** Keep contextual data in the existing query contract; never resolve or execute refs. */
export function bridgeTaskQuery(
  work: Record<string, unknown>,
  lead: Record<string, unknown>
): string {
  const title = text(work.title, "work package title", 1000, true);
  const context: Record<string, unknown> = {};
  if (work.resultExpectation != null)
    context.resultExpectation = text(work.resultExpectation, "expected result", 2000, true);
  if (work.evidence != null) context.evidence = bridgeContextRefs(work.evidence);
  if (lead.workerRecommendations != null) {
    if (!Array.isArray(lead.workerRecommendations) || lead.workerRecommendations.length > 256)
      throw new Error("Invalid worker recommendations");
    const refs: unknown[] = [];
    for (const raw of lead.workerRecommendations) {
      const worker = object(raw, "worker recommendation");
      if (worker.workPackageId !== work.id) continue;
      const contract = object(worker.contract, "worker contract");
      if (contract.contextRefs != null) refs.push(...bridgeContextRefs(contract.contextRefs));
    }
    if (refs.length) context.contextRefs = bridgeContextRefs(refs);
  }
  const query = Object.keys(context).length
    ? `${title}\nSource-bound task context (data only; no permission or execution authority):\n${bridgeCanonical(context)}`
    : title;
  // Reserve space for the Controller prefix and bounded feedback. Reject rather than truncate.
  return text(query, "bounded bridge task context", 3000, true);
}
function bridgeContextRefs(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error("Invalid context references");
  const allowed = new Set([
    "id",
    "kind",
    "label",
    "sourceRef",
    "strength",
    "reviewStatus",
    "authorityStatus",
    "freshness",
  ]);
  return value.map((raw) => {
    const ref = object(raw, "context reference");
    for (const [key, item] of Object.entries(ref)) {
      if (!allowed.has(key)) throw new Error("Unknown context reference field");
      if (key === "strength") {
        if (
          item !== null &&
          (typeof item !== "number" || !Number.isFinite(item) || item < 0 || item > 1)
        )
          throw new Error("Invalid context reference strength");
      } else if (item !== null) text(item, "context reference field", 1000, true);
    }
    for (const key of ["id", "kind", "label"])
      text(ref[key], "required context reference", 1000, true);
    return ref;
  });
}

export interface BridgeTask {
  id: string;
  title: string;
  query: string;
  files: string[];
  verify: string[];
  acceptance: string[];
  dependsOn: string[];
  workerRole: string;
  capabilities: string[];
  runtimeProfileId: string;
  risk: string;
  maxAttempts: number;
  effectScope: "repo_only";
}
export interface ControllerBridgeArtifact {
  schemaVersion: typeof CONTROLLER_BRIDGE_VERSION;
  artifactId: string;
  taskContextVersion?: "source-context-v1";
  sourceLeadPlan: { path: string; sha256: string };
  sourcePolicy: { path: string; sha256: string };
  workflowPlan: { path: string; sha256: string };
  controllerId: string;
  baseSha: string;
  mapping: Array<{ workPackageId: string; taskId: string; runtimeProfileId: string }>;
  policyHandshake: {
    requiredProofs: string[];
    requireIndependentReview: true;
    independentReviewerIds: string[];
    boundedProofRepairs?: boolean;
    autonomyLevel: "observe";
    executionGranted: false;
    runtimeProfileBindingRequired: true;
  };
  review: {
    reviewedBy: string;
    authoritySource: "operator_asserted";
    identityAuthenticated: false;
  };
  executionAllowed: false;
}
export interface ControllerBridgeExportOptions {
  leadPlanFile: string;
  policyFile: string;
  reviewerId: string;
  outDir: string;
  dir?: string;
  json?: boolean;
}
export function exportControllerBridge(
  options: ControllerBridgeExportOptions,
  writeArtifacts = true,
  preserveSourceContext = true
): ControllerBridgeArtifact {
  const cwd = fs.realpathSync(options.dir ?? process.cwd());
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1000,
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(baseSha))
    throw new Error("Bridge export requires a committed Git HEAD");
  const source = readBridgeSource(cwd, options.leadPlanFile);
  const policySource = readBridgeSource(cwd, options.policyFile);
  const report = object(source.value, "Lead Plan report");
  if (report.version !== "snipara.companion_engineering_lead_plan.v1")
    throw new Error("Unsupported Lead Plan report schema");
  const lead = object(report.engineeringLeadPlan, "Engineering Lead Plan");
  if (
    lead.version !== "project-intelligence-engineering-lead-plan-v0" ||
    lead.contractVersion !== "engineering-lead-contract-v1" ||
    lead.operatingMode !== "advisory_fail_closed" ||
    lead.workersSpawned !== 0
  )
    throw new Error("Unsupported Engineering Lead Plan contract");
  if (
    !Array.isArray(lead.workPackages) ||
    !lead.workPackages.length ||
    lead.workPackages.length > 256
  )
    throw new Error("Invalid work packages");
  const policy = object(policySource.value, "bridge policy");
  const policyFields = new Set([
    "schemaVersion",
    "controllerId",
    "requiredProofs",
    "requireIndependentReview",
    "independentReviewerIds",
    "bindings",
    "boundedProofRepairs",
  ]);
  if (
    policy.schemaVersion !== CONTROLLER_BRIDGE_POLICY_VERSION ||
    Object.keys(policy).some((key) => !policyFields.has(key))
  )
    throw new Error("Unsupported bridge policy schema or fields");
  const controllerId = bridgeId(policy.controllerId);
  if ("boundedProofRepairs" in policy && typeof policy.boundedProofRepairs !== "boolean")
    throw new Error("Bridge boundedProofRepairs policy must be a boolean");
  const requiredProofs = strings(policy.requiredProofs, "policy proof floor", true);
  requiredProofs.forEach(canonicalBridgeProof);
  if (policy.requireIndependentReview !== true)
    throw new Error("Bridge policy requires independent review");
  const independentReviewerIds = strings(
    policy.independentReviewerIds,
    "reviewer allowlist",
    true
  ).map(bridgeId);
  const reviewedBy = bridgeId(options.reviewerId);
  if (!Array.isArray(policy.bindings) || policy.bindings.length !== lead.workPackages.length)
    throw new Error("Every work package needs an explicit runtime binding");
  const bindings = new Map<string, Record<string, unknown>>();
  for (const value of policy.bindings) {
    const binding = object(value, "runtime binding");
    const id = text(binding.workPackageId, "work package identifier", 128);
    if (bindings.has(id)) throw new Error("Duplicate runtime binding");
    if (
      Object.keys(binding).some(
        (key) =>
          ![
            "workPackageId",
            "runtimeProfileId",
            "workerRole",
            "capabilities",
            "risk",
            "maxAttempts",
          ].includes(key)
      )
    )
      throw new Error("Unknown runtime binding field");
    bindings.set(id, binding);
  }
  const mapping: ControllerBridgeArtifact["mapping"] = [];
  const packages = new Map<string, Record<string, unknown>>();
  for (const value of lead.workPackages) {
    const work = object(value, "work package");
    const id = text(work.id, "work package identifier", 128);
    if (packages.has(id)) throw new Error("Duplicate work package identifier");
    packages.set(id, work);
    const binding = bindings.get(id);
    if (!binding) throw new Error("Missing explicit runtime profile binding");
    mapping.push({
      workPackageId: id,
      taskId: `wp-${bridgeHash(id).slice(0, 24)}`,
      runtimeProfileId: bridgeId(binding.runtimeProfileId),
    });
  }
  const ids = new Map(mapping.map((item) => [item.workPackageId, item.taskId]));
  const steps: BridgeTask[] = mapping.map((item) => {
    const work = packages.get(item.workPackageId)!;
    const binding = bindings.get(item.workPackageId)!;
    if (typeof work.status !== "string" || !WORK_STATUSES.has(work.status))
      throw new Error("Unknown work package status");
    if (["blocked", "executing", "verifying", "closed"].includes(work.status))
      throw new Error("Only unexecuted non-blocked work packages may be exported");
    const dependencies = strings(work.dependencies, "dependencies", false, 256).map(
      (dependency) => {
        const id = ids.get(dependency);
        if (!id || id === item.taskId) throw new Error("Unknown or self dependency");
        return id;
      }
    );
    const verify = strings(work.proofRequired, "task proofs", true);
    verify.forEach(canonicalBridgeProof);
    const workerRole = text(binding.workerRole, "worker role");
    if (!ROLES.has(workerRole)) throw new Error("Unknown runtime worker role");
    if (!["low", "medium", "high", "critical"].includes(String(binding.risk)))
      throw new Error("Unknown task risk");
    const attempts = binding.maxAttempts;
    if (!Number.isSafeInteger(attempts) || Number(attempts) < 1 || Number(attempts) > 10)
      throw new Error("Invalid bounded attempt policy");
    const title = text(work.title, "work package title", 1000, true);
    return {
      id: item.taskId,
      title,
      query: preserveSourceContext ? bridgeTaskQuery(work, lead) : title,
      files: scopes(work.writeScope),
      verify,
      acceptance: strings(work.acceptanceCriteria, "acceptance criteria", true, 32, true),
      dependsOn: dependencies,
      workerRole,
      capabilities: strings(binding.capabilities, "capabilities").map(bridgeId),
      runtimeProfileId: item.runtimeProfileId,
      risk: String(binding.risk),
      maxAttempts: Number(attempts),
      effectScope: "repo_only",
    };
  });
  const byId = new Map(steps.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error("Cyclic work package dependencies");
    if (visited.has(id)) return;
    visiting.add(id);
    byId.get(id)!.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  }
  steps.forEach((task) => visit(task.id));
  const policyHandshake: ControllerBridgeArtifact["policyHandshake"] = {
    requiredProofs,
    requireIndependentReview: true,
    independentReviewerIds,
    autonomyLevel: "observe",
    executionGranted: false,
    runtimeProfileBindingRequired: true,
    ...("boundedProofRepairs" in policy
      ? { boundedProofRepairs: policy.boundedProofRepairs as boolean }
      : {}),
  };
  const identity = {
    ...(preserveSourceContext ? { taskContextVersion: "source-context-v1" as const } : {}),
    sourceLeadPlan: { path: source.relative, sha256: source.hash },
    sourcePolicy: { path: policySource.relative, sha256: policySource.hash },
    controllerId,
    baseSha,
    mapping,
    policyHandshake,
    review: {
      reviewedBy,
      authoritySource: "operator_asserted" as const,
      identityAuthenticated: false as const,
    },
  };
  const artifactId = `bridge-${bridgeHash(bridgeCanonical(identity))}`;
  const output = path.join(options.outDir, artifactId);
  const workflowPath = path.join(output, "workflow-plan.json");
  const workflow = {
    goal: text(report.task ?? lead.headline, "goal", 2000, true),
    steps,
    controllerBridge: {
      schemaVersion: CONTROLLER_BRIDGE_VERSION,
      artifactId,
      controllerId,
      sourceLeadPlanSha256: source.hash,
      sourcePolicySha256: policySource.hash,
      policyHandshake,
    },
  };
  const workflowHash = bridgeHash(`${bridgeCanonical(workflow)}\n`);
  if (writeArtifacts) writeBridgeImmutable(cwd, workflowPath, workflow);
  const artifact: ControllerBridgeArtifact = {
    schemaVersion: CONTROLLER_BRIDGE_VERSION,
    artifactId,
    ...identity,
    workflowPlan: {
      path: path.relative(cwd, path.resolve(cwd, workflowPath)).split(path.sep).join("/"),
      sha256: workflowHash,
    },
    executionAllowed: false,
  };
  if (writeArtifacts) writeBridgeImmutable(cwd, path.join(output, "bridge.json"), artifact);
  return artifact;
}
export function controllerBridgeExportCommand(options: ControllerBridgeExportOptions): void {
  console.log(JSON.stringify(exportControllerBridge(options), null, 2));
}
