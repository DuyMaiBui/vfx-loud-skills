#!/usr/bin/env bash
# Phase 14 acceptance (plans/261028-self-contained-vfx-fetch/phase-14-recipe-prefab-builder.md): unit tests only, no Editor, no DB.
# The C# builder is NOT compiled here (phase 10 compiles it in Unity); the pure planner is compiled and run with plain dotnet.
#
# Usage: bash scripts/accept/phase-14.sh
# Exit codes: 0 all steps passed; otherwise the exit code of the first failing step.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$repo" || exit 1

specs="$(mktemp -d)"
trap 'rm -rf "$specs"' EXIT

echo "== phase 14: node tests (recipe-spec, merge-targets)" >&2
node --test tools/recipe-prefab/recipe-spec.test.ts tools/recipe-prefab/merge-targets.test.ts || exit $?

echo "== phase 14: recipe-spec CLI over the 10 fixtures (must report no unsupported)" >&2
node tools/recipe-prefab/recipe-spec.ts --recipes tools/recipe-prefab/fixtures --out "$specs" --empty-control || exit $?

echo "== phase 14: dotnet planner checks" >&2
dotnet run --project tools/recipe-prefab/tests -- "$specs" || exit $?

echo "phase 14: PASS" >&2
