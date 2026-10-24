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

## Orchestrator alone

Use `snipara-orchestrator task intake --goal ... --criterion ... --file ...
--verification ...`, then `task start --brief .snipara/task-intake.json`.
`task show --format markdown` and `task resume --format markdown` display its
five-step card over the existing Controller state. These commands do not call
Companion, dispatch an agent, execute proofs or restart a stopped Controller.
The next action points to the existing explicit Controller procedures.

An existing execution authorization can be selected explicitly at task start
with `--policy-file /absolute/path/policy.json`. Without it, the task stays in
observation mode. The policy uses the existing Controller schema, including
autonomy level, task risk, required proofs and finite budget; the brief or this
guide supplies no authorization. Prepare the policy before capturing intake so
the repository snapshot remains stable.

```sh
snipara-orchestrator task advance --id customer-input
snipara-orchestrator task advance --id customer-input --execute --catalog-file workers.json
```

The first command only previews. The second reconciles the active plan through
the existing executor. It may observe a run, start admissible work, or retry a
failed proof within the stored limits. It never raises autonomy, resets budget,
resumes stopped work, integrates, publishes or deploys. Worker selection and
review-repair successor plans retain their existing Controller procedures.

## Both tools, when useful

The existing reviewed bridge remains the authority boundary. For tasks with
loaded context, export exact bodies with an explicit mapping rather than
replacing source references with claims of delivery:

```json
[{"workPackageId":"customer:code","phaseId":"code","taskId":"code"}]
```

```sh
snipara-companion workflow export-context --mapping-file mapping.json \
  --output .snipara/runtime-context.json --json
snipara-companion controller-bridge export --lead-plan-file lead.json \
  --policy-file policy.json --reviewer-id reviewer --out-dir .snipara/bridge \
  --task-context-file .snipara/runtime-context.json --json
```

The bridge binds the mapping file, exact UTF-8 context bytes, source receipts,
policy and Git base. Orchestrator reconstructs the contract before admission.
The original workflow/task identity is preserved; the explicit consumer mapping
is separate. A changed body, source, scope, policy or candidate requires fresh
validation. Legacy reference-only exports remain readable without new fields.

To inspect an existing candidate decision, use `task decide <id>
--refresh-dossier --controller-id <id> --candidate-id <id>
--orchestrator-bin /absolute/path/snipara-orchestrator`. This is a read-only,
explicit call. The goal and criteria must bind the selected task. Eligibility
does not authorize integration, publication or deployment.

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
