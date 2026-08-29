-- Separate deliberate failures from real ones.
--
-- "What is failing" lumped them together, so a 503 that a caller explicitly
-- requested with ?_status=503 looked identical to a 503 the service produced on
-- its own. On this API that is exactly backwards: an injected failure is the
-- product working, and burying one real 500 among fifty requested ones hides
-- the only row that matters.
--
-- injected joins the primary key so the two kinds are separate rows rather than
-- a flag on a merged count. The table is days old and holds only test traffic,
-- so recreating it costs nothing worth keeping.

DROP TABLE IF EXISTS error_bucket;

CREATE TABLE error_bucket (
  day       TEXT    NOT NULL,
  status    INTEGER NOT NULL,
  path      TEXT    NOT NULL,
  injected  INTEGER NOT NULL DEFAULT 0,   -- 1 = the caller asked for this
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, status, path, injected)
);

CREATE INDEX IF NOT EXISTS idx_error_day ON error_bucket (day);
