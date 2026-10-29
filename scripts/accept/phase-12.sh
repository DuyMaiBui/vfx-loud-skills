#!/usr/bin/env bash
# Phase 12 acceptance (plans/261028-self-contained-vfx-fetch/phase-12-acceptance.md step 8): clean-project proof that a fetched recipe renders with no
# magenta, GUIDs intact, by both clients, and that the unconverted variant DOES fail the gate. Reads what steps 3-7 left under data/accept/ and
# re-checks the live project tree, the live server (read-only GETs) and a scratch copy (collision / exit-code probes). NO Editor is started and nothing
# in the cloud or in unity/VFXPreview is touched.
#
# Usage: bash scripts/accept/phase-12.sh
# Output (AX-01): one `CHECK <name> PASS|FAIL <detail>` line per assertion, a summary on stderr.
# Exit (AX-10): the number of FAILed checks. A missing input file is a FAIL, never a skip.
# Env (defaults): PHASE12_ACCEPT=<repo>/data/accept  PHASE12_URP_OUT=<accept>/previews-urp  PHASE12_CONTROL_OUT=<accept>/previews-original
#   PHASE12_UC_OUT=<accept>/previews-unityclient  VFX_SERVER=http://127.0.0.1:8787  VFX_API_KEY (default: read from data/.vfx-api-key, never printed)
#   (negative control: PHASE12_URP_OUT=data/accept/previews-original makes the urp-samples check go red)
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$repo" || exit 1
acc="${PHASE12_ACCEPT:-$repo/data/accept}"
urp_out="${PHASE12_URP_OUT:-$acc/previews-urp}"
control_out="${PHASE12_CONTROL_OUT:-$acc/previews-original}"
uc_out="${PHASE12_UC_OUT:-$acc/previews-unityclient}"
proj="$repo/unity/VFXAccept"
export VFX_SERVER="${VFX_SERVER:-http://127.0.0.1:8787}"
if [[ -z "${VFX_API_KEY:-}" && -f "$repo/data/.vfx-api-key" ]]; then VFX_API_KEY="$(cat "$repo/data/.vfx-api-key")"; fi
export VFX_API_KEY="${VFX_API_KEY:-}"
failed=0; total=0
check() { total=$((total + 1)); printf 'CHECK %s %s %s\n' "$1" "$2" "$3"; [[ "$2" == PASS ]] || failed=$((failed + 1)); }
js() { node -e "$1" "${@:2}" 2>&1; }  # js '<code>' args...  (argv[1..] = args)
samples="$acc/samples.json"
scratch="$acc/scratch"; rm -rf "$scratch"; mkdir -p "$scratch/bundles"
tree_hash() { # tree_hash <dir>: sha256 over every file's hash and every directory path under it
  (cd "$1" && { find . -type f -print0 | sort -z | xargs -0 -r sha256sum; find . -type d | sort; }) | sha256sum | cut -d' ' -f1; }
fetch() { # fetch <slug> <project-dir> [extra env as VAR=val ...]; stdout = client output, status = client exit code
  local slug="$1" p="$2"; shift 2; env "$@" bash "$repo/scripts/vfx-fetch.sh" "vfx://recipe/$slug/1" "$p"; }

# ---- 0. inputs
for f in "$samples" "$acc/targets.json" "$control_out/_failures.json" "$urp_out/_failures.json" "$urp_out/_status.json" "$uc_out/_failures.json" \
  "$acc/fetch-urp.jsonl" "$acc/fetch-after-unity.jsonl" "$acc/_recipe-prefabs.json"; do
  [[ -s "$f" ]] || check input_present FAIL "missing or empty $f"
done
[[ -n "$VFX_API_KEY" ]] || check api_key FAIL "no VFX_API_KEY and no data/.vfx-api-key"
[[ -d "$proj/Assets/VFXCloud" ]] || check project_present FAIL "$proj/Assets/VFXCloud absent"

# ---- 1. negative control: the unconverted variant FAILS the gate (>=1 magenta/unrenderable)
r="$(js '
const f=require("fs");const s=JSON.parse(f.readFileSync(process.argv[1])).samples.filter(x=>x.control).map(x=>x.slug);
const it=JSON.parse(f.readFileSync(process.argv[2]+"/_failures.json")).items;
const bad=s.filter(x=>it[x]&&it[x].state==="failed"&&["unrenderable-material","magenta-pixel"].includes(it[x].cause));
console.log(bad.length+"/"+s.length);process.exit(bad.length>=1?0:1)' "$samples" "$control_out")" \
  && check control_fails_gate PASS "variant=original: $r control samples reported unrenderable-material or magenta-pixel" \
  || check control_fails_gate FAIL "need >=1 failed control sample (unrenderable-material|magenta-pixel): $r"

# ---- 2. urp samples: 10/10 ok, zero failed, no magenta (the batch's own pixel gate)
r="$(js '
const f=require("fs");const s=JSON.parse(f.readFileSync(process.argv[1])).samples.map(x=>x.slug);
const it=JSON.parse(f.readFileSync(process.argv[2]+"/_failures.json")).items;
const st=JSON.parse(f.readFileSync(process.argv[2]+"/_status.json"));
const ok=s.filter(x=>it[x]&&it[x].state==="ok");
console.log(ok.length+"/"+s.length+" ok, status failed="+st.failed+(ok.length<s.length?" not ok: "+s.filter(x=>!ok.includes(x)).map(x=>x+"("+(it[x]?it[x].state+"/"+it[x].cause:"absent")+")").join(","):""));
process.exit(ok.length===s.length&&s.length===10&&st.failed===0?0:1)' "$samples" "$urp_out")" \
  && check urp_samples_ok PASS "$r" || check urp_samples_ok FAIL "$r"

# ---- 3. complete flags + GUID integrity (bundles re-fetched NOW from the server)
mkdir -p "$scratch/bundles"; fetchfail=""
for slug in $(js 'for(const x of JSON.parse(require("fs").readFileSync(process.argv[1])).samples)if(x.bundle)console.log(x.slug)' "$samples"); do
  curl -fsS -H "x-vfx-key: $VFX_API_KEY" "$VFX_SERVER/v1/closure/recipe/$slug/1?variant=urp" -o "$scratch/bundles/$slug.json" 2>/dev/null || fetchfail="$fetchfail $slug"
done
[[ -z "$fetchfail" ]] && check bundles_fetched PASS "9 bundles from $VFX_SERVER" || check bundles_fetched FAIL "cannot GET closure for:$fetchfail"
r="$(js '
const f=require("fs");const s=JSON.parse(f.readFileSync(process.argv[1])).samples.filter(x=>x.bundle);const out=[];let bad=0;
for(const x of s){let b;try{b=JSON.parse(f.readFileSync(process.argv[2]+"/bundles/"+x.slug+".json"))}catch{bad++;out.push(x.slug+":unreadable");continue}
 const un=(b.unresolved||[]).map(u=>u.guid);
 const okc=b.complete===x.expect_complete;
 const oku=x.expect_complete?un.length===0:(x.expect_unresolved||[]).every(p=>un.some(g=>g.startsWith(p)));
 if(!okc||!oku){bad++;out.push(x.slug+": complete="+b.complete+" unresolved="+un.map(g=>g.slice(0,8)).join("|"))}}
console.log(out.length?out.join("; "):s.filter(x=>x.expect_complete).length+" complete:true; "+s.filter(x=>!x.expect_complete).map(x=>x.slug+" complete:false by design (unresolved "+(x.expect_unresolved||[]).join(",")+")").join("; "));
process.exit(bad?1:0)' "$samples" "$scratch")" \
  && check complete_flags PASS "$r" || check complete_flags FAIL "$r"
r="$(node "$here/phase-12-guids.mjs" "$proj" "$scratch"/bundles/*.json 2>&1)" \
  && check guid_integrity PASS "$r" || check guid_integrity FAIL "$r"

# ---- 4. fetch summaries: every shell fetch exited 0 (namufx incomplete allowed by flag only), both passes
r="$(js '
const f=require("fs");const L=(p)=>f.readFileSync(p,"utf8").trim().split("\n").map(JSON.parse);
const a=L(process.argv[1]),b=L(process.argv[2]);
const bad=[...a,...b].filter(x=>x.rc!==0);
const uc=JSON.parse(f.readFileSync(process.argv[3])).unity_client;
const cross=b.filter(x=>uc.some(s=>x.uri.includes("/"+s+"/")));
const crossBad=cross.filter(x=>!(x.written===0&&x.unchanged>0));
console.log("fetches="+(a.length+b.length)+" nonzero="+bad.length+"; unity-client files seen as unchanged by the shell client: "+(cross.length-crossBad.length)+"/"+cross.length);
process.exit(bad.length===0&&a.length===9&&b.length===9&&cross.length===uc.length&&crossBad.length===0?0:1)' "$acc/fetch-urp.jsonl" "$acc/fetch-after-unity.jsonl" "$samples")" \
  && check fetch_exit0_and_cross_client PASS "$r" || check fetch_exit0_and_cross_client FAIL "$r"

# ---- 5. Unity client: install ok (GUID assertion is part of the install: a mismatch fails the run), zero magenta, same files as the bundle
r="$(js '
const f=require("fs");const s=JSON.parse(f.readFileSync(process.argv[1]));const out=[];let bad=0;
const it=JSON.parse(f.readFileSync(process.argv[2]+"/_failures.json")).items;
for(const slug of s.unity_client){
 let j;try{j=JSON.parse(f.readFileSync(process.argv[3]+"/unity-client/"+slug+".json"))}catch{bad++;out.push(slug+": no result");continue}
 const b=JSON.parse(f.readFileSync(process.argv[3]+"/scratch/bundles/"+slug+".json"));
 const want=new Map(b.files.filter(x=>x.origin==="asset_file").map(x=>[x.guid,x.target_path]));
 const got=new Map((j.items||[]).map(x=>[x.guid,x.path]));
 const same=want.size>0&&want.size===got.size&&[...want].every(([g,p])=>got.get(g)===p);
 const good=j.exit===0&&j.ok===true&&j.code===0&&same&&it[slug]&&it[slug].state==="ok";
 if(!good){bad++;out.push(slug+": exit="+j.exit+" ok="+j.ok+" guids/paths-match-bundle="+same+" render="+(it[slug]?it[slug].state:"absent"))}
 else out.push(slug+": installed "+j.written+" files, "+got.size+" guid/path pairs equal the bundle, render ok")}
console.log(out.join("; "));process.exit(bad?1:0)' "$samples" "$uc_out" "$acc")" \
  && check unity_client_ok PASS "$r" || check unity_client_ok FAIL "$r"

# ---- 6. collision safety (scratch project: the Editor-owned project is never written to)
slug1="retro-arsenal-exclamation"
b1="$scratch/bundles/$slug1.json"
planted_guid="$(js 'const b=JSON.parse(require("fs").readFileSync(process.argv[1]));const x=b.files.find(f=>f.origin==="asset_file"&&f.kind==="texture")||b.files.find(f=>f.origin==="asset_file");console.log(x.guid)' "$b1")"
cp1="$scratch/collision"; rm -rf "$cp1"; mkdir -p "$cp1/Assets/Planted"
printf 'not the vendor bytes\n' > "$cp1/Assets/Planted/other.bin"
printf 'fileFormatVersion: 2\nguid: %s\n' "$planted_guid" > "$cp1/Assets/Planted/other.bin.meta"
h0="$(tree_hash "$cp1/Assets")"
out="$(fetch "$slug1" "$cp1" 2>&1)"; rc=$?; h1="$(tree_hash "$cp1/Assets")"
[[ "$rc" == 3 && "$h0" == "$h1" ]] && check collision_refused PASS "exit 3, Assets tree hash unchanged (${h0:0:12})" \
  || check collision_refused FAIL "exit $rc (want 3), tree hash $([[ "$h0" == "$h1" ]] && echo unchanged || echo CHANGED)"
planted_before="$(sha256sum "$cp1/Assets/Planted/other.bin" "$cp1/Assets/Planted/other.bin.meta" | sha256sum)"
out="$(fetch "$slug1" "$cp1" VFX_ON_CONFLICT=skip 2>&1)"; rc=$?
planted_after="$(sha256sum "$cp1/Assets/Planted/other.bin" "$cp1/Assets/Planted/other.bin.meta" | sha256sum)"
[[ "$rc" == 0 && "$planted_before" == "$planted_after" ]] && check collision_skip PASS "VFX_ON_CONFLICT=skip: exit 0, planted file and .meta untouched" \
  || check collision_skip FAIL "exit $rc (want 0), planted $([[ "$planted_before" == "$planted_after" ]] && echo untouched || echo MODIFIED)"
cp2="$scratch/rerun"; rm -rf "$cp2"; mkdir -p "$cp2/Assets"
fetch "$slug1" "$cp2" >/dev/null 2>&1; h2="$(tree_hash "$cp2/Assets")"
out="$(fetch "$slug1" "$cp2" 2>/dev/null)"; rc=$?; h3="$(tree_hash "$cp2/Assets")"
r="$(js 'const j=JSON.parse(process.argv[1].trim().split("\n").pop());console.log("written="+j.written+" unchanged="+j.unchanged+" reused="+j.reused);process.exit(j.written===0&&j.unchanged>0?0:1)' "$out")"; rr=$?
[[ "$rc" == 0 && "$rr" == 0 && "$h2" == "$h3" ]] && check rerun_unchanged PASS "second plain run: exit 0, $r, tree hash unchanged" \
  || check rerun_unchanged FAIL "exit $rc, $r, tree hash $([[ "$h2" == "$h3" ]] && echo unchanged || echo CHANGED)"

# ---- 7. exit codes 0-7 of the fetch client: live probes for 1, 2, 5; the stub-server suite asserts 3, 4, 6, 7 (and 0..5 again)
cp3="$scratch/exitcodes"; rm -rf "$cp3"; mkdir -p "$cp3/Assets"
bash "$repo/scripts/vfx-fetch.sh" not-a-uri "$cp3" >/dev/null 2>&1; e2=$?
VFX_SERVER=http://127.0.0.1:9 bash "$repo/scripts/vfx-fetch.sh" "vfx://recipe/$slug1/1" "$cp3" >/dev/null 2>&1; e1=$?
bash "$repo/scripts/vfx-fetch.sh" vfx://recipe/namufx-stylized-water-water-splash-a/1 "$cp3" >/dev/null 2>&1; e5=$?
node --test "$repo/scripts/vfx-fetch-bundle.test.mjs" >"$scratch/exit-suite.log" 2>&1; esuite=$?
pass_n="$(grep -E '^ℹ pass ' "$scratch/exit-suite.log" | awk '{print $3}')"
[[ "$e2" == 2 && "$e1" == 1 && "$e5" == 5 && "$esuite" == 0 && "${pass_n:-0}" -gt 0 ]] \
  && check fetch_exit_codes PASS "live: usage=2 network=1 incomplete=5; stub suite (conflict 3, sha256 4, requires 6, guid_changed 7) ${pass_n} tests pass; 0 from every fetch above" \
  || check fetch_exit_codes FAIL "live usage=$e2 (2) network=$e1 (1) incomplete=$e5 (5); suite exit $esuite pass=${pass_n:-0}"

# ---- 8. recipe-built sample: the prefab came from the builder inside VFXAccept, not from the cloud
r="$(js 'const m=JSON.parse(require("fs").readFileSync(process.argv[1])).items["teleport-gate"];console.log(m.status+" "+m.systemsBuilt+"/"+m.layersInRecipe+" layers");process.exit(m.status==="built"&&m.systemsBuilt===m.layersInRecipe?0:1)' "$acc/_recipe-prefabs.json")" \
  && check recipe_built PASS "teleport-gate: $r (RecipePrefabBuilder in VFXAccept, textures via VFX_FETCH_LEGACY=1)" || check recipe_built FAIL "$r"

echo "phase 12: $failed failed of $total checks" >&2
exit "$failed"
