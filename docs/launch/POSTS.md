# Post Drafts

Keep the message problem-first. Edit names, links, and examples before posting.

## Short Social

I built `snipara-companion` for the moment before an AI coding agent edits a
file:

```bash
npx -y snipara-companion impact src/auth/session.ts --source local
```

No install, no init, no account. It asks your current checkout what depends on
that file and what it imports. Local mode stays on your machine.

GitHub: https://github.com/Snipara/snipara-companion

## Hacker News

Title:

```text
Show HN: Ask your repo what breaks if you touch a file
```

Body:

```text
I built snipara-companion, a small local CLI for AI coding sessions.

The first command is:

  npx -y snipara-companion impact src/auth/session.ts --source local

It builds a local code overlay from the current checkout and prints bounded
transitive impact chains and explainable risk. TypeScript gets compiler-AST
calls/references/imports; Python and Go use import fallback. No account, init,
or hosted graph is required for that path.

The second use case is agent continuity: phase state, handoffs, context packs,
and verification breadcrumbs are written under .snipara/ so a later agent can
resume without relying on chat history.

It is not a perfect runtime call-site analyzer: dynamic dispatch and reflection
remain outside deterministic local analysis. Hosted Snipara is optional for
team memory, semantic retrieval, and cross-project context.

GitHub: https://github.com/Snipara/snipara-companion
npm: https://www.npmjs.com/package/snipara-companion
```

## Reddit

Suggested communities: `r/opensource`, `r/programming`, or a tool-specific
community where self-promotion is allowed.

```text
I built a local CLI for the first minute of an AI coding session:

  npx -y snipara-companion impact src/auth/session.ts --source local

It prints bounded transitive paths and risk from a local overlay. TypeScript
uses compiler-AST call/reference/import edges; Python and Go use import
fallback. No account or hosted graph is required for that path.

The other half is agent continuity: local .snipara/ workflow state, handoffs,
context packs, and verification notes so work can survive compaction or handoff.

I would especially like feedback on false positives/negatives in `impact`
output across real repos.

GitHub: https://github.com/Snipara/snipara-companion
```

## Product Hunt

Tagline:

```text
Ask your repo what breaks before an AI agent edits it.
```

Description:

```text
snipara-companion is a local-first CLI for AI coding sessions. Run one npx
command to see bounded transitive impact from your current checkout, then keep longer
agent work resumable with local workflow state, handoffs, and context packs.
No account is needed for the local path.
```

## LinkedIn

```text
The riskiest part of many AI coding sessions is the first minute: the agent
starts editing before it understands local blast radius.

We made the first command in snipara-companion:

  npx -y snipara-companion impact src/auth/session.ts --source local

It builds a local compiler-AST/import overlay from the current checkout and shows:

- Incoming files that depend on the target
- Outgoing files the target depends on
- No account or hosted graph required for the local path

The second piece is continuity: .snipara/ phase state, handoffs, context packs,
and verification breadcrumbs so agent work can survive compaction and handoff.

GitHub: https://github.com/Snipara/snipara-companion
```

## Maintainer Reply Snippets

When someone asks whether it uploads code:

```text
The `--source local` path does not upload code. It builds a local overlay from
the current checkout. Hosted Snipara is opt-in for team and cross-project
features.
```

When someone expects call-site precision:

```text
The local overlay uses compiler-AST calls/references/imports for TypeScript and
import fallback for Python and Go. It cannot prove runtime reflection or every
dynamic dispatch target. Please open an issue if a path is wrong or misleading.
```

When someone gets empty impact output:

```text
Please open an "Impact output is wrong or surprising" issue with the command,
package version, language, and redacted output. The most useful repro is a tiny
public repo or file pair that shows the missing edge.
```
