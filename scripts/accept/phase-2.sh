#!/usr/bin/env bash
# Phase 2 acceptance (plans/261028-self-contained-vfx-fetch/phase-2-server.md, lane S).
#
# Usage: bash scripts/accept/phase-2.sh
# Exit codes: 0 all steps passed; otherwise the exit code of the first failing step (see with-testdb.sh).
# Everything DB-backed runs on the scratch DB vfxcloud_test_s2 with a temp DATA_DIR, never on the live DB.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$repo" || exit 1

echo "== phase 2: typecheck" >&2
npm run check || exit $?

echo "== phase 2: blob-store + bundle-builder tests" >&2
LOG_LEVEL=silent bash "$here/with-testdb.sh" s2 node --test server/src/blob-store.test.ts server/src/bundle-builder.test.ts || exit $?

echo "== phase 2: smoke (blob routes) against a throw-away server on a random port" >&2
bash "$here/with-testdb.sh" s2 bash -c '
  port=$((20000 + RANDOM % 20000))
  export PORT="$port" HOST=127.0.0.1 VFX_API_KEY=phase2-smoke-key AUTH_DISABLED=1 LOG_LEVEL=silent
  node server/src/index.ts >"$DATA_DIR/server.log" 2>&1 &
  pid=$!
  trap "kill $pid 2>/dev/null" EXIT
  for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && break; sleep 0.2; done
  VFX_SERVER="http://127.0.0.1:$port" bash scripts/smoke.sh --blob-only
' || exit $?

echo "phase 2: PASS" >&2
