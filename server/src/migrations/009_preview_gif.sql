-- Animated GIF preview per recipe slug, stored IN the database so an effect set (or any search hit) can be
-- previewed from the DB alone, without a loose file on disk and without a video element.
--
-- Why the GIF lives here and the webm/poster do not: the webm is what the lane renders and what a <video>
-- plays (Range requests, seeking); both stay under data/previews/. The GIF is the compact, self-contained,
-- always-loadable copy, so it is the one that travels with the row (backup, restore, second server).
--
-- One row per slug (the latest encode). `slug` is the middle segment of `vfx://recipe/<slug>/<version>`.
-- Idempotence key is (source_sha256, builder): re-ingesting the same rendered webm with the same encoder
-- generation is a no-op; a re-render has a new source hash and replaces the bytes in place.
-- Bounded by the recipe count and written once per re-rendered effect, read by a point lookup on the unique
-- slug index: an aggregate row set, not an event stream.
--
-- datastore-class: aggregate
CREATE TABLE preview_gif (
  slug          TEXT PRIMARY KEY CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  gif           BYTEA NOT NULL,
  width         INT   NOT NULL CHECK (width > 0),
  height        INT   NOT NULL CHECK (height > 0),
  frames        INT   NOT NULL CHECK (frames > 0),
  fps           INT   NOT NULL CHECK (fps > 0),
  bytes         INT   NOT NULL CHECK (bytes > 0 AND bytes = octet_length(gif)),
  -- hex sha256 of the GIF bytes: the HTTP ETag and the "same picture" check.
  sha256        TEXT  NOT NULL,
  -- hex sha256 of the source webm this was encoded from: half of the idempotence key.
  source_sha256 TEXT  NOT NULL,
  -- encoder generation (`v1`); bumping it forces a re-encode on the next ingest.
  builder       TEXT  NOT NULL,
  -- the ladder rung that won the size budget, e.g. `192px@12fps/96c` (diagnostics only).
  encoder       TEXT  NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
