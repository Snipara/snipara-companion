# Changelog

Release notes for `snipara-companion`, newest first.

## New In 3.5.7

- Bounds the best-effort hosted judgment lookup in `run` to 8 seconds instead
  of silently waiting for up to 30 seconds.
- Exposes `hostedJudgment.status` as `linked`, `unlinked`, or `unavailable` in
  JSON and prints one concise human-readable diagnostic without blocking the
  local Judgment Card.
- Compatibility note: hosted context queries now treat an explicit
  `max_tokens` value as immutable. Small conceptual or multi-hop budgets may
  return less context than older servers that silently enlarged the request;
  increase the requested budget when more context is intentional.
- Clarifies that references mode budgets the Answer Pack plus previews. Full
  referenced chunks remain retrievable and their `token_count` is planning
  metadata rather than initial response usage.

## New In 3.5.6

- Adds a managed workflow Judgment V1 loop: `workflow judgment` serves and
  persists a bounded Project Intelligence card, while `workflow
judgment-respond` records one explicit accepted, modified, ignored, or
  blocked response per recommendation.
- Uses the canonical hosted Project Intelligence Brief V2 endpoint to persist
  the served judgment identity; the endpoint now accepts validated,
  project-scoped API keys used by Companion.
- Replays the same hosted Advisor Influence receipt at evidence-bearing phase
  commits and final closeout, so one idempotent receipt advances from
  acknowledgement/application to verified outcome evidence without duplicates.
- Refuses managed final closeout when a served recommendation has no explicit
  response; Companion never manufactures an implicit ignored decision.

## New In 3.5.5

- Gives Memory Guard source-context retrieval its own bounded 30-second window
  while keeping ordinary memory recalls at 15 seconds.
- Skips Answer Pack generation and automatic decomposition for guard context so
  pre-commit and pre-final checks consume raw source sections without needless
  latency.

## New In 3.5.4

- Makes `reality-check` auto-link bounded reviewed Team Sync decisions, keyword
  document context, managed workflow receipts, and current verification
  evidence while preserving explicit CLI inputs and failing open when hosted
  context is unavailable.
- Keeps the evidence used by Reality Check inspectable in JSON and Markdown
  findings instead of using verification only as a hidden severity signal.
- Gives `query` a 30-second default timeout plus explicit search-mode,
  Answer Pack, decomposition, and shared-context controls for fast recovery.

## New In 3.5.3

- Propagates the configured Companion `sessionId` as
  `X-Snipara-Session-Id` on Hosted MCP calls.
- Labels supported retrieval calls as `snipara-companion` while preserving an
  explicit caller-provided client label and correlation context.
- Keeps correlation telemetry-only and project-scoped; authentication and
  ranking promotion remain separate contracts.

## New In 3.5.2

- Replaces the retired Windsurf preset with Kimi Code CLI across setup,
  automation, readiness, handoff, and help surfaces.
- Adds merge-safe `.kimi-code/mcp.json` installation plus a reviewable Kimi
  plugin bundle for Companion lifecycle hooks, skills, and commands.
- Keeps the Kimi adapter fail-open and requires explicit plugin installation;
  risky tool approval and Hosted MCP tenant boundaries remain authoritative.

## New In 3.5.1

- Adds Context Control V1 hosted diff/apply commands for declarative
  `snipara.project-context.json` sources.
- Binds hosted mutations to tenant-scoped server plans, remote compare-and-set
  hashes, explicit resolved Decision Requests, EDITOR API-key access, and
  detailed apply/reindex receipts.
- Keeps reconciliation add/update-only: unmanaged hosted documents are reported
  but never deleted, managed authority promotions are blocked, and stale plans
  fail before writes.
- Makes local V0 `context-control apply` enforce its review flag through an
  explicit `--approve` acknowledgement.

## New In 3.5.0

- Adds an explicit `workflow run --strong-repair` handoff contract for one
  bounded strong-adapter repair after local proof or output failure.
- Keeps Companion recommendation-only: it records final authority, proof,
  scope, and `main_agent` fallback without silently launching workers.

## New In 3.4.1

- Declares provider API keys by environment-variable name and supports
  `authorization` or `x-api-key` headers without persisting secret values.
- Resolves declared Codex and Claude CLI workers to explicit native adapters;
  unsupported generic CLI profiles fail closed.
- Preserves opt-in local routing behavior while forwarding provider auth metadata
  to the orchestrator catalog.

## New In 3.4.0

- Adds repeatable `workers execute --output-fragment` contracts.
- Fails a worker receipt closed when declared output fragments are missing,
  while preserving explicit approval, proof, and Git scope gates.
- Persists missing output fragments in the receipt for review and calibration.

## New In 3.3.0

- Adds reviewed, scoped Worker Trust Promotion commands: `workers trust
candidate`, `workers trust review`, and `workers trust status`. Promotion is
  bound to one worker profile hash, work category, write scope, expiry, and
  human Decision Request.
- Hardens `workers execute` with shell-free repeatable `--command-arg` argv,
  explicit proof requirements, conservative category escalation, provider/model
  telemetry, and exact trust-event consumption for delegated low-risk work.
- Keeps execution fail closed: explicit `--execute`, proof, scope validation,
  current profile identity, and post-run verification remain mandatory; auth,
  billing, schema, release, deploy, destructive, and mismatched scopes cannot
  inherit delegated trust.

## New In 3.2.33

- Turns `final-commit` into a structured closeout report with seven stable
  sections: what changed, why, evidence, retained decisions, decisions proposed
  for review, items not persisted, and risks plus the next step.
- Writes the same versioned, redacted report to
  `.snipara/workflow/final-report.json` and includes its path and SHA-256 hash in
  JSON output for automation and handoff verification.
- Retains phase commit and Why Capture receipts across a managed workflow so the
  report distinguishes durable stored knowledge from pending review candidates,
  duplicates, failures, and handoff-only content.
- Adds `--why`, repeatable `--evidence <status:text>`, repeatable `--risk`, and
  `--next-step` to both final-commit entry points while preserving the existing
  handoff-only memory policy.

## New In 3.2.32

- Promotes a Hosted MCP `servedJudgmentId` into the first-class Project
  Intelligence brief so `run` can persist Advisor Influence receipts without a
  fragile nested lookup or manual flag when the hosted brief already supplies
  the identity.
- Adds an explicit Advisor measurement funnel to JSON and text output:
  identity linked/missing, targeted versus unscoped, acknowledged, applied,
  verified, blocked, unmeasured, and receipt coverage.
- Stores a bounded measurement state with each first-party receipt so a runtime
  acknowledgement is never presented as recommendation-scoped application.
- Emits one stable `project-intelligence.judgment-run-envelope.v1` per `run`
  invocation. It reuses a bounded Snipara or Codex session id when available,
  otherwise generates an opaque run id, and attaches the same envelope to every
  first-party Advisor receipt.

## New In 3.2.31

- Sends phase commits, final commits, and Team Sync handoffs to project-scoped
  Why Capture with the existing goal, summary, files, verification commands,
  session reference, and commit SHA.
- Preserves reviewed-memory governance with an automatic read-only preview
  followed by confirmation only when durable rationale candidates exist; filed
  candidates remain `PENDING` in the review queue.
- Keeps capture best-effort and observable in JSON receipts and the activity
  timeline, so a Why Capture outage never rolls back a completed workflow or
  handoff and never introduces a documentation prompt.

## New In 3.2.30

- Persists an explicit `--ack-review-only` as a 15-minute, one-use
  acknowledgement bound to the exact guard profile, action, and finding
  fingerprint, so the immediately following Git hook can consume it safely.
- Invalidates that acknowledgement when findings change and never applies it
  to required acknowledgements, active conflicts, or hard blocks.
- Resolves collaboration state from `SNIPARA_WORKSPACE_DIR` or the Git
  top-level directory, preventing filtered package commands from writing a
  nested `packages/cli/.snipara/` session.

## New In 3.2.29

- Extends `workflow producer-report` with attributed gated-execution samples
  joined to their persisted supervisor reviews.
- Adds per-`workerId`/`workCategory` `workerTrust` breakdowns with execution,
  review, accepted, blocked, incomplete receipt-family, and workflow fingerprint
  counts.
- Keeps the read model deliberately supervised: every pair remains
  `probation_supervised`, `hardGateReady=false`, and lists the evidence still
  required before the separate Trust Promotion gates can be implemented.

## New In 3.2.28

- Adds bounded Outcome Loop retrieval correlation to generated Codex, Claude,
  Cursor, VS Code/Continue, and generic HTTP MCP references through
  `SNIPARA_SESSION_ID` / `X-Snipara-Session-Id`.
- Prints the active correlation session during `init` and documents the
  explicit `correlation_context.session_id` fallback for MCP clients that
  cannot inject environment-backed headers.
- Keeps the correlation identifier telemetry-only and project-scoped; it does
  not alter authentication or authorization.

## New In 3.2.27

- Scopes `context-control drift` dirty Git detection to the ProjectContext
  manifest, declared manifest sources, local Decision Requests, and
  `.snipara/context-control/` artifacts. Dirty files outside that scope remain
  visible but no longer force permanent `DRIFT_DETECTED` in shared checkouts.
- Clarifies the Context as Code V0 boundary: manifests are local declarative
  metadata and do not refresh hosted context, reconcile manifest-vs-hosted
  state, or mutate hosted memory. Hosted refresh/apply remains V1 work.
- Adds executable documentation smoke tests that run the README and full
  reference `context-control` examples against the built local CLI, closing the
  loop that previously allowed narrative examples to drift from command reality.

## New In 3.2.26

- Fixes the published `context-control plan` examples so they use the real CLI
  contract: `--summary` plus `--output`, without the nonexistent `--operation`
  or `--content` flags or an out-of-scope target.
- Adds a package-doc regression test that executes the documented command shape
  and rejects the unsupported flags if they return to the README or full
  reference.

## New In 3.2.25

- Adds `snipara-companion context-control plan` and `apply` for local,
  Terraform-style previews of Project Intelligence context mutations. Plans are
  content-hashed, pinned to the current Git base by default, and apply only
  bounded writes under `.snipara/context-control/`.
- Adds `snipara-companion context-control drift` as a read-only project drift
  report across Git state, managed workflow state, pending Decision Requests,
  saved context-control plans, and ProjectContext manifests.
- Adds `snipara-companion context-control validate --manifest
snipara.project-context.json` for Context as Code V0. The JSON manifest
  declares project context sources, tiers, authority, tags, owners, and review
  policies without uploading content or mutating hosted state.

## New In 3.2.24

- Adds a validated full `commitSha` to successful commit, amend, revert, and
  cherry-pick `tool_result` events so Outcome Intelligence can mature commit
  evidence without parsing raw command text.
- Keeps the signal fail-closed: non-commit commands, failed or no-op results,
  quiet or masked results without the current SHA prefix, reflog mismatches,
  and invalid object IDs emit no commit SHA.
- Rejects compound or shell-ambiguous commit commands and redacts bounded
  command previews, including named environment tokens and secrets, before an
  automation event leaves the process.

## New In 3.2.23

- Preserves the canonical project profile and the authenticated owner operating
  profile at the front of session bootstrap briefs, even when those durable
  profiles are older than ordinary carryover.
- Keeps profile selection bounded by the requested entry and token budgets,
  then ranks recent carryover and relevant decisions into the remaining space.

## New In 3.2.22

- Clarifies Snipara Sandbox manual install guidance to use
  `python -m pip install "snipara-sandbox[all]"`, where `[all]` is the pip
  extra on the package spec, not a separate argument.

## New In 3.2.19

- Adds `snipara-companion workflow sync-policy-ledger`, which uploads local
  Project Policy Decision Requests, resolution receipts, apply receipts, and
  policy drafts into the hosted Project Policy ledger for audit visibility.
- Keeps hosted sync observational: synced receipts are stored as bounded JSON
  documents and do not approve, refuse, activate, or edit canonical Project
  Policy automatically.

## New In 3.2.17

- Adds `snipara-companion workflow policy-ledger`, a local Project Policy
  decision ledger that summarizes pending, approved, refused, modified, and
  deferred policy artifacts for the LLM agent.
- Includes agent-facing prompts for pending Project Policy decisions while
  keeping approval explicit through `workflow decide`; the ledger never applies
  policy changes automatically.

## New In 3.2.16

- Adds an `operationalLoop` section to `snipara-companion status --json` and
  text status output. It composes local workflow state, Team Sync handoff
  attention, pending Decision Requests, and receipt gaps into concrete next
  actions.
- Keeps the loop advisory and agent-first: it points agents toward
  `workflow decisions`, `workflow decide`, `phase-commit`, and
  `outcome-capture preview --emit-outcome-receipt` without editing Project
  Policy, approving memory, or bypassing verification.

## New In 3.2.15

- Adds `snipara-companion run --emit-policy-decisions` so Project Policy
  `require_review` and `block` verdicts can become local Decision Requests in
  the agent workflow.
- Keeps Project Policy administration review-only: resolving the request records
  the human choice, while policy edits, stale marking, exceptions, or memory
  invalidation still require explicit follow-up action.

## New In 3.2.12

- Adds `snipara-companion workers execute` as the Controlled Worker Execution
  V0 receipt path. It defaults to dry-run, writes
  `snipara.controlled_worker_execution.receipt.v0` JSON, and records bounded
  task, worker, write-scope, acceptance, proof, approval, command, and
  execution evidence.
- Keeps execution fail-closed: `--execute` requires an explicit approval
  receipt, high-risk commands are blocked locally, and successful commands move
  to `verification_required` instead of being treated as reviewed work.
- Documents hosted Outcome Intelligence receipt ingestion as a project API
  surface while keeping aggregation advisory, reviewable, and task-profile
  scoped.

## New In 3.2.11

- Adds Outcome Intelligence V0 receipt emission to
  `outcome-capture preview --emit-outcome-receipt`, producing a typed
  `snipara.outcome_intelligence.receipt.v0` artifact from review, test, deploy,
  guard, and workflow events.
- Adds `snipara-companion run --outcome-receipts <files...>` so production
  judgment runs can ingest local receipt JSON and print reason-code/task-profile
  calibration buckets.
- Keeps Outcome Intelligence advisory and sample-gated: receipts are
  calibration evidence, not causal proof, global agent trust, or a Project
  Policy override.

## New In 3.2.9

- Deduplicates near-identical `session-bootstrap` text brief entries by content
  similarity, so workflow final commits and their checkpoint echoes do not both
  consume pushed-brief slots.
- Reserves brief capacity for relevant decision entries when available, while
  filtering checkpoint-like `DECISION` records that do not match the brief's
  active topic.
- Makes `session-bootstrap --include-session-context` a silent no-op in
  unconfigured projects, preserving the hook contract that an empty brief emits
  no header or decorative output.

## New In 3.2.8

- Ranks `session-bootstrap --include-session-context` text briefs by recent
  carryover, authority, and release/deploy signal before older durable memory,
  so high-signal handoffs surface ahead of stale trivia.
- Enforces the pushed brief budget at selection time, caps the default text
  brief to four entries, and keeps full hosted diagnostics available through
  `--json` instead of truncating noisy output after the fact.
- Filters stale/low-confidence/test bootstrap entries when fresh candidates are
  available, including legacy repo-path and old memory-injection references.

## New In 3.2.7

- Makes `workflow run --mode lite` a true zero-cost local path with no mandatory
  hosted recall, context query, or bootstrap calls.
- Lets `workflow run --mode auto` route small diffs to LITE, rationale/source
  questions to STANDARD, and release/deploy/architecture work to FULL or
  ORCHESTRATED.
- Changes `session-bootstrap` text output into a compact pushed brief that is
  silent when no high-signal memory or carryover item is available.
- Updates Companion and agent-facing docs to treat recall, context query, code
  impact, and end-of-task memory as on-demand escalations instead of entry
  ceremony.

## New In 3.2.5

- Updates `doctor` guidance for the lean hosted MCP agent surface: a compact
  Snipara tool set is expected, `snipara_help(query=...)` is the routed guidance
  path, and `snipara_help(list_all=true)` is for inspecting specialist opt-in
  surfaces.

## New In 3.2.4

- Renders the selected human choice into `manual_apply_required` apply hints
  emitted by `workflow decide`, so memory review decisions no longer leave the
  literal `<human-choice>` placeholder in follow-up commands.
- Documents Worker Registry local commands in the package README, including
  `workers local probe`, `add`, `list`, `status --json`, and `remove`.
- Adds `snipara-companion workers local list`, `workers local remove`, and
  `workers local probe` for persisted worker profiles and easier registry
  maintenance.
- Moves local worker declarations from a single `.snipara/workers/local.json`
  payload to per-worker profile files under `.snipara/workers/<worker-id>.json`
  with a shared `index.json` for the default worker id.
- Documents that tracked worker profiles are durable team-visible project state
  shared by worktrees through Git, and that secrets must be referenced through
  environment variables instead of committed in registry files.
- Adds CLI transport support for explicit OpenAI-compatible declarations as
  well as declared CLI workers.
- Adds automatic migration from legacy `workers/local.json` into per-worker
  profile files and keeps compatibility for existing `workflow run` routing flows.

## New In 3.2.3

- Promotes Intent Detection V0 from a snapshot stub to an advisory session
  intelligence contract with weighted signals, reason codes, evidence counts,
  and suggested workflow mode hints.
- Shows detected intent, confidence, advisory suggested mode, and signals in
  `workflow session`, `workflow resume --include-session-context`, and Project
  Intelligence briefs.
- Keeps all Intent Detection V0 output fail-closed: `hardRoutingAllowed=false`,
  no worker spawning, no merges, no canonical memory writes, and no blocking
  gates from intent alone.

## New In 3.2.2

- Adds Activity Timeline V0 under `.snipara/activity/timeline.jsonl` and a fast
  Session Snapshot V0 at `.snipara/activity/session.json` for local workflow,
  Team Sync, Producer Loop, and Decision Request visibility.
- Adds `workflow timeline` and `workflow session` so agents can inspect the
  append-only local activity log and session snapshot directly.
- Adds `workflow timeline --export md` for redacted publishable timeline
  artifacts, includes local Session Snapshot summaries in `workflow resume` and
  Project Intelligence briefs, and attaches advisory-only Intent Detection V0
  to the snapshot with `hardRoutingAllowed=false`.
- Emits review-only policy suggestion decision requests when repeated resolved
  receipts show the same human choice and rationale; suggestions remain manual
  apply only and are never auto-applied.
- Keeps Session Snapshot routing fail-closed with `hardRoutingAllowed=false`.

## New In 3.2.1

- Hardens Companion and orchestrator handoff interop. `lead-plan --json` now
  writes a default JSON artifact under `.snipara/lead-plans/` and returns the
  next `snipara-orchestrator team-sync gate` command.
- Preserves comma-containing `--acceptance` criteria as one criterion across
  lead-plan, agent-readiness, and adapter handoff flows.
- Makes `workflow decision-producer memory` inherit hosted `memory reviews`
  evidence when available and rejects internal review item types as human
  actions.
- Makes recurring policy suggestions group by producer kind, human choice, and
  target category instead of exact note text, fixes inherited memory decision
  apply hints to use the selected action, and reports emitted request ids from
  `memory reviews --emit-decisions`.
- Improves `doctor` orchestrator diagnostics with path/source/version mismatch
  detail, and gives local worker routing cards an actionable worker declaration
  hint.

## New In 3.2.0

- Adds `memory reviews`, a read-only connector for hosted human-review memory
  surfaces. It reads `snipara_memory_review_queue`,
  `snipara_memory_clean_candidates`, and
  `snipara_memory_duplicate_candidates`, then summarizes reviewable memories
  into agent-ready items.
- Adds `memory reviews --emit-decisions` to write local Decision Request V0
  artifacts with readable memory evidence items. It does not mutate hosted
  memory; requests still require explicit `workflow decide` resolution and use
  the existing hosted/manual apply paths.

## New In 3.1.1

- Improves Decision Request triage UX: batched Producer Loop requests now embed
  readable evidence items with workflow, phase, summary, status, file hints, and
  artifact path metadata, so a human can decide without manually opening every
  opaque artifact id first.
- Ignores local `.snipara/decisions/` receipts in Git by default.

## New In 3.1.0

- Adds Decision Request V0 local review routing under `.snipara/decisions/`.
  `workflow decisions` lists pending questions for an LLM client to ask the
  human, and `workflow decide` records a `decision_response` receipt with the
  explicit reviewer choice.
- Adds `workflow producer-triage` for unreviewed Producer Loop samples. Triage
  emits a batched decision request and never marks samples reviewed by itself;
  `workflow decide --choose accept_all|reject_all` applies the existing
  `producer-review` path and records the applied actions.
- Adds decision-request producers for `outcome-capture preview --emit-decisions`,
  hosted memory review actions, and stale context risks. These requests declare
  the existing apply path and do not gain any new canonical memory write
  capability.

## New In 3.0.14

- Adds `workflow producer-review` to mark local Producer Loop samples as
  reviewed or rejected with reviewer, outcome, and note metadata.
- Updates `workflow producer-report` so calibration status depends on reviewed
  samples, with separate reviewed, rejected, and unreviewed counts plus outcome
  counts. `hardGateReady` remains false in V0.

## New In 3.0.13

- Extends Producer Loop V0 reporting beyond the initial workflow producer:
  `workflow producer-report` now accepts PR Answer Pack decision-capture
  artifacts with producer kind `pr_answer_pack_decision_capture`.
- Keeps multi-producer calibration advisory-only. PR Answer Pack samples remain
  review-pending evidence and do not approve durable memory, launch workers, or
  become server-side compliance attestation.

## New In 3.0.12

- Makes `workflow phase-commit` and `workflow final-commit` emit local Producer
  Loop V0 artifacts under `.snipara/producer-loop/`, backed by the redacted
  Coding Intelligence Ledger builder.
- Adds `workflow producer-report` to summarize local Producer Loop adoption,
  producer kinds, workflow ids, latest artifact, reason-code counts, invalid
  artifacts, sample size, and calibration caveats before any hard gate.
- Keeps the boundary explicit: Producer Loop artifacts are local review
  evidence only. They do not launch workers, approve Project Brain memory, or
  provide server-side compliance attestation.

## New In 3.0.11

- Updates generated agent workflow guidance so FULL-mode audits use
  `snipara_plan`, `snipara_decompose`, and `snipara_multi_query` deliberately
  while simple one-shot lookups stay on targeted context queries.

## New In 3.0.10

- Hardens Intent Ledger extraction in `reality-check` so source-backed intent
  uses structured fields or explicit labeled sections before falling back to
  legacy prose.
- Stops inferring anti-goals and rejected alternatives from generic free-text
  words; those fields now require `Anti-goals:` / `Rejected alternatives:` or
  structured contract input.
- Makes the Intent Ledger freshness horizon configurable through contract
  policy instead of relying on an implementation-local constant.

## New In 3.0.9

- Fixes Unknown Registry IDs in `reality-check` so unknowns use the stable
  `unknown:` prefix instead of accidentally keeping a `reality:` finding prefix.
- Splits the shared Project Intelligence contracts into dedicated Reality
  Check, Intent Ledger, Unknown Registry, engineering lead, and shared-helper
  modules while preserving the public barrel exports used by Companion and PR
  Answer Packs.
- Hardens Intent Ledger extraction internals with named status/phrase extractor
  rules and a contract-level freshness horizon constant.

## New In 3.0.8

- Adds Intent Ledger V1 to `reality-check` output so local CLI and PR Answer
  Packs can show source-backed repository intent coverage, confidence, and
  stale or review-pending assumptions.
- Adds Unknown Registry V1 to surface missing intent, missing verification,
  stale intent, architecture drift, dirty local evidence, and heuristic
  calibration gaps as explicit project unknowns.
- Hardens PR Answer Pack release readiness with named scoring weights,
  structured blocking detection, and bounded related-document content filters.
- Clarifies that `reality-check --enforce` is a strict opt-in gate for
  calibrated hooks because V1 heuristics remain advisory-grade.

## New In 3.0.7

- Adds `snipara-companion reality-check` plus the
  `snipara-companion intelligence reality-check` alias for local
  contradiction-to-reality checks over Git-derived or supplied changed files.
- Adds `--enforce` so local hooks or CI adapters can fail on
  review-required/blocking Project Reality Check findings.

## New In 3.0.6

- Adds `snipara-companion intelligence ledger-export`, a local structured
  Coding Intelligence Ledger JSON export with schema versioning, bounded
  sections, confidence/calibration metadata, and redaction for secret-like
  content plus local repo paths.
- Documents the ledger export in the full Companion reference so packaged docs
  and the installed CLI stay aligned.

## New In 3.0.5

- Normalizes workflow closure with Team Sync: completed workflows now close
  active Team Sync work when the workflow goal is slug-like but the files and
  meaningful tokens still match the active work item.

## New In 3.0.4

- Adds compact memory audit summaries with auto-compact status, candidate
  counts, and follow-up commands for safe cleanup.
- Adds Team Sync hygiene actions to stale-work summaries so dry-run archive,
  completion, and handoff paths are visible without deleting data.
- Fixes Python toolchain inference in `verify` and detects
  `snipara-orchestrator` installed inside common project virtualenvs.

## New In 3.0.3

- Adds `snipara-companion workers local add|status` so a project can declare a
  local OpenAI-compatible worker such as LM Studio once and reuse it from
  workflow runs.
- Lets `workflow run --routing-local-worker <id>` load the declared worker,
  prefer local endpoints, pin the local model, and hand the resolved runtime
  metadata to `snipara-orchestrator`.
- Makes project-policy rejection explicit when local worker routing is
  requested but the effective Adaptive Work Routing policy does not allow local
  endpoints.
- Clarifies Team Sync stale-work and `team-sync sweep --dry-run` output so
  candidates, actual archive count, and remaining stale work are visible before
  cleanup.

## New In 3.0.2

- Adds adapter-neutral `proofVerification` status to Engineering Lead execution
  receipts so provided proof evidence is not treated as verified until a source
  validation is recorded.
- Fails imported closed receipts back to verification-required when proof is
  present but unverified.
- Limits ADE Adapter Pack V1 generation to first-party Codex and Claude Code
  packs while Cursor, Orca, Windsurf, and custom packs remain planned.

## New In 3.0.1

- Hardens local source activation validation so invalid numeric options fail
  visibly instead of silently falling back to defaults.
- Keeps local source snapshots deterministic and structurally validated before
  refreshes are used for code overlays.
- Removes the placeholder `DEC-002` memory decision from orchestrator handoffs
  and emits only workflow/context-derived decision IDs.

## New In 3.0.0

- Adds `snipara-companion source init|snapshot|status|sync|watch`, the local
  source activation path for folders with or without Git metadata.
- Builds deterministic `.snipara/source/latest.json` snapshots, supported
  document sync dry-runs, and refreshed local code overlays before any hosted
  provider approval.
- Makes non-Git folders first-class for local code overlays, including
  filesystem scanning, local-only overlay warnings, and stable dirty tree hashes.
- Repositions local source activation as the default free/no-provider first
  value path, while keeping hosted provider sync as the canonical shared CODE
  graph path.

## New In 2.3.1

- Hardens local Adaptive Work Routing handoffs so Companion preserves
  `workerProfiles` and resolver `scoreBreakdown` metadata from local
  orchestrator catalogs.
- Infers preferred local worker strengths and structured-output requirements
  from the workflow task before routing.
- Asks the local orchestrator to compare all discovered local models when local
  worker routing is requested and no explicit model is pinned.

## New In 2.3.0

- Adds Engineering Lead Execution Receipts V1 to `lead-plan` output. Local and
  imported plans now carry expected handoff, claim, approval, proof, outcome,
  and Project Brain update receipt gates while keeping `workersSpawned: 0`.
- Normalizes imported `executionReceipts` from Project Health or Companion
  exports. Unknown future receipt statuses or stages fail closed and emit
  `companion_dropped_unknown_execution_receipt_*` reason codes.
- Adds receipt-aware reconciliation and Markdown output so missing receipt
  requirements are visible before any worker handoff.

## New In 2.2.0

- Extends `snipara-companion lead-plan` to Engineering Lead Contract V1 with
  `contractVersion`, supervised `workPackages`, and a `supervision` summary for
  review/replan status, receipt requirements, and replan triggers.
- Adds `--from-plan <file>` and `--reconcile` so Companion can compare an
  imported Project Health or Companion lead plan against current local workflow,
  Team Sync, proof, acceptance, and file-scope signals. Stale scope and missing
  continuity fail closed into visible `companion_reconcile_*` reason codes.
- Keeps imported enum drift observable for the new work-package and supervision
  fields through `companion_dropped_unknown_*` reason codes.

## New In 2.1.1

- Makes `lead-plan --from-cockpit` enum drift observable: unknown future
  cockpit posture, status, worker role, worker status, or routing mode values
  still fail closed, but now emit `companion_dropped_unknown_*` reason codes in
  the imported summary and affected worker recommendation.

## New In 2.1.0

- Adds `snipara-companion lead-plan`, a local Companion Engineering Lead Plan
  artifact that turns workflow state, Team Sync, file scope, context refs, proof
  gates, and acceptance criteria into fail-closed worker recommendations.
- Supports `--from-cockpit <file>` so a Project Health cockpit JSON export can
  be normalized into the same CLI Markdown/JSON lead-plan report.
- Keeps the boundary explicit: `lead-plan` recommends contracts and handoffs,
  records `workersSpawned: 0`, uses `main_agent` fallback, and does not launch
  autonomous workers.

## New In 2.0.10

- Adds `snipara-companion agent-readiness audit`, a local readiness report that
  scores bounded agent delegation across scope, context, workflow continuity,
  Team Sync, proof gates, verification path, and target posture.
- Adds optional ADE Adapter Pack V1 output to `snipara-companion handoff` through
  `--adapter-pack --target <codex|claude-code|cursor|orca|windsurf|custom>`,
  including context refs, proof gates, acceptance criteria, conflict posture,
  receipt expectations, and a portable prompt for the receiving agent.
- Documents the Agent Readiness Audit and ADE Adapter Pack as service/product
  surfaces without claiming native IDE control or automatic worker execution.

## New In 2.0.9

- Aligns public package metadata with the local-first `impact` first-run
  positioning.
- Adds README badges and community support/security/PR surfaces for the public
  repository.
- Keeps GitHub issue-template labels aligned with the repo labels used for
  launch feedback.

## New In 2.0.8

- Keeps secret-like source files visible to local `impact` by redacting matching
  lines before graph extraction instead of excluding the whole file.
- Improves missing-target warnings so `--max-files` is suggested only when the
  local overlay actually hit the file cap.
- Adds launch assets, demo scripts, post drafts, and issue templates for
  impact feedback, docs feedback, and contribution proposals.

## New In 2.0.7

- Adds Project Policy / Decision Consistency V0 contracts to Project
  Intelligence, including deterministic `allow`, `warn`, `require_review`, and
  `block` verdicts with receipts.
- Surfaces conservative Project Policy decisions in `snipara-companion
intelligence brief` when approved resume-context decisions match the task or
  changed files, and folds those receipts into `snipara-companion run` policy
  gates.
- Reframes the package README around the account-free local `impact` first run,
  with the full reference moved to `docs/FULL_REFERENCE.md`.
- Makes `impact` available as a top-level command and keeps code graph `auto`
  source local by default, so no account or network call is required unless
  `--source hosted` is explicitly requested.
- Renders local `impact` output as a human-readable Incoming/Outgoing
  blast-radius by default, while preserving `--json` for the full overlay
  payload.

## New In 2.0.6

- Hardens `snipara-companion run` first-party Advisor Influence receipt capture
  with stable skip reasons, total/eligible/recorded/skipped counts, bounded
  write limits, per-recommendation skipped writes, and receipt automation
  metadata.
- Backfills observed run verification evidence into advisor receipts through
  `verificationExecuted` and bounded metadata for collaboration guard,
  package-surface review, and policy-gate results. This records verification
  evidence without claiming outcome proof.
- Keeps receipt writes tied to visible plan adaptation: recommendations that do
  not change the agent plan are explicitly skipped instead of silently recorded.

## New In 2.0.4

- Adds Project Intelligence policy gates to `snipara-companion run --release`,
  including advisory, required-action, and block decisions for release, schema,
  auth, billing, deploy, and package surfaces.
- Shows guard and Judgment Card policy blocks as explicit release blockers so
  agents cannot silently continue when strong project evidence requires a stop.

## New In 2.0.3

- Adds first-party Advisor Influence receipt capture to
  `snipara-companion run` with `--served-judgment-id`, so Project Advisor
  recommendations can record visible plan adaptation through the hosted
  Project Intelligence receipt API.
- Adds `--skip-advisor-receipts` for runs that need to keep the receipt write
  path disabled while still producing the Project Intelligence judgment output.

## New In 2.0.2

- Passes Adaptive Work Routing daily and monthly project budgets into hosted
  model requirements so the gateway can enforce budget caps against receipt
  history.
- Records Local Context Pack token economy fields on metadata-only receipts:
  baseline, packed, retrieved, and saved tokens. Retrieve receipts count the
  retrieved local payload against savings so they do not overstate reduction.

## New In 2.0.1

- Adds `snipara-companion context-pack pack|retrieve|stats|clean` as a
  no-account local Context Pack. It stores reversible tool outputs, logs, diffs,
  and notes under `.snipara/context-pack` with content-hash IDs and no raw
  hosted upload, local `.gitignore` protection, restrictive file permissions,
  and default blocking for secret-like input unless `--allow-sensitive` is set.
- Adds metadata-only Local Context Pack receipts to canonical event payloads,
  `post-tool --pack-result`, and `workflow runtime-checkpoint --context-pack` so
  workflows can reference exact local artifacts without uploading their content.

## New In 2.0.0

- Adds project-level Adaptive Work Routing policy consumption to `workflow run`.
  Companion now reads Project > Automation settings, applies endpoint and worker
  class bounds, and only calls the hosted catalog when the project policy allows
  catalog mode.
- Makes hosted Adaptive Work Routing catalog success explicit: missing
  `success: true` is treated as fail-closed and falls back to the main agent
  instead of optimistic success.
- Carries `catalogLimit` in provider-neutral model requirements so future
  selection policy can tune catalog breadth without hardcoding the gateway call.
- Supports open-package local-only routing through
  `.snipara/adaptive-routing.json`, so recommendation cards and handoff metadata
  can be generated without Snipara SaaS, hosted context, or hosted catalog
  calls.
- Documents the major routing milestone: strong planner reasoning can stay with
  the main agent while scoped execution is routed to cloud, local, or
  self-hosted workers through project policy and sanitized catalogs.

## New In 1.4.20

- Treats `workflow run --mode full --max-tokens` as a workflow budget split
  across durable bootstrap, optional session context, context query, shared
  context, and hosted planning.
- Adds `session_bootstrap_quality` and `plan_quality.warnings` diagnostics so
  agents can catch stale/test memories and weak generated-plan file hints before
  editing.
- Makes `workflow resume` short-lived session context truly opt-in with
  `--include-session-context` or explicit `--max-context-tokens`.
- Adds `doctor` companion version-skew reporting for stale global installs
  versus the workspace package or npm latest.

## New In 1.4.18

- Removes autonomous htask bootstrap/claim ergonomics from `snipara-companion`;
  those workflow commands now belong to `snipara-orchestrator`.
- Keeps the companion `htask` and `swarm` commands as explicit legacy hosted
  passthroughs that require stable IDs.

## New In 1.4.16

- Clarifies that hosted htask and swarm coordination belong to the
  `snipara-orchestrator` workflow surface.
- Keeps direct `snipara-companion htask` and `snipara-companion swarm` commands
  framed as legacy passthroughs instead of the primary task-routing path.

## New In 1.4.15

- Refines `snipara-companion run --release` Judgment Card behavior so completed
  package reviews no longer remain required actions, and explicitly skipped
  package reviews are shown as advisories instead of required work.
- Stops suggesting the npm package review command when the review already passed
  or was intentionally skipped.

## New In 1.4.14

- Adds a production Project Intelligence Judgment Card to `intelligence brief`
  and `verify`, with weighted readiness, evidence, and required-action output.
- Adds `snipara-companion run` as the agent-facing production entrypoint that
  composes resume context, memory health, code impact, release guard findings,
  package review, verification hints, and the final Judgment Card.
- Adds actionable collaboration guard cards so review-only findings, blocking
  conflicts, tests, handoffs, and package-surface checks are classified directly
  in guard JSON and human output.

## New In 1.4.13

- Adds `snipara-companion memory invalidate <memory-id>` and
  `snipara-companion memory supersede <old-memory-id> <new-memory-id>` so agents
  can apply Memory V2 lifecycle corrections through companion when a recalled
  memory is obsolete or replaced.
- Keeps lifecycle mutation outside read-only hygiene commands: `memory compact`
  remains dry-run only, while invalidate/supersede require explicit memory IDs.

## New In 1.4.5

- `workflow phase-commit` and `workflow final-commit` now complete matching
  local Team Sync work items when the workflow outcome is completed.
- Matching stays conservative: workflow-goal text wins, and file/token fallback
  is only used when no workflow goal is available, so deploy or promotion
  threads are not closed from implementation evidence alone.
- Text output now reports completed Team Sync work when workflow commits clean up
  local active items.

## New In 1.4.4

- Adds `snipara-companion memory local -- <args...>` as a thin bridge to the
  open `snipara-memory` engine for no-account local memory workflows.
- Adds `snipara-companion eval export` to write a `snipara-evals` case from
  local workflow, Team Sync, file, command, and expected-signal inputs.
- Adds `snipara-companion eval run` to execute `snipara-evals` through `npx` or a
  configured local runner.
- Clarifies the open Mini Snipara stack boundary: local continuity and evals are
  open, while team-wide presence, shared locks, GitHub checks, dashboards, and
  Cloud code graph remain hosted Snipara capabilities.

## New In 1.4.8

- Adds `snipara-companion collaboration guard --ack-review-only` so enforced
  release guards can acknowledge review-only stale-state and
  decision-consistency warnings without requiring
  `SNIPARA_COLLABORATION_GUARD=0`. The hosted `REVIEW_REQUIRED` verdict stays
  visible in the guard payload; `BLOCKED`, `REQUIRES_ACK`, active-session
  conflicts and blocking leases still fail.
- Updates the Infomaniak deploy guard to use the review-only ack path for
  release UX false positives while keeping the emergency env bypass reserved for
  true guard outages.

## New In 1.4.2

- Adds `snipara-companion collaboration start|watch|claim|guard|release|status`
  for safe parallel coding presence, auto-claims, advisory/exclusive resource
  claims, hosted guard checks, and conflict alarms across humans and agents.
- Adds `snipara-companion collaboration hooks install` plus guard profiles for
  blocking pre-commit, pre-push, pre-deploy, schema/migration, and package
  release checks.
- Adds `snipara-companion collaboration ide-status` for editor extensions and
  local companion UIs that need compact live collaboration state.
- Hardens local code impact so stale or incomplete local overlay caches report
  missing target files instead of silently returning an empty impact set.
- Adds `snipara-companion workflow impact-gate` for committed local workflow
  phases that are ahead of upstream but not pushed yet. It compares
  `upstream..HEAD`, separates dirty working-tree files, runs local code-overlay
  impact on the committed code files, and maps the result back to completed
  workflow phases.

## New In 1.4.1

- Makes local code overlay Git hooks background by default so `git commit` and
  `git push` return quickly while Snipara refreshes local overlay state and
  push-time promotion asynchronously.
- Adds `snipara-companion code hooks install --synchronous` for teams that
  intentionally want foreground hook work, plus a configurable background
  reindex delay for pre-push promotion.

## New In 1.3.7

- Hardens `memory-guard check` with `--confirmed-by-user "<confirmation>"`
  for explicit, auditable overrides after the user has reviewed destructive or
  contradictory signals.
- Adds stable guard exit codes in strict mode: `20` for confirmation required,
  `21` for unavailable memory/context guidance, and `22` for invalid guard
  options.
- Validates destructive checks before hosted calls so vague commands such as
  `--destructive` without `--intent` or `--command` fail fast.
- Extends `snipara-companion init --with-hooks` so it also installs local code
  overlay Git hooks (`post-commit` sync and `pre-push` promotion/reindex).

## New In 1.3.6

- Adds `snipara-companion memory audit` for a read-only memory hygiene pass that
  combines hosted memory health, cleanup candidates, and compaction dry-run.
- Adds `memory health`, `memory clean-candidates`, and `memory compact` as
  direct companion maintenance commands. `memory compact` always sends
  `dry_run=true` and does not mutate memory.
- Extends `memory-guard check` with `--intent`, `--destructive`, and
  `--require-confirmation` so agents can surface memory/context contradictions
  and ask the user before irreversible actions.

## New In 1.3.0

- Adds top-level Git-style agent work commands: `status`, `brief`, `timeline`,
  `verify`, `handoff`, and `workflow resume`.
- Adds `snipara-companion verify` for transparent verification plans based on
  companion code impact auto-source selection plus local package scripts.
- Reframes companion as the day-two continuity surface after
  `npx create-snipara` installs the project.

## New In 1.2.0

- Adds `snipara-companion intelligence brief` for a local Project Intelligence brief that composes hosted resume context, memory health, and code impact into one agent-ready output.
- Adds `workflow scaffold --preset project-intelligence-continuity-layer` for the full memory + code graph + workflow continuity roadmap.
- Updates generated agent workflow instructions so new work can call the Project Intelligence brief before risky changes and scaffold the roadmap preset for multi-phase delivery.

## New In 1.1.15

- Expands `init --client` to Claude Code, Cursor, Windsurf, Codex, Gemini, Mistral, ChatGPT, VS Code, Continue, and custom MCP clients.
- Keeps Claude Code, Cursor, and Windsurf as hook-capable presets while treating Mistral, ChatGPT, VS Code, Continue, and custom clients as MCP-first setup presets.
- Prints Codex TOML or HTTP MCP references for MCP-first clients instead of generating unsupported legacy hooks.

## New In 1.1.14

- Adds `npx -y snipara-companion@latest automations install/status/diff/update` for installing dashboard-generated automation hook bundles locally.
- `init --with-hooks` now delegates hook installation to the hosted automation config bundle so Claude Code, Cursor, and Windsurf use the same templates as Project Automation.
- Managed automation files are tracked in `.snipara/automations/manifest.json` and are not overwritten after local edits unless `--force` is used.
- Automation REST calls now use `www.snipara.com` while MCP calls stay on `api.snipara.com`, avoiding FastAPI IP rate limits on Stuck Guard and generated hook installs.

## New In 1.1.13

- Adds `snipara-companion stuck-guard status/check/simulate` for hosted Memory Guard / Stuck Guard decisions.
- `pre-tool` now emits canonical `tool_call` events and prints Rescue Packs when hosted Stuck Guard returns `inject` or `enforce`.
- `post-tool` now emits canonical `tool_result` events with status, exit code, command, classification, and a redacted/truncated preview.

## New In 1.1.12

- Documents the GitHub PR Answer Packs boundary: use `create-snipara --github`
  for the hosted GitHub App setup, and use `snipara-companion` only for local
  planning, code impact checks, workflow state, and memory commits.

## New In 1.1.10

- Snipara Sandbox guidance now points existing projects to `npx create-snipara repair --with-runtime`
- Managed workflow phases marked `needs_runtime` suggest Snipara Sandbox installation only when needed

## New In 1.1.4

- `snipara-companion onboard-folder` previews and applies dashboardless business-folder imports from local or LLM-materialized sources
- `snipara-companion workflow start/status/resume/phase-start/phase-commit` keeps a visible LLM plan in `.snipara/workflow/current.json` and persists each phase through hosted memory so compacted agents can resume safely
- `snipara-companion final-commit` persists the final workflow outcome with `snipara_end_of_task_commit`
- `snipara-companion code symbol-card` and `snipara-companion code impact` expose paid Context safeguards directly from the companion CLI

## New In 1.1.2

- `snipara-companion doctor` and Snipara Sandbox hints detect provider keys from local `.env` files without printing secret values

## New In 1.1.1

- `snipara-companion doctor` diagnoses Snipara auth, Snipara Sandbox, Snipara Sandbox MCP, provider keys, and Docker
- `workflow run` prints contextual Snipara Sandbox hints for full/orchestrated/execution-heavy work
- `workflow run --no-runtime-hint` hides Snipara Sandbox guidance for scripted terminal output

## New In 1.1.0

- `business-collections` commands for Team Business Context presets and reusable business docs
- `client-projects` commands for creating and listing project-scoped client context workspaces
- `upload --metadata/--metadata-file` plus convenience metadata flags for single-file business/client uploads

## New In 1.0.0

- direct `snipara-companion code` access for `callers`, `imports`, `neighbors`, and `shortest-path`
- `workflow run --mode lite|standard|full|orchestrate` for hosted-first workflow routing; `auto` remains a STANDARD compatibility alias
- `snipara-companion shared-context` for project-linked standards and team guidance
- automatic fallback to project token auth when a stale `SNIPARA_API_KEY` overrides a valid local login
