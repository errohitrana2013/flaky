-- How long people stay on a page.
--
-- The server cannot know this: it sees a request, not a departure. The pages
-- send a beacon on unload with the seconds elapsed, and this aggregates them.
--
-- Sums rather than individual visits, so nothing here can be traced to a
-- person. One write per page view — page views are a small fraction of API
-- traffic, so this does not move the per-request cost at all.

CREATE TABLE IF NOT EXISTS page_time (
  day          TEXT    NOT NULL,
  path         TEXT    NOT NULL,
  visits       INTEGER NOT NULL DEFAULT 0,
  sum_seconds  INTEGER NOT NULL DEFAULT 0,
  max_seconds  INTEGER NOT NULL DEFAULT 0,
  bounced      INTEGER NOT NULL DEFAULT 0,   -- left in under 10 seconds
  PRIMARY KEY (day, path)
);

CREATE INDEX IF NOT EXISTS idx_pagetime_day ON page_time (day);
