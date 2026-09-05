-- The chaos-adoption figure only ever knew about three of the seven controls.
--
-- `_scenario`, `_malformed`, `_retry_after` and `_cors=off` were invisible to
-- it, so the one number the product is steered by excluded the strongest thing
-- the product does. Worse, the share was computed as
-- with_delay + with_status + with_fail_rate, which counts a request twice when
-- it carries two controls — so the figure was simultaneously missing requests
-- and double-counting others.
--
-- with_any fixes the share: one per request, whatever it reached for. The two
-- named columns join the per-control breakdown, since "is anyone using
-- scenarios" is a question worth answering on its own.
ALTER TABLE path_bucket ADD COLUMN with_any       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE path_bucket ADD COLUMN with_scenario  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE path_bucket ADD COLUMN with_malformed INTEGER NOT NULL DEFAULT 0;

-- Backfill, or every historical day reads as 0% adoption until the window rolls
-- over. MAX() of the three is a floor: it is exact for the common case of one
-- control per request and never claims more chaos requests than there were.
UPDATE path_bucket SET with_any = MAX(with_delay, with_status, with_fail_rate);
