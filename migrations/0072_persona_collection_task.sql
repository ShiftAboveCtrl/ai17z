-- Collecting a persona corpus is browser work, so it is a browser task.
--
-- "Learn from this account" ran in the API process and shelled out to twscrape,
-- a Python library that is not in any packaged installation -- so it answered
-- "unavailable" everywhere and the feature did nothing. Reading X is something
-- AI17Z already does, in the signed-in Chrome the worker owns, and the API owns
-- no browsers: it records the intent here and the worker executes it, exactly
-- as CONNECT, OPEN_AUTH and the rest already work.
--
-- The CHECK is widened the same way every previous kind was added. Nothing else
-- about the table changes, and an installation that never uses the feature is
-- unaffected.
ALTER TABLE browser_tasks DROP CONSTRAINT browser_tasks_kind_check;
ALTER TABLE browser_tasks ADD CONSTRAINT browser_tasks_kind_check
  CHECK (kind IN (
    'CONNECT','HEALTH_CHECK','OPEN_AUTH','SCREENSHOT','CLEAR','DISCONNECT','INGEST',
    'PREFLIGHT','CANCEL_AUTH','SHUTDOWN_BROWSER','CREDENTIAL_SIGN_IN','COLLECT_PERSONA'
  ));
