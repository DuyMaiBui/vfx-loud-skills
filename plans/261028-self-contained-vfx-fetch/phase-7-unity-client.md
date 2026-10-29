# Phase 7: Unity client package (lane C, code only)

Lane: C
Depends-on: 1
Steps: lane-decides
Effort: M
Agent: `t1k-unity-base-feature-implementer` (C# only, no Editor), worktree `../vfx-skill-cloud-worktrees/lane-C`. Editor compile happens in phase 12.
Owns: `unity/Packages/com.mike.vfx-cloud/**`, `tools/vfxcloud-tests/**`
Creates: `unity/Packages/com.mike.vfx-cloud/Editor/VfxCloudBundle.cs`, `unity/Packages/com.mike.vfx-cloud/Editor/VfxCloudInstaller.cs`, `unity/Packages/com.mike.vfx-cloud/Editor/VfxCloudBatchFetch.cs`, `tools/vfxcloud-tests/Program.cs`, `tools/vfxcloud-tests/VfxCloudTests.csproj`, `scripts/accept/phase-7.sh`
AX: AX-01 `BatchFetch.Run` prints one `[VfxCloud] result {json}` line and exits non-zero on failure; AX-10 arguments listed in the class summary
Accept: `bash scripts/accept/phase-7.sh`

## Goal

The Unity window installs a whole bundle with the C6/C7 semantics, from pure logic that is testable with plain `dotnet`. READ-ONLY: plan.md Contract, `server/src/test-fixtures/bundle-sample.json`.

## Steps

1. Pure logic (no `UnityEngine`/`UnityEditor`) in `VfxCloudBundle.cs`: DTOs for C4 (Newtonsoft; add `com.unity.nuget.newtonsoft-json` to the client package's own `unity/Packages/com.mike.vfx-cloud/package.json` dependencies, `VfxPreview` already uses it), `Plan(bundle, projectIndex, policy)` returning per-file `Install | Unchanged | Reused | Conflict | Skip`, `TargetPath(file, root)` implementing the pure `reroot` of plan.md C4 (cases from `server/src/test-fixtures/reroot-cases.json`, phase 1), sha256 helper. `tools/vfxcloud-tests` compiles that file with plain `dotnet` (same approach as `tools/preview/framing-tests`) and asserts the fixture plan, the three conflict policies, and the "refuse writes nothing" rule.
2. `VfxCloudInstaller.cs` (Editor): reads settings (add `ApiKey` and `Variant` default `urp`, `OnConflict` default `refuse` to `VfxCloudSettings`; send `x-vfx-key`), GETs the closure, builds the project index from `AssetDatabase.FindAssets` + `AssetDatabase.GUIDToAssetPath`, downloads blobs to `Temp/vfx-cloud-<rand>/`, verifies sha256, moves `.meta` then asset, the whole move wrapped in `AssetDatabase.StartAssetEditing()` / `StopAssetEditing()` (finally), a journal with best-effort undo as in C7, ONE `AssetDatabase.Refresh()`, asserts `AssetPathToGUID(path) == guid` for every installed file, reports the result structure. `VfxCloudFetcher.Fetch(uri)` delegates to the installer for any `vfx://` URI (single-file legacy path kept behind `useLegacy`).
3. `VfxCloudFetchWindow.cs`: fields API key, variant, on-conflict dropdown, progress, result list with `requires` warnings.
4. `VfxCloudBatchFetch.cs`: `VfxCloud.Editor.BatchFetch.Run` per C10 (`-vfxUri`, `-vfxVariant`, `-vfxOnConflict`, `-vfxServer`, `-vfxKey`), exits `EditorApplication.Exit(code)` with codes aligned to C7.
5. `scripts/accept/phase-7.sh`: `dotnet run --project tools/vfxcloud-tests` (no Editor).
6. Branch `lane/C`, pathspec commit, push, report. Note in the report: "not compiled in Unity yet; phase 12 compiles it once".

## Falsifiable check

The dotnet test fails if `Plan` returns `Install` for a GUID already present with different bytes under `refuse`, or if a conflict plan lists any write.

## Rollback

Drop branch `lane/C`; the package is unreferenced by VFXPreview until phase 12 adds it to the clean project only.
