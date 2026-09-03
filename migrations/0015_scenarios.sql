-- Deterministic failure sequences: fail N times, then recover.
--
-- _fail_rate is a coin toss, which is right for "does my UI survive an unlucky
-- day" and useless for the two things people actually hand-roll fakes to test:
--
--   retry logic     — fail twice, succeed on the third, assert the backoff worked
--   circuit breakers — fail N consecutive times to force the breaker open, then
--                      recover so it can close again
--
-- Both need a counter, so this is the first stateful thing in the API. One row
-- per scenario, one write per request that uses one — opt-in, so it costs
-- nothing for anybody who does not.

CREATE TABLE IF NOT EXISTS scenarios (
  id          TEXT PRIMARY KEY,
  fail_count  INTEGER NOT NULL,          -- how many attempts fail before recovery
  status      INTEGER NOT NULL DEFAULT 503,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scenarios_expires ON scenarios (expires_at);
