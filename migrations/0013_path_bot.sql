-- Exclude bots from the one metric that decides the product's direction.
--
-- The chaos-adoption figure counted every request carrying _delay/_status/
-- _fail_rate. The e2e suite sends those dozens of times per run from curl, which
-- is classified a bot everywhere else — so the dashboard read 18.5% and told the
-- reader "people are reaching for the controls" when it was measuring a test
-- script.
--
-- Cheaper than adding bot to the primary key: two counters. A bot row and a
-- human row for the same path stay one row, and the human figure is a
-- subtraction.

ALTER TABLE path_bucket ADD COLUMN bot_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE path_bucket ADD COLUMN bot_chaos    INTEGER NOT NULL DEFAULT 0;
