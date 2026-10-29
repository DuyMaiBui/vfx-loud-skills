#!/usr/bin/env bash
# Foreground runner for the VFX Skill Cloud dev server. Used by the systemd user unit
# (scripts/systemd/vfx-skill-cloud.service) and safe to run by hand.
#
# Reads VFX_API_KEY from data/.vfx-api-key (mode 600, gitignored). The key is never echoed,
# never written to a log, and never passed on argv. Missing or empty key → exit 1 with a message
# naming the file, not the value. Keeps AUTH_DISABLED=1 (same env as scripts/server.sh start).
# `exec` so the node process IS the unit's main process: systemd stop/restart signal it directly.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY_FILE="$ROOT/data/.vfx-api-key"

if [[ ! -r "$KEY_FILE" ]]; then
  echo "server-run: $KEY_FILE is missing or unreadable; create it (mode 600) before starting the server" >&2
  exit 1
fi

VFX_API_KEY=""
read -r VFX_API_KEY <"$KEY_FILE" || true
if [[ -z "$VFX_API_KEY" ]]; then
  echo "server-run: $KEY_FILE is empty" >&2
  exit 1
fi
export VFX_API_KEY
export AUTH_DISABLED=1

cd "$ROOT"
exec node server/src/index.ts
