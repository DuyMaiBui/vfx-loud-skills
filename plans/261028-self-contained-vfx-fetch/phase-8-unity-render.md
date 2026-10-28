# Phase 8: Unity preview code: failure persistence, URP export, restore originals (lane R, code only)

Lane: R
Depends-on: 1
Steps: lane-decides
Effort: L
Agent: `t1k-unity-base-developer` for the C# (shader/material work in a mono project), `t1k-fullstack-developer` for the TS scripts; one lane lead may split, worktree `../vfx-skill-cloud-worktrees/lane-R`. No Editor in this phase; first compile is phase 10.
Owns: `unity/VFXPreview/Assets/Editor/VfxPreview/*.cs`, `tools/preview/framing-tests/**`, `tools/preview/targets.ts`, `seed/preview-failures*.ts`, `scripts/preview-restore-originals*.ts`
Creates: `unity/VFXPreview/Assets/Editor/VfxPreview/RenderFailures.cs`, `unity/VFXPreview/Assets/Editor/VfxPreview/UrpExport.cs`, `seed/preview-failures.ts`, `seed/preview-failures-ingest.ts`, `seed/preview-failures.test.ts` (matched by the `seed/*.test.ts` glob of phase 1), `scripts/preview-restore-originals.ts`, `scripts/preview-restore-originals.test.ts` (matched by `scripts/*.test.ts`), `scripts/accept/phase-8.sh`
AX: AX-01 ingest and restore print a one-line JSON summary; AX-10 `--help` lists `--dry-run`, `--pack`
Accept: `bash scripts/accept/phase-8.sh`

## Goal

Make every render outcome durable and enumerable, make the URP output publishable, and make the in-place conversion reversible, so phases 10-11 can run on data instead of guesses. READ-ONLY: plan.md C8/C9/C10, `server/src/test-fixtures`.

## Steps

1. `RenderFailures.cs` + hooks in `PreviewCell`/`PreviewBatch`/`PreviewRunner`: record per target `state/cause/detail/shaders` (cause classes of C9: prefab missing, `Unrenderable` gate = `unrenderable-material` with shader names, magenta clip = `magenta-pixel`, exception, nothing visible) and write `<vfxOut>/_failures.json` atomically at the end of a run, merging into the previous file by slug (latest wins). Targets without a prefab path -> `skipped:no-prefab` (the DB has 11 recipe rows without `prefabGuid`); family variants are not targets (unchanged).
2. `PreviewOptions`/`BatchEntry`: `-vfxTargets`, `-vfxOut`, keep `-noConvert`/`-skipGifIngest`; `BatchEntry` calls `node seed/preview-failures-ingest.ts --json` after the render (best effort, same pattern as the GIF ingest).
3. `seed/preview-failures.ts` (pure: parse + validate `_failures.json`, SQL upsert builder) and `seed/preview-failures-ingest.ts` (`migrate()` is NOT called: the table comes from migration 010; it refuses a DB without it with a clear message). Test with fixtures against a scratch DB (`assertScratchDb()`): upsert idempotent, latest run wins, CHECK constraint violations rejected.
4. `MaterialMapping`/`MaterialConverter`: `GlowCap` becomes an option (`Options.GlowCap`, preview default 1.25, export `null`); unit tests added to `tools/preview/framing-tests` for the option and for each existing named rule (guards against regression when phase 11 adds rules). Where a built-in Standard/Particle shader has no named rule, delegate to Unity's own URP upgrader (`UniversalRenderPipelineMaterialUpgrader.StandardUpgrader` / `ParticleUpgrader` found in `Library/PackageCache/com.unity.render-pipelines.universal*`) instead of adding another hand mapping; the existing `IsUrpDrawable` gate stays.
5. `UrpExport.cs`: `VfxPreview.UrpExport.Run -vfxExport <dir>` converts every material under `Assets/ImportedPacks` with `GlowCap=null`, then for each material whose shader changed copies the serialized `.mat` bytes to `<dir>/<guid>.mat` and writes `index.json` per C8 (`rule`, `sha256`, `original_shader_guid`, `shader_guid`); exits 0. It assumes RESTORED originals (phase 11 step order).
6. `scripts/preview-restore-originals.ts`: for every `.mat` GUID under `Assets/ImportedPacks`, `GET /v1/asset-file/<guid>?variant=original`, download the blob, verify sha256, rewrite the file in place (keeping the `.meta`); `--dry-run` lists what would change; refuses to run if `VFX_API_KEY` is unset under auth. Test with a stub server.
7. `tools/preview/targets.ts`: emit every extracted recipe with a `prefabGuid` (already does) and ALSO list the recipes without a prefab as `{slug, prefabGuid:null}` so the run can record `skipped:no-prefab` (keeps the enumeration complete: rows in `preview_render` == recipes that are targets or skipped-by-design).
8. `scripts/accept/phase-8.sh`: `dotnet run --project tools/preview/framing-tests` and `with-testdb.sh R node seed/preview-failures.test.ts` (no Editor).
9. Branch `lane/R`, pathspec commit, push, report: "C# not compiled; phase 10 compiles once".

## Falsifiable check

`preview-failures.test.ts` fails if a `failed` item arrives without a `cause`, if an older run overwrites a newer one, or if `skipped` rows count as failures. The framing tests fail if `GlowCap=null` still caps at 1.25.

## Rollback

Drop branch `lane/R`; `restore-originals` is read-only on the cloud, rewrites only gitignored ImportedPacks files.
