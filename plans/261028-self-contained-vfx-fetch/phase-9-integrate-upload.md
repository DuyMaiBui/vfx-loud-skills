# Phase 9: Integration without Unity: merge lanes, migrate live DB, ingest game recipes, bulk upload, verify closure

Lane: serial
Depends-on: 2, 3, 4, 5, 6, 14
Gate: human
Effort: M
Agent: `t1k-git-manager` for the merge steps, `t1k-fullstack-developer` for the operational runs (it follows this file literally); the orchestrator asks the user at the two preview-first gates (steps 5 and 6).
Owns: `data/backups/` (gitignored), `data/upload/`, `data/reports/` (gitignored run outputs)
Creates: `scripts/accept/phase-9.sh`, `scripts/accept/pinned-baseline.json`, `scripts/accept/check-pinned-baseline.ts`, `scripts/accept/with-corpus-clone.sh`
AX: AX-01 `phase-9.sh` prints one `CHECK name PASS|FAIL` line per assertion; AX-10 exit code is the number of failed checks
Accept: `bash scripts/accept/phase-9.sh`

## Goal

The live cloud holds: migration 010, the 116+ game recipes (studio-internal, studio-only, `ai_training=false`), every needed byte for all extracted recipes (variant `original`), and a verified-complete closure report. No Unity needed.

## Steps

1. Backup first (before ANY command that reaches `migrate()`): `podman exec vfx-pg pg_dump -U vfx -Fc vfxcloud > data/backups/vfxcloud-pre-010-$(date +%y%m%d-%H%M).dump`, then `pg_restore --list` on it must list `resource` and `asset`; also `tar -C data -czf data/backups/data-recipes-pre-010.tgz recipe texture shader vfx component code technique skill` (the payload files; est. under 1 minute, DB 181 MB, data 110 MB). Record the baseline counts (`resource`, `asset`, `resource_asset`, `preview_gif`) in `data/reports/baseline.txt`.
2. Merge lanes S, U, G, P (and, since they are already done and independent, F, C, R) into integration branch `integ/self-contained-fetch` (git-manager; rebase onto `origin/main` first; conflicts: stop and report). Run `with-testdb.sh integ npm run check` and the suite on the merged head (scratch DB) THROUGH `check-pinned-baseline.ts` (profile `scratch-unseeded`, see plan.md `## Pinned baseline`): raw `npm test` is red by design there, the comparison by test name is the gate. Also run `bash scripts/accept/phase-14.sh` once (lane B's tools are not in `npm test`).
3. Stop any running server (`scripts/server.sh` status), start the merged server (`scripts/server.sh`), which applies migration 010 to the live DB; confirm `SELECT name FROM schema_migrations` now ends with `010_asset_blobs.sql` and `/healthz` returns the baseline `resources` count. Set `VFX_API_KEY` for the server and the clients (not `AUTH_DISABLED` for blob routes; D3).
4. Game recipes: `node seed/extract-unitypackage.ts --pack studio-game-vfx --out data/extract/studio-game-vfx` (no DB), then smoke `node seed/ingest-extracted.ts --in data/extract/studio-game-vfx --limit 5`, show the 5 rows (license, visibility, `meta.ai_training`), then the full ingest (116 or more; seconds), then `npm run graph:build` (compare `asset`/`resource_asset`/edge counts before and after in `data/reports/graph-delta.txt`; `applyAssets` deletes assets it does not recompute, so a drop in the existing 8 packs' counts is a failure: restore from backup).
5. Gate (human): `node seed/upload-blobs.ts` (dry-run) -> `data/upload/plan.json`: files/bytes by kind and pack, unresolved GUID count. Present the numbers (estimate was about 9k blobs, up to 1.6 GB raw) and the measured smoke time: `node seed/upload-blobs.ts --yes --limit 5` (5 files, per-file ms). Full-run ETA = files x ms; ask the user to proceed.
6. Full upload `node seed/upload-blobs.ts --yes --variant original` (idempotent; if interrupted re-run). Then the game-pack and namufx sources are included by `packs.json`. Output summary JSON saved to `data/reports/upload-original.json`.
7. Verify: `node seed/verify-closure.ts --sample 200 --record`, then `--all` (estimate: 3350 recipes; unmeasured, the sample reports the per-recipe time first). Save `data/reports/closure-verify.json`. Expected: `sha_mismatch=0`; `incomplete` listed with causes (these feed phase 11 as `closure-unresolved`).
8. Spot download by hand: `VFX_API_KEY=... bash scripts/vfx-fetch.sh vfx://recipe/<a retro-arsenal slug>/1 <scratch project dir under data/accept/spot>`, tree hash unchanged on second run.
8b. Full suite once against the integrated live-corpus state, WITHOUT touching live data: `scripts/accept/with-corpus-clone.sh` takes a fresh `pg_dump -Fc` of the live DB after step 7 (post-ingest, post-upload), restores it into scratch DB `vfxcloud_test_integ`, copies the payload dirs (`data/recipe texture shader vfx component code technique skill`, not `blobs`/`previews`) into a temp `DATA_DIR`, runs `migrate()` (this also exercises migration 010 on real data) and then `check-pinned-baseline.ts` with profile `corpus-clone`: the 9 corpus-dependent tests must be GREEN there (expected pin: empty). A red there is a real finding (stop and report), a green list is the evidence that the pinned reds are only the unseeded-corpus artefact. Estimate: dump/restore of a 181 MB DB plus the suite wall time, unmeasured; the scratch-unseeded run is the reference for suite time.
9. `scripts/accept/phase-9.sh` asserts (each prints PASS/FAIL): migration 010 applied once; `asset_file` count equals the upload summary; zero `asset_file` rows with `visibility='global'` or `ai_training`; every `studio-game-vfx` recipe has `license='studio-internal'` and `visibility='studio-only'`; `GET /v1/blob/<sha>` without key is 403 under `AUTH_DISABLED=1`; sampled closure has `sha_mismatch=0`; the count of the pre-existing 3248 recipes is unchanged; `check-pinned-baseline.ts` exits 0 for both profiles.

## "Would this go red if broken?"

Make one pinned test pass (or remove it from the suite) and the unseeded-profile check fails by name; make an unpinned test fail and it fails by name. Remove the always-keyed hook: check 5 fails. Corrupt one stored blob byte (scratch copy): `verify-closure` reports `sha_mismatch=1`. Upload a Retro material read from ImportedPacks instead of the unitypackage: the uploader refuses (phase 3 test) and a sha compare against the unitypackage entry in this phase would differ.

## Rollback

Code: drop the integration branch. Data: `pg_restore --clean --if-exists` of the backup inside the container (DB), `rm -rf data/blobs` (blobs are re-creatable), `rm -rf data/extract`. Additive uploads leave existing records untouched, so a partial failure needs no rollback beyond re-running.
