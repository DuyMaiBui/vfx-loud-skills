# Phase 3: Bulk uploader and closure verifier (lane U)

Lane: U
Depends-on: 1
Steps: lane-decides
Effort: L
Agent: `t1k-fullstack-developer`, worktree `../vfx-skill-cloud-worktrees/lane-U`.
Owns: `seed/upload-blobs.ts`, `seed/verify-closure.ts`, `seed/upload/**`
Creates: `seed/upload-blobs.ts`, `seed/verify-closure.ts`, `seed/upload/collect.ts`, `seed/upload/client.ts`, `seed/upload/urp.ts`, `seed/upload/upload.test.ts`, `seed/upload/verify.test.ts`
AX: AX-01 `--json` one-line summary on stdout; AX-10 `--help` lists flags and the exit codes of plan.md C7 (0 ok, 1 failures or sha mismatch, 2 usage, 75 server unavailable after retries)
Accept: `node seed/upload/upload.test.ts`

## Goal

Collect the bytes of every `asset` / `resource_asset` record and every recipe prefab from the on-disk sources, upload them idempotently, register them, and prove the stored closure is complete. READ-ONLY inputs: `seed/extract/source.ts` (phase 1), `packs.json`, `server/src/unity-refs.ts`, `bundle-contract.ts`, `seed/graph/rules`. Develops against a stub HTTP server built from the phase-1 contract fixture; the real server is exercised in phase 9.

## Steps

1. `collect.ts`: roots = SELECT (read-only `pg`) of `meta->'source'->>'prefabGuid'`, `meta->>'pack'` for every extracted recipe plus all `asset` guids; for each pack in `packs.json` build its `PackageSource` (unitypackage dir from `VFX_UNITYPACKAGE_DIR` default `/home/mike/Downloads/UnityPackages`; folder; folder-set with `preferCopy` = contains ParticleSystem/VisualEffect). Breadth-first closure using `scanRefs` on the TEXT kinds of each file (`prefab mat anim controller asset asmdef`); stop at builtin / package / unresolved GUIDs (recorded). D12: add the nearest ancestor `.asmdef` of every script and the asmdefs it references. Never read from `unity/VFXPreview/Assets/ImportedPacks` for `variant=original`; a source path under it is a hard error. D16: when `copiesOf(guid)` reports differing sha256 across sources the first source in configured order wins, the others are recorded in `source.copies` and listed in `plan.json`; a later differing registration is a `conflict`, never an automatic `replace`. Use `scanRefs` from `server/src/unity-refs.ts` only (it includes the Shader Graph form); no local regex.
2. Plan output (`--dry-run`, the default when no `--yes`): `data/upload/plan.json` and a table of files / bytes by kind and by pack, count of unresolved GUIDs with `referenced_by`, estimated blobs; `--skip-kinds audio,script` honoured.
3. Upload (`--yes`): hash locally, `POST /v1/blob/missing` in batches of 1000, `PUT /v1/blob/:sha` with concurrency 8 and `x-vfx-kind`, then `POST /v1/asset-file/batch` in batches of 200 with `license`/`visibility` from `packs.json` (default `studio-only`), `source:{game,origin}`. Idempotent by sha256; safe to re-run; `--limit N` (smoke, N files in closure order), `--pack`, `--resume`, retries with backoff on 5xx/`75`, key from `VFX_API_KEY`, server from `VFX_SERVER`.
4. URP variant: `--variant urp --urp-dir data/export/urp` reads `index.json` (C8), accepts an item only when `shader_guid` is a known package GUID and differs from `original_shader_guid`, uploads `<guid>.mat`, registers `variant:"urp"` with the original's `meta_sha256` and `urp:{rule,glow_cap:null}`.
5. `verify-closure.ts`: for each recipe (or `--sample N`, `--slugs a,b`, `--all`) `GET /v1/closure/...?variant=urp|original`, download every blob (in-memory cache by sha), verify sha256, re-scan refs of every file and assert each ref is in `files`, `requires` or builtin; writes `data/reports/closure-verify.json` `{checked, complete, incomplete:[{slug,reason,unresolved:[guid]}], sha_mismatch:[...]}` and, with `--record`, upserts `preview_render(state='failed', cause='closure-unresolved')` for incomplete slugs that have a prefab. Exit 1 when any sha mismatch; exit 0 otherwise (incompleteness is a finding).
6. Tests (stub server, temp source tree built from fixtures): closure order and kinds; `--limit`; idempotent second run uploads 0 bytes; sha mismatch injected in the stub -> exit 1; ImportedPacks source path refused; asmdef ancestor included; URP accept/reject criterion; verify detects a ref missing from the bundle (mutate the stub bundle: test goes red).
7. Branch `lane/U`, pathspec commit, push, report.

## Verification and falsifiability

`node seed/upload/upload.test.ts` is the single entry (it imports `verify.test.ts`). It goes red when: the ImportedPacks guard is removed (a Retro material read from ImportedPacks would be uploaded), the idempotency check is removed (second run uploads bytes), the C8 URP criterion is removed (a material still on the pack shader is accepted), or the verifier stops comparing re-scanned refs to `files`/`requires`.

## Estimates for the later full run (phase 9, stated here because the lane builds the knobs)

About 9k blobs / up to 1.6 GB raw (unverified until `--dry-run`); local PUT throughput unmeasured, the smoke N=5 reports per-file ms and the full-run ETA before the user's go-ahead.

## Rollback

Code only: drop branch `lane/U`. The bytes it uploads in phase 9 are additive; to undo, `DELETE FROM asset_file WHERE created_at >= <phase-9 start>` and `rm -rf data/blobs` (blobs are re-creatable from sources).
