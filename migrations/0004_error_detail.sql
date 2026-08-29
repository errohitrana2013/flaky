-- What is failing, not just how much.
--
-- usage_bucket counts errors but records neither the status nor the path, so a
-- 51% error rate was visible and unexplainable in the same glance. This holds
-- the breakdown.
--
-- The write cost is only paid on failures. A healthy service writes here almost
-- never, so this adds nothing to the per-request ceiling that migration 0003
-- was concerned with — and on the day it does start costing writes, that is
-- itself the signal.
--
-- Paths are normalised before they land here (/v1/posts/42 -> /v1/posts/:id),
-- which keeps cardinality bounded and groups the rows the way you actually want
-- to read them.

CREATE TABLE IF NOT EXISTS error_bucket (
  day     TEXT    NOT NULL,
  status  INTEGER NOT NULL,
  path    TEXT    NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, status, path)
);

CREATE INDEX IF NOT EXISTS idx_error_day ON error_bucket (day);
