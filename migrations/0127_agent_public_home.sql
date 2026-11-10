-- Publication consent belongs to this installation, never to a portable agent.
CREATE TABLE agent_public_home (
  agent_id uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  pending jsonb,
  confirmed jsonb,
  post_link boolean NOT NULL DEFAULT false,
  problem text,
  proposed_digest text
);
