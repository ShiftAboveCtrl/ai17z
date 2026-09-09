-- What a post did, as X showed it at a moment in time.
--
-- Snapshots, never a running total. Growth is a question about change -- did
-- this format do better than that one, is this narrative accelerating -- and a
-- single number that is overwritten every time it is read can answer none of
-- it. Two readings a day apart are the smallest useful unit.
--
-- Every metric is nullable, and that is the point. X shows different things on
-- different surfaces and to different accounts, and `docs/ENGINEERING.md` is
-- clear that an unread image is an explicit gap rather than silence. A metric
-- the page did not show is missing here; zero means X said zero.

CREATE TABLE post_analytics (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  account_id     uuid REFERENCES accounts (id) ON DELETE SET NULL,
  channel        text NOT NULL DEFAULT 'x',
  -- The remote post. Identity is the post, not where it was found, so this is
  -- the status id and nothing else.
  remote_post_id text NOT NULL,
  -- Our own action row, when this post is one the agent made. Null for a post
  -- somebody else wrote that is being measured for context.
  action_id      uuid REFERENCES actions (id) ON DELETE SET NULL,
  observed_at    timestamptz NOT NULL DEFAULT now(),
  impressions    integer,
  likes          integer,
  reposts        integer,
  replies        integer,
  quotes         integer,
  bookmarks      integer,
  profile_visits integer,
  link_clicks    integer,
  -- Where the numbers came from, because a count read off a timeline and one
  -- read off the owner's analytics view are not the same evidence.
  source         text NOT NULL DEFAULT 'TIMELINE' CHECK (source IN ('TIMELINE', 'POST_ANALYTICS')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- One reading per post per source per minute is plenty; a poller that runs
-- twice must not write the same observation twice.
--
-- Bucketed at UTC explicitly. `date_trunc('minute', observed_at)` on a
-- timestamptz depends on the session's TimeZone, so Postgres will not have it
-- in an index -- and a uniqueness rule that moved with whoever was connected
-- would be no rule at all.
CREATE UNIQUE INDEX post_analytics_unique_reading
  ON post_analytics (remote_post_id, source, (date_trunc('minute', observed_at AT TIME ZONE 'UTC')));

-- The two questions: how has this post done over time, and what has this agent
-- published lately.
CREATE INDEX post_analytics_post_idx ON post_analytics (remote_post_id, observed_at DESC);
CREATE INDEX post_analytics_agent_idx ON post_analytics (agent_id, observed_at DESC);
