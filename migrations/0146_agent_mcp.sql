CREATE TABLE agent_mcp_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  agent_ids uuid[] NOT NULL CHECK (cardinality(agent_ids) BETWEEN 1 AND 100),
  hourly_quota integer NOT NULL CHECK (hourly_quota BETWEEN 1 AND 1000),
  window_start timestamptz NOT NULL DEFAULT date_trunc('hour', now()),
  calls integer NOT NULL DEFAULT 0,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
