CREATE INDEX agent_mcp_tokens_owner_idx ON agent_mcp_tokens (owner_id);

-- One protocol and one refusal bucket per credential, plus global invalid input.
CREATE TABLE agent_mcp_audit_windows (
  bucket text PRIMARY KEY,
  token_id uuid REFERENCES agent_mcp_tokens(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL DEFAULT date_trunc('minute', now())
);
