-- Separate your own site's traffic from everyone else's.
--
-- The try-it widget on the landing page issues real requests carrying a
-- flakyapi.dev referrer, which put your own homepage at the top of the referrer
-- table — the one table whose entire job is answering "which channel worked".
-- It also meant the chaos-adoption figure, the number that decides whether the
-- differentiator lands, was largely counting your own clicks.
--
-- Both stay recorded. On-site usage is worth knowing; it just must not be
-- mistaken for someone finding you.

ALTER TABLE path_bucket ADD COLUMN onsite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE path_bucket ADD COLUMN onsite_chaos INTEGER NOT NULL DEFAULT 0;
