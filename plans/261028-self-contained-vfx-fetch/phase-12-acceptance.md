# Phase 12: Unity slot 3: clean-project acceptance

Lane: serial
Depends-on: 7, 11
Effort: M
Agent: `t1k-unity-base-developer` (Editor driver); a second Editor on the NEW project `unity/VFXAccept`, opened only after the VFXPreview Editor work is finished (D13); never touches the user's open Editor.
Owns: `unity/VFXAccept/` (gitignored), `data/accept/`
Creates: `scripts/make-accept-project.sh`, `scripts/accept/phase-12.sh`
AX: AX-01 `make-accept-project.sh` is idempotent and prints the project path; AX-10 `phase-12.sh` exit code is the number of failed checks
Accept: `bash scripts/accept/phase-12.sh`

## Goal

Prove goal 4 with a falsifiable end-to-end check: a recipe fetched into a project that has none of the pack files renders with no magenta, GUIDs intact, by both clients; and the same fetch of the unconverted variant DOES fail the gate.

## Steps

1. `scripts/make-accept-project.sh`: create `unity/VFXAccept` from `unity/VFXPreview/ProjectSettings` + `Packages/manifest.json` (URP) + a COPY of `Assets/Editor/VfxPreview` (renderer) + the client package as `file:` dependency; no ImportedPacks, no `Assets/VFXCloud`. First open imports from scratch (duration unknown; measure and report it).
2. Samples (9): 3 Retro Arsenal (one with `Archanor VFX/Retro Arsenal/BasicGlow`, one `Beam`, one `Powerbox`), 2 Epic Toon FX (one `ETFX_PowerboxUnlit`), 1 Sci-Fi Arsenal, 1 Synty Polygon, 1 `studio-game-vfx`, 1 namufx. Slug list stored in `data/accept/samples.json`; `make-accept-project.sh` also writes `data/accept/targets.json` (filter of `tools/preview/targets.json` by those slugs).
3. NEGATIVE CONTROL first: shell client with `VFX_VARIANT=original` into VFXAccept, Editor imports, render with `-vfxTargets data/accept/targets.json -vfxOut data/accept/previews-original`: the Retro/Epic Toon samples MUST report `unrenderable-material` or `magenta-pixel` (this proves the gate detects missing conversion). Then wipe `Assets/VFXCloud` (and its `.meta`) in VFXAccept.
4. Shell client, `VFX_VARIANT=urp` default, for the 9 samples: `bash scripts/vfx-fetch.sh <uri> unity/VFXAccept`; Editor refresh; render to `data/accept/previews-urp` with `-skipGifIngest`: `_status.json` `failed == 0` and `_failures.json` all `ok` (the batch's own pixel gate in `PreviewBatch` fails any clip with a magenta frame; no GIF/DB write happens in this phase).
5. GUID integrity (inside `phase-12.sh`): every `.meta` `guid:` under `Assets/VFXCloud` equals the `guid` the bundle declared for that path (the script re-fetches the bundle JSON with `curl -H "x-vfx-key: $VFX_API_KEY"` and compares with `grep`/`node` over files it writes under `data/accept/`).
6. Collision safety: plant a file with a bundle GUID but different bytes at another path, re-run the fetch: exit 3, tree hash of `Assets/` unchanged; with `VFX_ON_CONFLICT=skip` exit 0 and the planted file untouched; second plain run of a clean fetch: `unchanged` for all, exit 0.
7. Unity client path: wipe `Assets/VFXCloud`, compile the client package once (`t1k unity recompile`, `console` clean), then `-executeMethod VfxCloud.Editor.BatchFetch.Run -vfxUri <retro sample> -vfxVariant urp` (server and key from `VFX_SERVER` / `VFX_API_KEY`) for 2 samples (one Retro, one game); render them; same zero-magenta result; GUID assertion output present in `[VfxCloud] result`.
8. `scripts/accept/phase-12.sh` reads `data/accept/*.json` produced by steps 3-7 plus a re-hash of the project tree and prints PASS/FAIL for: control FAILED as required (>=1 magenta/unrenderable), urp samples 9/9 ok, GUID check, collision exit code 3 and tree hash equality, Unity-client samples ok, `complete:true` for all 9 bundles (or listed `requires` only).

## "Would this go red if broken?"

The control is the proof: if the urp variant were identical to the original, step 4 would fail like step 3. If the pre-flight were skipped, step 6 changes the tree hash. If `.meta` were regenerated, step 5 reports a different GUID.

## Rollback

Delete `unity/VFXAccept/` and `data/accept/` (gitignored, scratch). Nothing in the cloud is modified by this phase.
