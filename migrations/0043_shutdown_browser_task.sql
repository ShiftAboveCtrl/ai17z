-- SHUTDOWN_BROWSER: actually close the browser, not just let go of it.
--
-- DISCONNECT detaches: for a CDP-attached browser Playwright drops the
-- connection and Chrome keeps running, which is right when somebody else
-- started it and wrong when AI17Z did. Stopping an agent has to be able to take
-- the window and its process tree with it, or "stopped" is not true.
--
-- Whether AI17Z started a browser is answered by the endpoint file it writes
-- beside the profile, so a browser it merely attached to is still only detached
-- from.

ALTER TABLE browser_tasks DROP CONSTRAINT browser_tasks_kind_check;
ALTER TABLE browser_tasks ADD CONSTRAINT browser_tasks_kind_check
  CHECK (kind IN ('CONNECT','HEALTH_CHECK','OPEN_AUTH','SCREENSHOT','CLEAR','DISCONNECT','INGEST','PREFLIGHT','CANCEL_AUTH','SHUTDOWN_BROWSER'));
