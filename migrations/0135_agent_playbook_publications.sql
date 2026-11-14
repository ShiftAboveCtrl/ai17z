-- Publishing this installation's own agent setup as a Studio playbook.
--
-- The inbound direction (import) pins a published playbook to an agent in
-- agent_playbooks. This is the outbound direction: the publication record for
-- one agent's own paper setup. `pending` holds the exact document the owner was
-- shown, before it is confirmed; `confirmed` holds what Studio accepted, so a
-- later publish is a new version rather than an overwrite. There is no status
-- column: whether Studio still lists it is what Studio said last, and an
-- outcome that could not be confirmed is `problem`.
CREATE TABLE agent_playbook_publications (
  agent_id  uuid PRIMARY KEY REFERENCES agents (id) ON DELETE CASCADE,
  pending   jsonb,
  confirmed jsonb,
  problem   text
);
