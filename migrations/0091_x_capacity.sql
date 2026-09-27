-- One account, one budget for asking X anything.
--
-- Every surface that reads X on an account's behalf used to keep its own
-- schedule and nothing added them up. Seven radar sources, the channel poller,
-- context reads for replies and the growth loop each looked reasonable alone;
-- together, on one live account, they came to roughly six page loads a minute,
-- and X answered with its own "slow down" on two search surfaces while the
-- rest carried on at full speed. A rate limit on one surface said nothing to
-- any other.
--
-- `accounts.health` already existed to express "signed in, working, and being
-- told to slow down", and `judgeHealth` already existed to decide it. Nothing
-- in production ever called either, so the column never left HEALTHY. This
-- migration adds only what that design could not hold: how many times this
-- account has tripped recently, and a ledger to count from.

-- How many cooldowns in a row this account has earned without a clean spell
-- between them. It is what makes the second cooldown longer than the first.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS health_strikes integer NOT NULL DEFAULT 0;
-- The last thing X did that counted as pressure, in its own words, and when.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS health_signal text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS health_signal_at timestamptz;

/*
  What this account asked of X, and what X said back.

  Kept short on purpose. The questions it answers are all about the last hour
  (how many reads in the last ten minutes, how many times X pushed back in the
  last fifteen), so rows older than a day are removed as new ones arrive. It is
  a meter, not a history.

  READ is one page load or one structured query. SIGNAL is X refusing,
  stalling, or asking to slow down. `class` is who the capacity was spent for:

  DIRECT   somebody wrote to the agent, or a reply is being verified
  TARGET   an account the owner explicitly asked the agent to follow
  BROAD    everything the agent goes looking for on its own
*/
CREATE TABLE IF NOT EXISTS x_capacity_ledger (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  entry text NOT NULL,
  class text NOT NULL,
  -- For a SIGNAL, which kind: RATE_LIMITED, STALLED, BROKEN.
  signal text,
  detail text,
  CONSTRAINT x_capacity_ledger_entry_check CHECK (entry IN ('READ', 'SIGNAL')),
  CONSTRAINT x_capacity_ledger_class_check CHECK (class IN ('DIRECT', 'TARGET', 'BROAD')),
  -- NULL for a READ. A CHECK that evaluates to unknown passes, so NULL needs
  -- no clause of its own.
  CONSTRAINT x_capacity_ledger_signal_check CHECK (signal IN ('RATE_LIMITED', 'STALLED', 'BROKEN'))
);

CREATE INDEX IF NOT EXISTS x_capacity_ledger_account_idx
  ON x_capacity_ledger (account_id, at DESC);

/*
  What became of each post the agent came across on its own.

  Broad discovery declines nearly everything by design, and that is the point
  of the cheap filter in front of it. What it did not do was say so anywhere:
  a declined keyword match left no job, no trace and no reason, so "why has it
  been quiet all afternoon" could only be answered by guessing, and nobody
  could see whether the posts it did take were any better than the ones it
  refused.

  One row per agent per post, the same shape the watched-account dispositions
  use. The audience X reported travels with it, because "it only replies to
  accounts nobody reads" is a claim this table can settle. Rows older than a
  week are removed as new ones arrive.
*/
CREATE TABLE IF NOT EXISTS broad_candidate_decisions (
  id bigserial PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  decision text NOT NULL,
  reason text NOT NULL,
  -- As X reported it. Null is "not seen", never zero.
  author_followers integer,
  decided_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broad_candidate_decisions_decision_check CHECK (decision IN ('QUEUED', 'DECLINED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS broad_candidate_decisions_key
  ON broad_candidate_decisions (agent_id, event_id);

CREATE INDEX IF NOT EXISTS broad_candidate_decisions_agent_idx
  ON broad_candidate_decisions (agent_id, decided_at DESC);
