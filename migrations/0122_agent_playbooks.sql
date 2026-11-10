-- Which published playbook an agent's paper mandate was set from, and at which
-- version. A pin is never edited: importing a new version retires the old pin
-- and writes another, in the same transaction that writes the mandate it
-- produced, so "what did it run last month" has an answer.
--
-- `document` is the playbook as published; `effective` is what was applied
-- after the owner's own ceiling narrowed it. Both are kept because the gap
-- between them is exactly what an owner asks about.
--
-- There is no status column on purpose: whether a pin is still what the agent
-- runs is computed by comparing mandate_id with the agent's current mandate, so
-- an owner editing the mandate by hand can never leave a pin claiming more
-- than is true.
CREATE TABLE agent_playbooks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  owner_id       uuid REFERENCES users (id) ON DELETE SET NULL,
  playbook_id    text NOT NULL,
  version        integer NOT NULL CHECK (version >= 1),
  title          text NOT NULL,
  content_sha256 text NOT NULL,
  document       jsonb NOT NULL,
  effective      jsonb NOT NULL,
  mandate_id     uuid NOT NULL REFERENCES trade_mandates (id) ON DELETE CASCADE,
  imported_at    timestamptz NOT NULL DEFAULT now(),
  retired_at     timestamptz
);
CREATE UNIQUE INDEX agent_playbooks_live_idx ON agent_playbooks (agent_id) WHERE retired_at IS NULL;
CREATE INDEX agent_playbooks_history_idx ON agent_playbooks (agent_id, imported_at DESC);
