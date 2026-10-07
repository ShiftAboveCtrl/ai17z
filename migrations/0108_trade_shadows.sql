-- Shadow trading: the real pipeline, run against live markets on a schedule,
-- recording what would have happened and executing nothing.
--
-- It exists to answer "would this have been any good" before anybody trusts
-- the thing with money, and it can only exist now that a venue can actually be
-- priced. A shadow that ran against no market would record a column of
-- NO_MARKET and teach nobody anything.
--
-- There is no second trading engine and no second scheduler. A due shadow runs
-- `runPaperTrade`, which is the one pipeline, and the claim moves `next_run_at`
-- forward in the statement that selects the row, exactly like the radar, the
-- job queue and the knowledge refresh. That is what stops two workers running
-- one shadow and stops a restart running every shadow at once.

CREATE TABLE trade_shadows (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- Nullable for the same reason a mandate's owner is: an agent can outlive
  -- the row that named who set it up, and losing the shadow with it would
  -- lose the record of what was observed.
  owner_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  label          text NOT NULL,

  -- What to run. The same vocabulary a paper trade takes, because that is what
  -- this runs: no shadow-specific notion of a trade exists or should.
  venue          text NOT NULL,
  side           text NOT NULL,
  asset_in       jsonb NOT NULL,
  asset_out      jsonb NOT NULL,
  subject        jsonb NOT NULL,
  max_in         text NOT NULL,
  max_slippage_bps      integer NOT NULL,
  max_price_impact_bps  integer NOT NULL,
  max_fee_base   text NOT NULL,

  -- When. A ceiling rather than a timetable, like the posting schedule: a
  -- shadow that is due looks at the market, and a market that cannot be read
  -- is recorded as that rather than retried in a tight loop.
  interval_seconds integer NOT NULL,
  next_run_at    timestamptz NOT NULL DEFAULT now(),
  last_run_at    timestamptz,

  -- What happened, in a form a screen can read without walking the journal.
  -- The intents themselves are the record; these are the tally.
  runs           integer NOT NULL DEFAULT 0,
  fills          integer NOT NULL DEFAULT 0,
  refusals       integer NOT NULL DEFAULT 0,
  no_market      integer NOT NULL DEFAULT 0,
  last_outcome   text,
  -- A sentence, because "why did it stop filling" is a fair question and a
  -- count cannot answer it.
  last_detail    text,

  paused         boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trade_shadows_side_chk CHECK (side IN ('BUY', 'SELL')),
  -- A minute is the floor. Faster than that is not a shadow of anything: it is
  -- a load generator aimed at somebody else's free API, and the read budget
  -- would refuse it anyway.
  CONSTRAINT trade_shadows_interval_chk CHECK (interval_seconds >= 60 AND interval_seconds <= 86400),
  CONSTRAINT trade_shadows_label_chk CHECK (length(btrim(label)) > 0),
  CONSTRAINT trade_shadows_outcome_chk
    CHECK (last_outcome IS NULL OR last_outcome IN ('FILLED', 'REFUSED', 'NO_MARKET', 'ERROR'))
);

-- What the claim reads. Partial, because a paused shadow is most of the table
-- on an installation somebody set up and stopped.
CREATE INDEX trade_shadows_due_idx ON trade_shadows (next_run_at) WHERE paused = false;
CREATE INDEX trade_shadows_agent_idx ON trade_shadows (agent_id, created_at DESC);

-- One shadow per agent per label, so re-running a setup screen updates the
-- shadow it already made rather than adding a second that runs beside it.
CREATE UNIQUE INDEX trade_shadows_label_idx ON trade_shadows (agent_id, label);
