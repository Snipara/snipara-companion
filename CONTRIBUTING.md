# Contributing

Thanks for helping improve `snipara-companion`.

## Local Setup

```bash
pnpm install
pnpm build
pnpm type-check
pnpm lint
pnpm test
pnpm pack:smoke
```

## Scope

This repository owns the local workflow CLI:

- local `.snipara/` workflow state
- status, timeline, handoff, resume, and phase commits
- local hook and client setup helpers
- optional calls to Hosted Snipara APIs when project auth is configured

Hosted context ranking, reviewed memory authority, team sync backend behavior,
and code graph impact are commercial Hosted Snipara surfaces. Issues and PRs
that need those surfaces may be redirected to the hosted product.

## Pull Requests

Keep changes focused and include tests for behavior changes. For public CLI
behavior, update `README.md` and help-output tests when relevant.
