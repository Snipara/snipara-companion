import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveWorkflowContinuityFile } from "./workflow-continuity";

export function buildWorkflowReceipt(state: {
  workflowId: string; status: string; currentPhaseId?: string;
  phases: Array<{ id: string; status: string }>;
}, operation: string, detailPath: string, phaseId?: string) {
  const phase = state.phases.find(item => item.id === phaseId);
  return { workflowId: state.workflowId, operation, status: phase?.status ?? state.status,
    phaseId, nextPhaseId: state.phases.find(item => item.status !== "completed" && item.status !== "skipped")?.id ?? null,
    statePath: ".snipara/workflow/current.json", detailPath };
}

export function printWorkflowReceipt(state: Parameters<typeof buildWorkflowReceipt>[0],
  operation: string, payload: unknown, options: { json?: boolean; detail?: boolean }, phaseId?: string,
  counts?: Record<string, string | number>): void {
  // One file per operation, replaced each time, so repeated calls do not pile up detail files.
  const relative = `.snipara/workflow/detail-${operation}.json`;
  const file = resolveWorkflowContinuityFile({ cwd: process.cwd(), path: relative });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write to a fresh file and rename over the target: a pre-planted symlink is replaced, never followed.
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(payload, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, file);
  const extras = payload && typeof payload === "object" ? payload as { brief?: { text: string }; planAdvice?: string[] } : {};
  const receipt = { ...buildWorkflowReceipt(state, operation, relative, phaseId), ...(counts ? { memory: counts } : {}), ...(extras.brief ? { brief: extras.brief } : {}), ...(extras.planAdvice ? { planAdvice: extras.planAdvice } : {}) };
  const memoryLine = counts ? `\nMemory: ${Object.entries(counts).map(([key, value]) => `${key} ${value}`).join(", ")}` : "";
  console.log(options.json ? JSON.stringify(options.detail ? payload : receipt) :
    options.detail ? JSON.stringify(payload, null, 2) :
    `${operation}: ${receipt.status}; workflow ${receipt.workflowId}; next ${receipt.nextPhaseId ?? "none"}${memoryLine}\nDetails: ${relative}${extras.brief?.text ? `\nBrief: ${relative}#brief\n${extras.brief.text}` : ""}`);
}
