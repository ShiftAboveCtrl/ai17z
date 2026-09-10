-- What the account itself looked like at a moment in time.
--
-- `post_analytics` answers "how did that post do". This answers the other
-- question an owner asks, which is whether any of it is adding up: followers a
-- week ago against followers today. Same discipline, and the same table shape
-- for the same reasons -- snapshots rather than a running total, every metric
-- nullable, and a metric X did not show recorded as missing rather than as
-- zero.
--
-- Nothing polls for these. `docs/architecture/CADENCE.md` is explicit that there
-- is one timing engine and no second timer, so a reading is taken whenever
-- something reads the account's own profile -- a capability the model chose, or
-- an owner asking. The series is therefore as dense as the looking, and a
-- screen that shows it has to say so rather than implying a daily measurement
-- nobody is taking.

CREATE TABLE account_analytics (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  account_id   uuid REFERENCES accounts (id) ON DELETE SET NULL,
  channel      text NOT NULL DEFAULT 'x',
  -- The handle as it was read. Kept because a handle changes and the series
  -- should still say which name the numbers were under at the time.
  handle       text NOT NULL,
  observed_at  timestamptz NOT NULL DEFAULT now(),
  followers    integer,
  following    integer,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- One reading per account per minute. Two reads in the same minute are looking
-- at one state, and recording both would make a flat line look like activity.
--
-- Bucketed at UTC explicitly, for the reason migration 0065 gives: date_trunc
-- on a timestamptz depends on the session's TimeZone, and a uniqueness rule
-- that moved with whoever was connected would be no rule at all.
CREATE UNIQUE INDEX account_analytics_unique_reading
  ON account_analytics (agent_id, lower(handle), (date_trunc('minute', observed_at AT TIME ZONE 'UTC')));

CREATE INDEX account_analytics_series_idx ON account_analytics (agent_id, observed_at DESC);
