-- AI17Z 0014: browser preflight as a system-level task.
--
-- Preflight answers "can this machine drive a browser at all", which is not a
-- question about any one account. The API has no browser, so it records the
-- intent and a browser-capable worker answers it.

ALTER TABLE browser_tasks
  ALTER COLUMN account_id DROP NOT NULL;

ALTER TABLE browser_tasks
  DROP CONSTRAINT browser_tasks_kind_check;

ALTER TABLE browser_tasks
  ADD CONSTRAINT browser_tasks_kind_check
    CHECK (kind IN ('CONNECT','HEALTH_CHECK','OPEN_AUTH','SCREENSHOT','CLEAR','DISCONNECT','INGEST','PREFLIGHT'));

-- Account-scoped tasks already allow one active per account. NULL account ids do
-- not collide in that index, so system tasks get their own guard.
CREATE UNIQUE INDEX browser_tasks_active_system_key ON browser_tasks (kind)
  WHERE account_id IS NULL AND status IN ('PENDING', 'RUNNING');
