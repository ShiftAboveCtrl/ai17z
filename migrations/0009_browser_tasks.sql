-- XBAM 0009: browser control plane.
--
-- A Chromium profile directory can only be opened by one process at a time, so
-- exactly one process is allowed to drive browsers: the worker. The API records
-- an intent here and the worker carries it out. This is the structural fix for
-- the legacy arrangement where browser authentication lived outside the
-- application entirely, in hand-launched Chrome windows.

CREATE TABLE browser_tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('CONNECT','HEALTH_CHECK','OPEN_AUTH','SCREENSHOT','CLEAR','DISCONNECT','INGEST')),
  status       text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED')),
  requested_by uuid REFERENCES users (id) ON DELETE SET NULL,
  params       jsonb NOT NULL DEFAULT '{}'::jsonb,
  result       jsonb,
  error        text,
  locked_by    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz
);
CREATE INDEX browser_tasks_pending_idx ON browser_tasks (status, created_at);
CREATE INDEX browser_tasks_account_idx ON browser_tasks (account_id, created_at DESC);

-- At most one queued or running task per account, so a user hammering the button
-- cannot open four browsers against the same profile.
CREATE UNIQUE INDEX browser_tasks_active_key ON browser_tasks (account_id)
  WHERE status IN ('PENDING', 'RUNNING');
