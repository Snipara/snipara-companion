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

Keep changes easy to review: fewer than 200 changed lines is the target;
200–400 lines needs an explicit review of the scope, and more than 400 lines
should be split or justified. Run `snipara-companion workflow impact-gate`
before pushing committed workflow phases to see this budget alongside the
local impact report. The gate also reports touched TypeScript and JavaScript
functions: complexity above 10, nesting above 4, or more than 60 lines asks
for review; complexity above 15, nesting above 6, or more than 100 lines
recommends splitting the function. These checks are advisory and only inspect
functions overlapping changed diff hunks.

Run `pnpm pack:smoke` before opening a release-facing package change.
