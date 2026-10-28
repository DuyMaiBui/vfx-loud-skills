-- 010: self-contained VFX fetch (plans/261028-self-contained-vfx-fetch, plan.md C1/C2/C9, D1/D2/D4).
-- Additive: no data rewrite. Widens the visibility CHECKs with `studio-only`, adds the byte registry
-- (asset_blob = one row per stored blob, bytes live on disk under DATA_DIR/blobs), the per-file
-- registry (asset_file = one row per (guid, variant)), and the per-slug render-failure record.
--
-- Constraint names: Postgres names an inline column CHECK `<table>_<column>_check`; 001_init created
-- resource_visibility_check and 007 created asset_visibility_check. Confirmed on a scratch DB by
-- server/src/bundle-contract.test.ts (pg_constraint lookup).
--
-- ROLLBACK (manual, never executed: migrate() runs every .sql in this directory, so the reverse
-- statements stay commented here). Run in order inside one transaction on a restored backup only:
--   BEGIN;
--   DROP TABLE preview_render, asset_file, asset_blob;
--   UPDATE resource SET visibility = 'project' WHERE visibility = 'studio-only';
--   UPDATE asset SET visibility = 'project' WHERE visibility = 'studio-only';
--   ALTER TABLE resource DROP CONSTRAINT resource_visibility_check,
--     ADD CONSTRAINT resource_visibility_check CHECK (visibility IN ('project','team','global'));
--   ALTER TABLE asset DROP CONSTRAINT asset_visibility_check,
--     ADD CONSTRAINT asset_visibility_check CHECK (visibility IN ('project','team','global'));
--   DELETE FROM schema_migrations WHERE name = '010_asset_blobs.sql';
--   COMMIT;
--   then: rm -rf "$DATA_DIR/blobs"

-- D2: studio-only = holder of the single server key; never global for bytes (C1).
ALTER TABLE resource DROP CONSTRAINT IF EXISTS resource_visibility_check;
ALTER TABLE resource ADD CONSTRAINT resource_visibility_check
  CHECK (visibility IN ('project','team','studio-only','global'));

ALTER TABLE asset DROP CONSTRAINT IF EXISTS asset_visibility_check;
ALTER TABLE asset ADD CONSTRAINT asset_visibility_check
  CHECK (visibility IN ('project','team','studio-only','global'));

-- One row per distinct stored blob (content-addressed); the bytes are on disk, never in this row.
-- datastore-class: aggregate
CREATE TABLE IF NOT EXISTS asset_blob (
  sha256       TEXT PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes        BIGINT NOT NULL CHECK (bytes >= 0),
  stored_bytes BIGINT NOT NULL CHECK (stored_bytes >= 0),
  encoding     TEXT NOT NULL CHECK (encoding IN ('identity','gzip')),
  -- relative to DATA_DIR, same convention as resource.storage_uri
  storage_uri  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (guid, variant): the registry of every file a bundle can ship. No FK to asset(id):
-- graph:build deletes and recreates asset rows, so the join is by guid.
-- datastore-class: aggregate
CREATE TABLE IF NOT EXISTS asset_file (
  id           BIGSERIAL PRIMARY KEY,
  guid         TEXT NOT NULL CHECK (guid ~ '^[0-9a-f]{32}$'),
  variant      TEXT NOT NULL CHECK (variant IN ('original','urp')),
  kind         TEXT NOT NULL CHECK (kind IN
                 ('prefab','material','texture','shader','mesh','animation','controller','script','asmdef','audio','other')),
  path         TEXT NOT NULL,
  asset_sha256 TEXT NOT NULL REFERENCES asset_blob(sha256),
  meta_sha256  TEXT REFERENCES asset_blob(sha256),
  refs         TEXT[] NOT NULL DEFAULT '{}',
  pack         TEXT NOT NULL,
  license      TEXT NOT NULL,
  -- C1: a row here can never be global (CHECK), only the legacy resource rows can.
  visibility   TEXT NOT NULL CHECK (visibility IN ('project','team','studio-only')),
  -- C1: documented constant; the rule itself is enforced by blobLicenseProblem (license.ts).
  ai_training  BOOLEAN NOT NULL DEFAULT false CHECK (ai_training = false),
  source       JSONB NOT NULL DEFAULT '{}',
  urp          JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guid, variant)
);
CREATE INDEX IF NOT EXISTS asset_file_asset_sha256_idx ON asset_file (asset_sha256);
CREATE INDEX IF NOT EXISTS asset_file_meta_sha256_idx ON asset_file (meta_sha256);
CREATE INDEX IF NOT EXISTS asset_file_refs_idx ON asset_file USING GIN (refs);

-- C9: one row per slug (latest run wins). Bounded by the render target count.
-- datastore-class: aggregate
CREATE TABLE IF NOT EXISTS preview_render (
  slug         TEXT PRIMARY KEY,
  state        TEXT NOT NULL CHECK (state IN ('ok','failed','skipped')),
  cause        TEXT,
  detail       TEXT,
  shaders      TEXT[] NOT NULL DEFAULT '{}',
  run_id       TEXT NOT NULL,
  rendered_at  TIMESTAMPTZ NOT NULL,
  CHECK (state <> 'failed' OR cause IS NOT NULL),
  CHECK (cause IS NULL OR cause IN ('magenta-pixel','unrenderable-material','prefab-missing','exception',
    'no-visible-output','closure-unresolved','unfixable-shader','unfixable-source','unfixable-script',
    'no-prefab','variant-borrows-canonical'))
);
