# Phase 10: Unity slot 1: import game pack, compile once, fresh full render, enumerate failures

Lane: serial
Depends-on: 6, 8, 9
Gate: human
Effort: M
Agent: `t1k-unity-base-developer` (Editor driver) with `t1k-unity-base-mono-tester` style verification by the orchestrator; Editor is windowed (rendering) and serialized with phases 11-12.
Owns: `tools/preview/run.json`, `unity/VFXPreview/Assets/ImportedPacks/studio-game-vfx/` (gitignored)
Creates: `scripts/accept/phase-10.sh`
AX: AX-01 `phase-10.sh` prints counts as `KEY=value` lines; AX-10 exit code is the number of failed checks
Accept: `bash scripts/accept/phase-10.sh`

## Goal

A fresh full render of every target (about 1690 existing + about 116 game) with a durable per-slug outcome in `preview_render`, and the failure classes enumerated with counts. No fixes yet.

## Steps

1. Editor state: `t1k unity instance list` for `unity/VFXPreview`. Open by the user -> drive it with the `t1k unity` CLI, never restart/kill it; not open -> launch windowed (Xvfb only if no display; `-batchmode` fails on this licence per README). No `Assets/Reimport All`.
2. Materialize the game pack in the preview project FROM THE CLOUD (the bytes now live there): for each game recipe `VFX_API_KEY=... VFX_VARIANT=original VFX_ROOT=Assets/ImportedPacks/studio-game-vfx bash scripts/vfx-fetch.sh vfx://recipe/<slug>/1 unity/VFXPreview` (loop over the slugs from the DB; many files repeat: `unchanged`/`reused`). Dependencies-first order is guaranteed by the bundle; run the loop once, then the Editor imports in one go. Do the same for the 10 namufx slugs whose prefabs are absent.
3. Regenerate targets: `node tools/preview/targets.ts` (includes game recipes and the no-prefab rows from lane R); targets count printed.
4. One batched compile of all lane-R C# (lane C's package is not referenced by VFXPreview; it compiles in phase 12) (`t1k unity recompile`, then `t1k unity console` for errors; fix in one batch by re-briefing lane R's agent, not here). Run the framing/logic tests again in the Editor-free `dotnet` project.
5. Smoke render: `tools/preview/run.json` `{"only": [16 slugs: 4 per big pack + 2 game + 2 namufx], "force": true, ...}`, run `Tools/VFX Preview/2. Render Previews` (or `BatchEntry.Run` windowed with `-packs none -vfxOut data/previews`), show `_status.json` + `_failures.json` rows. Estimate for the full run: 1806 clips x 0.349 s (measured on 517 clips, 180.6 s) = about 10.5 min plus GIF ingest of about 1.8k webm (unmeasured). Gate (human): go-ahead for the full run.
6. Full render: `run.json` `only: []`, `force: true`, `-packs none`; wait for `_status.json` `state: done`. GIF ingest runs at the end (`-skipGifIngest` not set); `node seed/preview-failures-ingest.ts --json` persists `_failures.json` to `preview_render`.
7. Enumerate: write `data/reports/render-failures.json` (counts by `cause`, by `shaders[]`, by pack; slugs list) from `preview_render` plus the `closure-unresolved` rows of phase 9. Save the compile log and `_status.json` copy next to it. Expected buckets from the evidence so far: 10 namufx prefab-missing (should now be 0 after step 2), 11 recipe rows without `prefabGuid` as `skipped:no-prefab` (10 hand-written slugs; `rod-twinkle-box` has a v2), 23 probe dirs not in DB (excluded), plus whatever the fresh run reveals (unknown today: the magenta scan of the 1680 existing GIFs is 0, but the 1590 unrendered were never gated).

## Falsifiable checks (`phase-10.sh`)

1. `count(preview_render) == count(targets) + count(no-prefab recipes)` (coverage; red if the persistence hook is broken).
2. Every `failed` row has a non-null `cause` and `run_id` of this run.
3. `_status.json` `ok + failed == total` and `state == 'done'`.
4. `npm run previews:magenta -- --json` exit 0 (no stored GIF is magenta).
5. The report file exists and its totals equal the table counts.

## Rollback

`DELETE FROM preview_render WHERE run_id = '<this run>'`; restore `tools/preview/run.json` from git; ImportedPacks/studio-game-vfx is gitignored (delete to undo); previews/GIFs are idempotent and overwritten by later runs. Data backup of phase 9 still valid.
