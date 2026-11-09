-- One on-request simulation per incoming message, across retries and workers.
-- A claimed request without a result is held for inspection, never rerun.
CREATE TABLE social_paper_requests (
  agent_id uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 200),
  result jsonb CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND result->'simulated' = 'true'::jsonb) IS TRUE),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (agent_id, request_key)
);
