-- The idea backlog.
--
-- An agent told to post daily has to post something, and the obvious
-- implementation is "it is 9am, invent a thought". That produces exactly the
-- content nobody wants: generic, untethered, and indistinguishable from every
-- other scheduled account.
--
-- Ideas come from things that actually happened — a conversation, a question
-- nobody answered, a position the agent took — and a scheduled post picks one
-- up rather than starting from nothing.

CREATE TABLE content_ideas (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

  -- observation | opinion | question | educational | prediction | thread |
  -- follow_up | callback | project_update
  kind         text NOT NULL DEFAULT 'observation',
  -- The idea in a sentence, as a note to self rather than as a draft.
  summary      text NOT NULL,
  -- Longer detail when there is any.
  detail       text NOT NULL DEFAULT '',

  -- Where it came from. An idea with no source is the thing this exists to
  -- prevent, so the origin is always recorded.
  source       text NOT NULL DEFAULT 'manual',
  source_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  source_handle text,

  -- 0-100. How promising it looked when it was captured.
  score        integer NOT NULL DEFAULT 50,
  -- unused | drafting | used | discarded
  status       text NOT NULL DEFAULT 'unused'
                 CHECK (status IN ('unused','drafting','used','discarded')),
  used_job_id  uuid REFERENCES jobs(id) ON DELETE SET NULL,
  used_at      timestamptz,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX content_ideas_usable_idx ON content_ideas (agent_id, score DESC)
  WHERE status = 'unused';
CREATE INDEX content_ideas_agent_idx ON content_ideas (agent_id, created_at DESC);
