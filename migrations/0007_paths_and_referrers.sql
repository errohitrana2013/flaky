-- The two questions the dashboard cannot answer.
--
--   1. Is the differentiator actually being used? Nothing recorded whether a
--      request carried _delay, _status or _fail_rate. That is *the* product
--      question — a mock API with unused chaos parameters is just a slower
--      JSONPlaceholder — and it was invisible.
--
--   2. Where is traffic coming from? Referrer went to Analytics Engine only,
--      so measuring whether a Reddit post or a Stack Overflow answer worked
--      meant an API call and a token.
--
-- path_bucket costs one write per request, taking the steady cost from two to
-- three. At D1's 100k/day free write ceiling that moves the limit from ~50k to
-- ~33k requests/day, which is far above current traffic and worth the trade for
-- questions this central. referrer_bucket is written only when a referrer is
-- present, which for an API is rare.

CREATE TABLE IF NOT EXISTS path_bucket (
  day             TEXT    NOT NULL,
  path            TEXT    NOT NULL,   -- normalised: /v1/posts/42 -> /v1/posts/:id
  requests        INTEGER NOT NULL DEFAULT 0,
  sum_ms          INTEGER NOT NULL DEFAULT 0,   -- with requests, gives a mean
  max_ms          INTEGER NOT NULL DEFAULT 0,   -- the tail the mean hides
  with_delay      INTEGER NOT NULL DEFAULT 0,
  with_status     INTEGER NOT NULL DEFAULT 0,
  with_fail_rate  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path)
);

CREATE INDEX IF NOT EXISTS idx_path_day ON path_bucket (day);

-- Truncated and host-only. A full referrer URL can carry a search query or a
-- private path, and the host answers "which channel worked" on its own.
CREATE TABLE IF NOT EXISTS referrer_bucket (
  day       TEXT    NOT NULL,
  referrer  TEXT    NOT NULL,
  requests  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, referrer)
);

CREATE INDEX IF NOT EXISTS idx_referrer_day ON referrer_bucket (day);
