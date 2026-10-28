#!/usr/bin/env bash
# Phase 9 acceptance (plans/261028-self-contained-vfx-fetch/phase-9-integrate-upload.md step 9). Run AFTER steps 1-8.
# Read-only against the live cloud (SELECTs, one unauthenticated GET, a `pg_dump` for the clone); it writes nothing live.
#
# Usage: bash scripts/accept/phase-9.sh [--dry]
#   --dry   print the check list and the first live command, run nothing, exit 0.
# Output (AX-01): one `CHECK <name> PASS|FAIL|SKIP <detail>` line per assertion. Exit (AX-10): the number of FAILs + SKIPs
# (a skipped check proves nothing, so it counts).
# Env (defaults): VFX_PG_CONTAINER=vfx-pg  VFX_TEST_PG_USER=vfx  VFX_LIVE_DB=vfxcloud  VFX_SERVER=http://127.0.0.1:8787
#   PHASE9_REPORTS=<repo>/data/reports  PHASE9_PRE_RECIPES=3248 (else `recipes_preexisting=N` in baseline.txt)
#   PHASE9_SKIP_SUITES=1  (test-only: the two pinned-baseline checks print SKIP and count as failures)
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$repo" || exit 1

container="${VFX_PG_CONTAINER:-vfx-pg}"
user="${VFX_TEST_PG_USER:-vfx}"
db="${VFX_LIVE_DB:-vfxcloud}"
server="${VFX_SERVER:-http://127.0.0.1:8787}"
reports="${PHASE9_REPORTS:-$repo/data/reports}"

names=(migration_010_once asset_file_matches_upload no_global_or_ai_training game_recipes_studio_only
  blob_403_without_key closure_sha_mismatch_zero preexisting_recipes_unchanged
  pinned_baseline_scratch_unseeded pinned_baseline_corpus_clone)

if [[ "${1:-}" == "--dry" ]]; then
  printf 'phase-9 checks: %s\n' "${names[*]}"
  echo "first live command: podman exec $container psql -U $user -d $db -Atc \"SELECT count(*) FROM schema_migrations WHERE name='010_asset_blobs.sql'\"  (read-only)"
  exit 0
fi

q() { podman exec "$container" psql -U "$user" -d "$db" -Atc "$1" 2>&1; }
failed=0
check() { # check <name> <PASS|FAIL|SKIP> <detail>
  printf 'CHECK %s %s %s\n' "$1" "$2" "$3"
  [[ "$2" == PASS ]] || failed=$((failed + 1))
}
eq() { # eq <name> <actual> <expected>
  if [[ "$2" == "$3" ]]; then check "$1" PASS "$2"; else check "$1" FAIL "got '$2' want '$3'"; fi
}
num() { [[ "${1:-}" =~ ^[0-9]+$ ]] && echo "$1" || echo "ERR($1)"; }

eq migration_010_once "$(num "$(q "SELECT count(*) FROM schema_migrations WHERE name='010_asset_blobs.sql'")")" 1

up="$reports/upload-original.json"
if [[ -f "$up" ]]; then
  want="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).files)" "$up" 2>&1)"
  eq asset_file_matches_upload "$(num "$(q "SELECT count(*) FROM asset_file WHERE variant='original'")")" "$want"
else
  check asset_file_matches_upload FAIL "missing $up (step 6 output)"
fi

eq no_global_or_ai_training "$(num "$(q "SELECT count(*) FROM asset_file WHERE visibility='global' OR ai_training")")" 0

# the selector must match something: a pack name that matches no row would make the all-rows check vacuously true
sel="COALESCE(meta->>'pack', meta->'source'->>'pack')='studio-game-vfx' AND type='recipe'"
total="$(num "$(q "SELECT count(*) FROM resource WHERE $sel")")"
bad="$(num "$(q "SELECT count(*) FROM resource WHERE $sel AND (license<>'studio-internal' OR visibility<>'studio-only' OR COALESCE(meta->>'ai_training','false')<>'false')")")"
if [[ "$total" =~ ^[0-9]+$ && "$total" -gt 0 && "$bad" == 0 ]]; then check game_recipes_studio_only PASS "recipes=$total"
else check game_recipes_studio_only FAIL "recipes=$total non_conforming=$bad (0 recipes means the pack selector matched nothing)"; fi

sha="$(q "SELECT asset_sha256 FROM asset_file ORDER BY id LIMIT 1")"
if [[ "$sha" =~ ^[0-9a-f]{64}$ ]]; then
  eq blob_403_without_key "$(curl -s -o /dev/null -w '%{http_code}' "$server/v1/blob/$sha")" 403
else
  check blob_403_without_key FAIL "no asset_file row to probe ($sha)"
fi

cv="$reports/closure-verify.json"
if [[ -f "$cv" ]]; then
  res="$(node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log((r.sha_mismatch||[]).length+' '+r.checked)" "$cv" 2>&1)"
  if [[ "$res" =~ ^0\ [1-9][0-9]*$ ]]; then check closure_sha_mismatch_zero PASS "checked=${res#0 }"
  else check closure_sha_mismatch_zero FAIL "sha_mismatch/checked='$res' (need 0 and checked>0)"; fi
else
  check closure_sha_mismatch_zero FAIL "missing $cv (step 7 output)"
fi

pre="${PHASE9_PRE_RECIPES:-}"
[[ -z "$pre" && -f "$reports/baseline.txt" ]] && pre="$(sed -n 's/^recipes_preexisting=//p' "$reports/baseline.txt" | head -1)"
eq preexisting_recipes_unchanged "$(num "$(q "SELECT count(*) FROM resource WHERE type='recipe' AND visibility<>'studio-only'")")" "${pre:-3248}"

if [[ "${PHASE9_SKIP_SUITES:-}" == 1 ]]; then
  check pinned_baseline_scratch_unseeded SKIP "PHASE9_SKIP_SUITES=1"
  check pinned_baseline_corpus_clone SKIP "PHASE9_SKIP_SUITES=1"
else
  if out="$(bash "$here/run-pinned-suite.sh" 2>&1)"; then check pinned_baseline_scratch_unseeded PASS "$(tail -1 <<<"$out")"
  else check pinned_baseline_scratch_unseeded FAIL "$(grep -m3 '^FAIL' <<<"$out" | tr '\n' ';')"; fi
  # live pg_dump (read-only) -> scratch clone vfxcloud_test_integ -> corpus-clone pin (empty: every name must be green)
  if out="$(bash "$here/with-corpus-clone.sh" 2>&1)"; then check pinned_baseline_corpus_clone PASS "$(tail -1 <<<"$out")"
  else check pinned_baseline_corpus_clone FAIL "$(grep -m3 '^FAIL\|\[with-corpus-clone\]' <<<"$out" | tr '\n' ';')"; fi
fi

echo "phase 9: $failed failed/skipped of ${#names[@]}" >&2
exit "$failed"
