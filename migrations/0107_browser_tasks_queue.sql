-- A browser task may wait its turn instead of deleting the one before it.
--
-- `browser_tasks_active_key` allows one PENDING or RUNNING task per account,
-- because a Chrome profile is held by one process and two browsers on one
-- profile is a real conflict. That index is correct and stays.
--
-- What was wrong is what happened on collision. `enqueueBrowserTask` superseded
-- the pending task, on the reasoning that pressing a button twice means "do it
-- now" rather than "do it twice". True for CONNECT and OPEN_AUTH, where the
-- second press is the same intention. False for a read, where the second request
-- names a different person: asking to read Alice and then Bob read only Bob, and
-- Alice's request ended SUPERSEDED with "Replaced by a newer request for the
-- same account." Measured on a real installation: two READ_X_ACCOUNT requests,
-- one observation row.
--
-- QUEUED sits outside the unique index's predicate, so several may wait while
-- exactly one is PENDING or RUNNING. Exclusivity is still the index's to enforce
-- rather than the application's, which is why this is a status rather than a
-- second table.
ALTER TABLE browser_tasks DROP CONSTRAINT IF EXISTS browser_tasks_status_check;
ALTER TABLE browser_tasks
  ADD CONSTRAINT browser_tasks_status_check
  CHECK (status IN ('QUEUED', 'PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED'));

-- The worker promotes a queued task only when its account has nothing active,
-- so this is the index that lookup uses.
CREATE INDEX IF NOT EXISTS browser_tasks_queued_idx
  ON browser_tasks (account_id, created_at)
  WHERE status = 'QUEUED';
