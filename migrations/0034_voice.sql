-- Voice fingerprints, and the recent-output ledger anti-repetition reads.
--
-- The fingerprint is derived, cached, and always traceable to the samples it
-- came from. It lives beside the persona version rather than inside it: a
-- persona is what the owner wrote, a fingerprint is what was measured, and
-- conflating the two makes it impossible to tell which is which.

CREATE TABLE voice_fingerprints (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- The derived measurements.
  fingerprint   jsonb NOT NULL,
  sample_count  integer NOT NULL DEFAULT 0,
  -- Where the samples came from: persona examples, approved posts, a corpus.
  sources       jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Set when the owner has edited it by hand, so a re-derivation does not
  -- silently undo the correction.
  pinned        boolean NOT NULL DEFAULT false,
  derived_at    timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- One current fingerprint per agent. History lives in the traces.
  UNIQUE (agent_id)
);

-- What the agent has recently published, in a form cheap to compare against.
-- The actions table has the same text, but joining through jobs and events on
-- every candidate reply is a lot of work for a similarity check.
CREATE TABLE recent_output (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  action_id      uuid REFERENCES actions(id) ON DELETE SET NULL,
  text           text NOT NULL,
  -- Who it was said to, because saying the same thing to the same person again
  -- is worse than saying it to somebody who has not heard it.
  recipient_handle text,
  posted_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX recent_output_agent_idx ON recent_output (agent_id, posted_at DESC);
