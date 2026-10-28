# Plan: Self-contained VFX fetch (bytes in the cloud, closure download, game-VFX ingest, render-failure fixes)

Hardness: phases=14 new=8 modules=0 lanes=8
Flags: --auto

Repo: `/var/home/mike/Documents/Work/The1/vfx-skill-cloud` (Node 26 TS-stripping server, Postgres in podman `vfx-pg`, Unity 6000.3.15f1 preview project, Unity client package). Branch base: current `fix/preview-magenta-materials` (clean). Delivery: one PR to `main` (origin has no `staging` branch: `git ls-remote --heads origin staging` empty, 2026-10-28).

## Goal (decided by the owner; not re-asked)

1. Upload the studio game VFX (7 game projects, 161 unique GUIDs, 116 extractable now) to the local cloud with previews, license `studio-internal`, `ai_training=false`.
2. The 3270 recipes already in the cloud (3248 DB rows; 8 packs) are previewable and downloadable.
3. Recipes that fail to render (magenta / missing shader / missing material / missing texture) are fixed.
4. A downloaded recipe (`vfx_fetch`, `scripts/vfx-fetch.sh`, the Unity window) arrives with every file needed to render in the target Unity project: shaders, materials (URP-converted where the original shader is built-in, e.g. Retro Arsenal), textures, meshes, `.meta` GUIDs preserved. Owner decision: the packs are purchased by the studio, the cloud is studio-internal, so original file BYTES are stored (reverses the "metadata only" policy of `LICENSES.md` for these packs), visibility restricted, `ai_training=false`, never `global`.

## Evidence baseline (measured 2026-10-28, read-only)

| Fact | Value | Source |
|---|---|---|
| resource rows / recipes | 3404 / 3248 (3237 extracted, each with a distinct `meta.source.prefabGuid`) | `podman exec vfx-pg psql -U vfx -d vfxcloud` SELECT |
| asset rows (kind) | material 616, texture 584, mesh 131, shader 17 = 1348; `resource_asset` 22272 | same; migration `007_knowledge_graph.sql` |
| recipe licenses / visibility | asset-store-eula 3057, synty-store-eula 180, cc0 11 (recipes); all `visibility=project` | same |
| preview state | 1680 `preview_gif` rows = `index.json` items; 1590 `data/recipe` dirs without own preview (1568 are DB rows): 1547 variants (borrow canonical GIF by design), 10 hand-written (no prefab; the DB has 11 recipe rows without `prefabGuid`, `rod-twinkle-box` has a v2: 10 preview slugs; BUILT into prefabs by lane B, phase 14), 10 namufx (prefab absent in ImportedPacks); the 23 `probe-*` dirs (no DB row) are archived and deleted by the orchestrator OUTSIDE this plan and are excluded from every count, scope and phase here (after that, `data/recipe` has 3247 dirs, 1567 without own preview) | scratchpad `preview-gap-report.md` |
| render history | last `_status.json`: 517 clips, 0 failed, 180.6 s (0.349 s/clip); per-slug failures are NOT persisted anywhere (failed targets are removed from index and GIF purged) | `data/previews/_status.json`, README "Preview GIF" gates |
| prefab bytes on disk (ImportedPacks) | 4076 prefabs = 1156 MB; textures 950 files = 323 MB; fbx 614 (case-insensitive; 61 are `.FBX`) = 40 MB; wav 278 = 92 MB; ImportedPacks total 1.7 GB / 15236 files | `find ... -printf %s` |
| DB / data size | 181 MB DB; `data/` 110 MB | `pg_database_size`, `du -sh data` |
| Unity source of originals | `.unitypackage` files in `/home/mike/Downloads/UnityPackages` (`VFX_UNITYPACKAGE_DIR`), namufx folder source, game `Assets/` roots in `packs.json` | `PackImporter.cs:76-77`, `packs.json` |
| Existing converter | `MaterialConverter.ConvertAll` rewrites materials IN PLACE in ImportedPacks, glow capped at `GlowCap=1.25` (LDR preview) | `MaterialConverter.cs:28-41`, `MaterialMapping.cs:56` |
| Migration runner | `migrate()` applies every unseen `server/src/migrations/*.sql` automatically on server start, `graph:build`, `previews:gif`, `previews:magenta` AND on tests that import it | `server/src/db.ts:16-48`, `magenta.test.ts:127`, `preview-gif.test.ts:51` |
| Auth today | one static key `x-vfx-key` on `/v1/*` only; `AUTH_DISABLED=1` is the compose default; `/mcp` has NO auth; server binds `0.0.0.0` | `http.ts:33-41`, `compose.yaml`, `config.ts:20-22`, `index.ts:17` |

Sizing of the upload (estimate, the uploader `--dry-run` replaces it with exact numbers in phase 9): about 3.3k extracted-recipe prefabs + about 1.3k asset files + nested prefabs/animation/controller/script/audio refs, each with its `.meta`: about 9k blobs, up to about 1.6 GB raw; text kinds are gzipped at rest, so about 0.3-0.5 GB on disk.

## Phases

| # | Phase | Group | Lane | Effort | File |
|---|-------|-------|------|--------|------|
| 1 | Foundation: migration, contract, license gate, shared libs, source API, package.json, test-DB harness | A (shared, serial) | serial | L | phase-1-foundation.md |
| 2 | Server: blob store, asset-file registry, bundle builder, routes, MCP `vfx_fetch` | B | S | L | phase-2-server.md |
| 3 | Bulk uploader + closure verifier | B | U | L | phase-3-uploader.md |
| 4 | Game-VFX extractor: visibility, parse errors, nested prefabs, first-copy-with-VFX | B | G | M | phase-4-game-vfx.md |
| 5 | Unity package GUID map (86 prefabs with outside GUIDs) | B | P | M | phase-5-package-guids.md |
| 6 | Shell/Node fetch client (`vfx-fetch.sh`) | B | F | M | phase-6-fetch-client.md |
| 7 | Unity client package: bundle install, GUID safety (code only) | B | C | M | phase-7-unity-client.md |
| 8 | Unity preview: failure persistence, URP export, restore originals (code only) | B | R | L | phase-8-unity-render.md |
| 9 | Integration (no Unity): merge, migrate live DB, ingest game recipes, bulk upload, closure verify | C (serial) | serial | M | phase-9-integrate-upload.md |
| 10 | Unity slot 1: import game pack, compile, fresh full render, enumerate failures | C (Editor) | serial | M | phase-10-render-enumeration.md |
| 11 | Unity slot 2: fix failure classes, export + upload URP variant, previews, GIF | C (Editor) | serial | L | phase-11-fix-rerender.md |
| 12 | Unity slot 3: clean-project acceptance (shell client + Unity client + negative control) | C (Editor) | serial | M | phase-12-acceptance.md |
| 13 | Docs sync and final numbers | D | serial | S | phase-13-docs.md |
| 14 | Recipe-to-prefab builder so the 10 hand-written recipes get previews (code only; runs in phase 10) | B (added 2026-10-28, parallel with 2-8) | B | M | phase-14-recipe-prefab-builder.md |

Critical path: 1 > 2 > 9 > 10 > 11 > 12 > 13 (lanes 3, 4, 5, 6 also gate 9 (phase 9 runs the fetch client); lane 8 and lane 14 (B) gate 10; lane 7 gates 12). Editor-bound phases 10, 11, 12 run strictly one after another on the single Editor slot.

## Human steps (do first)

None blocking. Two confirmation gates are built in (preview-first rule): the bulk upload (phase 9: dry-run numbers, smoke N=5, then full) and the full render (phase 10: smoke 16 clips, then full). The orchestrator asks the user at those two points.

## Planning waves

Group A: run
Group B: run
Review: 1 reviewer
Fan-out: 8 lanes
Facts: lanes=8 new-rows=8

Group A ran 3 helpers in one message (plus a 4th `t1k-corpus-scout` re-check of the NEW rows that cites this plan dir, so the spawn rows join to it): `t1k-corpus-scout` (corpus has no content-addressed store or GUID-preserving client; 114 repos swept, this repo is not indexed), two `t1k-investigator` lanes (server shape; Unity and tooling shape). Fact-fetcher skipped: no external library question (Fastify, pg, zod already in the repo; Unity facts come from local files).

## Verification topology

| Lane | Verifier | Concurrent? |
|------|----------|-------------|
| S | `node server/src/blob-store.test.ts` (scratch DB + scratch DATA_DIR) | yes, own scratch DB `vfxcloud_test_S` |
| U | `node seed/upload/upload.test.ts` (stub HTTP server, fixtures from phase 1) | yes, no DB |
| G | `node seed/extract/nested.test.ts` (fixtures, no DB) | yes |
| P | `node seed/extract/package-guids.test.ts` (fixtures + reads local PackageCache) | yes |
| F | `node scripts/vfx-fetch-bundle.test.mjs` (stub HTTP server, temp project dir) | yes |
| C | `dotnet run --project tools/vfxcloud-tests` through `scripts/accept/phase-7.sh` (pure C# logic, no Editor) | yes, no Editor |
| R | `dotnet run --project tools/preview/framing-tests` + `node seed/preview-failures.test.ts` through `scripts/accept/phase-8.sh` | yes, no Editor |
| B | recipe-spec + merge-targets node tests and `dotnet run --project tools/recipe-prefab/tests` through `scripts/accept/phase-14.sh` (no Editor, no DB) | yes, no Editor |

Lane sizing: tier=sonnet UNMEASURED; lanes=8; p=0.8 each; P(all land)=0.17 (information, not a cap). Integration therefore expects stragglers (see below).

Isolation (stated once): every lane works in its own `git worktree` under `../vfx-skill-cloud-worktrees/lane-<id>` because lanes S, G, P, F, R run suites concurrently and S/R touch scratch DBs; all DB-backed tests use `vfxcloud_test_<lane>` and a temp `DATA_DIR` through `scripts/accept/lib-testdb.sh` (phase 1), never the live `vfxcloud` DB.

## SHARED vs LANE file partition (binding)

Phase 1 (serial, ONE agent, first, ends in commit + `npm run check` + `npm test` green) owns every SHARED file. Phase-B agents treat them READ-ONLY; a lane that needs a shared change STOPS and reports to the orchestrator, who re-runs phase 1 or absorbs the change.

SHARED (phase 1):
- `server/src/migrations/010_asset_blobs.sql`
- `server/src/config.ts`, `server/src/errors.ts`
- `server/src/license.ts`, `server/src/license.test.ts`, `server/src/store.ts` (visibility type, publish gate; `closure()` left intact), `server/src/facet-query.ts`
- `server/src/bundle-contract.ts` (+ `bundle-contract.test.ts`, `server/src/test-fixtures/**`)
- `server/src/unity-refs.ts` (+ `unity-refs.test.ts`): YAML GUID-ref scanner, builtin classifier (reuses `rules.assets.builtinGuidPattern`), package-map loader
- `server/src/unity-package-guids.json` (empty valid skeleton created here; lane P is its only writer afterwards)
- `seed/extract/source.ts`, `seed/extract/source.test.ts` (PackageSource gains `files()` with `.meta` bytes, `copiesOf()`, and the `preferCopy` option)
- `seed/extract/packs.json` (per-pack `visibility`, `bytes` flag)
- `package.json` (npm scripts for every lane, test globs `seed/*.test.ts seed/upload/*.test.ts seed/extract/*.test.ts scripts/*.test.mjs scripts/*.test.ts`)
- `LICENSES.md`, `README.md` (new "Bytes and bundle API" section, the contract copy for humans)
- `.gitignore` (`/unity/VFXAccept/`)
- `scripts/accept/lib-testdb.sh`, `scripts/accept/with-testdb.sh`, `scripts/accept/migrate-testdb.ts`, `scripts/accept/phase-1.sh`
- `server/src/test-fixtures/**` (`bundle-sample.json`, `reroot-cases.json`, `scratch-db.ts`)

LANES (disjoint; each lists its files in its phase file):
- S: `server/src/blob-store*.ts`, `server/src/bundle-builder*.ts`, `server/src/http.ts`, `server/src/mcp.ts`, `scripts/smoke.sh` (co-changes with http/mcp/store in git history: seam check)
- U: `seed/upload-blobs.ts`, `seed/verify-closure.ts`, `seed/upload/**`
- G: `seed/extract/recipe*.ts`, `seed/extract/unity-yaml*.ts`, `seed/extract/pipeline*.ts`, `seed/extract/ingest*.ts`, `seed/extract/nested*.ts`, `seed/extract-unitypackage.ts`, `seed/ingest-extracted.ts`
- P: `seed/extract/package-guids*.ts`, `server/src/unity-package-guids.json`
- F: `scripts/vfx-fetch.sh`, `scripts/vfx-fetch-bundle.mjs`, `scripts/vfx-fetch-bundle.test.mjs`
- C: `unity/Packages/com.mike.vfx-cloud/**`, `tools/vfxcloud-tests/**`
- R: `unity/VFXPreview/Assets/Editor/VfxPreview/*.cs` EXCEPT `RecipePrefabBuilder*.cs` (lane B's), `tools/preview/framing-tests/**`, `tools/preview/targets.ts`, `seed/preview-failures*.ts`, `scripts/preview-restore-originals.ts`
- B (added 2026-10-28, phase 14): `unity/VFXPreview/Assets/Editor/VfxPreview/RecipePrefabBuilder*.cs`, `tools/recipe-prefab/**`, `scripts/accept/phase-14.sh`. Disjoint from R by the explicit exclusion above; no other lane's glob matches either path (checked against every Owns line: S `server/src/blob-store*`/`bundle-builder*`/`http.ts`/`mcp.ts`, U `seed/upload*`, G `seed/extract/*`, P `seed/extract/package-guids*`, F `scripts/vfx-fetch*`, C `unity/Packages/**` and `tools/vfxcloud-tests/**`).
- Explicit hand-offs (a file named in two phases is a sequential hand-off, never concurrent): `server/src/unity-package-guids.json` phase 1 (empty skeleton) -> lane P (sole writer); `README.md` phase 1 (contract section) -> phase 13 (final); `MaterialMapping.cs`, `MaterialConverter.cs`, `tools/preview/framing-tests/**` lane R -> phase 11 (lane R finished); `tools/preview/run.json` phase 10 -> phase 11; `data/reports/` is written by phases 9, 10 and 11 in turn; `data/accept/` is phase 12's (phase 9 step 8 uses `data/accept/spot` before it exists, then phase 12 may wipe it); phase 11's restore step may rewrite `ImportedPacks/studio-game-vfx` (phase 10 created it); lane B's files -> phase 11 (sole editor for builder defects once lane B finished); `scripts/accept/` gains phase 9's `pinned-baseline.json`, `check-pinned-baseline.ts`, `with-corpus-clone.sh` (new files, no other owner).
- Phases 9-13 are serial and each owns only the artifacts it creates (`scripts/accept/phase-N.sh`, `tools/preview/run.json`, `unity/VFXAccept/` which is gitignored, `unity/VFXPreview/Packages/manifest.json` in phase 12 only).

Co-change seam check (`cochange-seams.cjs`, advisory): `server <> seed` weak coupling through `pipeline.ts`/`packs.json` with `store.ts` (handled: `packs.json` is phase 1, `pipeline.ts` is lane G, `store.ts` is phase 1); `scripts/smoke.sh` moves with `http.ts`/`mcp.ts`/`store.ts` at confidence 1.0 (assigned to lane S); `unity` is independent of `server` and `seed`.

Editor-bound work: phases 10, 11, 12 only. Lanes B, C and R are code-only ("implement blind, verify once"): their C# is first compiled in phase 10 (R and B code, in VFXPreview) and phase 12 (C code, in the clean `VFXAccept` project). Unity runs windowed (rendering needs it); never launch a second Editor on a project that has one, never kill the user's Editor, never `Assets/Reimport All`; check `t1k unity instance list` first and drive an already-open Editor through the CLI.

## Contract

Owner: plan author; a change request goes to the Owner, who re-briefs (phase 1 re-run for shared files)
File: plan.md
Test: server/src/bundle-contract.test.ts

Contract id `vfx-bytes/1`. Phase 1 turns this section into `server/src/bundle-contract.ts` (zod schemas + TS types) and `server/src/test-fixtures/bundle-sample.json`; every lane validates against those, none restates them. Text below is the SSOT until phase 1 lands.

### C1 Policy: visibility, license, ai_training

- `visibility` allowed values on `resource` and `asset`: `project | team | studio-only | global` (migration 010 swaps the CHECK constraints; order of restriction project < team < studio-only < global). New table `asset_file.visibility` allows only `project | team | studio-only`: a row in `asset_file` can NEVER be `global` (CHECK). The guarantee covers `asset_file` only: legacy `resource` files that enter a bundle as `origin:"resource"` keep their own visibility (they may be `global`) and are served by the existing `/v1/resource/.../file` route.
- `asset_file.ai_training boolean NOT NULL DEFAULT false CHECK (ai_training = false)`: the column is a documented constant; the rule is ENFORCED by `blobLicenseProblem` (an `ai_training=true` request or an ai-training license is `forbidden`).
- Licenses that may carry bytes: `synty-store-eula`, `asset-store-eula`, `studio-internal` (plus `cc0`, `cc-by`, `cc-by-sa`, which `asset_file` does not need now). Refused with `forbidden`: `unknown`, `restricted`, any unrecognised license, any `ai_training=true` request. Gate function: `blobLicenseProblem(license, visibility)` in `license.ts` (pure, tested without DB).
- New game recipes: `license=studio-internal`, `license_class=studio-internal`, `visibility=studio-only`, `ai_training=false`. Existing 3248 recipes keep `visibility=project`.
- Bytes are served only to a caller holding the API key, never through MCP payloads (MCP returns URLs and metadata); a blob referenced by no `asset_file` row (neither as `asset_sha256` nor as `meta_sha256`) is not served.

### C2 Blob storage

- Content-addressed files in `${DATA_DIR}/blobs/<sha[0:2]>/<sha[2:4]>/<sha256>`; sha256 is lowercase hex of the UNCOMPRESSED bytes. Text kinds (`prefab material shader animation controller script asmdef meta other-text`) are gzipped at rest, binary kinds (`texture mesh audio`) stored as is.
- Table `asset_blob(sha256 TEXT PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'), bytes BIGINT NOT NULL, stored_bytes BIGINT NOT NULL, encoding TEXT NOT NULL CHECK (encoding IN ('identity','gzip')), storage_uri TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`. `storage_uri` is relative to `DATA_DIR` (same convention as `resource.storage_uri`).
- Table `asset_file(id BIGSERIAL PK, guid TEXT NOT NULL CHECK (guid ~ '^[0-9a-f]{32}$'), variant TEXT NOT NULL CHECK (variant IN ('original','urp')), kind TEXT NOT NULL CHECK (kind IN ('prefab','material','texture','shader','mesh','animation','controller','script','asmdef','audio','other')), path TEXT NOT NULL, asset_sha256 TEXT NOT NULL REFERENCES asset_blob, meta_sha256 TEXT REFERENCES asset_blob, refs TEXT[] NOT NULL DEFAULT '{}', pack TEXT NOT NULL, license TEXT NOT NULL, visibility TEXT NOT NULL CHECK (visibility IN ('project','team','studio-only')), ai_training BOOLEAN NOT NULL DEFAULT false CHECK (ai_training = false), source JSONB NOT NULL DEFAULT '{}', urp JSONB, created_at, updated_at, UNIQUE (guid, variant))`. No FK to `asset(id)`: `graph:build` deletes and recreates `asset` rows, so the join is by `guid`, never by id.
- `refs` = distinct lower-case GUIDs found by `scanRefs` (ONE implementation, `server/src/unity-refs.ts`, used by the server, the uploader and the verifier; no lane re-implements it) with exactly three patterns: P1 `guid:\s*([0-9a-f]{32})` (YAML `{fileID, guid, type}` references), P2 `GUID:([0-9a-f]{32})` (asmdef/asmref `references`), P3 `\\?"guid\\?"\s*:\s*\\?"([0-9a-f]{32})` (Shader Graph / JSON-embedded references, e.g. `m_SerializedTexture`, `m_SerializedSubGraph`; 19 `.shadergraph` in ImportedPacks, 15 distinct non-builtin GUIDs only reachable this way). Computed SERVER-side at registration from the stored blob (clients never send refs), excluding the file's own guid (a real self-reference exists: Retro Arsenal `BalloonRelease.prefab` `m_CorrespondingSourceObject`). Binary files yield `[]`. Known limits, stated: asmdef references by assembly NAME (e.g. `Unity.TextMeshPro`) are not GUIDs and are not followed; `.asmref` files are `kind:"asmdef"`; folder `.meta` files are not shipped.
- Limits: `VFX_BLOB_MAX_BYTES` default 268435456 (256 MiB, 413 `too_large` above); `POST /v1/blob/missing` at most 5000 hashes; `POST /v1/asset-file/batch` at most 500 files; bundle at most `VFX_BUNDLE_MAX_FILES` default 3000 files (400 `invalid` with `details.file_count`).

### C3 HTTP API (all under `/v1`, header `x-vfx-key`)

Auth: blob and bundle routes (`/v1/blob*`, `/v1/asset-file*`, `/v1/closure*`) require the key EVEN when `AUTH_DISABLED=1`, unless the explicit opt-in `VFX_BLOB_ALLOW_ANON=1` is set. With `VFX_API_KEY` empty and no opt-in they answer 403 `forbidden` (never open by accident). Other `/v1` routes keep today's behaviour.

| Route | Request | Success | Errors |
|---|---|---|---|
| `POST /v1/blob/missing` | JSON `{"sha256": ["<64hex>", ...]}` | 200 `{"missing": ["<64hex>", ...]}` (subset, input order, deduplicated) | 400 `invalid` bad hash or over 5000 |
| `PUT /v1/blob/:sha256` | raw octets, `content-type: application/octet-stream`, optional `x-vfx-kind: <kind>` (chooses gzip at rest, default text/binary by kind else binary) | 201 `{"sha256","bytes","created":true}`; already stored 200 same body with `"created":false` | 400 `invalid` + `details.actual` when the body hash differs from `:sha256`; 413 `too_large` |
| `GET /v1/blob/:sha256` (HEAD too) | `Accept-Encoding: gzip` optional | 200 raw bytes; for a gzip-at-rest blob and a gzip-accepting client the stored bytes with `Content-Encoding: gzip`; headers `etag: "<sha256>"`, `x-vfx-sha256`, `cache-control: private, max-age=31536000, immutable`; 304 on `If-None-Match` | 404 `not_found` (also for a blob no `asset_file` row references) |
| `POST /v1/asset-file/batch` | JSON `{"files": [AssetFileInput, ...]}` | 200 `{"results": [{"guid","variant","status": "created"|"unchanged"|"replaced"|"rejected","code"?,"error"?,"details"?}], "counts": {"created","unchanged","replaced","rejected"}}` (per-item outcome, the batch itself is not atomic) | 400 `invalid` malformed body |
| `GET /v1/asset-file/:guid?variant=original\|urp` | none | 200 one `BundleFile` (below) for that file, `variant` default `original` | 404 `not_found` |
| `GET /v1/closure/:type/:slug/:version?variant=urp\|original` | none | 200 `Bundle` (below), `variant` default `urp` | 404 `not_found` unknown record; 400 `invalid` bad `variant` or too many files |

`AssetFileInput` = `{"guid","variant","kind","path","asset_sha256","meta_sha256":string|null,"pack","license","visibility","source":{"game":string|null,"origin":string,"copies"?:[{"origin":string,"sha256":"<64hex>"}]},"urp"?:{"rule":string,"glow_cap":number|null,"shader_guid":"<32hex>"},"replace"?:boolean}`; `source.copies` lists the other sources that carried the same guid with different bytes (D16; `origin` is a pack slug or game label). Both blobs must already be stored, else the item is `rejected` with `code:"conflict"` and `details.missing:[sha...]`. Re-registering an existing `(guid, variant)` with the same shas is `unchanged`; with different shas it is `rejected` `conflict` unless `replace:true` (then `replaced`). License gate failures are `rejected` with `code:"forbidden"`. `variant:"urp"` requires `kind:"material"` and a `urp` object.

MCP: `vfx_fetch` gains optional input `variant` (`"urp"|"original"`, default `"urp"`) and its JSON output gains `bundle` (the `Bundle` below) next to the unchanged legacy fields (`closure` stays, same shape, so old clients keep working). `vfx_resolve` is unchanged. MCP never carries bytes.

### C4 `Bundle` (closure response, snake_case everywhere)

```json
{
  "schema": "vfx-bundle/1",
  "uri": "vfx://recipe/<slug>/<version>",
  "variant": "urp",
  "root_guid": "<32hex>|null",
  "complete": true,
  "reason": null,
  "files": [BundleFile],
  "requires": [{"guid":"<32hex>","kind":"builtin|package","name":"<string>","package":"<string>|null","version":"<string>|null","referenced_by":["<guid>"]}],
  "unresolved": [{"guid":"<32hex>","referenced_by":["<guid>"]}],
  "cycles": [["<guid>"]],
  "file_count": 0,
  "total_bytes": 0
}
```

`BundleFile`:

```json
{
  "guid": "<32hex lowercase>|null",
  "origin": "asset_file|resource",
  "kind": "prefab|material|texture|shader|mesh|animation|controller|script|asmdef|audio|other",
  "variant": "original|urp",
  "urp_converted": false,
  "urp_rule": null,
  "path": "Assets/<original project-relative path, forward slashes>",
  "target_path": "Assets/VFXCloud/<pack>/<path without the leading Assets/>",
  "pack": "<pack slug>",
  "license": "<license>",
  "sha256": "<64hex of the asset bytes>",
  "bytes": 0,
  "download_url": "<absolute>/v1/blob/<sha256>",
  "meta_sha256": "<64hex>|null",
  "meta_bytes": 0,
  "meta_download_url": "<absolute>/v1/blob/<meta_sha256>|null"
}
```

- Paths: `target_path` keeps the whole relative structure of `path` under the pack folder (so folder-scoped asmdefs and relative layouts survive); `VFX_ROOT` / the Unity client root replace ONLY the `Assets/VFXCloud/<pack>` prefix by the pure function `reroot(target_path, root)`; both clients implement it from this sentence and are tested against the same fixture.
- Ordering: `files` are dependencies first. Deterministic DFS post-order from the root over `refs`; siblings visited by kind rank (`shader, texture, mesh, audio, animation, controller, script, asmdef, material, other, prefab`) then `path`; the root file is LAST. A reference cycle is broken at the back edge and listed in `cycles`; the bundle is still returned.
- `variant=urp`: for each `material` the `urp` row replaces the `original` row when one exists (`variant:"urp"`, `urp_converted:true`, `urp_rule` set); every other kind is `original`. Variant choice is per material GUID; a file is in the bundle iff it is reachable from the root through the CHOSEN rows' refs along ANY path, so a pack shader file is shipped only when some shipped file (a material that stayed `original`, or another recipe part) still references it. `variant=original` returns vendor bytes untouched.
- `requires`: referenced GUIDs that are not shipped because they belong to the target's Unity install or UPM packages: `builtin` (pattern `rules.assets.builtinGuidPattern`; `name` is the fixed constant `Unity default resources` for `...f000...` and `Unity extra resources` for `...e000...`, `package` null) or `package` (found in `unity-package-guids.json`, e.g. URP `Particles/Unlit` shader). A GUID that matches neither the builtin pattern nor a map entry is `unresolved`, never a nameless `requires`. Package files are NEVER shipped. `unresolved` = referenced GUID found nowhere (no `asset_file`, no builtin, no package entry): `complete` is `false` and the client treats it as an error unless told otherwise.
- `reason` is `null` or one of `"no_prefab"` (recipe has no `meta.source.prefabGuid`), `"bytes_not_uploaded"` (prefab guid known, no `asset_file` row). In both cases `files` is `[]`, `complete` is `false`.
- Derived (publish-back) recipes and non-recipe types: existing `resource` closure items appear as `origin:"resource"` files (`guid` = `meta.unity.guid` or `null`, `meta_sha256/meta_bytes/meta_download_url` = `null`, `target_path` = legacy `target_hint`, `download_url` = legacy `/v1/resource/.../file`); their prefab bytes are scanned for `refs` and resolved through `asset_file` like any other root.
- Null semantics: every key is always present; `null` means "not applicable", never an empty string; arrays are never `null`.

### C5 Error envelope

`{"error": "<message>", "code": "invalid|not_found|conflict|too_large|forbidden", "details"?: {...}}`; HTTP 400 invalid, 403 forbidden, 404 not_found, 409 conflict (single-resource routes), 413 too_large. The existing 401 body `{"error":"unauthorized"}` is unchanged.

### C6 `.meta` and GUID preservation (clients)

- Each file is installed as the pair `<target_path>` + `<target_path>.meta`, the `.meta` byte-exact from `meta_download_url` (so the `guid:` inside it is the original). Write `.meta` first, then the asset, so Unity never imports a file without its `.meta`. Items with `meta_download_url: null` (origin `resource`): no `.meta` is written (legacy behaviour; Unity assigns a new GUID).
- Pre-flight over the WHOLE bundle before writing anything: (a) guid already present in the project at another path: same sha256 -> `reused` (skip, nothing written); different sha256 -> conflict; (b) `target_path` exists with another guid -> conflict; (c) same path, same guid, same sha -> `unchanged`. Conflict policy `refuse` (default) aborts the whole install with nothing written; `skip` leaves the conflicting files and installs the rest; `overwrite` replaces content but keeps the existing `.meta` and reports the GUID kept. Never delete anything.
- Never overwrite on GUID collision without the explicit flag (`VFX_ON_CONFLICT=skip|overwrite` for the shell client, the "On conflict" dropdown for the Unity client).
- After the install the Unity client runs one `AssetDatabase.Refresh()` and asserts `AssetDatabase.AssetPathToGUID(path) == item.guid` for every installed file; a mismatch fails the run loudly.

### C7 Verification and install atomicity

Every blob is downloaded to a temp directory (`<project>/Temp/vfx-cloud-<random>/`), its sha256 (of the decompressed bytes) is compared with `sha256` / `meta_sha256`, and only when ALL files verified does the move phase start. A mismatch aborts with exit 4 and nothing is moved. "Nothing written" is guaranteed for the verify phase only; the move phase keeps a journal (`Temp/vfx-cloud-journal.json`: every file it created or replaced) and on any failure undoes it best-effort (created files removed, replaced files restored from the temp copy). If `Temp/` and `Assets/` are on different filesystems (rename returns EXDEV) the client copies to a hidden temp name inside the target directory and renames from there. A running Editor can import between the `.meta` and the asset rename (it deletes an orphan `.meta` and assigns a fresh GUID), so: the shell client prints a warning when `Temp/UnityLockfile` exists, and ALWAYS re-reads each installed `.meta` after the move and fails with exit 7 (`guid_changed`, naming the files) if a `guid:` differs from the bundle; the Unity client wraps the whole move in `AssetDatabase.StartAssetEditing()` / `StopAssetEditing()` and then asserts GUIDs (C6).

Shell/Node client exit codes: `0` ok, `1` network/server error, `2` usage, `3` conflict refused, `4` sha256 mismatch, `5` bundle incomplete (`complete:false`) unless `VFX_ALLOW_INCOMPLETE=1`, `6` a `requires` package missing from `Packages/manifest.json` and `VFX_STRICT_REQUIRES=1`, `7` a `.meta` guid changed after the move (`guid_changed`). Environment: `VFX_SERVER` (default `http://127.0.0.1:8787`), `VFX_API_KEY` (sent as `x-vfx-key`), `VFX_VARIANT` (`urp` default | `original`), `VFX_ON_CONFLICT` (`refuse` default | `skip` | `overwrite`), `VFX_ROOT` (re-roots `target_path`: `<VFX_ROOT>/<path without Assets/>`), `VFX_DRY_RUN=1` (print the plan, write nothing), `VFX_FETCH_LEGACY=1` (the old per-resource path). Uploader and verifier (`seed/upload-blobs.ts`, `seed/verify-closure.ts`) exit codes: `0` ok, `1` one or more files failed or a sha256 mismatched, `2` usage, `75` server unavailable after retries. stdout last line of the fetch client: one JSON summary `{"uri","variant","written","unchanged","reused","skipped","requires_missing","complete"}`.

### C8 URP conversion output (what gets published)

- One converted `.mat` per material GUID, `variant:"urp"`, SAME `guid`, SAME `path`, SAME `.meta` blob as the original (the `.meta` carries the GUID and has no shader data); stored only when the conversion changed the shader: converted `m_Shader.guid` differs from the original and is a package GUID known to `unity-package-guids.json` (URP `Particles/Unlit` `0406db5a14f94604a8c57ccfbc9f3b46` expected). Conversion is a pure function of the material, so it is shared by every recipe that uses the material (join by guid), never per recipe.
- `original` bytes come ONLY from the vendor source (`.unitypackage`, namufx folder, game folders), never from `unity/VFXPreview/Assets/ImportedPacks` (already converted in place). `urp` bytes come from the export directory `data/export/urp/` written by `VfxPreview.UrpExport.Run` (lane R): `<guid>.mat` + `index.json` `{"version":1,"items":[{"guid","path","rule","sha256","original_shader_guid","shader_guid"}]}`. The export conversion is NOT capped: `glow_cap: null` (the preview conversion keeps `GlowCap=1.25` for its LDR frames; a real game with bloom wants the original HDR magnitude).
- Pack built-in shader files (e.g. Retro Arsenal `Archanor VFX/*`) are published as `original` only.

### C9 Render-failure record

`data/previews/_failures.json` (written by the Unity lane, one write per run, atomic): `{"version":1,"runId":"<iso8601>","items":{"<slug>":{"state":"ok|failed|skipped","cause":"<class>|null","detail":"<text>|null","shaders":["<shader name>"],"renderedAt":"<iso8601>"}}}`. `cause` for `failed`: `magenta-pixel | unrenderable-material | prefab-missing | exception | no-visible-output | closure-unresolved`; for `failed` after analysis (documented unfixable): `unfixable-shader | unfixable-source | unfixable-script`; for `skipped`: `no-prefab | variant-borrows-canonical`. Persisted by `seed/preview-failures-ingest.ts` into table `preview_render(slug TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('ok','failed','skipped')), cause TEXT, detail TEXT, shaders TEXT[] NOT NULL DEFAULT '{}', run_id TEXT NOT NULL, rendered_at TIMESTAMPTZ NOT NULL, CHECK (state <> 'failed' OR cause IS NOT NULL), CHECK (cause IS NULL OR cause IN ('magenta-pixel','unrenderable-material','prefab-missing','exception','no-visible-output','closure-unresolved','unfixable-shader','unfixable-source','unfixable-script','no-prefab','variant-borrows-canonical')))` (migration 010); latest run wins per slug. `closure-unresolved` is written by `seed/verify-closure.ts`, not by Unity.

### C10 Render CLI arguments (phase 12 depends on lane R)

`-executeMethod VfxPreview.BatchEntry.Run` additionally accepts `-vfxTargets <file>` (targets JSON, default `tools/preview/targets.json`), `-vfxOut <dir>` (default `data/previews`), `-noConvert`, `-skipGifIngest`, `-packs <csv|none>` (existing). `-executeMethod VfxPreview.UrpExport.Run -vfxExport <dir>` writes the C8 export. `-executeMethod VfxCloud.Editor.BatchFetch.Run -vfxUri <uri> -vfxVariant <urp|original> -vfxOnConflict <refuse|skip|overwrite>`, `-vfxServer <url>` and `-vfxKey <key>` (each defaults to the env var `VFX_SERVER` / `VFX_API_KEY`; lane C) installs a bundle through the Unity client and exits non-zero on failure.

## Decision register

| # | Decision | Taken |
|---|----------|-------|
| D1 | Where big bytes go | Files in `DATA_DIR/blobs` content-addressed by sha256, text kinds gzip at rest, metadata in Postgres. Not `bytea`: bytes would add about 1.6 GB raw to a 181 MB DB, bloat `pg_dump` backups and WAL, and `resource` already stores payload files under `DATA_DIR` while only small, travel-with-the-row GIFs live in the DB. Only referenced files are stored (closure of the recipes' prefabs, not the 89 GB of game projects or the 1.7 GB ImportedPacks tree). |
| D2 | Visibility | Add `studio-only` (migration 010) to `resource` and `asset`; `asset_file` accepts only `project|team|studio-only` by CHECK. New game recipes use `studio-only` (what `LICENSES.md` already says it wants); existing recipes untouched. Server has a single shared key, so `studio-only` = "holder of the key"; it is a label plus a never-global guarantee, not per-user ACL. |
| D3 | Blob auth | Blob routes need the key even under `AUTH_DISABLED=1`; opt-out is the explicit `VFX_BLOB_ALLOW_ANON=1`. Reason: purchased-pack bytes must not leak through the compose default (`AUTH_DISABLED=1`, bind `0.0.0.0`). |
| D4 | Variant model | `original` (vendor bytes) and `urp` (converted material, same guid/path/meta) rows keyed `(guid, variant)`; converted once per material and shared by all recipes; client default `urp`. |
| D5 | Conversion for publishing | Separate export run with no glow cap from RESTORED original materials; the preview keeps `GlowCap=1.25`. Cycle: restore originals, export, restore originals, preview-convert, render. |
| D6 | Refs source of truth | Server computes `refs` from the stored bytes; uploader and verifier use the same `unity-refs.ts`. |
| D7 | Packages not shipped | UPM package and Unity built-in files are listed under `requires` (with the package name), never uploaded; the client warns when the package is absent. Unknown GUIDs are `unresolved` and make the bundle `complete:false`. |
| D8 | Level.prefab rule (same GUID in several games with different bytes) | First copy that CONTAINS a ParticleSystem/VisualEffect wins, else the first copy in configured game order; every game carrying the guid stays in `meta.source.games`, and when copies differ `meta.source.copies:[{game,sha256}]` records each (recipe metadata; the `asset_file` field of the same name uses `origin`, see C3). Why: first-game-wins is an accident of configured order and can pick a VFX-free copy, silently dropping a recipe another game's copy would produce; content-based choice loses nothing and stays deterministic. |
| D9 | Nested prefab instances (34 skipped) | Resolve ONLY variants of an extracted VFX prefab whose `m_Modifications` touch ParticleSystem scalar/curve properties and Transform/name/active; flatten base + overrides. Any unsupported override path skips the prefab with reason `nested-override-unsupported:<path>`; gameplay prefabs that merely embed VFX (Ball, Ball_Big, Ball_Rocket) stay skipped (`gameplay-prefab`): their VFX children are already their own recipes. All 34 plus the 4 yaml-parse-error files still have their BYTES stored when reachable, so a later extractor can add them without re-upload. Never silently drop an override. |
| D10 | yaml-parse-error (4) | Reproduce each; fix `unity-yaml.ts` when it is a parser limit, else skip with a precise reason; never skip as a blanket. |
| D11 | Audio | Referenced audio clips are part of the closure (`kind:audio`) so effects arrive with sound (278 wav = 92 MB in ImportedPacks); `--skip-kinds audio` exists in the uploader if the dry-run shows a surprise. |
| D12 | Scripts and asmdef | Referenced `.cs` (58 in ImportedPacks) are shipped as `kind:script`; the uploader also includes the nearest ancestor `.asmdef` of a shipped script and the asmdefs it references by `GUID:`; precompiled plugins (`.dll`) are never shipped and show up in `requires` or `unresolved`. |
| D13 | Acceptance project | Clean `unity/VFXAccept` (gitignored), created by script from `VFXPreview` `ProjectSettings`/`Packages`/`Assets/Editor` plus the client package; a second Editor on a DIFFERENT project, opened only after the VFXPreview Editor work of phases 10-11 is finished. |
| D14 | Delivery | Lanes push branches from worktrees and report; phase 9 integrates them into one integration branch; ONE PR to `main` at the end of phase 13. Commits by pathspec, never on the default branch. |
| D16 | Same GUID, different bytes in two sources (non-prefab: material, texture, anim) | The first source in configured order (`packs.json` pack order, then game root order) wins for `variant=original`; the uploader records every differing copy under `source.copies:[{origin, sha256}]` and lists them in `data/upload/plan.json`; re-registration with different bytes is a `conflict` and is never auto-`replace`d (lane U owns the policy, `copiesOf` from phase 1 supplies the data for every kind, not only prefabs). |
| D17 | Hand-written recipes without a prefab (owner, 2026-10-28) | BUILD a renderable prefab from each recipe's own parameters (lane B, phase 14): a billboard `ParticleSystem` per layer with the layer's texture, blend, lifetime, scale curve, delay, loop and burst count; nested `recipe:` layers instantiate the referenced `vfx` prefab. Generated prefabs live under the gitignored `Assets/RecipePrefabs/` and are NOT registered in the cloud (derived locally, not vendor bytes); the preview is the deliverable. A construct the builder cannot map skips the slug with the reason, never a partial preview. |
| D18 | Fetching a hand-written recipe | These recipes have no prefab so `GET /v1/closure` reports `reason:"no_prefab"` (C4). The builder's textures and nested `vfx` prefabs are fetched with the legacy per-resource closure (`VFX_FETCH_LEGACY=1 bash scripts/vfx-fetch.sh vfx://recipe/<slug>/1 <project>`), which lane F keeps; this plan does not change C4. OPEN POINT for lane S: C4 says `files` is `[]` for `no_prefab`; if S returns the `origin:"resource"` items instead, phase 10 may use the bundle path. |
| D19 | Pre-existing red tests (phase 1 result, commit f623303) | Recorded as a named pinned baseline (section `## Pinned baseline`) with an inverted-pin companion; phase 9 runs the full suite once against a clone of the integrated live corpus. |
| D15 | Live-data safety | `npm test` and every accept script run on scratch DBs that are MIGRATED before the run (`scripts/accept/migrate-testdb.ts`; a bare empty DB makes the tests that do not call `migrate()` fail by race) with `DATA_DIR` in a temp dir (some existing tests `fs.rm` under `config.dataDir`); the live DB is migrated only in phase 9 after `pg_dump` backup; uploads are additive and idempotent by sha256. |

Straggler: integrate lanes that landed by about 2x the median lane time; re-spawn a late lane on the remaining diff; never wait on it. Phase 9 needs lanes 2, 3, 4, 5, 6, phase 10 needs 8 (and 6 through 9), phase 12 needs 7: a missing lane blocks only its dependants.

## Pinned baseline

Phase 1 (commit f623303) left 9 tests red and 5 skipped on an UNSEEDED scratch DB; they were red before phase 1 and depend on a seeded corpus. Measured twice with `bash scripts/accept/with-testdb.sh pin node --test --test-reporter=spec server/src/*.test.ts seed/extract/*.test.ts seed/graph/*.test.ts hooks/*.test.mjs` (199 tests, 185 pass, 9 fail, 5 skipped; identical sets in both runs; live DB still 9 migrations). Every failing assertion is a precondition (`need two recipes without a GIF`, `need a Synty recipe in the corpus`, `previous test published it`), not product logic. One of them (publish-derived #3) is a cascade of the one before it.

Pin `scratch-unseeded` (identity is `<file> :: <test name>`):

| # | File | Test name (exact) |
|---|---|---|
| 1 | server/src/preview-gif.test.ts | cards expose gif (and preview_uri) when the slug has one, null otherwise |
| 2 | server/src/preview-gif.test.ts | a variant without its own GIF borrows its family canonical one, flagged viaFamily |
| 3 | server/src/preview-gif.test.ts | the review page (flat and set) embeds the DB GIF as an <img> and counts it as a preview |
| 4 | server/src/publish-derived.test.ts | publish refuses a bad derived record BEFORE writing anything |
| 5 | server/src/publish-derived.test.ts | derived recipe: provenance, modifications, derived_from edge, searchable, closure is whole and dependency-first |
| 6 | server/src/publish-derived.test.ts | vfx-fetch.sh fetches the whole closure (dependencies first); VFX_FETCH_DEPS=0 fetches only the file asked for |
| 7 | server/src/review.test.ts | session/selection round trip, replace semantics, validation |
| 8 | server/src/review.test.ts | GET /review renders cards with a placeholder when there is no preview, and reopens by session |
| 9 | server/src/review.test.ts | GET /review escapes hostile query text |

Pinned SKIPS on the same profile (a skip proves nothing, so they are pinned too): `facet-search.test.ts` "POST /v1/facets over the corpus: totals, OR / AND consistency, unknown facet is a 400"; `recolor-service.test.ts` "POST /v1/recolor: hue shift returns payload, tint list and per-key changes; base untouched", "POST /v1/recolor: same input is deterministic; includePayload:false drops the payload", "publish:true creates one derived_from record (licence inherited, project) and is idempotent", "published payload differs from the base only on colour rows (round-trips the emitter)".

Measurement note (phase 9): `node --test` shares ONE scratch DB across files, and `bundle-builder.test.ts` leaves recipe rows behind, so on the wider file list pins #1 and #3 read green by leaked state (pin #2 stayed red); alone, each file is red as pinned. The pin is therefore measured by `scripts/accept/run-pinned-suite.sh` (every test file in its own fresh migrated scratch DB), which reproduces the 9 red + 5 skipped exactly. The pin is unchanged.

Companion rule (inverted pin, both directions, by name, never by count). `scripts/accept/check-pinned-baseline.ts` (phase 9, data in `scripts/accept/pinned-baseline.json`) compares the actual red and skipped name sets with the pin:
- a red or skipped test NOT in the pin fails the check and names it (a new regression cannot hide behind the 9);
- a pinned test that is GREEN fails the check and names it ("pinned test is green: remove it from the pin, never re-pin the others"): the pin can only shrink by an explicit edit, and a count-only comparison is forbidden;
- profile `corpus-clone` (phase 9 step 8b, a restore of the integrated live corpus) pins NOTHING: every one of the 14 names must be green there, and a red or skipped one is a finding;
- the checker's own test feeds it a synthetic result set and goes red in both directions (an extra red, and a pinned name turning green).

## Reuse Ledger

| # | Capability | Verdict | Evidence |
|---|---|---|---|
| 1 | Content-addressed blob store with sha256 upload API | NEW | no hit in corpus (nearest: `GameFoundation` publish-time file hash, `DOTSCore.BlobConfig.ContentHash`, `TheOne.Data.ExternalFileStorage` verify-on-download); local `server/src/store.ts:670` stores name-addressed |
| | | | reuse-search: not-found-after-corpus-and-grep |
| | | | scope: corpus 114 repos (this project not indexed), server/src/store.ts, server/src/http.ts, scripts/vfx-fetch.sh \| swept: 2026-10-28 |
| 2 | Per-file registry plus guid-ref closure (`asset_file`, bundle builder) | NEW | local closure `store.ts:446` walks only `resource_edge uses` (no bytes of extracted recipes); `asset` rows are metadata only (`007_knowledge_graph.sql`) |
| | | | reuse-search: not-found-after-corpus-and-grep |
| | | | scope: corpus 114 repos, server/src/store.ts, server/src/migrations, seed/graph \| swept: 2026-10-28 |
| 3 | Unity YAML GUID-ref scanner (`guid: <32hex>` / asmdef `GUID:`) | NEW | `grep -rnE "guid:\s*\(\?\|\[0-9a-f\]\{32\}" seed server/src` hit only `source.ts:77` (reads a `.meta`'s own guid) |
| | | | reuse-search: not-found-after-corpus-and-grep |
| | | | scope: seed/extract/source.ts, seed/extract/recipe.ts, seed/graph/build.ts, server/src/store.ts \| swept: 2026-10-28 |
| 4 | Resource-edge closure and manifest shape | EXTEND | `closure()` @ `server/src/store.ts:446`, `ClosureItem` @ `:419`; kept as `origin:"resource"` items inside the bundle |
| 5 | Recipe -> asset metadata | EXTEND | `asset`/`resource_asset` @ `007_knowledge_graph.sql`; `asset_file` joins by `guid` |
| 6 | License gate | EXTEND | `server/src/license.ts` (`EXTRACTED_LICENSES`, `extractedLicenseProblem`) gains `blobLicenseProblem` |
| 7 | Builtin GUID pattern | REUSE | `rules.assets.builtinGuidPattern` @ `seed/graph/rules.ts:17`, used by `seed/graph/build.ts:126` |
| 8 | Unity package GUID map (URP/TMP/etc. shader and material GUIDs) | NEW | no map in repo (`grep -rn "unity-package\|builtin" seed server/src` only the `builtin` flag on `asset.meta`); sources exist on disk: `unity/VFXPreview/Library/PackageCache`; design precedent only (re-check 2026-10-28): corpus `GameFoundation.Editor.PackageRegistry` `AssemblyPackageIndex.GetPackageForGuid` maps asmdef GUIDs to packages (Editor C-sharp code, not usable from the Node server) |
| | | | reuse-search: not-found-after-corpus-and-grep |
| | | | scope: corpus unity base (UITemplate, ThirdPartyServices, PluginYourGames), seed/graph/build.ts, server/src/store.ts \| swept: 2026-10-28 |
| 9 | Package sources (unitypackage, folder, folder-set) | EXTEND | `PackageSource` @ `seed/extract/source.ts:10` gains `files()` (with `.meta`), `copiesOf()`, `preferCopy` |
| 10 | URP material conversion | EXTEND | `MaterialMapping.Plan` / `MaterialConverter.ConvertAll` @ `unity/VFXPreview/Assets/Editor/VfxPreview/`; corpus: Unity's own `StandardUpgrader`/`ParticleUpgrader` (URP PackageCache `MaterialUpgrader`) is the fallback for built-in Standard/Particle shaders instead of a fourth hand mapping |
| 11 | Per-slug render-failure persistence | NEW | `_status.json` has counts and notes only; `grep -c 'FAILED\|magenta' unity/VFXPreview/Logs/preview-batch*.log` = counts, no slug list |
| | | | reuse-search: not-found-after-corpus-and-grep |
| | | | scope: unity/VFXPreview/Assets/Editor, unity/VFXPreview/Logs, seed, server/src, data/previews \| swept: 2026-10-28 |
| 12 | GIF ingest and magenta scan | REUSE | `seed/preview-gif-ingest.ts`, `seed/previews-magenta-scan.ts`, `server/src/preview-gif-encode.ts` |
| 13 | Shell fetch of a closure | EXTEND | `scripts/vfx-fetch.sh` (resource closure today) moves to the bundle through `scripts/vfx-fetch-bundle.mjs` |
| 14 | Unity client fetch window | EXTEND | `VfxCloudFetcher.cs` (single URI, no dependencies today) gains bundle install |
| 15 | Scratch-DB test harness | NEW | `grep -rn "createdb\|_test" scripts server/src` no match; existing DB tests run against the live DB |
| | | | reuse-search: not-found-after-corpus-and-grep |
| | | | scope: scripts, server/src, package.json \| swept: 2026-10-28 |
| 16 | Bulk uploader and closure verifier | NEW | `seed/ingest-extracted.ts` ingests recipes only; no byte uploader anywhere |
| | | | reuse-search: not-found-after-corpus-and-grep |
| | | | scope: seed/ingest-extracted.ts, scripts/vfx-fetch.sh, server/src/http.ts, corpus 114 repos \| swept: 2026-10-28 |
| 17 | Recipe-to-prefab builder (YAML layers -> ParticleSystem prefab) | NEW | no Editor builder reads recipe YAML: grep for `ParticleSystem.MainModule`, `PrefabUtility.SaveAsPrefabAsset` over `unity/VFXPreview/Assets/Editor` and `unity/Packages` hit nothing; `seed/extract/behavior.ts:72` only reads layer names for a description |
| | | | reuse-search: not-found-after-corpus-and-grep |
| | | | scope: unity/VFXPreview/Assets/Editor/VfxPreview/PreviewCell.cs, seed/extract/behavior.ts, corpus 114 repos (2 queries: build prefab from particle recipe; generate particle system prefab editor script: only unrelated one-off prefab generators) \| swept: 2026-10-28 |

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Migration 010 (visibility CHECK swap, new tables) applied to the live DB by an accidental `npm test`, server start or `previews:gif` before the backup | medium | high | Phase 1 and every lane run tests on scratch DBs only (`lib-testdb.sh`); phase 9 step 1 is `pg_dump -Fc` to `data/backups/` and a `pg_restore --list` check before ANY command that reaches `migrate()`; 010 is additive plus constraint widening, rollback SQL kept in phase 1 |
| Purchased-pack bytes exposed: `0.0.0.0` bind, `AUTH_DISABLED=1` compose default, unauthenticated `/mcp` | medium | high | D3 (blob routes always keyed), `cache-control: private`, no bytes over MCP, never-global CHECK, orphan blob not served; tests assert 403 without key under `AUTH_DISABLED=1`; loopback/LAN bind restriction DEFERRED by the owner (deferred decision 14) |
| Pre-existing `vfx_publish` reads any server path via `localPath`/`file_path` through the unauthenticated `/mcp` (store.ts:640-642) | medium | high | Off-scope for this plan, parked: no new tool in this plan reads a server path (uploader PUTs bytes); recommended follow-up issue to key `/mcp` |
| Upload size or time larger than estimated | medium | medium | Dry-run prints exact files/bytes by kind first; smoke N=5 prints per-file time; gzip at rest; resumable, idempotent by sha256; `--skip-kinds` |
| `graph:build` deletes `asset` rows it does not recompute (applyAssets) | low | medium | `asset_file` has no FK to `asset`; phase 9 runs `graph:build` after ingest and compares counts before/after |
| Original bytes overwritten: ImportedPacks mats are already converted | high | high | D4/C8: originals come only from vendor sources; uploader refuses a path under `ImportedPacks` for `variant=original`; test asserts the sha of a known Retro material equals the unitypackage entry |
| GUID collision or `.meta` corruption in a target project | medium | high | C6 pre-flight over the whole bundle, refuse by default, `.meta` byte-exact, post-import GUID assertion, acceptance step plants a colliding file and requires exit 3 with the tree hash unchanged |
| URP conversion visually wrong (glow, blend) so fixes loop | medium | medium | Bounded to 3 fix cycles in phase 11; each cycle limited to named rules; remaining failures must carry a documented `unfixable` cause; acceptance only demands no magenta and no unrenderable material |
| Game prefabs reference third-party plugin shaders/scripts not in any source | medium | medium | Phase 5 map plus `unresolved` reporting; such recipes get `complete:false` and a recorded cause, never a silent partial bundle |
| Nested-prefab flatten produces wrong parameters | medium | medium | D9 limits scope, unsupported overrides skip; tests built from the real skipped files |
| Editor unavailable or licence-blocked headless (README records `-batchmode` licence error) | medium | medium | Windowed Editor only, serialized phases 10-12; code lanes verified without Editor; if the Editor cannot be driven, phases 10-12 stay BLOCKED and report |
| Concurrent Unity access: user already has VFXPreview open | medium | medium | Check `t1k unity instance list` before every Editor step; use the CLI against the open Editor; never kill it |
| Recipe-built prefabs look unlike the intended effect (builder maps only what the YAML states) | medium | low | Preview is a faithful render of the recipe's stated parameters, not a guess at motion; unmapped constructs skip the slug with a reason; builder defects are fixed in phase 11 |
| Pre-existing red tests mask a new regression | medium | medium | Named pinned baseline with an inverted-pin companion (both directions, by test name), plus one full-suite run against a clone of the live corpus in phase 9 |

## Self-improvement loop

- **Signal:** `bundle-contract.test.ts` and `scripts/accept/phase-*.sh` go red when a lane drifts from the contract; `seed/verify-closure.ts` reports unresolved GUIDs per slug; `preview_render` shows every failed slug with a cause.
- **Loop:** phase 11 re-runs verify-closure and the render after each fix cycle (max 3).
- **Fix:** change `plan.md` Contract and re-brief; shared files via a phase 1 re-run.
- **Guard:** the pinned-baseline companion (phase 9), `preview_render` coverage check (rows == targets) in phase 10, the negative control in phase 12 (original-variant fetch must fail the magenta gate), and the never-global/ai_training CHECK tests from phase 1.

## Deferred decisions

| # | Question | Options | Choice taken | Why | How to reverse |
|---|----------|---------|--------------|-----|----------------|
| 1 | Bytes in DB or on disk | bytea / files in DATA_DIR | files, content-addressed, gzip text | D1 | change `storage_uri` driver in `blob-store.ts` |
| 2 | Add `studio-only` visibility | add / keep `project` | add (migration 010) | LICENSES.md already wants it; never-global CHECK is cleaner | drop value from CHECK, set rows to `project` |
| 3 | Blob auth under `AUTH_DISABLED=1` | open / keyed | keyed, opt-out env | purchased bytes | set `VFX_BLOB_ALLOW_ANON=1` |
| 4 | Level.prefab duplicate | first-game / first-copy-with-VFX | first copy with VFX | D8 | `preferCopy` option off in `pipeline.ts` |
| 5 | Nested prefabs | flatten all / flatten simple / skip | flatten simple variants only | D9 | extend `nested.ts` rules |
| 6 | Include audio and scripts | include / exclude | include | "everything needed"; 92 MB wav | `--skip-kinds` |
| 7 | 23 `probe-*` dirs | delete / leave | the orchestrator archives and deletes them outside this plan (owner decision); removed from every scope and count here | destructive, handled by the owner's session | restore from the archive |
| 8 | 10 hand-written recipes with no prefab | build prefab-from-recipe / mark skipped | BUILD (owner decision 2026-10-28): lane B, phase 14; builder-skipped slugs stay `skipped:no-prefab` with a reason | D17 | drop lane B; the slugs revert to `skipped:no-prefab` |
| 9 | Glow cap in published URP variant | cap 1.25 / none | none (preview keeps cap) | real games have bloom | set `glow_cap` in the export options |
| 10 | Package files | ship / `requires` | `requires` | UPM files belong to the target install | ship selected files via a new `kind` |
| 11 | Acceptance project | reuse VFXPreview / clean copy | clean `VFXAccept` | only a clean project proves "arrives with everything" | n/a |
| 12 | PR target | staging / main | main | origin has no `staging` branch | `gh pr edit --base` |
| 13 | Merge-up tree | flat phases / tree | flat | `t1k-tree.cjs trigger` printed `tree:true` (54 owned files >= 6) and `preflight` passed, but the user fixed the structure (Phase A shared, parallel Phase B lanes, serial Editor slots, `plan.md` + `phase-*.md`); a tree's per-node merge scheme would duplicate D14 and its leaves target `.claude/**` | re-plan as a tree with `/t1k:plan --tree` if wanted |
| 14 | `studio-only` protection beyond the key | bind to loopback/LAN or per-user tokens / key-required blob routes only | key-required blob routes only (D3); NO bind or token change now (owner decision) | one shared key is the accepted protection for this internal studio server | add a loopback bind or tokens in a later plan |
| 15 | Third-party GUIDs no source can resolve | fetch their bytes from elsewhere / report only | report-only first: bundles say `unresolved`, `complete:false`, listed per recipe; no bytes sourced elsewhere | owner decision; phase 5 output decides if a follow-up is worth it | add sources to `packs.json` later |
| 16 | The 9 pre-existing red tests | fix now / pin | pin by test name with an inverted companion (section `## Pinned baseline`); not fixed in this plan | they depend on an unseeded corpus and were red before phase 1 | seed a corpus fixture and delete the pin |
