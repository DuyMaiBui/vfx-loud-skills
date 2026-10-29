#!/usr/bin/env bash
# Run the full suite against a CLONE of the integrated live corpus, never the live DB (plan.md D19, phase 9 step 8b).
#
# Usage: with-corpus-clone.sh [--lane integ] [--dump FILE] [--data-src DIR] [-- <cmd> [args...]]
#   1. dump: `pg_dump -Fc` of the live DB (read-only on live) into a temp file, or the given --dump FILE (used by the
#      self-test and for a repeat run; the live DB is then not touched at all);
#   2. restore it into scratch DB vfxcloud_test_<lane> (default integ) via lib-testdb.sh (name always carries `_test_`);
#   3. copy the payload dirs recipe texture shader vfx component code technique skill (NOT blobs/previews) from --data-src
#      (default <repo>/data) into a temp DATA_DIR;
#   4. migrate() the clone (migrate-testdb.ts; exercises migration 010 on real data when the dump predates it);
#   5. default: `node --test <npm test files>` as junit -> check-pinned-baseline.ts --profile corpus-clone
#      (pin is EMPTY: all 14 names must be green; a red or skipped one is a finding). With `-- <cmd>` run <cmd> instead.
# Env: VFX_PG_CONTAINER (vfx-pg), VFX_TEST_PG_USER (vfx), VFX_LIVE_DB (vfxcloud).
# Exit: the checker's / <cmd>'s; 2 usage; 75 container down / dump or restore failed; 1 migration failed.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# shellcheck source=lib-testdb.sh
source "$here/lib-testdb.sh"

lane=integ dump="" src="$repo/data"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --lane) lane="${2:-}"; shift 2 ;;
    --dump) dump="${2:-}"; shift 2 ;;
    --data-src) src="${2:-}"; shift 2 ;;
    --) shift; break ;;
    *) echo "usage: with-corpus-clone.sh [--lane L] [--dump F] [--data-src D] [-- cmd...]" >&2; exit 2 ;;
  esac
done

user="${VFX_TEST_PG_USER:-vfx}"
container="${VFX_PG_CONTAINER:-vfx-pg}"
tmpdump=""
if [[ -z "$dump" ]]; then
  tmpdump="$(mktemp)"
  dump="$tmpdump"
  echo "[with-corpus-clone] pg_dump -Fc ${VFX_LIVE_DB:-vfxcloud} (read-only on live) -> $dump" >&2
  podman exec "$container" pg_dump -U "$user" -Fc "${VFX_LIVE_DB:-vfxcloud}" >"$dump" || { rm -f "$tmpdump"; echo "[with-corpus-clone] pg_dump failed" >&2; exit 75; }
fi
[[ -s "$dump" ]] || { echo "[with-corpus-clone] dump $dump missing or empty" >&2; exit 2; }
trap '[[ -n "$tmpdump" ]] && rm -f "$tmpdump"' EXIT

testdb_create "$lane"; rc=$?
[[ $rc -eq 2 ]] && exit 2
[[ $rc -ne 0 ]] && { echo "[with-corpus-clone] could not create scratch DB (is $container up?)" >&2; exit 75; }
# testdb_create set its own EXIT trap; keep both cleanups
trap '[[ -n "$tmpdump" ]] && rm -f "$tmpdump"; testdb_drop' EXIT

echo "[with-corpus-clone] restore -> ${VFX_TESTDB_NAME}" >&2
podman exec -i "$container" pg_restore -U "$user" -d "$VFX_TESTDB_NAME" --no-owner --exit-on-error <"$dump" \
  || { echo "[with-corpus-clone] pg_restore failed" >&2; exit 75; }

for d in recipe texture shader vfx component code technique skill; do
  [[ -d "$src/$d" ]] && cp -a "$src/$d" "$DATA_DIR/$d"
done
echo "[with-corpus-clone] db=${VFX_TESTDB_NAME} data=${DATA_DIR}" >&2

cd "$repo" || exit 1
node scripts/accept/migrate-testdb.ts || { echo "[with-corpus-clone] migrate of the clone failed" >&2; exit 1; }

if [[ $# -gt 0 ]]; then
  "$@"
  exit $?
fi
files="$(node -e "process.stdout.write(require('./package.json').scripts.test.replace(/^node --test /,''))")"
files="$(shopt -s nullglob; for g in $files; do ls $g; done | tr '\n' ' ')"
junit="$(mktemp)"
# shellcheck disable=SC2086
node --test --test-reporter=junit $files >"$junit" 2>/dev/null || true
node scripts/accept/check-pinned-baseline.ts --profile corpus-clone --junit "$junit"
rc=$?
rm -f "$junit"
exit $rc
