-- One row per crossing of an owner-confirmed risk watch on a published evidence card.
-- The two unique keys are the whole idempotency story: the card and the Studio
-- observation, and the card and the crossing, so a restart or a repeated Studio
-- batch can offer the same follow-up only once.
CREATE TABLE evidence_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_job_id uuid NOT NULL REFERENCES evidence_card_requests(job_id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES radar_sources(id) ON DELETE CASCADE,
  observation_id text NOT NULL,
  crossing_key text NOT NULL,
  -- Exactly the measured numbers and their times; no text, no handle, nothing about the asker.
  observation jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'rehearsed', 'skipped')),
  reason text,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  queued_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (card_job_id, observation_id),
  UNIQUE (card_job_id, crossing_key)
);
CREATE INDEX evidence_followups_due ON evidence_followups(next_attempt_at) WHERE status = 'pending';
CREATE INDEX evidence_followups_agent_day ON evidence_followups(agent_id, queued_at) WHERE status = 'queued';
CREATE UNIQUE INDEX evidence_followups_job ON evidence_followups(job_id) WHERE job_id IS NOT NULL;
