#!/usr/bin/env bash
# Run a command against a fresh scratch DB, migrated first (plan.md D15, phase-1 step 2).
#
# Usage: with-testdb.sh <lane> <cmd> [args...]
#   Creates vfxcloud_test_<lane> and a temp DATA_DIR, runs `node scripts/accept/migrate-testdb.ts` on it,
#   then runs <cmd> from the repo root with DATABASE_URL and DATA_DIR exported. Prints the scratch DB name
#   on stderr as `[with-testdb] db=... data=...`. Non-interactive. The EXIT trap drops the DB and DATA_DIR.
#
# Exit codes:
#   0    the wrapped command passed
#   N    the wrapped command's own exit code (passed through unchanged)
#   2    usage error (missing lane or command, or a lane that is not [a-z0-9]+)
#   75   the scratch DB could not be created (Postgres container down): retry later
#   1    the migration of the scratch DB failed (see the migrate-testdb output)

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

# shellcheck source=lib-testdb.sh
source "$here/lib-testdb.sh"

if [[ $# -lt 2 ]]; then
  echo "usage: with-testdb.sh <lane> <cmd> [args...]" >&2
  exit 2
fi

lane="$1"
shift

testdb_create "$lane"
create_status=$?
if [[ $create_status -eq 2 ]]; then
  exit 2
elif [[ $create_status -ne 0 ]]; then
  echo "[with-testdb] could not create scratch DB vfxcloud_test_${lane} (is the vfx-pg container up?)" >&2
  exit 75
fi

echo "[with-testdb] db=${VFX_TESTDB_NAME} data=${DATA_DIR}" >&2

if ! (cd "$repo" && node scripts/accept/migrate-testdb.ts); then
  echo "[with-testdb] migration of ${VFX_TESTDB_NAME} failed" >&2
  exit 1
fi

cd "$repo" || exit 1
"$@"
