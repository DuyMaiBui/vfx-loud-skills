-- VFX Skill Cloud V0 — contract xem plans/260928-1659-vfx-skill-cloud-v0/phase-0-contract.md
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS resource (
  id            BIGSERIAL PRIMARY KEY,
  uri           TEXT UNIQUE NOT NULL,
  type          TEXT NOT NULL CHECK (type IN
                  ('texture','shader','code','recipe','component','vfx')),
  slug          TEXT NOT NULL,
  version       INT  NOT NULL DEFAULT 1,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  tags          TEXT[] NOT NULL DEFAULT '{}',
  style         TEXT[] NOT NULL DEFAULT '{}',
  category      TEXT NOT NULL DEFAULT '',
  engine        TEXT NOT NULL DEFAULT 'unity',
  license       TEXT NOT NULL,
  visibility    TEXT NOT NULL DEFAULT 'project'
                  CHECK (visibility IN ('project','team','global')),
  storage_uri   TEXT NOT NULL,
  preview_uri   TEXT,
  mime          TEXT NOT NULL DEFAULT 'application/octet-stream',
  bytes         INT  NOT NULL DEFAULT 0,
  embedding     vector(384),
  meta          JSONB NOT NULL DEFAULT '{}',
  created_by    TEXT NOT NULL DEFAULT 'seed',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  search_text   TEXT NOT NULL DEFAULT '',   -- tags::text KHÔNG immutable -> app ghi tay
  search_tsv    tsvector GENERATED ALWAYS AS (
                  to_tsvector('simple',
                    name || ' ' || description || ' ' ||
                    category || ' ' || search_text)
                ) STORED,
  UNIQUE (type, slug, version)
);

CREATE INDEX IF NOT EXISTS resource_embedding_idx
  ON resource USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS resource_tags_idx ON resource USING gin (tags);
CREATE INDEX IF NOT EXISTS resource_type_idx ON resource (type);
CREATE INDEX IF NOT EXISTS resource_search_idx ON resource USING gin (search_tsv);

CREATE TABLE IF NOT EXISTS resource_edge (
  src BIGINT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  dst BIGINT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  rel TEXT   NOT NULL CHECK (rel IN ('uses','requires','derived_from','similar_to')),
  PRIMARY KEY (src, dst, rel)
);
