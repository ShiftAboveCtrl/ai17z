-- "Why is it moving": a measured what-changed reply. One row per ask, so the
-- hourly asker cap and the per-mint cap count the reads it spent (two: the
-- pools of the mint, and the latest swaps through the chosen pool). card_job_id
-- is the job whose reads answered it, itself when it read.
CREATE TABLE evidence_move_requests (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  requester text NOT NULL,
  chain text NOT NULL,
  address text NOT NULL,
  "window" text NOT NULL CHECK ("window" IN ('5m', '1h', '6h', '24h')),
  reads smallint NOT NULL CHECK (reads BETWEEN 0 AND 2),
  dry_run boolean NOT NULL,
  card_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_move_requester ON evidence_move_requests(agent_id, requester, created_at);
CREATE INDEX evidence_move_mint ON evidence_move_requests(agent_id, chain, address, created_at);

-- What this installation itself read about one pool of one mint, so a later ask
-- can say "then" from a reading and not from arithmetic. Every figure is nullable:
-- a figure the source did not send is absent, never zero.
CREATE TABLE mint_window_reads (
  id bigserial PRIMARY KEY,
  chain text NOT NULL,
  address text NOT NULL,
  pool_address text NOT NULL,
  source text NOT NULL,
  read_at timestamptz NOT NULL,
  price_usd double precision,
  liquidity_usd double precision,
  volume_m5 double precision,
  volume_h1 double precision,
  volume_h6 double precision,
  volume_h24 double precision
);
CREATE INDEX mint_window_reads_lookup ON mint_window_reads(chain, address, pool_address, read_at DESC);
