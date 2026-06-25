# snipara-companion Launch Kit

Use this when announcing `snipara-companion` or preparing a demo.

## Positioning

One-liner:

> Ask your repo what breaks if you touch a file.

Problem:

AI coding agents often edit before they understand local blast radius, and long
agent work loses continuity across compaction, handoffs, and cold starts.

First-run command:

```bash
npx -y snipara-companion impact src/auth/session.ts --source local
```

Expected shape:

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

## What To Say

- No global install, no init, no account for the local first run.
- `impact` builds a local file-level code overlay from the current checkout.
- Local mode is first-class for one repo, one machine, and one session.
- Hosted Snipara is optional for team memory, semantic retrieval, cross-machine
  presence, and outcome learning.
- Agent continuity is the second hook: `.snipara/` keeps phase state, handoffs,
  context packs, and verification breadcrumbs durable.

## What Not To Say

- Do not claim perfect AST call-site analysis. Local impact is file-level import
  impact.
- Do not imply hosted Snipara is required for the first run.
- Do not say code is uploaded by default. `--source local` stays local.
- Do not present local mode as degraded. It is complete for local repo impact
  and workflow continuity.

## Launch Checklist

- Verify the published package:

  ```bash
  npm view snipara-companion version bin dist-tags --json
  npx -y snipara-companion@latest --version
  npx -y snipara-companion@latest impact src/index.ts --source local
  ```

- Record a 15 to 30 second terminal demo using
  [DEMO_SCRIPT.md](./DEMO_SCRIPT.md).
- Publish the GitHub README link and npm link together.
- Post one problem-first version from [POSTS.md](./POSTS.md), not every channel
  at once.
- Watch GitHub issues for the first 48 hours and label:
  `impact-feedback`, `docs-feedback`, `good-first-issue`, `privacy`, `bug`.
- Turn repeated confusion into README edits before adding new features.

## Primary Links

- GitHub: <https://github.com/Snipara/snipara-companion>
- npm: <https://www.npmjs.com/package/snipara-companion>
- Full reference: [../FULL_REFERENCE.md](../FULL_REFERENCE.md)
- Demo script: [DEMO_SCRIPT.md](./DEMO_SCRIPT.md)
- Post drafts: [POSTS.md](./POSTS.md)
