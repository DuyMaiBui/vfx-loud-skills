# Phase 2: Server blob store, registry, bundle builder (lane S)

Lane: S
Depends-on: 1
Steps: lane-decides
Effort: L
Agent: `t1k-fullstack-developer`, worktree `../vfx-skill-cloud-worktrees/lane-S`.
Owns: `server/src/blob-store*.ts`, `server/src/bundle-builder*.ts`, `server/src/http.ts`, `server/src/mcp.ts`, `scripts/smoke.sh`
Creates: `server/src/blob-store.ts`, `server/src/blob-store.test.ts`, `server/src/bundle-builder.ts`, `server/src/bundle-builder.test.ts`, `scripts/accept/phase-2.sh`
AX: AX-01 every route answers the C5 error envelope with a stable `code`; AX-10 `scripts/smoke.sh` prints one PASS/FAIL line per route
Accept: `bash scripts/accept/phase-2.sh`

## Goal

Implement plan.md C1-C5 on the server: store and serve bytes, register files, build the bundle, expose `vfx_fetch` `bundle`. Read-only inputs: every phase-1 file (contract, `unity-refs.ts`, `license.ts`, migration, config). A needed change there: STOP and report.

## Steps

1. `blob-store.ts`: `putBlob(stream|Buffer, expectedSha, kind)` (hash while writing to `blobs/tmp/<rand>`, compare, gzip by `TEXT_KINDS`, `rename` into `<aa>/<bb>/<sha>`, upsert `asset_blob`; second put of the same sha is a no-op returning `created:false`; over `blobMaxBytes` aborts and deletes the temp), `missing(shas)`, `openBlob(sha, acceptsGzip)` (stream, gunzips when the client does not accept gzip), `isReferenced(sha)` (true when the sha is the `asset_sha256` OR the `meta_sha256` of any `asset_file` row; a test requires a `.meta` blob to be served).
2. `registerFiles(inputs)`: per item validate against `bundle-contract.ts`, `blobLicenseProblem`, both blobs present (`conflict` + `details.missing`), compute `refs = scanRefs(decompressed asset bytes)` server-side (YAML kinds only; binary kinds `refs=[]`), upsert by `(guid, variant)` with `unchanged | created | replaced | rejected` semantics from C3.
3. `bundle-builder.ts`: `buildBundle(uri, variant)`: roots = (a) existing `closure()` items as `origin:"resource"`, (b) the recipe's `meta.source.prefabGuid` from `asset_file` (variant rule C4); BFS over `refs` (bounded by `bundleMaxFiles`); classification order for a missing guid: `asset_file` -> `isBuiltinGuid` -> package map (`requires`) -> `unresolved`; deterministic DFS post-order with `KIND_RANK`; `cycles`; `complete`, `reason`, `file_count`, `total_bytes`; absolute URLs via the existing `absoluteUrl()` rule (`PUBLIC_BASE_URL`).
4. `http.ts`: auth `onRequest` extension for `/v1/blob*`, `/v1/asset-file*`, `/v1/closure*` (C3 rule, 403 `forbidden` when no key configured and no opt-in); `addContentTypeParser('application/octet-stream', {parseAs:'buffer'})` with `bodyLimit = blobMaxBytes` only for the PUT route; error handler maps `too_large`->413, `forbidden`->403, passes `details`; the six route rows of C3 (GET also answers HEAD) including `HEAD`/`304` on `GET /v1/blob/:sha`.
5. `mcp.ts`: `vfx_fetch` input `variant` (zod enum, default `urp`), output adds `bundle`; legacy `closure` unchanged; MCP code path never reads or returns bytes.
6. `scripts/smoke.sh`: add blob PUT/GET/missing, batch register, closure, 403 without key under `AUTH_DISABLED=1`.
7. Tests (all call `assertScratchDb()`, use a temp `DATA_DIR`): put/get round-trip incl. gzip and non-gzip client; hash mismatch 400 and no file left behind; 256 MiB limit via a lowered `VFX_BLOB_MAX_BYTES`; orphan blob 404; batch register all four statuses; license gate `forbidden`; bundle for the fixture graph (prefab -> 2 materials -> texture + shader, one URP material, one cycle, one builtin ref, one package ref, one unresolved): exact `files` order, `requires`, `unresolved`, `complete`; `variant=urp` omits the pack shader no shipped material still references; `reason:"no_prefab"` and `"bytes_not_uploaded"`; `origin:"resource"` item; auth matrix (no key, wrong key, `AUTH_DISABLED=1`, opt-in).
8. `scripts/accept/phase-2.sh`: `with-testdb.sh S` running `npm run check` and the two test files plus `scripts/smoke.sh` against a throw-away server on a random port with the scratch DB.
9. Branch `lane/S`, pathspec commit, push, report. No PR (D14).

## Verification and falsifiability

`bash scripts/accept/phase-2.sh` green. Each C1/C3 rule has a test that fails when the rule is deleted (e.g. remove the always-keyed hook -> the `AUTH_DISABLED=1` test goes red; remove the sha compare -> the mismatch test goes red).

## Rollback

`git revert` / drop branch `lane/S`; no live data touched (scratch DB only).
