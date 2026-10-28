# Phase 10: Unity slot 1: import game pack, compile once, fresh full render, enumerate failures

Lane: serial
Depends-on: 6, 8, 9, 14
Gate: human
Effort: M
Agent: `t1k-unity-base-developer` (Editor driver) with `t1k-unity-base-mono-tester` style verification by the orchestrator; Editor is windowed (rendering) and serialized with phases 11-12.
Owns: `tools/preview/run.json`, `unity/VFXPreview/Assets/ImportedPacks/studio-game-vfx/` (gitignored)
Creates: `scripts/accept/phase-10.sh`
Also runs (does not own): lane B's `RecipePrefabBuilder` (phase 14) for the 10 hand-written recipes
AX: AX-01 `phase-10.sh` prints counts as `KEY=value` lines; AX-10 exit code is the number of failed checks
Accept: `bash scripts/accept/phase-10.sh`

## Goal

A fresh full render of every target (1690 existing + 116 game + the 10 recipe-built = 1816 clips) with a durable per-slug outcome in `preview_render`, and the failure classes enumerated with counts. No fixes yet.

## Steps

1. Editor state: `t1k unity instance list` for `unity/VFXPreview`. Open by the user -> drive it with the `t1k unity` CLI, never restart/kill it; not open -> launch windowed (Xvfb only if no display; `-batchmode` fails on this licence per README). No `Assets/Reimport All`.
2. Materialize the game pack in the preview project FROM THE CLOUD (the bytes now live there): for each game recipe `VFX_API_KEY=... VFX_VARIANT=original VFX_ROOT=Assets/ImportedPacks/studio-game-vfx bash scripts/vfx-fetch.sh vfx://recipe/<slug>/1 unity/VFXPreview` (loop over the slugs from the DB; many files repeat: `unchanged`/`reused`). Dependencies-first order is guaranteed by the bundle; run the loop once, then the Editor imports in one go. Do the same for the 10 namufx slugs whose prefabs are absent.
2b. Hand-written recipes (lane B): fetch each recipe's textures and nested `vfx` prefabs with the legacy closure into the preview project: `VFX_FETCH_LEGACY=1 VFX_API_KEY=... bash scripts/vfx-fetch.sh vfx://recipe/<slug>/1 unity/VFXPreview` for the 10 slugs (D18), then `node tools/recipe-prefab/recipe-spec.ts --out data/previews/recipe-specs` (non-zero exit lists unsupported constructs; those slugs will be skipped, not partial).
3. Regenerate targets: `node tools/preview/targets.ts` (includes game recipes and, from lane R, the hand-written recipes as `prefabGuid:null`); targets count printed (expected 1806 rows before the merge in step 4b).
4. One batched compile of all lane-R C# (lane C's package is not referenced by VFXPreview; it compiles in phase 12) (`t1k unity recompile`, then `t1k unity console` for errors; fix in one batch by re-briefing lane R's agent, not here). Run the framing/logic tests again in the Editor-free `dotnet` project.
4b. Build the recipe prefabs: Editor `VfxPreview.RecipePrefabBuilder.Run -vfxSpecs data/previews/recipe-specs -vfxOut data/previews/_recipe-prefabs.json` (it was compiled with step 4), then `node tools/recipe-prefab/merge-targets.ts` (rewrites `tools/preview/targets.json` in place: built slugs get their prefab guid; expected 1816 rows with a prefab guid, fewer only for builder-skipped slugs which keep `prefabGuid:null` and the builder's reason). Control: `RecipePrefabBuilder.Run --empty-control` renders a zero-layer prefab into `-vfxOut data/previews-control` (no GIF ingest, not persisted) and MUST report `no-visible-output`.
5. Smoke render: `tools/preview/run.json` `{"only": [18 slugs: 4 per big pack + 2 game + 2 namufx + 2 recipe-built (`teleport-gate`, `hit-spark`)], "force": true, ...}`, run `Tools/VFX Preview/2. Render Previews` (or `BatchEntry.Run` windowed with `-packs none -vfxOut data/previews`), show `_status.json` + `_failures.json` rows. Estimate for the full run: 1816 clips x 0.349 s (measured on 517 clips, 180.6 s) = about 10.6 min plus GIF ingest of about 1.8k webm (unmeasured). Gate (human): go-ahead for the full run.
6. Full render: `run.json` `only: []`, `force: true`, `-packs none`; wait for `_status.json` `state: done`. GIF ingest runs at the end (`-skipGifIngest` not set); `node seed/preview-failures-ingest.ts --json` persists `_failures.json` to `preview_render`.
7. Enumerate: write `data/reports/render-failures.json` (counts by `cause`, by `shaders[]`, by pack; slugs list) from `preview_render` plus the `closure-unresolved` rows of phase 9. Save the compile log and `_status.json` copy next to it. Expected buckets from the evidence so far: 10 namufx prefab-missing (should now be 0 after step 2), the 10 hand-written slugs now `ok` via the builder (any builder-skipped slug stays `skipped:no-prefab` with `detail='recipe-builder: <reason>'`; `rod-twinkle-box` has a v1 and a v2 sharing one preview slug), plus whatever the fresh run reveals (unknown today: the magenta scan of the 1680 existing GIFs is 0, but the 1590 unrendered were never gated).

## Falsifiable checks (`phase-10.sh`)

1. `count(preview_render) == count(distinct slugs in the merged targets) + count(builder-skipped slugs)` (coverage by slug; red if the persistence hook is broken).
1b. Recipe-built checks: `_recipe-prefabs.json` has `systemsBuilt == layersInRecipe` for every built slug; the 10 slugs are `ok` or builder-skipped with a reason; each `ok` one has a `preview_gif` row; the `--empty-control` result is `no-visible-output`.
2. Every `failed` row has a non-null `cause` and `run_id` of this run.
3. `_status.json` `ok + failed == total` and `state == 'done'`.
4. `npm run previews:magenta -- --json` exit 0 (no stored GIF is magenta).
5. The report file exists and its totals equal the table counts.

## Rollback

`DELETE FROM preview_render WHERE run_id = '<this run>'`; restore `tools/preview/run.json` from git; ImportedPacks/studio-game-vfx is gitignored (delete to undo); previews/GIFs are idempotent and overwritten by later runs. Data backup of phase 9 still valid.
