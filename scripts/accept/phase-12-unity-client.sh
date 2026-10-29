#!/usr/bin/env bash
# Phase 12 step 7: install bundles through the Unity client (VfxCloud.Editor.BatchFetch.Run) in unity/VFXAccept, one batch Editor run per sample.
# usage: bash scripts/accept/phase-12-unity-client.sh <slug>...      env: VFX_API_KEY (required), VFX_SERVER, VFX_VARIANT (default urp)
# Writes data/accept/unity-client/<slug>.json = the single `[VfxCloud] result {json}` line of the run plus `exit` (the Editor's exit code).
# Runs headless through the batch gate (installing files needs no rendering). Exit: number of samples whose Editor exit code was not 0.
set -uo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source /home/mike/.claude/scripts/unity-batch-gate.sh
unity="${UNITY_BIN:-/var/home/mike/Unity/Hub/Editor/6000.3.15f1/Editor/Unity}"
: "${VFX_API_KEY:?VFX_API_KEY must be set (read it from data/.vfx-api-key; never print it)}"
export T1K_UNITY_BATCH_TIMEOUT_SEC="${T1K_UNITY_BATCH_TIMEOUT_SEC:-900}"
out="$repo/data/accept/unity-client"; mkdir -p "$out" "$repo/data/accept/logs"
bad=0
for slug in "$@"; do
  log="$repo/data/accept/logs/unity-client-$slug.log"
  unity_batch_gate_run "$unity" -batchmode -nographics -quit -projectPath "$repo/unity/VFXAccept" -logFile "$log" \
    -executeMethod VfxCloud.Editor.BatchFetch.Run -vfxUri "vfx://recipe/$slug/1" -vfxVariant "${VFX_VARIANT:-urp}" >/dev/null 2>&1
  rc=$?
  line="$(grep -a '^\[VfxCloud\] result ' "$log" | tail -1 | sed 's/^\[VfxCloud\] result //')"
  node -e 'const l=process.argv[1];let j={};try{j=JSON.parse(l)}catch{j={parse_error:true}};j.exit=Number(process.argv[2]);require("fs").writeFileSync(process.argv[3],JSON.stringify(j,null,1))' "${line:-null}" "$rc" "$out/$slug.json"
  echo "$slug exit=$rc"
  [[ "$rc" == 0 ]] || bad=$((bad + 1))
done
exit "$bad"
