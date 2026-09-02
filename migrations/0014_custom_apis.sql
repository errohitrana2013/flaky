-- User-supplied JSON, served as a mock API for 24 hours.
--
-- Close cousin of the sandbox: same 24h life, same nightly purge. The
-- difference is that a sandbox overlays the built-in dataset, while this is
-- entirely the caller's own shape.
--
-- The whole document is one row rather than a row per record. These are read far
-- more often than written, always in full, and never queried across — so a blob
-- is one read instead of many, and there is no schema to guess at.

CREATE TABLE IF NOT EXISTS custom_apis (
  id          TEXT PRIMARY KEY,
  body        TEXT    NOT NULL,   -- the JSON exactly as given
  bytes       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_custom_expires ON custom_apis (expires_at);
