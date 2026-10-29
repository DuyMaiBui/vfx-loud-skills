#!/usr/bin/env bash
# Phase 11 acceptance (plans/261028-self-contained-vfx-fetch/phase-11-fix-rerender.md step 9). Read-only: SELECTs, two npm scan scripts, file reads.
# Run AFTER the final render + `npm run previews:gif` and AFTER the full URP upload; before the upload the urp_* checks FAIL on purpose
# (the DB holds fewer urp rows than the export), they are never skipped.
#
# Usage: bash scripts/accept/phase-11.sh
# Output (AX-01): `FIXABLE=<n>` first, then one `CHECK <name> PASS|FAIL <detail>` line per assertion.
# Exit (AX-10): the number of FAILs; non-zero whenever FIXABLE is not 0. A DB or file error is a FAIL, never a skip.
# Env (defaults): VFX_PG_CONTAINER=vfx-pg  VFX_TEST_PG_USER=vfx  VFX_LIVE_DB=vfxcloud
#   PHASE11_EXPORT_DIR=<repo>/data/export/urp  PHASE11_TARGETS=<repo>/tools/preview/targets.json
#   PHASE11_GUIDS=<repo>/server/src/unity-package-guids.json
#   PHASE11_UNFIXABLE_LIKE='unfixable-%'  (negative control: a pattern that matches nothing makes every documented failure count as fixable)
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$repo" || exit 1

container="${VFX_PG_CONTAINER:-vfx-pg}"
user="${VFX_TEST_PG_USER:-vfx}"
db="${VFX_LIVE_DB:-vfxcloud}"
export_dir="${PHASE11_EXPORT_DIR:-$repo/data/export/urp}"
targets="${PHASE11_TARGETS:-$repo/tools/preview/targets.json}"
guids="${PHASE11_GUIDS:-$repo/server/src/unity-package-guids.json}"
unfixable="${PHASE11_UNFIXABLE_LIKE:-unfixable-%}"

psqlq() { podman exec -i "$container" psql -U "$user" -d "$db" -At -v ON_ERROR_STOP=1 "$@" 2>&1; }
q() { psqlq -c "$1"; }
num() { [[ "${1:-}" =~ ^[0-9]+$ ]] && echo "$1" || echo "ERR($1)"; }
failed=0
check() { # check <name> <PASS|FAIL> <detail>
  printf 'CHECK %s %s %s\n' "$1" "$2" "$3"
  [[ "$2" == PASS ]] || failed=$((failed + 1))
}
eq() { if [[ "$2" == "$3" ]]; then check "$1" PASS "$2"; else check "$1" FAIL "got '$2' want '$3'"; fi; }

# 1. FIXABLE: failed renders whose cause is not a documented unfixable-* one
fixable="$(num "$(q "SELECT count(*) FROM preview_render WHERE state='failed' AND cause NOT LIKE '${unfixable//\'/\'\'}'")")"
echo "FIXABLE=$fixable"
eq fixable_zero "$fixable" 0
documented="$(num "$(q "SELECT count(*) FROM preview_render WHERE state='failed' AND cause LIKE '${unfixable//\'/\'\'}'")")"
echo "unfixable_documented=$documented"

# 2. magenta scan and render/GIF consistency (their own exit codes)
if out="$(npm run --silent previews:magenta 2>&1)"; then check previews_magenta PASS "$(tail -1 <<<"$out")"
else check previews_magenta FAIL "$(tail -2 <<<"$out" | tr '\n' ' ')"; fi
if out="$(npm run --silent previews:consistency 2>&1)"; then check previews_consistency PASS "$(tail -1 <<<"$out")"
else check previews_consistency FAIL "$(head -3 <<<"$out" | tr '\n' ' ')"; fi

# 3. slug coverage: every target slug has a preview_gif row or a skipped / unfixable-* preview_render row
if slugs="$(node -e "const t=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));if(!t.length)process.exit(3);console.log(t.map(x=>x.slug).join('\n'))" "$targets" 2>&1)" \
  && ! grep -qv '^[A-Za-z0-9._-]*$' <<<"$slugs"; then
  n="$(wc -l <<<"$slugs" | tr -d ' ')"
  missing="$( { echo "CREATE TEMP TABLE t(slug text);"; echo "COPY t FROM stdin;"; echo "$slugs"; echo '\.'
      echo "SELECT count(*) FROM t WHERE NOT EXISTS (SELECT 1 FROM preview_gif g WHERE g.slug=t.slug) AND NOT EXISTS (SELECT 1 FROM preview_render r WHERE r.slug=t.slug AND (r.state='skipped' OR r.cause LIKE '${unfixable//\'/\'\'}'));"; } | psqlq | tail -1)"
  missing="$(num "$missing")"
  if [[ "$missing" == 0 ]]; then check slug_coverage PASS "targets=$n uncovered=0"; else check slug_coverage FAIL "targets=$n uncovered=$missing"; fi
else
  check slug_coverage FAIL "cannot read targets from $targets"
fi

# 4. URP variant: DB rows equal the export index.json item count (honest before the upload: FAIL with both numbers)
if want="$(node -e "const i=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));if(i.version!==1||!Array.isArray(i.items)||!i.items.length)process.exit(3);console.log(i.items.length)" "$export_dir/index.json" 2>&1)"; then
  eq urp_count_matches_export "$(num "$(q "SELECT count(*) FROM asset_file WHERE variant='urp'")")" "$want"
else
  check urp_count_matches_export FAIL "no usable $export_dir/index.json: $want"
fi

# 5. every urp row (and every export item) names a shader GUID known to unity-package-guids.json; zero rows is a FAIL, not vacuous truth
if known="$(node -e "const g=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).entries;console.log(Object.keys(g).map(k=>\"'\"+k+\"'\").join(','))" "$guids" 2>&1)" && [[ "$known" == \'* ]]; then
  rows="$(num "$(q "SELECT count(*) FROM asset_file WHERE variant='urp'")")"
  bad="$(num "$(q "SELECT count(*) FROM asset_file WHERE variant='urp' AND COALESCE(urp->>'shader_guid','') NOT IN ($known)")")"
  if [[ "$rows" =~ ^[1-9][0-9]*$ && "$bad" == 0 ]]; then check urp_shader_guid_known PASS "rows=$rows unknown=0"
  else check urp_shader_guid_known FAIL "rows=$rows unknown=$bad"; fi
  if ebad="$(node -e "const k=new Set(Object.keys(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).entries));const i=JSON.parse(require('fs').readFileSync(process.argv[2],'utf8')).items;const b=i.filter(x=>!k.has(x.shader_guid));console.log(b.length)" "$guids" "$export_dir/index.json" 2>&1)"; then
    eq export_shader_guid_known "$ebad" 0
  else check export_shader_guid_known FAIL "$ebad"; fi
else
  check urp_shader_guid_known FAIL "cannot read $guids"
fi

echo "phase 11: $failed failed of 7 checks (FIXABLE=$fixable)" >&2
exit "$failed"
