# snipara-companion

**Ask your repo what breaks if you touch this.**

No global install. No `init`. No account. Your code stays on your machine.

```bash
npx -y snipara-companion impact src/auth/session.ts --source local
```

Example output excerpt:

```text
Code impact
Source: local_overlay
Reason: source_forced_local

Target
  src/auth/session.ts

Incoming
  apps/web/src/lib/auth/permissions.ts
  apps/web/src/app/api/auth/session/route.ts

Outgoing
  src/auth/cookies.ts
  src/auth/tokens.ts
```

That first command is the product promise: run a local blast-radius check from
your current checkout in seconds, before an agent edits the wrong thing.

## Free Local Surface

These commands are useful without hosted Snipara:

| Command | What it gives you locally |
| --- | --- |
| `impact` / `code impact` | File-level blast-radius from the local code overlay |
| `code callers` / `imports` / `neighbors` / `shortest-path` | Structural repo questions from local files |
| `workflow start` / `phase-start` / `phase-commit` / `resume` | Agent continuity that survives compaction |
| `context-pack` | Reversible local packs for long logs, diffs, and tool output |
| `judgment-card`, `verify`, `references` | Local review artifacts and source-backed references |
| `stuck-guard`, `memory-guard`, `pre-tool`, `post-tool` | Fail-soft local guards and hook helpers |

## Agent Continuity

After the first impact check, keep the work resumable:

```bash
npx -y snipara-companion workflow start --goal "ship auth hardening"
npx -y snipara-companion workflow phase-start audit
npx -y snipara-companion workflow phase-commit audit --summary "mapped auth impact"
npx -y snipara-companion handoff --summary "auth impact mapped" --next "run auth tests"
```

`snipara-companion` writes local state under `.snipara/` so a coding agent can
resume with the current phase, recent handoffs, timeline, context packs, and
verification hints.

## Local First, Hosted When Useful

Local mode is first-class for one repo, one machine, and one session. Hosted
Snipara is the upgrade path for team and cross-project intelligence.

| Need | Local companion | Hosted Snipara |
| --- | --- | --- |
| Inspect this repo before editing | Yes, no account | Optional hosted code graph |
| Keep code private on this machine | Yes | Use only when explicitly configured |
| Preserve agent workflow state | Yes, `.snipara/` files | Syncs across machines and agents |
| Store/retrieve long tool output | Yes, `context-pack` | Metadata and receipts can be shared |
| Semantic project context and embeddings | Local docs/artifacts only | Managed context ranking |
| Reviewed memory and outcome calibration | Local artifacts only | Team memory and proof loop |
| Shared claims, locks, dashboards, GitHub checks | Local hints only | Team coordination and audit |

Use hosted mode when you want shared memory, semantic retrieval, cloud code
graph, cross-machine presence, outcome learning, team coordination, or dashboard
proof. Keep local mode when the question is simply: "what does this repo say
will break if I touch this file?"

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

Release notes live in [CHANGELOG.md](./CHANGELOG.md).
