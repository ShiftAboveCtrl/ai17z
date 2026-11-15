-- "Explain this transaction": a plain reading of one public Solana signature.
-- One row per ask, so the per-asker hourly cap and the signature cooldown count
-- the reads it spent (zero when the answer of a recent ask was reused). The
-- signature is stored because it is public chain data; nothing links it to a
-- person or a handle.
CREATE TABLE evidence_transaction_requests (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  requester text NOT NULL,
  signature text NOT NULL,
  reads smallint NOT NULL CHECK (reads BETWEEN 0 AND 2),
  dry_run boolean NOT NULL,
  card_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_transaction_requester ON evidence_transaction_requests(agent_id, requester, created_at);
CREATE INDEX evidence_transaction_signature ON evidence_transaction_requests(agent_id, signature, created_at);
