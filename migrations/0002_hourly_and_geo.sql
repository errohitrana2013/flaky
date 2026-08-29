-- Traffic by hour of day and by country.
--
-- Analytics Engine already holds all of this per request, and stays the place
-- to go for an ad-hoc question. These rollups exist so the dashboard can answer
-- the two recurring ones — when do people show up, and where from — with a
-- single fast D1 read instead of an API call.

-- A visitor is counted once per day, so the country they first appeared from is
-- enough to count unique visitors per region without a second table.
ALTER TABLE daily_visitors ADD COLUMN country TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_visitors_country ON daily_visitors (day, country);

-- 24 rows per day. Hours are UTC; the dashboard converts to the viewer's local
-- time, because "when should I ship" is a local-time question.
CREATE TABLE IF NOT EXISTS usage_hourly (
  day       TEXT    NOT NULL,
  hour      INTEGER NOT NULL,
  requests  INTEGER NOT NULL DEFAULT 0,
  errors    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, hour)
);

CREATE INDEX IF NOT EXISTS idx_hourly_day ON usage_hourly (day);

-- Two-letter ISO country code from Cloudflare, or 'XX' when it cannot tell.
-- Country is as fine-grained as this gets: city or region would start to make
-- a low-traffic day identifying, which the visitor hashing exists to prevent.
CREATE TABLE IF NOT EXISTS usage_geo (
  day       TEXT    NOT NULL,
  country   TEXT    NOT NULL,
  requests  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, country)
);

CREATE INDEX IF NOT EXISTS idx_geo_day ON usage_geo (day);
