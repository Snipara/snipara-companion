# snipara-companion

[![npm version](https://img.shields.io/npm/v/snipara-companion.svg)](https://www.npmjs.com/package/snipara-companion)
[![CI](https://github.com/Snipara/snipara-companion/actions/workflows/ci.yml/badge.svg)](https://github.com/Snipara/snipara-companion/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](./package.json)

**Ask your repo what breaks if you touch this.**

No global install. No account. Your code stays on your machine.

`create-snipara` is the canonical activation engine. Use it first when a repo
needs Hosted MCP config, editor/client files, a First Work Brief, and
review-only memory candidates. Use `snipara-companion` after that first
activation for local continuity: source refresh, impact checks, workflow phase
state, handoffs, and durable task outcomes.

```bash
npx -y create-snipara@latest init --client cursor --starter
npx -y snipara-companion session-bootstrap --include-session-context --max-context-tokens 1000
npx -y snipara-companion impact src/auth/session.ts --source local
npx -y snipara-companion source init .
```

## Companion Continuity Contract V1

Editor integrations and post-activation workflows can ask Companion for one
machine-readable "continue this workspace" payload:

```bash
npx -y snipara-companion@latest continue-workspace --include-session-context --json
```

The payload version is `snipara.companion.continuity.v1`. It is designed for
native editor commands, status bars, panels, and agent handoffs that need to
resume real work without rescanning or reimplementing Snipara semantics. It
includes project binding, session bootstrap entries and quality warnings,
workflow phase state, Team Sync handoff summary, passive source snapshot status,
session snapshot summary, stable local artifact paths, and recommended next
actions.

Session bootstrap treats two explicit profiles as durable operating context:
the project profile is selected first, followed by the authenticated owner
profile. These profiles reserve bounded space ahead of ordinary decisions and
carryover; Companion does not infer a psychological profile from conversation
history.

Use this after `create-snipara` activation. `create-snipara` remains the
canonical engine for first workspace setup; Companion owns the repeatable local
continuity loop after that.

## Retrieval And Outcome Correlation

`snipara-companion init` creates and prints a bounded workspace session ID.
Export it as `SNIPARA_SESSION_ID` before starting Codex, Claude, Cursor, VS Code,
Continue, or another HTTP MCP client. Generated configs forward it as
`X-Snipara-Session-Id`, while canonical execution events use the same Companion
session automatically. Clients without environment-backed headers can pass the
same value as `correlation_context.session_id` on retrieval tools.

The identifier is opaque, project-scoped telemetry. It does not grant access or
change authorization, and explicit per-call correlation remains authoritative.
Companion also forwards its configured `sessionId` automatically on every
Hosted MCP call and labels supported retrieval traffic as
`snipara-companion`, unless the caller supplied an explicit client label. This
improves join coverage without inventing a second server-side identity.

Example output excerpt:

```text
Code impact - local - src/auth/session.ts
Source: local_overlay
Reason: source_forced_local

Incoming (2) - files that depend on this
  apps/web/src/lib/auth/permissions.ts
  apps/web/src/app/api/auth/session/route.ts

Outgoing (2) - files this depends on
  src/auth/cookies.ts
  src/auth/tokens.ts

Use --json for full overlay details.
```

That first command is the product promise: run a local blast-radius check from
your current checkout in seconds, before an agent edits the wrong thing.

## Free Local Surface

These commands are useful without hosted Snipara:

| Command                                                                               | What it gives you locally                                                    |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `source init` / `source sync` / `source status`                                       | Local source snapshot, document preview, and code overlay                    |
| `impact` / `code impact`                                                              | File-level blast-radius from the local code overlay                          |
| `reality-check`                                                                       | Intent Ledger, Unknown Registry, auto-linked context, and inspectable proof  |
| `code callers` / `imports` / `neighbors` / `shortest-path`                            | Structural repo questions from local files                                   |
| `workflow start` / `phase-start` / `phase-commit` / `resume`                          | Agent continuity that survives compaction                                    |
| `workflow timeline` / `workflow session`                                              | Append-only local activity log and Session Snapshot V0                       |
| `workflow decisions` / `workflow decide`                                              | Local human decision requests and response receipts                          |
| `workflow policy-ledger` / `workflow apply-decisions` / `workflow sync-policy-ledger` | Project Policy review ledger, explicit apply pipeline, and hosted audit sync |
| `run --emit-policy-decisions`                                                         | Project Policy review requests in the agent workflow                         |
| `workflow producer-triage`                                                            | Ask for human review of unreviewed Producer Loop samples                     |
| `workflow producer-report`                                                            | Local Producer Loop adoption and calibration report                          |
| `workflow producer-review`                                                            | Mark local Producer Loop samples reviewed or rejected                        |
| `context-control plan` / `apply` / `drift` / `validate` / `hosted-*`                  | Review local state and reconcile Context as Code with hosted project context |
| `context-pack`                                                                        | Reversible local packs for long logs, diffs, and tool output                 |
| `judgment-card`, `verify`, `lead-plan`, `agent-readiness`                             | Local review artifacts and delegation contracts                              |
| `intelligence ledger-export`                                                          | Structured redacted ledger JSON for replay and review                        |
| `stuck-guard`, `memory-guard`, `pre-tool`, `post-tool`                                | Fail-soft local guards and hook helpers                                      |

### Context Control

`context-control` is the local trust layer for Project Intelligence state. It
borrows Terraform's useful product grammar without copying Terraform: preview a
bounded context mutation, inspect drift, then apply only the exact reviewed
plan. V0 remains the local trust-artifact layer. Context Control V1 adds an
authenticated hosted diff/apply path with tenant scoping, compare-and-set hashes,
explicit Decision Request approval, detailed receipts, and add/update-only writes.

```bash
npx -y snipara-companion context-control plan \
  --summary "record reviewed context state" \
  --output .snipara/context-control/plans/demo.json

npx -y snipara-companion context-control apply \
  --plan .snipara/context-control/plans/demo.json \
  --approve

npx -y snipara-companion context-control drift
```

For Context as Code V0, add `snipara.project-context.json` and validate it
locally:

```json
{
  "schemaVersion": "snipara.project_context_manifest.v0",
  "sources": [
    {
      "path": "docs/architecture.md",
      "authority": "canonical",
      "tier": "HOT",
      "required": true,
      "description": "Architecture context that agents should treat as canonical."
    }
  ],
  "policies": [
    {
      "id": "review-context-changes",
      "scope": "memory.canonical",
      "requirement": "Human review required before changing canonical context.",
      "reviewRequired": true
    }
  ]
}
```

To reconcile that manifest with hosted project context, first write a reviewed
plan and Decision Request, resolve the request, then apply the exact plan:

```text
snipara-companion context-control hosted-diff --manifest snipara.project-context.json --output .snipara/context-control/plans/hosted.json --emit-decision-request
snipara-companion workflow decide <request-id> --choose approve_hosted_apply --reviewer <name>
snipara-companion context-control hosted-apply --plan .snipara/context-control/plans/hosted.json --approval .snipara/decisions/resolved/<request-id>.json --output .snipara/context-control/applied/hosted.json
```

V1 never deletes remote documents. It reports hosted paths outside the manifest,
blocks authority promotions on existing managed sources, rejects stale remote
hashes, and requires an EDITOR-authorized API key for mutation. The local
approval artifact records declared human review; the API key remains the actual
hosted mutation authority.

```bash
npx -y snipara-companion context-control validate --manifest snipara.project-context.json
npx -y snipara-companion context-control plan --manifest snipara.project-context.json
```

The manifest is declarative metadata only. Validation and local reconciliation
do not upload documents, approve memory, refresh hosted context, or mutate
hosted Snipara state. `context-control drift` scopes dirty Git signals to the
manifest, manifest sources, local Decision Requests, and `.snipara/context-control/`
artifacts so unrelated checkout noise does not become permanent drift. A future
V1 hosted refresh/apply surface should compare manifest state against hosted
context before allowing real hosted mutations.

### Local Worker Registry

Use `workers local` when you want Companion to route bounded work to a local
OpenAI-compatible runtime such as LM Studio. The registry is project state under
`.snipara/workers/`; commit intentional profile changes like any other
workflow artifact. Keep API keys, tokens, passwords, and private credentialed
URLs out of worker profiles. Use environment variables for credentials.

Probe the local runtime first:

```bash
npx -y snipara-companion workers local probe \
  --base-url http://127.0.0.1:1234 \
  --model openai/gpt-oss-20b \
  --role documentation \
  --capability docs_write \
  --write-scope packages/cli/README.md
```

Declare the worker only after the probe matches the intended model and scope:

```bash
npx -y snipara-companion workers local add \
  --id local-openai-gpt-oss-20b \
  --base-url http://127.0.0.1:1234 \
  --model openai/gpt-oss-20b \
  --role documentation \
  --capability docs_write \
  --write-scope packages/cli/README.md
```

Inspect declared workers before routing:

```bash
npx -y snipara-companion workers local list
npx -y snipara-companion workers local status --json
```

Remove stale local profiles when a model, endpoint, or write scope is no longer
valid:

```bash
npx -y snipara-companion workers local remove local-openai-gpt-oss-20b
```

Reviewed trust is separate from registration. Compute a scoped candidate from
accepted, source-backed real-work receipts, emit a Decision Request, and inspect
the resulting expiring event:

```bash
npx -y snipara-companion workers trust candidate --emit-decision-requests --json
npx -y snipara-companion workers trust review \
  --request-id decision-abc123 \
  --choice approve \
  --reviewer alice \
  --expires-in-days 30
npx -y snipara-companion workers trust status --json
```

Benchmarks, fixtures, model names, and self-attestation never promote a worker.
Even `delegated_earned` is limited to the exact low-risk category, profile hash,
write scope, and expiry. It removes only a repeated approval receipt; explicit
execution, proof, verification, and all sensitive/release gates remain.

## Agent Continuity

After the first impact check, keep the work resumable:

```bash
npx -y snipara-companion workflow start --goal "ship auth hardening"
npx -y snipara-companion workflow phase-start audit
npx -y snipara-companion lead-plan --task "ship auth hardening" --changed-files src/auth/session.ts --proof "pnpm test auth" --acceptance "auth tests pass"
npx -y snipara-companion lead-plan --from-plan ./project-health-lead-plan.json --reconcile --changed-files src/auth/session.ts
npx -y snipara-companion lead-plan --from-plan ./project-health-lead-plan.json --json | jq '.engineeringLeadPlan.executionReceipts'
npx -y snipara-companion workflow phase-commit audit --summary "mapped auth impact"
npx -y snipara-companion workflow producer-triage
npx -y snipara-companion workflow decisions
npx -y snipara-companion workflow policy-ledger
npx -y snipara-companion workflow decide decision-abc123 --choose accept_all --reviewer alice
npx -y snipara-companion workflow apply-decisions --dry-run
npx -y snipara-companion workflow sync-policy-ledger
npx -y snipara-companion workflow timeline
npx -y snipara-companion workflow timeline --export md
npx -y snipara-companion workflow session --json
npx -y snipara-companion workflow producer-report
npx -y snipara-companion workflow producer-review --latest --outcome useful --reviewer alice
npx -y snipara-companion handoff --summary "auth impact mapped" --next "run auth tests"
```

`snipara-companion` writes local state under `.snipara/` so a coding agent can
resume with the current phase, recent handoffs, timeline, context packs, and
verification hints.

`workflow timeline` reads the append-only activity log at
`.snipara/activity/timeline.jsonl`. `workflow session` derives
`.snipara/activity/session.json` for fast local resume and Orchestrator dogfood;
Session Snapshot V0 includes latest activity, risk reasons, touched files, a
next action, and advisory Intent Detection V0. Intent Detection V0 reports the
inferred intent, confidence, reason-code signals, local evidence counts, and a
suggested workflow mode. `workflow run --mode auto` uses that same Control Plane
principle to choose lite, standard, full, or orchestrate. Lite runs with zero
mandatory hosted context calls; recall/context/code-impact are on-demand
escalations, not an entry toll.
`workflow timeline --export md` prints a compact redacted Markdown timeline for
handoff or publication.

Workflow `phase-commit` and `final-commit` also emit Producer Loop artifacts
under `.snipara/producer-loop/`. These are local review evidence backed by the
redacted Coding Intelligence Ledger, not automatic durable memory, worker
execution, calibrated confidence, or server-side attestation. Use
`workflow producer-report` to inspect local adoption, reason-code counts, sample
size, reviewed/rejected/unreviewed counts, invalid artifacts, and calibration
caveats before any future hard gate. The report also joins attributed gated
receipts from `.snipara/orchestrator/executions/` with persisted supervisor
reviews, then emits `workerReceipts` and a per-`workerId`/`workCategory`
`workerTrust` breakdown. That report is observability only. The separate
`workers trust candidate/review/status` flow can write a reviewed event after
the evidence thresholds and human Decision Request pass; it never promotes from
the report alone.

`final-commit` also prints a stable seven-section closeout report:

1. What changed
2. Why
3. Evidence
4. Decisions kept
5. Decisions proposed for review
6. Not persisted
7. Risks and next step

Pass an explicit rationale with `--why`, repeatable verification receipts with
`--evidence <status:text>`, remaining risks with `--risk`, and the recommended
follow-up with `--next-step`. Supported evidence statuses are `passed`,
`failed`, `not-run`, and `unknown`; evidence without a status remains
`unknown`. The same redacted, versioned report is written to
`.snipara/workflow/final-report.json`, and `--json` includes the report plus its
artifact path and SHA-256 hash. Stored phase outcomes appear under decisions
kept, while Why Capture candidates remain explicitly pending review.
The report also recognizes exported PR Answer Pack decision-capture artifacts
with producer kind `pr_answer_pack_decision_capture`, so calibration can track
more than the workflow producer once those artifacts are present locally.
Use `workflow producer-review --artifact <path|file|artifactId>` or
`workflow producer-review --latest` after auditing embedded evidence to move a
sample from `sample_unreviewed` to `sample_reviewed` or `sample_rejected`.
For conversational human review, run `workflow producer-triage` to create a
batched Decision Request artifact, `workflow decisions --json` to give the
LLM client the exact question/evidence/options to ask, and `workflow decide`
only after the human answers. Batched requests include readable evidence items
with artifact summaries, statuses, file hints, and metadata instead of only
opaque refs. Decision requests never resolve by timeout or default, and only
`workflow decide` applies the existing `producer-review` path.
When repeated resolved receipts share the same human choice and rationale,
`workflow decide` may emit a new review-only policy suggestion decision request;
it still uses manual apply instructions and never writes policy automatically.
`workflow policy-ledger` gives the LLM agent a consolidated view of pending,
approved, refused, modified, and deferred Project Policy decision artifacts,
plus the exact pending requests it should ask the human about. It is read-only
and does not apply policy edits.
After the human resolves a request, `workflow apply-decisions --dry-run` previews
local follow-up actions for resolved Project Policy receipts. Running
`workflow apply-decisions` writes only idempotent review artifacts such as local
policy drafts under `.snipara/policies/drafts/`; it does not activate canonical
Project Policy silently.
Run `workflow sync-policy-ledger` after local review to upload Decision Request,
resolution, apply receipt, and policy draft artifacts into the hosted Project
Policy ledger. The sync is audit-only and does not approve, refuse, activate, or
edit canonical Project Policy.
Other producers such as `outcome-capture preview --emit-decisions`,
`memory reviews --emit-decisions`, `workflow decision-producer memory`, and
`workflow decision-producer context-risk` emit requests with their existing apply
paths declared; they do not write canonical memory directly. `memory reviews`
is the hosted-memory review connector: it reads review queue, cleanup, and
duplicate candidate surfaces, summarizes the items for the LLM, and only writes
local Decision Requests when `--emit-decisions` is passed. Its JSON output
includes `emittedCount`, `emittedRequestIds`, and an `emitted` summary so an
agent can continue without re-listing pending requests.

## Local First, Hosted When Useful

Local mode is first-class for one repo, one machine, and one session. Hosted
Snipara is the upgrade path for team and cross-project intelligence.

| Need                                            | Local companion           | Hosted Snipara                      |
| ----------------------------------------------- | ------------------------- | ----------------------------------- |
| Inspect this repo before editing                | Yes, no account           | Optional hosted code graph          |
| Activate docs and code without GitHub           | Yes, `source init`        | Provider sync after approval        |
| Keep code private on this machine               | Yes                       | Use only when explicitly configured |
| Preserve agent workflow state                   | Yes, `.snipara/` files    | Syncs across machines and agents    |
| Store/retrieve long tool output                 | Yes, `context-pack`       | Metadata and receipts can be shared |
| Semantic project context and embeddings         | Local docs/artifacts only | Managed context ranking             |
| Reviewed memory and outcome calibration         | Local artifacts only      | Team memory and proof loop          |
| Shared claims, locks, dashboards, GitHub checks | Local hints only          | Team coordination and audit         |

Use hosted mode when you want shared memory, semantic retrieval, cloud code
graph, cross-machine presence, outcome learning, team coordination, or dashboard
proof. Keep local mode when the question is simply: "what does this repo say
will break if I touch this file?"

For folders without Git metadata or users who have not approved GitHub yet, run:

```bash
npx -y snipara-companion source init .
npx -y snipara-companion source status --json
```

This writes `.snipara/source/latest.json`, builds a local document sync preview,
and refreshes `.snipara/code-overlay/latest.json`. The hosted code graph remains
the canonical shared graph after provider sync.

## Install

Use `npx` for one-off checks:

```bash
npx -y snipara-companion impact src/auth/session.ts --source local
```

Install globally only if you use it every day:

```bash
npm install -g snipara-companion
snipara-companion impact src/auth/session.ts
snipara-companion workflow resume
```

## Command Reference

The previous long README has moved to [docs/FULL_REFERENCE.md](./docs/FULL_REFERENCE.md).
Start there for the full command list, hook setup, hosted MCP bridge commands,
workflow modes, team-sync, local context packs, and release-oriented flows.

Launch assets, demo scripts, and post drafts live in
[docs/launch/LAUNCH_KIT.md](./docs/launch/LAUNCH_KIT.md).

Release notes live in [CHANGELOG.md](./CHANGELOG.md).
When project auth is configured, `workflow phase-commit`, `final-commit`, and
`team-sync handoff` also run reviewed Why Capture. The Companion first sends a
read-only preview and confirms only when the server detects durable rationale.
Confirmed candidates enter the pending review queue; capture failures remain
visible but do not block the primary workflow command. No documentation prompt
is shown. `final-commit` remains handoff-only: the report explains what was
stored or proposed, but it does not approve pending candidates or write final
summary text as durable memory.
