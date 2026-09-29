-- How far into a back-and-forth an agent is, counted from what it published.
--
-- The engagement step walks the agent's own replies backwards through the
-- posts they answered, one lookup per turn, on every reply it considers. The
-- rendered thread cannot be trusted for this: X collapses a long chain, and a
-- live agent read eight replies to one account as one or two.
CREATE INDEX IF NOT EXISTS actions_agent_remote_action_idx
  ON actions (agent_id, remote_action_id)
  WHERE remote_action_id IS NOT NULL;
