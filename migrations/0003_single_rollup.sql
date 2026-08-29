-- Collapse three rollup tables into one.
--
-- usage_daily, usage_hourly and usage_geo held the same fact at three
-- different grains, so every request paid for three upserts. They are all just
-- different GROUP BYs over (day, hour, key, country), so one table serves all
-- three and the per-request write cost drops from four statements to two.
--
-- That matters because D1's free tier allows 100k writes a day. At four writes
-- per request the rollups became the ceiling at ~25k requests/day — before the
-- Workers request limit binds. At two, the ceiling doubles.
--
-- Cardinality is bounded: 24 hours x countries seen x keys active, per day.
-- For anonymous traffic that is at most a few thousand rows a day.

CREATE TABLE IF NOT EXISTS usage_bucket (
  day       TEXT    NOT NULL,
  hour      INTEGER NOT NULL,
  key_id    TEXT    NOT NULL DEFAULT 'anon',
  tier      TEXT    NOT NULL DEFAULT 'anonymous',
  country   TEXT    NOT NULL DEFAULT 'XX',
  requests  INTEGER NOT NULL DEFAULT 0,
  errors    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, hour, key_id, country)
);

CREATE INDEX IF NOT EXISTS idx_bucket_day     ON usage_bucket (day);
CREATE INDEX IF NOT EXISTS idx_bucket_country ON usage_bucket (day, country);
CREATE INDEX IF NOT EXISTS idx_bucket_key     ON usage_bucket (day, key_id);

-- The superseded tables held only smoke-test traffic at the time of this
-- migration. Dropping them rather than leaving them dead keeps the schema
-- honest about where the numbers come from.
DROP TABLE IF EXISTS usage_daily;
DROP TABLE IF EXISTS usage_hourly;
DROP TABLE IF EXISTS usage_geo;
