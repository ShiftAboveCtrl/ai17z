-- Somewhere for two processes to agree how much of an endpoint's budget is left.
--
-- An installation runs more than one worker. Today a containerised one claims
-- the jobs that need no browser and a native one claims the jobs that do, and
-- both run the pipeline for their share; `AI17Z_WORKER_ROLE=all` is a supported
-- arrangement where one process claims both. The limiter that shipped first kept
-- its budget in memory and said so, which meant each process believed it had the
-- whole allowance and an endpoint could be shown twice what AI17Z thought it was
-- sending.
--
-- That was tolerable while X was the only channel, because every X job needs a
-- browser and so only ever reached one worker. It stops being tolerable the
-- moment a second channel, a background watcher or a non-browser capability
-- exists -- all of which are planned -- so it is fixed before the number of
-- upstreams multiplies rather than after.
--
-- ### What is NOT here
--
-- Budgets an endpoint scopes to the source address. Two AI17Z installations on
-- one machine have two databases and no table in common, and a public endpoint
-- counting by IP sees one caller. A row here could never coordinate them, and
-- pretending otherwise would be the same lie in a more expensive place. Those
-- live outside the database; see `MACHINE` scope in packages/upstream.

-- One row per request that was allowed, so a sliding window can be summed.
--
-- Rows rather than a counter per window: a fixed counter lets twice the capacity
-- through across a boundary -- spend the minute's whole budget in its last
-- second and the next minute's in its first -- and the burst that produces is
-- exactly what an operator notices.
CREATE TABLE upstream_quota_spends (
  id          bigserial PRIMARY KEY,
  -- Whose budget. `upstream:<id>` for an installation's own allowance, which is
  -- what a per-key quota actually maps to.
  quota_key   text NOT NULL,
  -- Which window this was spent against. One request spends against every
  -- window that applies, so a per-second and a per-minute budget each get a row.
  interval_ms bigint NOT NULL,
  weight      integer NOT NULL CHECK (weight >= 1),
  spent_at    timestamptz NOT NULL DEFAULT now()
);

-- The only query this table serves: what has been spent against one window
-- since a moment. Descending so the planner walks the recent end.
CREATE INDEX upstream_quota_spends_window_idx
  ON upstream_quota_spends (quota_key, interval_ms, spent_at DESC);

-- When an endpoint named a time.
--
-- A 429 is the operator speaking, and every process sharing that budget has to
-- hear it -- otherwise the worker that was not refused carries straight on into
-- the limit that has just been announced. One row per budget, and a later time
-- never shortens an earlier one.
CREATE TABLE upstream_blocks (
  quota_key text PRIMARY KEY,
  until     timestamptz NOT NULL,
  -- What the upstream said, for the health screen. Never a URL and never a
  -- header dump: this is read by a person deciding whether something is wrong.
  why       text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
