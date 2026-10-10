/** Explicit public Controller actions. Inspecting never starts execution or grants authority. */
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { bridgeId, bridgeRecord } from "./controller-bridge";
import { bridgeLocalPath, readBridgeSource } from "./controller-bridge-io";
import { readControllerProgress } from "./controller-progress";
import { projectControllerBridge } from "./controller-bridge-project";

const ACTIONS = new Set([
  "inspect",
  "show",
  "stop",
  "resume",
  "candidate-show",
  "review-show",
  "review-attach",
  "evaluate",
]);
export interface ControllerCockpitOptions {
  dir: string;
  controllerId: string;
  action?: string;
  bridgeFile?: string;
  orchestratorBin?: string;
  candidateId?: string;
  receiptFile?: string;
  cancelActive?: boolean;
  timeoutSeconds?: number | string;
  json?: boolean;
}
export function buildControllerCockpit(options: ControllerCockpitOptions): Record<string, unknown> {
  const cwd = fs.realpathSync(options.dir);
  const controllerId = bridgeId(options.controllerId);
  if (!fs.statSync(cwd).isDirectory()) throw new Error("Cockpit workspace must be a directory");
  const action = options.action ?? "inspect";
  if (!ACTIONS.has(action))
    throw new Error("Unsupported cockpit action; dispatch and land are not cockpit actions");
  if (options.cancelActive && action !== "stop")
    throw new Error("--cancel-active requires explicit stop action");
  if (options.receiptFile && action !== "review-attach")
    throw new Error("--receipt-file requires explicit review-attach action");
  const candidateId = options.candidateId == null ? undefined : bridgeId(options.candidateId);
  const stateFile = `.snipara/orchestrator/project-controllers/${controllerId}/state.json`;
  bridgeLocalPath(cwd, stateFile);
  const progress = readControllerProgress(stateFile, cwd);
  const bridge = options.bridgeFile
    ? projectControllerBridge({
        dir: cwd,
        bridgeFile: options.bridgeFile,
        controllerFile: stateFile,
      })
    : null;
  const base = ["--workspace", cwd, "--controller-id", controllerId];
  const candidate = candidateId ? ["--candidate-id", candidateId] : [];
  const commands = {
    show: ["controller", "status", ...base],
    stop: ["controller", "stop", ...base, ...(options.cancelActive ? ["--cancel-active"] : [])],
    resume: ["controller", "resume", ...base],
    "candidate-show": ["controller", "candidate", "show", ...base, ...candidate],
    "review-show": ["controller", "candidate", "review-show", ...base, ...candidate],
    evaluate: ["controller", "candidate", "evaluate", ...base, ...candidate],
  };
  if (action === "inspect")
    return {
      schemaVersion: "snipara.companion_controller_cockpit.v1",
      controllerProgress: progress,
      bridgeProjection: bridge,
      recommendedCommands: commands,
      executionAllowed: false,
      identityAuthenticated: false,
      nextAction:
        "Inspect candidate and independent review; attach an existing operator-asserted receipt explicitly before evaluation.",
    };
  let argv: string[];
  if (action === "review-attach") {
    if (!options.receiptFile)
      throw new Error(
        "review-attach requires an existing --receipt-file; cockpit never creates verdicts"
      );
    const receipt = readBridgeSource(cwd, options.receiptFile);
    if (
      !bridgeRecord(receipt.value) ||
      receipt.value.schemaVersion !== "snipara.candidate_review.v1" ||
      receipt.value.controllerId !== controllerId ||
      (candidateId && receipt.value.candidateId !== candidateId)
    )
      throw new Error("Review receipt identity or schema mismatch");
    argv = [
      "controller",
      "candidate",
      "review-record",
      ...base,
      "--receipt-file",
      bridgeLocalPath(cwd, options.receiptFile),
    ];
  } else argv = commands[action as keyof typeof commands];
  if (!options.orchestratorBin || !path.isAbsolute(options.orchestratorBin))
    throw new Error("Explicit actions require an absolute --orchestrator-bin path");
  const executable = fs.realpathSync(options.orchestratorBin);
  if (path.basename(executable) !== "snipara-orchestrator" || !fs.statSync(executable).isFile())
    throw new Error("Expected a regular public snipara-orchestrator executable");
  fs.accessSync(executable, fs.constants.X_OK);
  const timeout = Number(options.timeoutSeconds ?? 30);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60)
    throw new Error("Cockpit timeout must be between 1 and 60 seconds");
  const result = spawnSync(executable, argv, {
    cwd,
    encoding: "utf8",
    timeout: timeout * 1000,
    maxBuffer: 1_000_000,
    shell: false,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `Explicit Controller ${action} failed: ${(result.error?.message ?? result.stderr ?? "nonzero exit").slice(0, 2000)}`
    );
  return {
    schemaVersion: "snipara.companion_controller_cockpit_action.v1",
    action,
    controllerId,
    argv,
    exitCode: result.status,
    output: result.stdout,
    executionGranted: false,
    identityAuthenticated: false,
  };
}
export function controllerCockpitCommand(options: ControllerCockpitOptions): void {
  console.log(JSON.stringify(buildControllerCockpit(options), null, 2));
}
