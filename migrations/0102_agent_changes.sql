-- Changes an owner asked for in chat, and what became of each.
--
-- One row per change to one agent. The history is the product: who asked,
-- the words they used, what the setting was before and after, which part of
-- the agent it belonged to, whether reading it back agreed, and whether it was
-- confirmed, declined or undone. An agent's own settings are still written
-- through their canonical versioned tables; this row says why they moved.
CREATE TABLE agent_changes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  owner_id        uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Where it was asked for. A conversation can be deleted; the change stays.
  conversation_id uuid REFERENCES chat_conversations (id) ON DELETE SET NULL,
  message_id      uuid REFERENCES chat_messages (id) ON DELETE SET NULL,
  request_text    text NOT NULL DEFAULT '',
  kind            text NOT NULL,
  subsystem       text NOT NULL CHECK (subsystem IN ('PERSONA', 'POLICY', 'POSTING')),
  risk            text NOT NULL CHECK (risk IN ('LOW', 'CONFIRM', 'NEVER')),
  status          text NOT NULL
                  CHECK (status IN ('APPLIED', 'AWAITING_CONFIRMATION', 'DECLINED', 'UNDONE', 'REFUSED', 'FAILED')),
  summary         text NOT NULL,
  before_value    jsonb,
  after_value     jsonb,
  -- The setting read back after writing it, and whether it agreed.
  verification    jsonb NOT NULL DEFAULT '{}'::jsonb,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz,
  undone_at       timestamptz
);
CREATE INDEX agent_changes_agent_idx ON agent_changes (agent_id, created_at DESC);
