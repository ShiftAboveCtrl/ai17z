-- Every time an agent used a capability, and what happened.
--
-- The concept is new. `tools` and `agent_tools` already say what exists and
-- what an agent may use, and neither has ever recorded a use -- because until
-- now nothing called one. A capability that runs without leaving a record is
-- the thing `docs/ENGINEERING.md` warns about from the other direction: an
-- owner who cannot see what their agent did has to trust it instead.
--
-- Keyed to the job where there is one. A capability can also run outside a job
-- (a readiness probe, an owner pressing something), so job_id is nullable and
-- agent_id is not.

CREATE TABLE capability_invocations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  job_id         uuid REFERENCES jobs (id) ON DELETE CASCADE,
  account_id     uuid REFERENCES accounts (id) ON DELETE SET NULL,
  capability_id  text NOT NULL,
  -- Which of the loop's steps this was. One-based, so "step 3 of 3" reads the
  -- way a person counts, and a bounded loop's ceiling is visible in the data.
  step           integer NOT NULL DEFAULT 1,
  outcome        text NOT NULL CHECK (outcome IN ('SUCCEEDED','FAILED','REFUSED','TIMED_OUT')),
  -- What the owner sees, and what the model was told. One sentence.
  detail         text NOT NULL DEFAULT '',
  -- Validated input and output, never the raw model text: the point of the
  -- schemas is that what ran is what is recorded.
  input          jsonb NOT NULL DEFAULT '{}'::jsonb,
  output         jsonb,
  duration_ms    integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- The two questions asked of this table: what did this job do, and what has
-- this agent been doing lately.
CREATE INDEX capability_invocations_job_idx ON capability_invocations (job_id, created_at);
CREATE INDEX capability_invocations_agent_idx ON capability_invocations (agent_id, created_at DESC);
