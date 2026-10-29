#!/usr/bin/env bash
# Render a targets file in the clean acceptance project (windowed Editor on $DISPLAY: rendering needs a real frame; Xvfb is not installed here).
# usage: bash scripts/accept/phase-12-render.sh <targets.json> <out-dir> <log-name>   (paths relative to the repo root)
# The Editor runs VfxPreview.BatchEntry.Run with -packs none -noConvert (no in-place conversion: the fetched bytes are what gets rendered) and
# -skipGifIngest. DATABASE_URL points at a database that does not exist so the best-effort failure ingest at the end can never write the live DB.
# Exit: the Editor's exit code (0 ok, 1 failed targets, 2 timeout).
set -uo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
targets="${1:?targets.json}"; out="${2:?out dir}"; name="${3:?log name}"
unity="${UNITY_BIN:-/var/home/mike/Unity/Hub/Editor/6000.3.15f1/Editor/Unity}"
mkdir -p "$repo/data/accept/logs"
export DISPLAY="${DISPLAY:-:0}"
# Userinfo from PGUSER/PGPASSWORD, dev defaults vfx/vfx (the local vfx-pg container, scripts/dev-db.sh).
pg_userinfo="${PGUSER:-vfx}:${PGPASSWORD:-vfx}"
export DATABASE_URL="postgres://${pg_userinfo}@127.0.0.1:5432/vfxaccept_nonexistent"
exec "$unity" -projectPath "$repo/unity/VFXAccept" -logFile "$repo/data/accept/logs/$name.log" \
  -executeMethod VfxPreview.BatchEntry.Run -packs none -noConvert -skipGifIngest -vfxTargets "$targets" -vfxOut "$out"
