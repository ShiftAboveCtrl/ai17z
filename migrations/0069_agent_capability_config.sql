-- Per-agent settings for one capability, beside the decision about it.
--
-- `CapabilityContext.config` has existed since capabilities did, and its
-- comment said the value came from `agent_tools.config`. It did not, and could
-- not: capabilities stopped going through `agent_tools` when migration 0068
-- gave them a table of their own, and before that the row they would have read
-- was never written either. `stepGenerate` is the only production caller of
-- `runCapabilityLoop`, and it passed `permissions` and never `configs`, so the
-- field arrived at every capability as `{}` and the sentence describing it was
-- false in two ways at once.
--
-- A field a capability can read and nobody can set is not configuration, it is
-- a promise. This is the storage that makes it one.
--
-- It belongs here rather than in a table of its own because it is the same
-- question about the same pair: what has this owner said about this capability
-- for this agent. Splitting "may it" from "how" across two tables would mean
-- two writes, two reads and two chances for them to disagree about which
-- capability they are describing.
ALTER TABLE agent_capability_permissions
  ADD COLUMN config jsonb NOT NULL DEFAULT '{}'::jsonb;

-- An object, never a scalar or a list. Every reader treats it as a bag of named
-- settings -- `Record<string, unknown>` in the contract -- and a bare `3` or a
-- `[1,2]` stored here would arrive as something no caller has a branch for.
-- Checked at the database because that is where the guarantee has to live: the
-- runtime is not the only thing that can write a row.
ALTER TABLE agent_capability_permissions
  ADD CONSTRAINT agent_capability_permissions_config_object
  CHECK (jsonb_typeof(config) = 'object');
