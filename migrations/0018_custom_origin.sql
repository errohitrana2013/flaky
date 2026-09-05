-- Where a custom API was created from, and what is in it.
--
-- /custom is the second product surface and the only one with real dwell time,
-- but nothing recorded who was using it. Country and region are the same
-- coarseness as daily_visitors — deliberately not city, for the reason stated
-- on the privacy page.
--
-- `resources` is a summary ("todos:3,users:2") so the admin list does not have
-- to read every stored body to say what an API contains. A body can be 256 KB
-- and there can be a day's worth of them.
ALTER TABLE custom_apis ADD COLUMN country   TEXT NOT NULL DEFAULT '';
ALTER TABLE custom_apis ADD COLUMN region    TEXT NOT NULL DEFAULT '';
ALTER TABLE custom_apis ADD COLUMN resources TEXT NOT NULL DEFAULT '';
