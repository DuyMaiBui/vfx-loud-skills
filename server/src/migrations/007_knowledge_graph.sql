-- Knowledge graph over the corpus.
--  * three new relations: variant_of (same effect, other colour/version), pairs_with (muzzle + projectile +
--    impact of one weapon set), applies_to (technique/component/shader/code -> recipes it applies to);
--  * resource_edge.weight: similarity score for similar_to (Jaccard over shared assets), NULL otherwise;
--  * `asset`: materials / textures / shaders / meshes that extracted recipes reference by GUID, one row per
--    (guid, kind), metadata ONLY (no bytes, no embedding, no search text). Deliberately NOT `resource` rows:
--    they would be returned by every unfiltered search, counted by /v1/facets and healthz, and need fake
--    storage_uri/embedding. `resource_asset` is the recipe -> asset `uses` edge.
ALTER TABLE resource_edge DROP CONSTRAINT IF EXISTS resource_edge_rel_check;
ALTER TABLE resource_edge ADD CONSTRAINT resource_edge_rel_check CHECK (rel IN
  ('uses','requires','derived_from','similar_to','variant_of','pairs_with','applies_to'));
ALTER TABLE resource_edge ADD COLUMN IF NOT EXISTS weight REAL;

CREATE TABLE IF NOT EXISTS asset (
  id         BIGSERIAL PRIMARY KEY,
  guid       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('material','texture','shader','mesh')),
  name       TEXT NOT NULL,
  path       TEXT,                       -- source path inside the pack; NULL for external / built-in references
  pack       TEXT NOT NULL DEFAULT '',
  license    TEXT NOT NULL,              -- licence of the pack that ships it
  visibility TEXT NOT NULL DEFAULT 'project' CHECK (visibility IN ('project','team','global')),
  external   BOOLEAN NOT NULL DEFAULT false,
  meta       JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guid, kind)
);

CREATE TABLE IF NOT EXISTS resource_asset (
  resource_id BIGINT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  asset_id    BIGINT NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  rel         TEXT   NOT NULL DEFAULT 'uses' CHECK (rel IN ('uses')),
  PRIMARY KEY (resource_id, asset_id, rel)
);
CREATE INDEX IF NOT EXISTS resource_asset_asset_idx ON resource_asset (asset_id);

CREATE INDEX IF NOT EXISTS resource_family_idx ON resource ((meta->>'family')) WHERE meta->>'family' IS NOT NULL;
