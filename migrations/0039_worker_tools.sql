-- What tools each worker can actually reach.
--
-- Availability was answered by whichever process was asked, so the API said
-- "twscrape is not on PATH" while a worker three inches away had it installed
-- and working. A worker knows what it can reach; the API knows who asked.

ALTER TABLE workers
  ADD COLUMN tools jsonb NOT NULL DEFAULT '{}'::jsonb;
