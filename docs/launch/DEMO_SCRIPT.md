# Demo Runner

This is not a script to paste by hand. The source of truth is the executable
runner in this directory:

```bash
docs/launch/demo-impact.sh
```

It creates a temporary public-safe demo repository, commits a small auth import
graph, and runs:

```bash
npx -y snipara-companion@latest impact src/auth/session.ts --source local
```

Expected output shape:

```text
Code impact - local - src/auth/session.ts
Source: local_overlay
Reason: source_forced_local

Incoming (2) - files that depend on this
  apps/web/src/app/api/auth/session/route.ts
  apps/web/src/lib/auth/permissions.ts

Outgoing (2) - files this depends on
  src/auth/cookies.ts
  src/auth/tokens.ts

Use --json for full overlay details.
```

## Recording

For a terminal recording, run the executable and record that terminal session:

```bash
asciinema rec -c "docs/launch/demo-impact.sh" docs/launch/impact.cast
```

Optional GIF conversion if `agg` is installed:

```bash
agg docs/launch/impact.cast docs/launch/impact.gif
```

## Options

Use a local package path or a specific version:

```bash
SNIPARA_COMPANION_PACKAGE=snipara-companion@2.0.9 docs/launch/demo-impact.sh
SNIPARA_COMPANION_PACKAGE=. docs/launch/demo-impact.sh
```

Keep the generated demo repository for debugging:

```bash
KEEP_DEMO_DIR=1 docs/launch/demo-impact.sh
```

## Review Checklist

- The command appears in the first five seconds.
- The words `Incoming` and `Outgoing` are visible without scrolling.
- There is no login, browser, account setup, or `init`.
- No private path, token, secret, or customer name appears.
- If the output is empty or surprising, fix the CLI or use the issue template
  before posting the demo.
