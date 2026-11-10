---
name: snipara-fix-with-proof
description: Resolve a repository bug when reproducing it, preserving its contract or binding test evidence needs care. Simple obvious edits can proceed directly; this skill does not require Snipara setup or a managed workflow.
metadata:
  version: "0.2.0"
  stage: "internal-pilot"
---

# Fix the observed behavior

Identify expected versus actual behavior from current code and evidence. Retrieve
project context only for a missing decision or contract. Preserve unrelated edits
and make the smallest coherent correction. Use a meaningful existing regression
check or add one that distinguishes the failure; avoid unrelated refactoring.

Example: an optional numeric limit rejects `0`. Check both omission and zero;
changing a truthiness rejection to a nullish rejection can still violate optionality.

Follow applicable Sandbox gates before executable repository checks. A failed
gate does not authorize host execution or installation; retain an already-approved
scoped alternative. Continue static work while a required choice is pending.
Yesterday's passing receipt for tree A does not verify changed tree B.

Report the correction, actual verification and material limits. Reuse an existing
task/checkpoint when useful; no new workflow or per-use pilot log is required.
Persist only a reusable validated learning, not routine completion noise.
