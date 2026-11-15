-- One row per mint read for a two-mint comparison. evidence_card_requests is keyed
-- on the job, so a second mint from the same job needs a table of its own. Both
-- tables count toward the same hourly asker cap, so asking for a pair spends two
-- reads, never one.
CREATE TABLE evidence_compare_requests (
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  side smallint NOT NULL CHECK (side IN (0, 1)),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  requester text NOT NULL,
  chain text NOT NULL,
  address text NOT NULL,
  dry_run boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, side)
);
CREATE INDEX evidence_compare_requester ON evidence_compare_requests(agent_id, requester, created_at);
CREATE INDEX evidence_compare_mint ON evidence_compare_requests(agent_id, chain, address, created_at);
