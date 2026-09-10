-- What an owner has decided about each capability, for one agent.
--
-- This was supposed to live in `agent_tools`, and the comment in
-- `capabilityPermissions.ts` said so: only genuinely new concepts get new
-- tables, and "may this agent use this" is not new. The intention was right and
-- the storage could never work, for a reason nothing surfaced:
--
--   `agent_tools.tool_id` is a foreign key into `tools`, the built-in tool
--   catalogue. `setAgentTool` writes `INSERT ... SELECT $1, t.id FROM tools
--   WHERE t.key = $2`, so a key with no catalogue row selects nothing and the
--   insert is a silent no-op. Capability ids are registry-defined and have
--   never been in that catalogue.
--
-- So every attempt to allow a capability succeeded, wrote nothing, and read
-- back as the default. Reads default to allowed, so they worked and nobody
-- noticed. Writes default to disabled, which meant `x.like` and `x.repost`
-- could not be switched on from the interface at all: the owner clicked
-- Allowed, the screen said Allowed, and the agent was refused for ever.
--
-- The obvious repair -- give each capability a `tools` row -- puts twelve
-- capabilities into the Tools screen, which lists that catalogue. Two things
-- called capability in one product was already one too many; two vocabularies
-- in one catalogue would be worse. This is the smaller table.

CREATE TABLE agent_capability_permissions (
  agent_id      uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  -- The registry id, `family.verb_noun`. Not a foreign key: the capability
  -- registry is process-wide and in memory, and a row for a capability that a
  -- later version stopped registering is a decision the owner made about
  -- something that no longer exists -- which is worth keeping and worth
  -- ignoring, not worth failing an insert over.
  capability_id text NOT NULL,
  permission    text NOT NULL CHECK (permission IN ('DISABLED', 'OWNER_APPROVAL', 'ALLOWED')),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, capability_id)
);

CREATE INDEX agent_capability_permissions_agent_idx ON agent_capability_permissions (agent_id);
