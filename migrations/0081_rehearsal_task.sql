-- Reading a real post so an agent can be tried against it, without publishing.
--
-- The Response Lab answers the question an owner asks before they will let an
-- agent near their account: what would it say to this, and why that. Answering
-- it honestly means using a real post rather than a typed approximation,
-- because most of what decides a reply, meaning who wrote it, what was said
-- above, when it happened and what had to be looked up, is exactly what a typed
-- approximation leaves out.
--
-- ### Why this is a browser task
--
-- The same reason COLLECT_PERSONA and READ_X_ACCOUNT are. The API owns no
-- browsers, and reading X goes through the signed-in session the worker holds.
-- A lab that read X from the API would need a second way in, which is the
-- requirement that killed the feature this one descends from.
--
-- ### Read-only, and unable to be otherwise
--
-- It calls the X intelligence layer, which has no post, like, follow, repost or
-- message in its contract and must never grow one. What it does with what it
-- read is manufacture an event and run the ordinary pipeline as a **dry run**,
-- so nothing here can publish even by mistake: every remote call in the execute
-- step is behind `!job.dryRun`, and the rehearsal reads the job row back to
-- check the flag landed rather than trusting that it did.
ALTER TABLE browser_tasks DROP CONSTRAINT browser_tasks_kind_check;
ALTER TABLE browser_tasks ADD CONSTRAINT browser_tasks_kind_check
  CHECK (kind IN (
    'CONNECT','HEALTH_CHECK','OPEN_AUTH','SCREENSHOT','CLEAR','DISCONNECT','INGEST',
    'PREFLIGHT','CANCEL_AUTH','SHUTDOWN_BROWSER','CREDENTIAL_SIGN_IN','COLLECT_PERSONA',
    'READ_X_ACCOUNT','REHEARSE_X_POST'
  ));
