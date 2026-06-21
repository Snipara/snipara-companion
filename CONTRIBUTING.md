# Contributing

Thanks for helping improve `snipara-companion`.

By participating, you agree to the project
[Code of Conduct](./CODE_OF_CONDUCT.md).

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
- local `impact` output, parser coverage, and first-run docs
- optional calls to Hosted Snipara APIs when project auth is configured

Hosted context ranking, reviewed memory authority, team sync backend behavior,
and cloud code graph behavior are commercial Hosted Snipara surfaces. Issues
and PRs that need those surfaces may be redirected to the hosted product.

## Good First Contributions

Useful focused contributions include:

- reduced repros for wrong or surprising `impact` output
- parser/resolver tests for TypeScript, Python, or Go imports
- README, demo, and launch-kit clarity fixes
- workflow continuity tests for `.snipara/` state

Use the issue templates for impact feedback, docs feedback, and contribution
proposals. Keep reports redacted: no secrets, private keys, customer names, or
private repository output.

## Pull Requests

Keep changes focused and include tests for behavior changes. For public CLI
behavior, update `README.md` and help-output tests when relevant.

Run `pnpm pack:smoke` before opening a release-facing package change.
