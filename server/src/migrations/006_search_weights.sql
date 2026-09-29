-- Search v2: weighted, stemmed full-text (name A > tags/keywords/synonyms B > category C > description D).
-- 'simple' had no stemming ("Bubbles" never matched "bubble") and one flat weight. The generated column
-- must be rebuilt to change its expression; search_text (app-written) now also carries keywords,
-- split name tokens, English synonyms and Vietnamese aliases (see server/src/search-doc.ts).
DROP INDEX IF EXISTS resource_search_idx;
ALTER TABLE resource DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE resource ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', regexp_replace(name, ' \([^()]*\)$', '')), 'A') ||
  setweight(to_tsvector('english', search_text), 'B') ||
  setweight(to_tsvector('english', category), 'C') ||
  setweight(to_tsvector('english', description), 'D')
) STORED;
CREATE INDEX resource_search_idx ON resource USING gin (search_tsv);
