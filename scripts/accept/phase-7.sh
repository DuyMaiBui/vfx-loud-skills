#!/usr/bin/env bash
# Phase 7 acceptance (plans/261028-self-contained-vfx-fetch/phase-7-unity-client.md): pure-logic tests of the Unity client, no Editor.
# Usage: bash scripts/accept/phase-7.sh
# Exit codes: 0 all tests passed; otherwise the failing step's exit code.
# The Editor-side files (Installer, BatchFetch, Window) are compiled once in phase 12 in a clean project.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$repo" || exit 1

echo "== phase 7: vfxcloud pure-logic tests (dotnet)" >&2
dotnet run --project tools/vfxcloud-tests || exit $?

echo "phase 7: PASS (not compiled in Unity yet; phase 12 compiles the Editor files once)" >&2
