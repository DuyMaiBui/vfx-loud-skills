# Phase 5: Unity package GUID map (lane P)

Lane: P
Depends-on: 1
Steps: lane-decides
Effort: M
Agent: `t1k-fullstack-developer`, worktree `../vfx-skill-cloud-worktrees/lane-P`.
Owns: `seed/extract/package-guids*.ts`, `server/src/unity-package-guids.json`
Creates: `seed/extract/package-guids.ts`, `seed/extract/package-guids.test.ts`
AX: AX-01 `--json` prints the classification counts; AX-10 `--help` lists `--full` and `--out`
Accept: `node seed/extract/package-guids.test.ts`

## Goal

Resolve the GUIDs that the 86 game prefabs reference but that live outside the game `Assets/` folders (package or built-in shaders and materials), producing the map the server uses to fill `requires` instead of reporting `unresolved`. READ-ONLY: `unity-refs.ts` (shape + loader), `packs.json` (game roots). Sole writer of `server/src/unity-package-guids.json` from now on.

## Steps

1. Candidate GUID set: scan every `.prefab`, `.mat`, `.anim`, `.controller` reachable from the 116+38 game prefabs and from the pack closures (same `scanRefs`), subtract GUIDs defined by any `.meta` under the game `Assets/` roots and the pack sources and the builtin pattern: the remainder is the "outside" set (expected to contain the 86 prefabs' references).
2. Sources for names: (a) `unity/VFXPreview/Library/PackageCache/*/**/*.meta` (URP, core, shadergraph, TMP, etc., with `package@version` from the folder name), (b) each game's `Library/PackageCache` and `Packages/packages-lock.json` if present, (c) a small hand-kept table of Unity built-in constants (default resources, `0000000000000000e000000000000000` extra, `...f...` default) with fileID names where known.
3. Output (`--out`, default the server JSON): only the REFERENCED subset (auditable, small) with `{kind:'package'|'builtin', name (shader/material display name read from the `.shader` first line or `.mat` m_Name), package, version, path}`; `--full` dumps every PackageCache GUID. Include the URP `Particles/Unlit` shader (`0406db5a14f94604a8c57ccfbc9f3b46`) and the URP Lit shader always, because the C8 URP criterion needs them.
4. Report (stdout, `--json`): outside GUIDs total, mapped by package, UNMAPPED list with `referenced_by` prefab paths. Unmapped GUIDs are not guessed; they stay `unresolved` at bundle time and the lane report lists which recipes they affect (feeds open question 3).
5. Tests: fixture PackageCache tree (two packages) -> expected map; a GUID defined in a game folder is not classified as package; unmapped stays out of the JSON.
6. Branch `lane/P`, pathspec commit, push, report with the counts (this is the "package GUID map" deliverable, item (d)).

## Falsifiable check

`package-guids.test.ts` fails if a game-defined GUID leaks into the package map or an unmapped GUID gets an invented name.

## Rollback

Code + one JSON file; drop branch `lane/P`.
