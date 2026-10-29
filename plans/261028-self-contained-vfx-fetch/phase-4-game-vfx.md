# Phase 4: Game-VFX extractor changes (lane G)

Lane: G
Depends-on: 1
Steps: lane-decides
Effort: M
Agent: `t1k-fullstack-developer`, worktree `../vfx-skill-cloud-worktrees/lane-G`.
Owns: `seed/extract/recipe*.ts`, `seed/extract/unity-yaml*.ts`, `seed/extract/pipeline*.ts`, `seed/extract/ingest*.ts`, `seed/extract/nested*.ts`, `seed/extract-unitypackage.ts`, `seed/ingest-extracted.ts`
Creates: `seed/extract/nested.ts`, `seed/extract/nested.test.ts`
AX: AX-01 extractor summary line gains per-reason skip counts as JSON; AX-10 `--help` unchanged
Accept: `node seed/extract/nested.test.ts`

## Goal

All 161 unique GUIDs from the 7 game projects become recipes where they can (116 today), the skip reasons are exact, and the record carries `visibility=studio-only`. READ-ONLY: `source.ts` (`preferCopy`, `copiesOf`), `packs.json` (`visibility`). No DB writes in this phase (the ingest is phase 9).

## Steps

1. Visibility from pack: `pipeline.ts` sets `record.visibility = pack.visibility ?? 'project'`; `ingest.ts` stops hard-coding `'project'` (type `Visibility`), still rejecting `global`. Update `pipeline.test.ts` and `ingest.test.ts` assertions: `project` for packs without the field (unchanged), `studio-only` for studio-game-vfx. `source.test.ts` is phase 1's (read-only here; it already covers `preferCopy`).
2. D8: `pipeline.ts` passes `preferCopy` = the existing `vfx-components` predicate; `meta.source.games` unchanged; add `meta.source.copies:[{game,sha256}]` when copies differ. Test with two fake game roots where only the second copy has a ParticleSystem.
3. D10: reproduce the 4 `yaml-parse-error` prefabs (re-run `node seed/extract-unitypackage.ts --pack studio-game-vfx --out <tmp>` and list the skip lines that end in `[yaml-parse-error]`; the earlier run's log was session scratch and is not a dependency), classify (parser limit vs genuinely malformed), fix `unity-yaml.ts` with a regression test built from a trimmed copy of the failing construct, or skip with the precise parse reason.
4. D9: `nested.ts` classifies each of the 34 `nested-prefab-instance` skips: (a) variant of an extracted VFX prefab with only supported overrides, (b) gameplay prefab embedding VFX, (c) unsupported override path. Implement flatten for (a) in `recipe.ts` (base prefab + `m_Modification.propertyPath` overrides on ParticleSystem scalar/curve fields, Transform, name, active); (b)/(c) skip with reasons `gameplay-prefab` / `nested-override-unsupported:<path>`. Emit `data/extract/nested-report.json` (counts per class, per prefab path). If class (a) is empty the flatten code is not written (YAGNI) and the report says so.
5. Tests from real trimmed fixtures of the skipped files; the pipeline summary prints `skipped` by reason as JSON.
6. Run the extractor (no DB): `node seed/extract-unitypackage.ts --pack studio-game-vfx --out data/extract/studio-game-vfx`; record `ok / skipped by reason` in the lane report; expected `ok >= 116` and `yaml-parse-error` reduced or each explained.
7. Branch `lane/G`, pathspec commit, push, report (include the numbers).

## Falsifiable checks

`nested.test.ts` fails if a supported override is dropped (assert the flattened `startSize` equals the override value, not the base), if an unsupported path is flattened instead of skipped, and if `studio-only` falls back to `project`.

## Rollback

Code only; drop branch `lane/G`. `data/extract/` is scratch.
