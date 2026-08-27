-- Granular capabilities.
--
-- An agent-account link carried one action_type, which conflated two different
-- questions: what the agent does in response to an event, and what it is
-- permitted to do at all. An agent could reply or post, never both, and nothing
-- recorded a decision to allow it. Capabilities answer the second question and
-- are checked at execution, not only in the UI.

CREATE TABLE agent_account_capabilities (
  agent_id   uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  capability text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (agent_id, account_id, capability),
  -- The grant only means anything while the link exists.
  FOREIGN KEY (agent_id, account_id) REFERENCES agent_accounts (agent_id, account_id) ON DELETE CASCADE
);

CREATE INDEX agent_account_capabilities_account_idx ON agent_account_capabilities (account_id);

-- Existing links keep exactly what they could already do: read, generate, and
-- the one action they were configured for. Nothing gains a permission here.
INSERT INTO agent_account_capabilities (agent_id, account_id, capability)
SELECT agent_id, account_id, c
  FROM agent_accounts, LATERAL (VALUES ('READ'), ('GENERATE')) AS v(c);

INSERT INTO agent_account_capabilities (agent_id, account_id, capability)
SELECT agent_id, account_id, action_type
  FROM agent_accounts
 WHERE action_type <> 'NONE'
ON CONFLICT DO NOTHING;
