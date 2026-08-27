-- CANCEL_AUTH: stop waiting on a sign-in nobody is going to finish.
--
-- Without it the only way out of an open sign-in window was to wait for the
-- deadline, which is fifteen minutes of a screen saying it is waiting for you.

ALTER TABLE browser_tasks DROP CONSTRAINT browser_tasks_kind_check;
ALTER TABLE browser_tasks
  ADD CONSTRAINT browser_tasks_kind_check
    CHECK (kind IN ('CONNECT','HEALTH_CHECK','OPEN_AUTH','SCREENSHOT','CLEAR','DISCONNECT','INGEST','PREFLIGHT','CANCEL_AUTH'));
