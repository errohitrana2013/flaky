-- Separate people from scanners.
--
-- classifyClient already labels bots, but that label only ever reached
-- Analytics Engine. The D1 rollups the dashboard reads had no idea, so within
-- hours of the domain going live "visitors" was counting the commodity crawlers
-- that probe /.env and /.git/config on every new host.
--
-- A metric you cannot trust is worse than no metric: it makes scanning look
-- like traction.

ALTER TABLE daily_visitors ADD COLUMN bot INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_visitors_bot ON daily_visitors (day, bot);
