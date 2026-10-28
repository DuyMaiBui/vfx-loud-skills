# Phase 6: Shell / Node fetch client (lane F)

Lane: F
Depends-on: 1
Steps: lane-decides
Effort: M
Agent: `t1k-fullstack-developer`, worktree `../vfx-skill-cloud-worktrees/lane-F`.
Owns: `scripts/vfx-fetch.sh`, `scripts/vfx-fetch-bundle.mjs`, `scripts/vfx-fetch-bundle.test.mjs`
Creates: `scripts/vfx-fetch-bundle.mjs`, `scripts/vfx-fetch-bundle.test.mjs`
AX: AX-01 last stdout line is the C7 JSON summary; AX-10 `--help` lists env vars and exit codes 0-7
Accept: `node scripts/vfx-fetch-bundle.test.mjs`

## Goal

`scripts/vfx-fetch.sh <vfx-uri> [project_root]` installs the whole bundle per plan.md C6/C7 with GUIDs preserved. READ-ONLY: `server/src/test-fixtures/bundle-sample.json`, `bundle-contract.ts` (reference only; the client stays dependency-free so it can be copied next to a game repo).

## Steps

1. `vfx-fetch-bundle.mjs` (Node, no dependencies, ES modules): GET `/v1/closure/<type>/<slug>/<version>?variant=`, validate the manifest by hand-written field checks mirroring C4 (unknown `schema` -> exit 1; accepts only `vfx-bundle/1`), compute the plan: pre-flight over the whole bundle (C6 a/b/c) by indexing existing `.meta` guids under `<project>/Assets` once; `VFX_DRY_RUN=1` prints it.
2. Download every blob (`Accept-Encoding: gzip`, `x-vfx-key`), verify sha256 of decompressed bytes against `sha256`/`meta_sha256` into `<project>/Temp/vfx-cloud-<rand>/`; on all-good, move pairs (`.meta` first, then asset) into `target_path` (or `reroot(target_path, VFX_ROOT)`, the pure function of plan.md C4) while writing a journal (`Temp/vfx-cloud-journal.json`); any failure in the move phase undoes the journal best-effort; an EXDEV rename falls back to copy-to-hidden-name-then-rename; a verify-phase abort leaves the project byte-identical. Print a warning when `Temp/UnityLockfile` exists (an open Editor can import between the two renames). After the move re-read every installed `.meta` and exit 7 (`guid_changed`, naming files) when a `guid:` differs from the bundle.
3. Conflict policy `VFX_ON_CONFLICT`; `requires` check against `<project>/Packages/manifest.json` (warn; exit 6 with `VFX_STRICT_REQUIRES=1`); `complete:false` -> exit 5 unless `VFX_ALLOW_INCOMPLETE=1`.
4. `vfx-fetch.sh` becomes a thin wrapper: argument checks as today (`vfx://type/slug/version`), then `exec node "$(dirname "$0")/vfx-fetch-bundle.mjs" "$@"`; `VFX_FETCH_LEGACY=1` keeps the previous body in a function so existing flows can be compared. The header comment documents the C7 environment and exit codes.
5. Tests with a local stub server serving the fixture: happy path writes N pairs in order; second run `unchanged`; GUID collision different sha -> exit 3 and a tree hash before/after equal; planted corrupt blob -> exit 4 and nothing written; `.meta` bytes equal the served bytes (guid preserved); `complete:false` -> exit 5; a stub that rewrites a `.meta` guid after the move (simulates the Editor race) -> exit 7; gzip and identity responses; `reroot` cases from `server/src/test-fixtures/reroot-cases.json` (phase 1, shared with lane C); missing key -> exit 1 with the 403 envelope shown.
6. Branch `lane/F`, pathspec commit, push, report.

## Falsifiable check

The collision test fails if the pre-flight is removed (a file would be written before the conflict is seen); the corrupt-blob test fails if verification happens after the move.

## Rollback

Drop branch `lane/F`; `VFX_FETCH_LEGACY=1` keeps the old behaviour in the same file.
