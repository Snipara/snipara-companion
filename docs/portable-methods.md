# Portable workflows with existing Companion contracts

Use the smallest suitable workflow. A known one-line fix can stay LITE; these presets are starting points when an explicit plan is useful.

```sh
snipara-companion workflow scaffold --preset bugfix --goal "Fix a reproduced defect"
snipara-companion workflow scaffold --preset feature --goal "Deliver a scoped feature"
snipara-companion workflow scaffold --preset legacy --goal "Change behavior while preserving compatibility"
snipara-companion workflow start --plan-file .snipara/workflow/plans/bugfix-plan.json
snipara-companion workflow phase-start scope
snipara-companion workflow status --json
```

The existing generated JSON can be edited before start. Bugfix defaults to STANDARD coordination, feature and legacy to FULL. Record real source references, allowed files and repository-specific checks in each plan. No worker, service or Orchestrator is required by these templates. A workflow does not automatically execute its gate labels.

## Passing work to Orchestrator

The existing Engineering Lead plan and controller-bridge export remain the path for governed execution. New exports add `taskContextVersion: source-context-v1` to the hash-bound bridge identity. The existing task query contains the exact expected result, work-package evidence and matching worker context references as bounded JSON data. Source references are not downloaded, executed or treated as permissions. Unknown reference fields, malformed values and context over 3000 UTF-16 code units are refused before export rather than truncated. Shorten the reference descriptions or split the work explicitly. The Python initializer reconstructs the same query; source drift or a changed query is rejected. Legacy artifacts without the context version retain their original title-only semantics. Legacy compatibility does not assert that an old export transported rich context.

## Reading completion evidence

`final-commit` records a declaration and handoff, not independent proof execution. Its `completionEvidence` always identifies caller authority and unchecked task proofs/objective acceptance, even when explicit evidence labels say passed. STRICT mode validates declared passing evidence; it does not authenticate the person who supplied it.

A Controller snapshot is also unverified. `controller-bridge project` can separately report `taskProofs: verified` only after checking exact local sources, native proof floor, scope and proposal bindings. Its `objectiveAcceptance` stays `not_checked`: a reported accepted Controller status or candidate review is not an independently evaluated feature result. The projection cannot close a task or grant execution. Existing Orchestrator Feature acceptance and exact-tree evaluation remain the path for objective validation.

## Reproducing native continuation

In the monorepo, use `scripts/validation/portable-methods.py --help`. Run with the Orchestrator development environment. Native execution requires `--execute-native` and an explicit fresh output directory. The campaign uses a synthetic fixture, existing host adapters, interruption and failing-proof controls, and equal frozen context in files-only/Companion arms. Saved workflow v2 state is read through the real local `workflow status` command. This tests local checkpoint rehydration, not hosted-memory resume or live-process migration. Outputs preserve failures, durations and observed usage; unknown measurements remain null. The benchmark script is repository validation tooling, not a new installed workflow engine.
