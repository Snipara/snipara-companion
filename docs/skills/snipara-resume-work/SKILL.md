---
name: snipara-resume-work
description: Resume an interrupted Snipara-managed task or handoff when checkpoint identity, source drift or evidence needs reconciliation. A dirty workspace alone does not trigger task resumption.
metadata:
  version: "0.2.0"
  stage: "internal-pilot"
---

# Resume the intended task

Match the user's task to its workspace and checkpoint. Reuse sufficient supplied
context. If more is needed, use installed Companion `workflow resume --json` or
the selected task's `task resume`; inspect omitted blockers/detail before acting.
Use Team Sync only when another actor's work is relevant. If the tool is absent,
inspect available artifacts and current files without installing a replacement.

Reconcile current source, dirty paths, authorization and proof. Preserve unrelated
changes. Historical receipts do not establish current tests or a live process.
Carry valid authorization forward; ask only for a genuinely unresolved choice.
Existing ownership, Sandbox and Controller requirements remain binding.

Example: “continue the UI fix” with a release checkpoint. Locate the UI task;
do not overwrite or resume the unrelated release workflow.

Take the next authorized action rather than stopping at a continuation plan.
Update the task's existing checkpoint when needed for continuity; no duplicate
journal or per-use pilot log is required.
