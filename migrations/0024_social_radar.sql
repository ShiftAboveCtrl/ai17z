-- Social Radar: many ways of noticing the same post, one event.
--
-- Ingest went through /notifications alone. When that surface is incomplete —
-- and it regularly is — the agent simply never learns a mention happened, and
-- nothing anywhere says a source stopped working. An account showed HEALTHY
-- while the one thing it depended on had been failing for an hour.
--
-- The fix is not a better notification scraper. It is several independent
-- monitors that each produce candidates, and one reconciler that merges them on
-- the post's own identity.

CREATE TABLE radar_sources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- notifications | mention_search | reply_search | own_threads |
  -- tracked_account | tracked_keyword
  kind         text NOT NULL,
  -- The handle, keyword, or query this instance watches. Null for the monitors
  -- that need no argument, such as notifications.
  target       text,
  label        text NOT NULL DEFAULT '',
  enabled      boolean NOT NULL DEFAULT true,
  config       jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Health is per source, not per account. A source failing must not be able to
  -- make the account look fine.
  status       text NOT NULL DEFAULT 'UNKNOWN'
                 CHECK (status IN ('UNKNOWN','HEALTHY','DEGRADED','FAILING','DISABLED')),
  last_poll_at         timestamptz,
  last_success_at      timestamptz,
  -- The last time this source found something, which is different from the last
  -- time it worked. A quiet source is not a broken one.
  last_result_at       timestamptz,
  last_error           text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  -- High-water mark, so a poll resumes rather than restarting.
  cursor       text,
  next_poll_at timestamptz,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- One instance of a monitor per target per account.
  UNIQUE (account_id, kind, target)
);

CREATE INDEX radar_sources_due_idx ON radar_sources (next_poll_at) WHERE enabled;
CREATE INDEX radar_sources_account_idx ON radar_sources (account_id);

-- How each event was discovered. A child of events, not a second event store:
-- the event row remains the single identity, and this records the evidence.
CREATE TABLE event_discoveries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  source_id    uuid REFERENCES radar_sources(id) ON DELETE SET NULL,
  source_kind  text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  -- Seeing the same post again through the same source is not new information,
  -- but how often it happens is worth knowing.
  seen_count   integer NOT NULL DEFAULT 1,
  UNIQUE (event_id, source_kind)
);

CREATE INDEX event_discoveries_event_idx ON event_discoveries (event_id);

-- Posts the agent itself has made, so replies underneath them can be found
-- without depending on a notification arriving.
CREATE TABLE own_posts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  agent_id      uuid REFERENCES agents(id) ON DELETE SET NULL,
  remote_id     text NOT NULL,
  remote_url    text,
  text          text NOT NULL DEFAULT '',
  posted_at     timestamptz,
  -- Reconciliation state: when replies underneath were last checked, and how
  -- many were found, so a dead thread can be checked less often.
  last_checked_at timestamptz,
  reply_count     integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, remote_id)
);

CREATE INDEX own_posts_check_idx ON own_posts (account_id, last_checked_at NULLS FIRST);
