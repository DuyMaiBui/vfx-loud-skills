# Phase 11: Unity slot 2: fix failure classes, export + upload the URP variant, previews, GIF

Lane: serial
Depends-on: 10
Effort: L
Agent: `t1k-unity-base-developer` for the C# rule changes, `t1k-fullstack-developer` for scripts/uploads; Editor serialized after phase 10, before phase 12.
Owns: `unity/VFXPreview/Assets/Editor/VfxPreview/MaterialMapping.cs` and `MaterialConverter.cs` (lane R is finished, so this phase is their sole editor), `tools/preview/framing-tests/**`, `tools/preview/magenta-allow.txt`, `tools/preview/run.json`
Creates: `scripts/accept/phase-11.sh`
AX: AX-01 `phase-11.sh` prints the fixable-failure count as `FIXABLE=<n>`; AX-10 exit code is non-zero when `FIXABLE` is not 0
Accept: `bash scripts/accept/phase-11.sh`

## Goal

Zero failed slugs with a fixable cause; every remaining failure carries a documented unfixable cause; the published `urp` variant exists for every converted material; previews and GIFs exist for all new and previously failing slugs. At most 3 fix cycles.

## Fix classes (from phase 10's `render-failures.json`; the order is the expected size, confirm with data)

| Class | Detection | Fix |
|---|---|---|
| A. built-in shader with no named rule (Sci-Fi Arsenal, Hovl, Lana, Synty variants) | `unrenderable-material` + shader name | add a named rule in `MaterialMapping.cs` for pack shaders whose maths is known; otherwise route Standard/Particle shaders through Unity's URP `StandardUpgrader`/`ParticleUpgrader`; each rule gets a `framing-tests` case |
| B. magenta from custom shader that fails to compile in URP | `magenta-pixel` with a `.shader`/Shader Graph in the closure | map to a rule (A) or mark `unfixable-shader` with the compile error in `detail` |
| C. prefab or material absent from ImportedPacks | `prefab-missing` | re-materialize from the cloud (`vfx-fetch.sh`, step 2 of phase 10) |
| D. source asset absent (reference to a texture/material that no source holds) | `closure-unresolved` | cannot be fixed by code; record `unfixable-source` (C9 enum; `unfixable-shader` for class B, `unfixable-script` for scripts needing a missing plugin) and the GUIDs; recipe stays listed with `complete:false` |
| E. nothing visible / script-driven | `no-visible-output` | framing or `Simulate` limit: documented, add to `magenta-allow.txt` only if the slug is genuinely magenta by design |

## Cycle (repeat up to 3 times; each cycle ends with the numbers in `data/reports/cycle-<n>.txt`)

1. Restore originals: `node scripts/preview-restore-originals.ts` (rewrites materials under ImportedPacks from the cloud's vendor bytes; Editor refreshes).
2. Export the publishable conversion: `VfxPreview.UrpExport.Run -vfxExport data/export/urp` (uncapped glow, C8).
3. Restore originals again, then preview conversion (`MaterialConverter.ConvertAll`, glow cap 1.25) as `BatchEntry` does.
4. Edit rules for the top class, one batched compile (`t1k unity recompile`), `dotnet run --project tools/preview/framing-tests`.
5. Render only the failing slugs (`run.json` `only: [slugs]`, `force: true`); ingest `_failures.json`; GIF ingest.
6. Stop when `FIXABLE=0` or after cycle 3 (then report the leftovers instead of looping).

## After the last cycle

7. Upload the URP variant (smoke then full; count = number of changed materials, expected on the order of hundreds): `node seed/upload-blobs.ts --yes --variant urp --urp-dir data/export/urp --limit 5` then without `--limit`. Re-run `node seed/verify-closure.ts --all --record` for `variant=urp`.
8. Previews for all new + previously failing slugs: a final render of the union (`only`) then `npm run previews:gif`; `npm run previews:magenta` must exit 0. Variants (1547) keep borrowing the canonical GIF (`viaFamily`), unchanged by design.
9. `scripts/accept/phase-11.sh`: `FIXABLE = count(preview_render WHERE state='failed' AND cause NOT LIKE 'unfixable-%')` must be 0; `previews:magenta` exit 0; every extracted target slug has a `preview_gif` row or an `unfixable-*`/`skipped` row; URP variant count in `asset_file` equals the export `index.json` item count; every `asset_file` `variant='urp'` row has `urp->>'shader_guid'` present in `unity-package-guids.json`.

## "Would this go red if broken?"

Revert one rule edit: that class's slugs reappear as `failed` in the next render (`FIXABLE>0`). Publish a urp row with the original shader: the C8 criterion rejects it at upload (phase 3 test) and `phase-11.sh` finds none. Delete a GIF row: the slug-coverage check fails.

## Rollback

`git checkout -- <rule files>`; ImportedPacks: run `preview-restore-originals.ts` to return to vendor bytes; DB: `DELETE FROM asset_file WHERE variant='urp'`; `preview_render` rows are replaced by the next run; previews are idempotent.
