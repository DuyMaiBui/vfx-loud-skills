-- Visual review flow: a session = a frozen, ordered list of candidate URIs shown on /review; a selection = which of
-- them the user picked (and for which role: muzzle / projectile / impact ...). Selections are replaced wholesale on
-- each submit, so the table always holds the latest pick set.
CREATE TABLE IF NOT EXISTS review_session (
  id         TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  query      JSONB NOT NULL DEFAULT '{}',
  uris       JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS review_selection (
  session_id TEXT NOT NULL REFERENCES review_session(id) ON DELETE CASCADE,
  uri        TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT '',
  chosen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, uri)
);
