# One task, five steps

Use your existing coding agent. Companion adds a local task card; Orchestrator
adds its own optional execution and integration controls. Neither requires the
other. Hosted MCP context also works directly in your agent with neither CLI.
The Companion facade never starts a worker. Orchestrator has an explicit
advancement command governed by its existing execution policy.

## Companion alone

Run the prepared Companion package from your repository:

```sh
snipara-companion task start "Handle missing customer input" --id customer-input \
  --accept "Missing input returns the agreed validation error" \
  --file src/customer.ts --check "pnpm test"
snipara-companion task work customer-input
# Work with your agent and run the agreed checks.
snipara-companion task work customer-input --summary "Implemented validation" \
  --outcome completed --evidence "passed:Relevant regression checks executed"
snipara-companion task verify customer-input
snipara-companion task decide customer-input
snipara-companion task resume customer-input
```

`verify` proposes checks from the existing verification planner; it does not run
them. Evidence supplied on the command line is a declaration. Without an
independently checked candidate, `decide` assigns the missing verification to
the agent and keeps integration blocked. It cannot turn that declaration into
an integration recommendation. `close --summary ...
--outcome completed` closes local workflow work; it does not merge or prove the
functional objective. Failed and partial outcomes remain visible for resumption.

The task start path reuses existing Feature artifacts under `.snipara/tasks/`
and the existing `.snipara/workflow/current.json`. It uses an explicit local-only
process (`SNIPARA_LOCAL_ONLY=1`), even if a Hosted account is configured. Saved
credentials remain unchanged. Existing advanced commands retain their behavior.
Another active workflow is preserved and prevents accidental replacement.

The additive `task.reference` (`snipara.task_reference.v1`) binds the immutable
intake, canonical local repository/worktree, owner file revision and effective
verification contract. `identitySha256` is shared across owners observing the
same intake in the same worktree; `referenceSha256` also includes owner revision
and artifact paths. Neither hash grants authority or identifies a trusted hosted
project. A mismatched legacy task stays readable with a null reference and a
`task.referenceReason`; there is no new task store or migration.

Managed views use `managedProgress` (`snipara.task_progress.v1`) while preserving
the legacy `status`. Saved running markers and recorded closure are historical,
not observed execution or verified completion. A closure remains visible through
`recordedClosure`. Static review, no runtime checks and missing runtime proof have
distinct reasons, without changing proof policy. A Controller dossier can supply
managed proof only when its task reference matches the intake/worktree identity
and effective verification contract; matching a title or objective alone is
insufficient. Standalone consumers can use the exported pure `buildTaskReference`
and `projectManagedProgress` helpers without creating a Controller.

## Select a GitHub issue, or stay local

Local tasks need no GitHub authentication. For a selected issue, existing `gh`
authentication performs two bounded read-only calls: repository access, then
the selected issue. The issue must belong to the current GitHub origin. A pull
request, foreign repository, inaccessible issue or unavailable connection fails
explicitly; no write, login or connector installation is attempted.

```sh
snipara-companion task brief "Handle missing input" --id customer-input \
  --issue 42 --accept "Missing input returns validation error" \
  --file src/customer.ts --check "pnpm test" --output .snipara/input-brief.json
snipara-companion task start --brief .snipara/input-brief.json
snipara-companion task source-refresh .snipara/input-brief.json
```

The goal, criteria, scope and verification come from the operator. Issue text is
untrusted source material, including any instructions embedded in its body.
The immutable brief records its source timestamp/hash and the Git/dirty state.
The staged Git index has its own fingerprint; identical working bytes cannot
hide a changed staged version. Older snapshots without that observation need
revalidation before admission.
Explicit refresh compares a new observation and preserves the historical brief.
Directory and glob scopes are declarations; they are not blindly read as files.
The simplified Companion path supports literal/root/directory scopes and
segment patterns `*`, `?`, `**`. Complex bracket/brace patterns with wildcards
must be clarified into these scopes before work; the card explains the block.

## Evidence and next action

Text and `--json` render the same `snipara.task_journey.v1` model, including
criteria, five textual step statuses, evidence, blockers, capabilities and one
next action with its effects. `task export --format json|markdown --output
.snipara/card.json` saves a bounded immutable local copy in the requested format.
Use a new filename for a later observation. Catalog or binary presence alone
does not prove the capability callable, a review passed or an agent ran.

`supervision` names the next responsible actor (`agent`, `system`, `human`),
the action and its reason. An agent continues framed work, collects missing
checks and investigates declared check failures within the existing retry
ceiling. The user is asked for missing objectives or scope, contract/repository
drift, exhausted limits or authority beyond the agreed frame. Unknown failures
stay blocked until their cause is established. Guidance grants no permissions:
the surrounding coding agent still uses its host's authorization and controls.

Runtime evidence distinguishes preparation, adapter submission, native
acknowledgement and semantic use. Exact bodies are neither truncated nor moved
into the short task-title field. A source snapshot does not establish remote
freshness. A transport acknowledgement does not prove the model used the source
correctly. User comprehension and time savings require separate observation.
The simplified card does not restart a runtime or automatically adopt a new
Git base after integration. Existing Controller landing and health receipts
remain the source for that advanced lifecycle; a changed base requires an
explicit continuation decision rather than silent acceptance of drift.
