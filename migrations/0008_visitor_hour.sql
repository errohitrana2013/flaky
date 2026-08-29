-- When people arrive, as distinct from how many requests land.
--
-- usage_bucket counts requests per hour, which one busy script can dominate.
-- "when do people show up" is a different question and the one that matters for
-- deciding when to ship or post.
--
-- This records the hour a visitor was FIRST seen that day, so the chart reads
-- as arrivals. It costs no extra write: the column is set on the insert that
-- already happens and is never updated, because a visitor only arrives once.
--
-- -1 marks rows written before this column existed, and they are excluded
-- rather than silently bucketed into hour 0.

ALTER TABLE daily_visitors ADD COLUMN hour INTEGER NOT NULL DEFAULT -1;

CREATE INDEX IF NOT EXISTS idx_visitors_hour ON daily_visitors (day, hour);
