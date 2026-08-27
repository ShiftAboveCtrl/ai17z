-- Relationship memory: who the agent is talking to.
--
-- Every reply was written as though it were the first. Somebody who had been
-- talking to the agent for weeks got the same explanatory tone as a stranger,
-- and a conversation that continued across two posts had no continuity at all.
--
-- Deliberately narrow. This holds what happened between the agent and a person:
-- how often they have spoken, what about, what was said, what the agent owes
-- them. It is not a dossier, and nothing here infers anything about somebody
-- from anything other than the conversations they chose to have.

CREATE TABLE relationships (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  channel        text NOT NULL,
  -- The platform's own id where known; the handle is what is usually available
  -- and can change, so both are kept and the id wins when present.
  remote_user_id text,
  handle         text NOT NULL,
  display_name   text NOT NULL DEFAULT '',

  first_interaction_at timestamptz NOT NULL DEFAULT now(),
  last_interaction_at  timestamptz NOT NULL DEFAULT now(),
  interaction_count    integer NOT NULL DEFAULT 0,
  -- Counted separately: somebody the agent has answered ten times is a
  -- different relationship from somebody who has mentioned it ten times.
  inbound_count        integer NOT NULL DEFAULT 0,
  outbound_count       integer NOT NULL DEFAULT 0,

  -- NEW | KNOWN | FAMILIAR | REGULAR. Derived, not editable directly, but the
  -- owner can pin it when the derivation is wrong.
  familiarity        text NOT NULL DEFAULT 'NEW'
                       CHECK (familiarity IN ('NEW','KNOWN','FAMILIAR','REGULAR')),
  familiarity_pinned boolean NOT NULL DEFAULT false,

  -- What the conversations have actually been about, learned from them.
  topics       jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- A sentence the owner can read and correct.
  summary      text NOT NULL DEFAULT '',
  -- How this person tends to write, so the agent can meet them where they are.
  typical_tone text,
  -- Owner-supplied notes. Never generated.
  owner_note   text NOT NULL DEFAULT '',

  -- Set by the owner to change how the agent treats this person.
  disposition  text NOT NULL DEFAULT 'NEUTRAL'
                 CHECK (disposition IN ('NEUTRAL','FRIENDLY','CAUTIOUS','BLOCKED')),

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, channel, handle)
);

CREATE INDEX relationships_lookup_idx ON relationships (agent_id, channel, lower(handle));
CREATE INDEX relationships_recent_idx ON relationships (agent_id, last_interaction_at DESC);
CREATE INDEX relationships_remote_idx ON relationships (agent_id, channel, remote_user_id)
  WHERE remote_user_id IS NOT NULL;

-- Distinctive things worth referring back to. A callback is what makes a
-- conversation feel continuous, and overusing one is what makes it feel scripted.
CREATE TABLE relationship_callbacks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id uuid NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
  -- A short phrase naming the shared reference, in the agent's own words.
  label           text NOT NULL,
  detail          text NOT NULL DEFAULT '',
  -- Where it came from, so a callback can always be traced to a real exchange.
  source_event_id uuid REFERENCES events(id) ON DELETE SET NULL,
  source_job_id   uuid REFERENCES jobs(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz,
  use_count       integer NOT NULL DEFAULT 0,
  -- The owner can retire one that has worn out without deleting the history.
  retired         boolean NOT NULL DEFAULT false,
  UNIQUE (relationship_id, label)
);

CREATE INDEX relationship_callbacks_usable_idx
  ON relationship_callbacks (relationship_id, last_used_at NULLS FIRST)
  WHERE NOT retired;
