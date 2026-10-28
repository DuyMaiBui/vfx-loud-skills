# Phase 13: Docs sync, final numbers, single PR

Lane: serial
Depends-on: 12
Effort: S
Agent: `t1k-docs-manager` (README/skills text), `t1k-git-manager` (commit, push, PR to `main`).
Owns: `README.md`, `skills/**`
Creates: `scripts/accept/phase-13.sh`
AX: AX-01 `phase-13.sh` prints one `CHECK name PASS|FAIL` line per assertion; AX-10 exit code is the number of failed checks
Accept: `bash scripts/accept/phase-13.sh`

## Goal

The docs say what the system now does, the numbers in them are the measured ones, and the work ships as one PR.

## Steps

1. README: replace the "metadata only / no bytes" statements, document `vfx_fetch` `variant` + `bundle`, `vfx-fetch.sh` environment and exit codes (C7), the Unity window options, uploader and verifier commands, backup command, `preview_render` and how to read failures (`SELECT cause, count(*) FROM preview_render WHERE state='failed' GROUP BY 1`), the restore-originals and export cycle. `skills/**`: the fetch and publish-back guidance (`skills/vfx-authoring`) gets the new fetch behaviour and the `requires`/`complete` semantics for agents.
2. Final numbers into README "Status" (from `data/reports/*.json`): recipes, game recipes added, blobs, bytes on disk, URP variants, failures by unfixable cause, previews count.
3. Final gates on the integration head (scratch DB): `npm run check`, `npm test`; live: `npm run previews:magenta` exit 0, `/healthz`.
4. `scripts/accept/phase-13.sh`: README mentions each C-section command it must (grep list kept in the script), the numbers in README equal the report files, `npm run check` clean.
5. Commit by pathspec, `git fetch origin` first, push the integration branch, open ONE PR to `main` (no `staging` branch on origin) with the plan link and the closing report; arm `--auto` only if the base has required checks.

## Verification and falsifiability

`phase-13.sh` goes red when a documented command is removed from the README (grep list), when a README number differs from `data/reports/*.json`, or when `npm run check` fails; it does not judge prose quality (the reviewer does).

## Rollback

Revert the docs commit; PR can be closed without effect on the live DB.
