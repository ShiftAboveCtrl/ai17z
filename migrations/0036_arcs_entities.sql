-- Conversation arcs and the entity graph.
--
-- Every turn was handled as though the thread had just started. An argument
-- that developed over six replies was re-derived from a transcript each time,
-- which is expensive, lossy, and means the agent can concede a point and then
-- argue it again two turns later.
--
-- Thread state is the summary that survives: what the disagreement is, what has
-- been settled, what is still open. Retrieved instead of a raw transcript.

CREATE TABLE thread_states (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  -- The remote thread key, so a state can be found before a conversation row
  -- exists for it.
  remote_conversation_id text NOT NULL,

  summary         text NOT NULL DEFAULT '',
  main_topic      text,
  -- What the two of them are actually disagreeing about, if anything.
  open_question   text,
  resolved_points jsonb NOT NULL DEFAULT '[]'::jsonb,
  participants    jsonb NOT NULL DEFAULT '[]'::jsonb,

  turn_count      integer NOT NULL DEFAULT 0,
  -- Rebuilt every few turns rather than every turn: summarising costs a model
  -- call and a thread does not change that fast.
  summarised_at_turn integer NOT NULL DEFAULT 0,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, remote_conversation_id)
);

CREATE INDEX thread_states_recent_idx ON thread_states (agent_id, updated_at DESC);

-- Recurring things the agent says. Not phrases — arguments. An agent with three
-- ideas that it recycles endlessly is worse than one with three ideas it knows
-- it has already used this week.
CREATE TABLE narratives (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  label        text NOT NULL,
  detail       text NOT NULL DEFAULT '',
  use_count    integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, label)
);

CREATE INDEX narratives_rested_idx ON narratives (agent_id, last_used_at NULLS FIRST);

-- Recurring public things worth recognising: projects, organisations, topics.
-- Postgres tables rather than a graph database, because the shape is small and
-- the queries are lookups.
CREATE TABLE entities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- person | project | organisation | topic | event
  kind         text NOT NULL,
  name         text NOT NULL,
  name_key     text NOT NULL,
  summary      text NOT NULL DEFAULT '',
  mention_count integer NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, kind, name_key)
);

CREATE INDEX entities_lookup_idx ON entities (agent_id, name_key);

CREATE TABLE entity_edges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  from_id      uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_id        uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  -- works_on | mentioned_with | discussed | related_to
  relation     text NOT NULL,
  -- How many times this connection has been observed, which is the only claim
  -- being made: that these two came up together, not that anything is true.
  observations integer NOT NULL DEFAULT 1,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_id, to_id, relation)
);

CREATE INDEX entity_edges_from_idx ON entity_edges (from_id);
