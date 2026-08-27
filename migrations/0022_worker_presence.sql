-- Worker presence, and unblocking browser tasks nobody can run.
--
-- Pressing "Open sign-in" with no browser-capable worker running queued a task
-- that stayed PENDING forever. The unique index on active tasks then refused
-- every later attempt with "a task is already running for this account", which
-- was true and useless: nothing was running, and nothing ever would.
--
-- Two things were missing. Nowhere recorded whether a worker able to do the job
-- even exists, and recovery only ever looked at RUNNING tasks.

CREATE TABLE workers (
  id           text PRIMARY KEY,
  role         text NOT NULL,
  -- Capabilities are derived from the role, but stored so the API can answer
  -- "can anything here open a browser?" without knowing what a role means.
  browser_capable boolean NOT NULL DEFAULT false,
  jobs_capable    boolean NOT NULL DEFAULT false,
  hostname     text,
  version      text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workers_seen_idx ON workers (last_seen_at DESC);

-- A task that was never claimed needs a shorter fuse than one that was: nothing
-- is in flight, so freeing it costs nothing and leaving it costs the account.
ALTER TABLE browser_tasks
  ADD COLUMN superseded_by uuid REFERENCES browser_tasks(id) ON DELETE SET NULL;

ALTER TABLE browser_tasks DROP CONSTRAINT IF EXISTS browser_tasks_status_check;
ALTER TABLE browser_tasks
  ADD CONSTRAINT browser_tasks_status_check
    CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED','CANCELLED','SUPERSEDED'));

-- Free whatever is stuck right now, so upgrading fixes the account rather than
-- requiring somebody to know this table exists.
UPDATE browser_tasks
   SET status = 'CANCELLED',
       error = 'Cancelled while upgrading: no worker had picked this up.',
       finished_at = now()
 WHERE status IN ('PENDING', 'RUNNING');
