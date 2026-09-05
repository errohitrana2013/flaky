-- Mark the pastes that are just the example.
--
-- "Use an example" then "Create the API" is the most common thing that happens
-- on /custom, and it says nothing about what anyone wanted to mock. The admin
-- table hides these so what is left is the traffic worth reading.
--
-- New rows get the flag at insert time by comparing the stored body. This
-- backfills the existing ones the same way: the body is the output of
-- JSON.stringify, so it is byte-identical for every whitespace variant of the
-- example, and one changed value is enough to miss the match — which is exactly
-- the behaviour wanted.
ALTER TABLE custom_apis ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0;

UPDATE custom_apis SET is_sample = 1 WHERE body = '{"todos":[{"id":1,"title":"Test the loading state","done":false,"userId":1},{"id":2,"title":"Test the error state","done":true,"userId":1},{"id":3,"title":"Test the retry logic","done":false,"userId":2}],"users":[{"id":1,"name":"Asha Menon","team":"Platform"},{"id":2,"name":"Wei Chen","team":"Product"}]}';
