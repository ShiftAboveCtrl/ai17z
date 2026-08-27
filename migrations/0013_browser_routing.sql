-- AI17Z 0013: route browser work to a worker that can actually do it, and stop
-- two jobs fighting over one browser profile.
--
-- A containerised worker has no Chrome and no display. Before this, it could
-- claim an X job and fail it. Jobs now declare whether they need a browser, and
-- a worker claims only what its role can serve.

ALTER TABLE jobs
  ADD COLUMN requires_browser boolean NOT NULL DEFAULT false;

-- Existing jobs on browser-backed channels are marked so recovery routes them
-- correctly rather than handing them to whichever worker asks first.
UPDATE jobs SET requires_browser = true WHERE channel IN ('x');

CREATE INDEX jobs_claim_browser_idx ON jobs (requires_browser, status, run_at, priority);

-- One browser profile, one operation at a time. Held by lease so a worker that
-- dies does not block the account forever.
ALTER TABLE accounts
  ADD COLUMN busy_by text,
  ADD COLUMN busy_until timestamptz,
  ADD COLUMN busy_reason text;

CREATE INDEX accounts_busy_idx ON accounts (busy_until) WHERE busy_by IS NOT NULL;

COMMENT ON COLUMN accounts.busy_by IS
  'Worker currently driving this account browser profile. Lease, not a lock: expires.';
