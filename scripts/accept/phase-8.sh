#!/usr/bin/env bash
# Phase 8 acceptance (plans/261028-self-contained-vfx-fetch/phase-8-unity-render.md). No Unity Editor is started.
#
# Usage: bash scripts/accept/phase-8.sh
# Exit codes: 0 all steps passed; otherwise the exit code of the first failing step (see with-testdb.sh).
# DB-backed steps run on a scratch DB (vfxcloud_test_r), never on the live vfxcloud DB.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$repo" || exit 1

echo "== phase 8: C# pure-logic checks (framing, magenta, material mapping)" >&2
dotnet run --project tools/preview/framing-tests || exit $?

echo "== phase 8: restore-originals test (stub server, no DB)" >&2
node scripts/preview-restore-originals.test.ts || exit $?

echo "== phase 8: render-failure ingest on a migrated scratch DB" >&2
bash "$here/with-testdb.sh" r node seed/preview-failures.test.ts || exit $?

echo "phase 8: PASS (C# not compiled here: the first Editor compile is phase 10)" >&2
