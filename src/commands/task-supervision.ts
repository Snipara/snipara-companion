/** Guidance for an already authorized host agent; never an execution or integration grant. */
import type { TaskJourneyCard, TaskJourneyOptions } from "./task-journey";
import type { ManagedWorkflowTask } from "./workflows";

export interface TaskSupervision {
  owner: "agent" | "system" | "human";
  disposition: "continue" | "verify" | "repair" | "wait" | "decision" | "complete" | "blocked";
  humanRequired: boolean;
  reasonCodes: string[];
  reason: string;
}

export function projectTaskSupervision(card: Omit<TaskJourneyCard, "supervision">, task?: ManagedWorkflowTask,
  requestedAction?: TaskJourneyOptions["action"], scopedWorkChanges = false): TaskSupervision {
  const result = (owner: TaskSupervision["owner"], disposition: TaskSupervision["disposition"], code: string,
    reason: string): TaskSupervision => ({ owner, disposition, humanRequired: owner === "human", reasonCodes: [code], reason });
  if (!card.task.goal || !card.task.criteria.length || !card.task.files.length)
    return result("human", "decision", "task_contract_incomplete",
      "Préciser l’objectif, le résultat attendu et le périmètre autorisé avant de travailler.");
  if (card.blockers.length && card.status !== "correction_required" && !scopedWorkChanges)
    return result("human", "decision", "task_contract_or_snapshot_requires_resolution",
      "Le contrat, le dépôt ou les sources ont changé. Expliquer l’écart et faire confirmer le cadre avant de poursuivre.");
  if (task?.status === "blocked" && !card.recommendation.fresh) {
    if (task.attempt >= task.maxAttempts)
      return result("human", "decision", "task_attempt_limit_reached",
        "La limite d’essais est atteinte. Présenter les échecs et le reste à faire avant de demander un nouveau budget.");
    // This is a caller-declared investigation trigger, not proof of the failure or its cause.
    if (task.evidence?.some((item) => /^failed:\s*\S/i.test(item)) && card.continuity?.status === "exact_snapshot")
      return result("agent", "repair", "task_declared_check_failure_within_attempt_limit",
        "Examiner l’échec déclaré, justifier la correction dans le périmètre convenu, puis reprendre et vérifier dans la limite d’essais existante.");
    return result("system", "blocked", "task_failure_unclassified",
      "La cause de l’arrêt n’est pas établie. Recueillir les faits avant de proposer une correction ou un arbitrage.");
  }
  if (card.recommendation.fresh) {
    if (card.recommendation.action === "integrate")
      return result("agent", "complete", "task_required_evidence_observed",
        "Les contrôles requis sont enregistrés. Appliquer la procédure d’intégration uniquement si son autorisation distincte existe déjà.");
    const dossier = card.dossier as { gates?: Array<{ status?: string; required?: boolean; category?: string }> } | undefined;
    const unmet = dossier?.gates?.filter((gate) => gate.required && gate.status !== "passed") ?? [];
    if (unmet.length && unmet.every((gate) => ["not_run", "unknown", "stale"].includes(gate.status ?? "") &&
      ["verification", "proof", "prerequisite", "review"].includes(gate.category ?? "")))
      return result("agent", "verify", "task_required_evidence_missing",
        "Recueillir les vérifications et la revue manquantes de cette version. Ne pas intégrer tant que ces preuves restent absentes.");
    return result("human", "decision", "task_dossier_obstacle_requires_resolution",
      "Le dossier signale un obstacle non résolu. Expliquer sa cause et la correction proposée sans élargir automatiquement l’autorisation.");
  }
  if (["verify", "decide"].includes(requestedAction ?? "") || card.status === "verification_required" || card.status === "closed")
    return result("agent", "verify", "task_verification_not_observed",
      "Exécuter les vérifications convenues avec l’hôte autorisé et conserver leurs résultats. Une déclaration de fin ne remplace pas les preuves.");
  return result("agent", "continue", "task_framed_work_ready",
    "Avancer dans le périmètre convenu, conserver les décisions et vérifier le résultat. Solliciter l’utilisateur seulement si un arbitrage dépasse ce cadre.");
}
