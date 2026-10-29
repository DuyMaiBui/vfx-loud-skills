#!/usr/bin/env bash
# Phase 1 acceptance (plans/261028-self-contained-vfx-fetch/phase-1-foundation.md).
#
# Usage: bash scripts/accept/phase-1.sh
# Exit codes: 0 all steps passed; otherwise the exit code of the first failing step (see with-testdb.sh).
# Every DB-backed step runs on a scratch DB (vfxcloud_test_p1), never on the live vfxcloud DB.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$repo" || exit 1

echo "== phase 1: typecheck" >&2
npm run check || exit $?

echo "== phase 1: full suite on a migrated scratch DB" >&2
bash "$here/with-testdb.sh" p1 npm test || exit $?

echo "== phase 1: contract test on a migrated scratch DB" >&2
bash "$here/with-testdb.sh" p1 node server/src/bundle-contract.test.ts || exit $?

echo "== phase 1: live DB untouched (no migration 010 applied to vfxcloud)" >&2
live="$(podman exec vfx-pg psql -U vfx -d vfxcloud -tAc "SELECT count(*) FROM schema_migrations WHERE name LIKE '010%'")" || exit 1
if [[ "$live" != "0" ]]; then
  echo "phase 1: live vfxcloud has migration 010 applied (count=${live}); it must wait for phase 9" >&2
  exit 1
fi

echo "phase 1: PASS" >&2
