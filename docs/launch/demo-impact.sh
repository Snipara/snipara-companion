#!/usr/bin/env bash
set -euo pipefail

PACKAGE="${SNIPARA_COMPANION_PACKAGE:-snipara-companion@latest}"
case "$PACKAGE" in
  .|./*|../*|/*)
    PACKAGE="$(cd "$PACKAGE" && pwd)"
    ;;
esac
KEEP_DEMO_DIR="${KEEP_DEMO_DIR:-0}"
DEMO_DIR="$(mktemp -d)"

cleanup() {
  if [ "$KEEP_DEMO_DIR" != "1" ]; then
    rm -rf "$DEMO_DIR"
  fi
}
trap cleanup EXIT

run() {
  printf '$ %s\n' "$*"
  "$@"
}

write_file() {
  local path="$1"
  mkdir -p "$(dirname "$path")"
  cat > "$path"
}

cd "$DEMO_DIR"
git init -q
git config user.email demo@example.com
git config user.name Demo

write_file src/auth/cookies.ts <<'EOF'
export function readCookie(name: string) {
  return name;
}
EOF

write_file src/auth/tokens.ts <<'EOF'
export function verifyToken(token: string) {
  return token.length > 0;
}
EOF

write_file src/auth/session.ts <<'EOF'
import { readCookie } from './cookies';
import { verifyToken } from './tokens';

export function readSession() {
  return verifyToken(readCookie('session'));
}
EOF

write_file apps/web/src/lib/auth/permissions.ts <<'EOF'
import { readSession } from '../../../../../src/auth/session';

export function canReadAdmin() {
  return readSession();
}
EOF

write_file apps/web/src/app/api/auth/session/route.ts <<'EOF'
import { readSession } from '../../../../../../../src/auth/session';

export function GET() {
  return readSession();
}
EOF

git add .
git commit -m "demo repo" >/dev/null

printf 'Demo repo: %s\n\n' "$DEMO_DIR"
run npx -y "$PACKAGE" impact src/auth/session.ts --source local

if [ "$KEEP_DEMO_DIR" = "1" ]; then
  printf '\nKept demo repo: %s\n' "$DEMO_DIR"
fi
