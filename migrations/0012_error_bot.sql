-- Was this error a real caller, or a scanner?
--
-- The table showed 89 400s and 40-odd 404s with no way to tell whether they came
-- from the site's own UI, a test run, or a credential sweep. Answering it meant
-- reasoning from arithmetic offline, which is not a dashboard.
--
-- bot joins the primary key so the two are separate rows. Errors are the only
-- thing written here, so the extra cardinality costs nothing on a healthy day.

DROP TABLE IF EXISTS error_bucket;

CREATE TABLE error_bucket (
  day       TEXT    NOT NULL,
  status    INTEGER NOT NULL,
  path      TEXT    NOT NULL,
  injected  INTEGER NOT NULL DEFAULT 0,
  bot       INTEGER NOT NULL DEFAULT 0,
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, status, path, injected, bot)
);

CREATE INDEX IF NOT EXISTS idx_error_day ON error_bucket (day);
