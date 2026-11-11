CREATE TABLE evidence_card_requests (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  requester text NOT NULL,
  chain text NOT NULL,
  address text NOT NULL,
  dry_run boolean NOT NULL,
  card_job_id uuid REFERENCES evidence_card_requests(job_id) ON DELETE SET NULL,
  watch_request jsonb,
  watch_confirmed jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_card_requester ON evidence_card_requests(agent_id, requester, created_at);
CREATE INDEX evidence_card_mint ON evidence_card_requests(agent_id, chain, address, created_at);
