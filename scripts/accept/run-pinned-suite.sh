#!/usr/bin/env bash
# Deterministic pinned-baseline measurement (plan.md D19, phase 9 step 2). Runs EVERY test file of `npm test` in its OWN
# fresh, migrated scratch DB (with-testdb.sh), merges the junit, and feeds check-pinned-baseline.ts (profile scratch-unseeded).
# Why per file: node --test runs files against ONE shared DB and some files (bundle-builder.test.ts) leave recipe rows
# behind, which silently turned the pinned preview-gif reds green by order/state (never a real fix). A pin is only
# meaningful against the unseeded state it names, so each file gets exactly that.
#
# Usage: run-pinned-suite.sh [--profile scratch-unseeded] [--list "<space separated test files>"]
# Exit: the checker's (0 clean, 1 differences, 2 usage). Never touches the live DB (scratch DBs vfxcloud_test_pin<N>).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$repo" || exit 1
profile=scratch-unseeded
list=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) profile="$2"; shift 2 ;;
    --list) list="$2"; shift 2 ;;
    *) echo "usage: run-pinned-suite.sh [--profile P] [--list \"files\"]" >&2; exit 2 ;;
  esac
done
if [[ -z "$list" ]]; then
  # the file globs of the `npm test` script, so the pin covers exactly what npm test runs
  list="$(node -e "const s=require('./package.json').scripts.test;process.stdout.write(s.replace(/^node --test /,''))")"
  list="$(shopt -s nullglob; for g in $list; do ls $g; done | tr '\n' ' ')"
fi
out="$(mktemp)"
trap 'rm -f "$out"' EXIT
n=0
for f in $list; do
  n=$((n + 1))
  bash "$here/with-testdb.sh" "pin$n" node --test --test-reporter=junit "$f" >>"$out" 2>/dev/null || true
done
echo "[run-pinned-suite] ran $n files, one fresh scratch DB each" >&2
node scripts/accept/check-pinned-baseline.ts --profile "$profile" --junit "$out"
