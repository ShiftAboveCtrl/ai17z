-- Goals that last across wakes. 0145 gave a goal one bounded attempt for ever.
-- Here a goal keeps a history of attempts, a small checkpoint of what earlier
-- attempts found, a daily budget, and a place to propose an ending. The latest
-- attempt still lives in agent_goals.plan, so nothing that reads it changes.

ALTER TABLE agent_goals
  ADD COLUMN daily_step_budget int NOT NULL DEFAULT 6
    CONSTRAINT agent_goals_daily_step_budget_check CHECK (daily_step_budget BETWEEN 1 AND 30),
  ADD COLUMN daily_time_budget_ms int NOT NULL DEFAULT 180000
    CONSTRAINT agent_goals_daily_time_budget_check CHECK (daily_time_budget_ms BETWEEN 10000 AND 900000),
  -- What earlier attempts found, built from validated capability output only.
  -- The hard cap is on the stored text, so a bug cannot grow it.
  ADD COLUMN resume jsonb
    CONSTRAINT agent_goals_resume_check CHECK (
      resume IS NULL OR (jsonb_typeof(resume) = 'object' AND octet_length(resume::text) <= 2048)
    ),
  -- When the next attempt may start. Not next_review_at, which has no reader.
  ADD COLUMN next_attempt_at timestamptz,
  -- The agent proposes an ending and the owner accepts it. The agent never
  -- writes status or progress.
  ADD COLUMN proposed_end text
    CONSTRAINT agent_goals_proposed_end_check CHECK (proposed_end IS NULL OR proposed_end IN ('DONE','ABANDON')),
  ADD COLUMN proposed_end_reason text NOT NULL DEFAULT ''
    CONSTRAINT agent_goals_proposed_end_reason_check CHECK (char_length(proposed_end_reason) <= 300),
  -- Set when a write may or may not have happened. Only the owner clears it.
  ADD COLUMN blocked_reason text,
  -- Attempts in a row that found nothing new. Drives the backoff and the
  -- proposal to abandon a goal that cannot move.
  ADD COLUMN quiet_attempts int NOT NULL DEFAULT 0
    CONSTRAINT agent_goals_quiet_attempts_check CHECK (quiet_attempts >= 0);

-- A goal that already ended an attempt under 0145 waits a normal interval
-- before its second one rather than starting on the next wake.
UPDATE agent_goals SET next_attempt_at = now() + interval '2 hours' WHERE plan IS NOT NULL;

CREATE TABLE agent_goal_attempts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id     uuid NOT NULL REFERENCES agent_goals (id) ON DELETE CASCADE,
  agent_id    uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  attempt_no  int NOT NULL CHECK (attempt_no >= 1),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  state       text NOT NULL CHECK (state IN ('RUNNING','COMPLETED','PROPOSED','STOPPED','EXHAUSTED','INTERRUPTED')),
  -- Shaped exactly like agent_goals.plan steps: references and outcomes only.
  steps       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(steps) = 'array'),
  summary     text NOT NULL DEFAULT '',
  -- Facts this attempt added that earlier attempts did not hold.
  new_facts   int NOT NULL DEFAULT 0 CHECK (new_facts >= 0),
  UNIQUE (goal_id, attempt_no)
);

-- The compare-and-set backstop: a goal cannot have two running attempts.
CREATE UNIQUE INDEX agent_goal_attempts_one_running ON agent_goal_attempts (goal_id) WHERE state = 'RUNNING';
CREATE INDEX agent_goal_attempts_window ON agent_goal_attempts (goal_id, started_at DESC);
