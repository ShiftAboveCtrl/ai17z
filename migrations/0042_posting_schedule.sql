-- When an agent may say something nobody asked it to.
--
-- One row per agent. The schedule is a ceiling, not a timetable: when it comes
-- due the agent looks in its idea backlog, and posts only if there is something
-- there worth saying. An agent with nothing to say says nothing, and the row
-- records that as the reason rather than inventing a post because a timer went
-- off.
--
-- next_post_at is claimed with FOR UPDATE SKIP LOCKED like every other queue
-- here, so two workers cannot both decide it is time.

CREATE TABLE agent_posting (
  agent_id         uuid PRIMARY KEY REFERENCES agents (id) ON DELETE CASCADE,
  -- Which connected account the post goes out through.
  account_id       uuid REFERENCES accounts (id) ON DELETE CASCADE,
  enabled          boolean NOT NULL DEFAULT false,
  -- Gap between chances to post. Easy Mode writes 6h, 5h, or 22h.
  interval_seconds integer NOT NULL DEFAULT 21600 CHECK (interval_seconds BETWEEN 300 AND 604800),
  -- A fixed heartbeat is a distinctive pattern and a poor citizen. This is
  -- about being unremarkable, not about hiding.
  jitter_percent   integer NOT NULL DEFAULT 25 CHECK (jitter_percent BETWEEN 0 AND 50),
  next_post_at     timestamptz,
  last_post_at     timestamptz,
  last_job_id      uuid,
  -- Why the last chance did or did not produce a post, in words.
  last_reason      text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_posting_due_idx ON agent_posting (next_post_at) WHERE enabled;
