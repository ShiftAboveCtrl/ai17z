-- Somewhere for a feed watcher to remember what it has already seen.
--
-- A feed is a list that is republished in full every time it is fetched. The
-- newest entry and the oldest sit in the same document, and nothing in it says
-- which of them is new to us. So "has this been seen" is not a property of the
-- feed at all -- it is a thing only this installation knows, and it has to
-- survive a restart or the answer resets to "none of it", at which point a
-- worker coming back up announces thirty old articles as though they had just
-- happened.
--
-- That failure is quiet in exactly the wrong way: nothing errors, the entries
-- are real, the dates are real, and an agent confidently tells somebody about a
-- release from three weeks ago. The cursor below is what stops it, and it is the
-- reason this table exists rather than a map in memory.
--
-- ### No second scheduler
--
-- `next_poll_at` and the claim that moves it forward are deliberately the same
-- shape the account poller already uses. The claim updates the due time in the
-- same statement that selects the row, which is what stops two workers polling
-- one feed and stops a restart stampeding every feed at once. There is one way
-- to schedule recurring work in AI17Z and this is it.
CREATE TABLE feed_subscriptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One row per feed. A second subscription to the same URL would poll it twice
  -- and emit everything twice, so the database refuses it rather than trusting
  -- whoever is adding it.
  url                  text NOT NULL UNIQUE,
  -- What a person calls it. The feed's own title is fetched, but a feed that has
  -- never successfully been read still needs a name on a screen.
  label                text NOT NULL DEFAULT '',
  enabled              boolean NOT NULL DEFAULT true,

  -- How often to look. Fifteen minutes by default: often enough to be useful,
  -- and slow enough that a hundred subscriptions are still a polite neighbour.
  interval_seconds     integer NOT NULL DEFAULT 900 CHECK (interval_seconds >= 60),
  next_poll_at         timestamptz NOT NULL DEFAULT now(),

  -- The validators the source last offered. Sending these back is what makes
  -- frequent polling nearly free: a source that has not changed answers 304 with
  -- no body at all, and neither side spends anything.
  etag                 text,
  last_modified        text,

  -- ### The cursor
  --
  -- Ids rather than a timestamp watermark, because a watermark trusts the feed's
  -- dates and feeds get dates wrong: entries appear with no date, with the
  -- publication date of the site rather than the post, and occasionally in the
  -- future. An id that has been seen has been seen whatever its date says.
  --
  -- Bounded, because this is a cursor and not an archive. A feed shows its most
  -- recent entries -- typically ten to fifty -- so a few hundred remembered ids
  -- covers every entry a feed will ever show us again, and the oldest fall off
  -- the end where they can never reappear anyway.
  seen_entry_ids       text[] NOT NULL DEFAULT '{}',

  -- Whether a first poll has completed.
  --
  -- The first read of a new subscription is not news. Without this, adding a
  -- feed announces its entire visible history at once -- which is the same
  -- failure as the restart replay, arriving by a different route. The first poll
  -- records what it saw and emits nothing.
  primed               boolean NOT NULL DEFAULT false,

  -- What happened last time, for a person looking at why a feed is quiet.
  last_polled_at       timestamptz,
  last_status          text NOT NULL DEFAULT '',
  last_error           text NOT NULL DEFAULT '',
  consecutive_failures integer NOT NULL DEFAULT 0,
  -- Counted rather than inferred: "it is working but nothing is being published"
  -- and "it has been broken for a week" look identical from the outside.
  total_entries_seen   integer NOT NULL DEFAULT 0,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- The only query the watcher makes: which feeds are due. Ascending, so the one
-- waiting longest is taken first.
CREATE INDEX feed_subscriptions_due_idx
  ON feed_subscriptions (next_poll_at)
  WHERE enabled;
