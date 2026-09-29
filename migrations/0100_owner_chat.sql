-- Owner chat: an owner talking to their own agents, one at a time or several
-- in a room.
--
-- A conversation is history, never memory. Nothing written here reaches an
-- agent's durable memory unless the owner saves it, and a save is its own row
-- that outlives the conversation: deleting a conversation must not take a
-- memory the owner deliberately kept, and deleting that memory must not
-- rewrite the message it came from.

CREATE TABLE chat_conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title       text NOT NULL DEFAULT '',
  -- AGENT is one agent and its owner; ROOM is several agents and their owner.
  kind        text NOT NULL CHECK (kind IN ('AGENT', 'ROOM')),
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_conversations_owner_idx ON chat_conversations (owner_id, updated_at DESC);

CREATE TABLE chat_participants (
  conversation_id uuid NOT NULL REFERENCES chat_conversations (id) ON DELETE CASCADE,
  agent_id        uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  -- The order "Ask all" answers in, so a later agent can read an earlier one.
  position        integer NOT NULL,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, agent_id)
);
CREATE INDEX chat_participants_agent_idx ON chat_participants (agent_id);

CREATE TABLE chat_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES chat_conversations (id) ON DELETE CASCADE,
  -- Order within a conversation. Several answers are written in one
  -- transaction and share a timestamp, so time cannot order them.
  seq             bigint GENERATED ALWAYS AS IDENTITY,
  -- OWNER wrote it; AGENT is an answer; NOTICE is AI17Z saying something
  -- about the conversation itself (an agent left, a turn was cut short).
  author_kind     text NOT NULL CHECK (author_kind IN ('OWNER', 'AGENT', 'NOTICE')),
  agent_id        uuid REFERENCES agents (id) ON DELETE SET NULL,
  content         text NOT NULL DEFAULT '',
  -- Only an agent's answer moves through these. An owner's message is DONE
  -- when written.
  status          text NOT NULL DEFAULT 'DONE'
                  CHECK (status IN ('PENDING', 'ANSWERING', 'DONE', 'FAILED', 'CANCELLED')),
  -- The owner message an answer is to. Answers never create answers, which is
  -- what stops two agents talking to each other for ever.
  answers         uuid REFERENCES chat_messages (id) ON DELETE CASCADE,
  -- What the answer rests on: capabilities used, memories retrieved, the
  -- model that wrote it. Conclusions and sources, never reasoning.
  evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,
  error           text,
  locked_by       text,
  lock_expires_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  answered_at     timestamptz
);
CREATE INDEX chat_messages_conversation_idx ON chat_messages (conversation_id, seq);
CREATE INDEX chat_messages_due_idx ON chat_messages (seq) WHERE status IN ('PENDING', 'ANSWERING');

-- What the owner chose to keep from a conversation, and where it went.
CREATE TABLE chat_saves (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     uuid REFERENCES chat_conversations (id) ON DELETE SET NULL,
  message_id          uuid REFERENCES chat_messages (id) ON DELETE SET NULL,
  agent_id            uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  -- MEMORY is one agent's own memory; KNOWLEDGE is a knowledge source the
  -- owner gave that agent, which is how a room's shared conclusion reaches
  -- each agent they chose and nobody else.
  target              text NOT NULL CHECK (target IN ('MEMORY', 'KNOWLEDGE')),
  memory_id           uuid REFERENCES memories (id) ON DELETE SET NULL,
  knowledge_source_id uuid REFERENCES knowledge_sources (id) ON DELETE SET NULL,
  content             text NOT NULL,
  saved_by            uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_saves_conversation_idx ON chat_saves (conversation_id);

-- Why a recorded event produced no work for an agent.
--
-- Ingest has always known and only ever logged it, so "why didn't you answer
-- this?" about a post with no job could be answered only by guessing from
-- today's settings. Written in the ingest transaction, one row per agent.
CREATE TABLE event_agent_skips (
  event_id    uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  agent_id    uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  reason      text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, agent_id)
);
