-- "Test this agent": a suite of synthetic situations run through the real
-- Response Lab, each a rehearsal (a dry-run job the ordinary pipeline runs).
--
-- Only which job answered which case is stored. What each case's verdict is
-- (pass, needs reading, stayed silent, failed) is judged from the job when it
-- is read, so the suite shows exactly what the rehearsal's own trace says and
-- nothing a second recorder could disagree with.

CREATE TABLE agent_test_suites (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  -- The Foundry run the cases came from, when they came from one.
  foundry_run_id uuid REFERENCES research_runs (id) ON DELETE SET NULL,
  requested_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  -- [{ id, category, title, message, expect, checks, jobId, error }]
  cases          jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_test_suites_agent_idx ON agent_test_suites (agent_id, created_at DESC);
