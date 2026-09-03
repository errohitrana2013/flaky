-- The other direction: succeed N times, then start failing.
--
-- 0015 does "fail twice, then work", which is what a retry policy and a circuit
-- breaker need. But a rate limit behaves the other way round — fine, fine, fine,
-- then 429 — and so does everything else that runs out: a quota, a free trial,
-- an access token, a session. Those are the failures people cannot reproduce
-- without either burning real quota or waiting for a real clock.
--
-- One flag rather than a second table, because it is the same counter read
-- against the same threshold; only the comparison flips.
--
-- Note on the column name: fail_count is now "the threshold" — the number of
-- attempts before the behaviour changes. With invert = 0 those attempts fail
-- (0015's meaning, unchanged). With invert = 1 they succeed, and everything
-- after fails. Renaming it would have meant an ALTER on a live table for the
-- sake of a word, so the meaning is documented here instead.

ALTER TABLE scenarios ADD COLUMN invert INTEGER NOT NULL DEFAULT 0;
