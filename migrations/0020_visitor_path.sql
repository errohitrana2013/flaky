-- What a returning visitor actually did, path by path.
--
-- The frequency table says twenty-four people came back and nothing about why.
-- Every other rollup is keyed by day and path with no visitor column, so "which
-- endpoints did the person who came back five times use" could not be asked at
-- all — about the only people who have shown any sign of preferring this to
-- whatever they were using before.
--
-- This is the first table that records behaviour against an identity rather
-- than in aggregate, and it puts a third write on every request. Both were
-- weighed and chosen deliberately. The write ceiling drops from roughly 33k
-- requests a day to roughly 25k, which still binds later than the Workers
-- request limit on the free plan; and the privacy page now states plainly that
-- the trail is kept, tied to the same salted hash as everything else, for the
-- same 90 days as the visitor row it hangs off.
--
-- Bots are never written here. A credential sweep touches dozens of probe paths
-- in a minute and would be most of this table by row count while answering
-- nothing — the question is what interested people do, and a scanner is not
-- interested in anything.
--
-- Paths arrive already normalised (/v1/posts/42 is stored as /v1/posts/:id), so
-- the row count per visitor is bounded by the number of endpoints rather than
-- by traffic.
CREATE TABLE IF NOT EXISTS visitor_path (
  day        TEXT    NOT NULL,
  visitor    TEXT    NOT NULL,
  path       TEXT    NOT NULL,
  requests   INTEGER NOT NULL DEFAULT 0,
  -- Whether this person reached for the thing the product exists for, on this
  -- path. The aggregate share cannot say whether one enthusiast is the whole
  -- number; per visitor, it can.
  chaos      INTEGER NOT NULL DEFAULT 0,
  errors     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, visitor, path)
);

-- The read is always "these visitors, across this window", so visitor leads.
CREATE INDEX IF NOT EXISTS idx_visitorpath_visitor ON visitor_path (visitor, day);
-- The nightly purge deletes by day, on the same 90-day cutoff as daily_visitors.
CREATE INDEX IF NOT EXISTS idx_visitorpath_day ON visitor_path (day);
