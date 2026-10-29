#!/usr/bin/env bash
# Phase 13 acceptance (plans/261028-self-contained-vfx-fetch/phase-13-docs.md step 4). Read-only: reads README.md,
# skills/**, data/reports/*.json, seed/extract/unfixable-scripts.json, tools/preview/*; SELECTs on the live DB; two npm
# scans without --purge; one GET /healthz; `npm run check`. It does not judge prose quality (the reviewer does).
#
# Usage: bash scripts/accept/phase-13.sh
# Output (AX-01): one `CHECK <name> PASS|FAIL <detail>` line per assertion, then `phase 13: <n> failed of <m> checks`.
# Exit (AX-10): the number of FAILs.
# Env (defaults): PHASE13_README=<repo>/README.md  PHASE13_SKILLS=<repo>/skills  PHASE13_REPORTS=<repo>/data/reports
#   VFX_SERVER=http://127.0.0.1:8787  VFX_PG_CONTAINER=vfx-pg  VFX_TEST_PG_USER=vfx  VFX_LIVE_DB=vfxcloud
# Negative control (by hand; the real README is never mutated): copy README to a scratch file, delete one documented
#   command and change one Status number there, then run PHASE13_README=<scratch> bash scripts/accept/phase-13.sh.
#   It must exit non-zero and name both failures.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$repo" || exit 1

readme="${PHASE13_README:-$repo/README.md}"
skills="${PHASE13_SKILLS:-$repo/skills}"
reports="${PHASE13_REPORTS:-$repo/data/reports}"
server="${VFX_SERVER:-http://127.0.0.1:8787}"
container="${VFX_PG_CONTAINER:-vfx-pg}"
user="${VFX_TEST_PG_USER:-vfx}"
db="${VFX_LIVE_DB:-vfxcloud}"

psqlq() { podman exec -i "$container" psql -U "$user" -d "$db" -At -v ON_ERROR_STOP=1 -c "$1" 2>&1; }
num() { [[ "${1:-}" =~ ^[0-9]+$ ]] && echo "$1" || echo "ERR($1)"; }
failed=0
total=0
check() { # check <name> <PASS|FAIL> <detail>
  total=$((total + 1))
  printf 'CHECK %s %s %s\n' "$1" "$2" "$3"
  [[ "$2" == PASS ]] || failed=$((failed + 1))
}
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if [[ ! -r "$readme" ]]; then
  check readme_readable FAIL "cannot read $readme"
  echo "phase 13: $failed failed of $total checks"
  exit "$failed"
fi

# 1. Every documented command or option is mentioned in README (grep list kept here; add a line when a command is documented).
commands=(
  'scripts/vfx-fetch.sh' 'VFX_VARIANT' 'VFX_ROOT' 'VFX_ON_CONFLICT' 'VFX_DRY_RUN' 'VFX_ALLOW_INCOMPLETE'
  'VFX_STRICT_REQUIRES' 'VFX_FETCH_LEGACY' 'VFX_BLOB_ALLOW_ANON' 'seed/upload-blobs.ts' '--variant urp --urp-dir'
  '--skip-kinds' '--dangling-map' 'seed/verify-closure.ts' '--record' 'pg_dump -U vfx -Fc' 'pg_restore --list'
  'scripts/preview-restore-originals.ts' 'UrpExport.Run' 'seed/preview-failures-ingest.ts' 'npm run previews:gif'
  'previews:magenta' 'previews:consistency' 'waivers.json' 'magenta-allow.txt' 'BatchFetch.Run' '-vfxUri'
  'GROUP BY 1' 'TheOne → VFX Cloud → Fetch URI' 'Bytes and bundle API'
)
i=0
for c in "${commands[@]}"; do
  i=$((i + 1))
  if grep -qF -- "$c" "$readme"; then check "documented_$i" PASS "$c"; else check "documented_$i" FAIL "README does not mention: $c"; fi
done

# 2. Stale statements are gone from README and skills (the wording the phase replaces).
stale=('metadata only' 'no bytes' 'metadata-only' 'chỉ metadata' 'Tools → VFX Cloud' 'không đụng `.meta`'
  'không bao giờ bị đụng' 'không được ghi `.meta`' 'Assets/VFXCloud/<type>/<slug>')
i=0
for s in "${stale[@]}"; do
  i=$((i + 1))
  hits="$(grep -rlF -- "$s" "$readme" "$skills" 2>/dev/null | tr '\n' ' ')"
  if [[ -z "$hits" ]]; then check "no_stale_$i" PASS "absent: $s"; else check "no_stale_$i" FAIL "still in: $hits ($s)"; fi
done

# 3. The agent-facing skill documents the bundle contract (fetch behaviour and complete/requires/unresolved/dangling).
for t in 'vfx-bundle/1' 'bundle.complete' 'unresolved' 'requires' 'dangling' 'VFX_FETCH_LEGACY'; do
  if grep -rqF -- "$t" "$skills"; then check "skill_$t" PASS "$t"; else check "skill_$t" FAIL "skills do not mention $t"; fi
done

# 4. Status numbers: README `| `key` | value |` rows inside "## Status" equal the report files and live SELECTs.
expected="$tmp/expected.txt"
if node -e '
  const fs = require("fs");
  const [reports, repo] = process.argv.slice(1);
  const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
  const urp = J(`${reports}/closure-verify-urp.json`);
  const up = J(`${reports}/upload-original.json`);
  const out = {
    closure_urp_checked: urp.checked,
    closure_urp_complete: urp.complete,
    closure_urp_incomplete: urp.incomplete.length,
    closure_urp_dangling: urp.dangling.length,
    asset_files_original: up.files,
    original_bytes: up.bytes,
    game_recipes_removed: Object.keys(J(`${repo}/seed/extract/unfixable-scripts.json`).entries).length,
    magenta_allow: fs.readFileSync(`${repo}/tools/preview/magenta-allow.txt`, "utf8").split("\n").filter((l) => l.trim() && !/^\s*#/.test(l)).length,
  };
  for (const [k, v] of Object.entries(out)) console.log(k, v);
' "$reports" "$repo" > "$expected" 2>"$tmp/node.err"; then
  {
    echo "resources $(num "$(psqlq 'SELECT count(*) FROM resource')")"
    echo "recipes $(num "$(psqlq "SELECT count(*) FROM resource WHERE type='recipe'")")"
    echo "resource_edges $(num "$(psqlq 'SELECT count(*) FROM resource_edge')")"
    echo "asset_files_urp $(num "$(psqlq "SELECT count(*) FROM asset_file WHERE variant='urp'")")"
    echo "asset_blobs $(num "$(psqlq 'SELECT count(*) FROM asset_blob')")"
    echo "blob_stored_bytes $(num "$(psqlq 'SELECT COALESCE(sum(stored_bytes),0) FROM asset_blob')")"
    echo "previews_rendered $(num "$(psqlq 'SELECT count(*) FROM preview_render')")"
    echo "previews_ok $(num "$(psqlq "SELECT count(*) FROM preview_render WHERE state='ok'")")"
    echo "previews_failed $(num "$(psqlq "SELECT count(*) FROM preview_render WHERE state='failed'")")"
    echo "fixable_failures $(num "$(psqlq "SELECT count(*) FROM preview_render WHERE state='failed' AND cause NOT LIKE 'unfixable-%'")")"
    echo "preview_gifs $(num "$(psqlq 'SELECT count(*) FROM preview_gif')")"
  } >> "$expected"
  status_rows="$tmp/readme-status.txt"
  awk -F'|' '/^## Status/{f=1} /^## Chạy/{f=0} f && /^\| `[a-z_]+` \|/ { k=$2; v=$3; gsub(/[` ]/,"",k); gsub(/ /,"",v); print k, v }' "$readme" > "$status_rows"
  if [[ -s "$status_rows" ]]; then check status_table_present PASS "$(wc -l < "$status_rows" | tr -d ' ') keyed rows"
  else check status_table_present FAIL "no keyed rows under ## Status"; fi
  while read -r k v; do
    got="$(awk -v k="$k" '$1==k{print $2; exit}' "$status_rows")"
    if [[ -z "$got" ]]; then check "status_$k" FAIL "missing from README Status"
    elif [[ "$got" == "$v" ]]; then check "status_$k" PASS "$v"
    else check "status_$k" FAIL "README=$got source=$v"; fi
  done < "$expected"
  while read -r k _; do
    grep -q "^$k " "$expected" || check "status_unknown_$k" FAIL "README key has no source"
  done < "$status_rows"
else
  check status_sources FAIL "cannot read report sources: $(tr '\n' ' ' < "$tmp/node.err")"
fi

# 5. Cross-checks that tie the report to the live state.
waivers="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).waivers.length))' "$repo/tools/preview/waivers.json" 2>&1)"
failed_db="$(num "$(psqlq "SELECT count(*) FROM preview_render WHERE state='failed'")")"
if [[ "$waivers" == "$failed_db" ]]; then check waivers_cover_failed PASS "waivers=$waivers failed=$failed_db"
else check waivers_cover_failed FAIL "waivers=$waivers failed=$failed_db"; fi

if out="$(npm run --silent previews:magenta -- --json 2>&1)"; then check previews_magenta PASS "$(tail -1 <<<"$out")"
else check previews_magenta FAIL "$(tail -2 <<<"$out" | tr '\n' ' ')"; fi

if out="$(npm run --silent previews:consistency -- --json 2>&1)" && grep -q '"consistent":true' <<<"$out"; then
  check previews_consistency PASS "$(tail -1 <<<"$out")"
else check previews_consistency FAIL "$(tail -1 <<<"$out")"; fi

if health="$(curl -fsS -m 5 "$server/healthz" 2>&1)" && grep -q '"ok":true' <<<"$health"; then
  check healthz PASS "$server/healthz ok"
else check healthz FAIL "$server/healthz: $health"; fi

if out="$(npm run --silent check 2>&1)"; then check npm_check PASS "tsc --noEmit clean"
else check npm_check FAIL "$(tail -3 <<<"$out" | tr '\n' ' ')"; fi

echo "phase 13: $failed failed of $total checks"
exit "$failed"
