-- A goal gets one bounded attempt, including proposals and refusals. Keeping
-- the result on the goal prevents a later wake reviving a revoked grant.
ALTER TABLE agent_goals ADD COLUMN plan jsonb;
ALTER TABLE agent_goals ADD CONSTRAINT agent_goals_plan_check CHECK (
  plan IS NULL OR (
    jsonb_typeof(plan) = 'object'
    AND plan->>'state' IS NOT NULL
    AND plan->>'state' IN ('RUNNING','COMPLETED','PROPOSED','STOPPED','EXHAUSTED')
  )
);
