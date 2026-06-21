# Demo Script

Goal: produce a 15 to 30 second terminal recording that proves the first-run
promise without depending on a private repo.

## Recording Setup

- Terminal size: 88 x 26 or similar.
- Theme: high contrast, readable font, no prompt plugins that leak paths or
  credentials.
- Network is needed only for `npx` to fetch the package. The analysis command
  uses `--source local`.
- Do not record private repositories, environment variables, or secrets.

## Deterministic Demo Repo

Paste this into a clean shell:

```bash
DEMO_DIR="$(mktemp -d)"
cd "$DEMO_DIR"
git init >/dev/null
git config user.email demo@example.com
git config user.name Demo

mkdir -p src/auth apps/web/src/lib/auth apps/web/src/app/api/auth/session

cat > src/auth/cookies.ts <<'EOF'
export function readCookie(name: string) {
  return name;
}
EOF

cat > src/auth/tokens.ts <<'EOF'
export function verifyToken(token: string) {
  return token.length > 0;
}
EOF

cat > src/auth/session.ts <<'EOF'
import { readCookie } from './cookies';
import { verifyToken } from './tokens';

export function readSession() {
  return verifyToken(readCookie('session'));
}
EOF

cat > apps/web/src/lib/auth/permissions.ts <<'EOF'
import { readSession } from '../../../../src/auth/session';

export function canReadAdmin() {
  return readSession();
}
EOF

cat > apps/web/src/app/api/auth/session/route.ts <<'EOF'
import { readSession } from '../../../../../../src/auth/session';

export function GET() {
  return readSession();
}
EOF

git add .
git commit -m "demo repo" >/dev/null

npx -y snipara-companion impact src/auth/session.ts --source local
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

## Asciinema

```bash
asciinema rec docs/launch/impact.cast
# run the deterministic demo commands
asciinema play docs/launch/impact.cast
```

Optional GIF conversion if `agg` is installed:

```bash
agg docs/launch/impact.cast docs/launch/impact.gif
```

## VHS

Create `docs/launch/impact.tape`:

```text
Output docs/launch/impact.gif
Set FontSize 18
Set Width 1200
Set Height 720
Set TypingSpeed 50ms

Type "npx -y snipara-companion impact src/auth/session.ts --source local"
Enter
Sleep 3s
```

Then run:

```bash
vhs docs/launch/impact.tape
```

## Review Checklist

- The command appears in the first five seconds.
- The words `Incoming` and `Outgoing` are visible without scrolling.
- There is no login, browser, account setup, or `init`.
- No private path, token, secret, or customer name appears.
- If the output is empty or surprising, fix the CLI or use the issue template
  before posting the demo.

