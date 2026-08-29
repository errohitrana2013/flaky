-- Region (state/province) and a distinct-address count.
--
-- Both hang off daily_visitors rather than usage_bucket, deliberately. Adding
-- region to the hot rollup would multiply its primary key and undo the write
-- reduction from 0003; daily_visitors already has exactly one row per visitor
-- per day, so both columns come free with a write that already happens.
--
--   unique visitors = COUNT(*)              one row per person per day
--   unique addresses = COUNT(DISTINCT ip_hash)
--
-- The gap between those two numbers is the answer to "is this ten people or one
-- person with ten tabs".

ALTER TABLE daily_visitors ADD COLUMN region TEXT NOT NULL DEFAULT '';

-- SHA-256(salt + ip), truncated — never an address. Separate from `visitor`,
-- which also mixes in the user agent, so two browsers on one connection are two
-- visitors but one address.
ALTER TABLE daily_visitors ADD COLUMN ip_hash TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_visitors_region ON daily_visitors (day, country, region);
