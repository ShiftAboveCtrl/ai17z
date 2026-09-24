-- The four things an agent has to remember about restraining itself.
--
-- Budgets are deliberately absent from this file. How many model calls an
-- agent has made today, how many approaches it has published, how much it has
-- looked up: every one of those is already a row somewhere, in `model_calls`,
-- `actions` and `jobs`. Counting them is a read, it survives a restart because
-- the rows do, and a second copy would be a number that drifts from the thing
-- it is supposed to describe. What could not be derived is here, and nothing
-- else is.

-- When the agent last went looking, and how that session ended.
--
-- This is the one growth fact with nowhere to live: "is a session open, and
-- when did the last one finish" cannot be read off work that may not have
-- happened. A session that produced nothing is still a session, and it still
-- has to rest afterwards.
CREATE TABLE IF NOT EXISTS agent_growth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  -- Null while the session is open. Set when it ends, for any reason.
  ended_at timestamptz,
  -- In words: ran its time, nothing left worth looking at, budget spent,
  -- quiet hours arrived, the account stopped being healthy.
  ended_reason text,
  candidates_considered integer NOT NULL DEFAULT 0,
  model_calls integer NOT NULL DEFAULT 0,
  research_calls integer NOT NULL DEFAULT 0,
  public_actions integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS agent_growth_sessions_agent_idx
  ON agent_growth_sessions (agent_id, started_at DESC);

-- At most one session open per agent at a time. A second open row would make
-- "am I in a session" a question with two answers.
CREATE UNIQUE INDEX IF NOT EXISTS agent_growth_sessions_one_open
  ON agent_growth_sessions (agent_id) WHERE ended_at IS NULL;

-- Somebody who asked not to be contacted.
--
-- Deliberately not a flag on `relationships`. That table has
-- `disposition = 'BLOCKED'`, which is documented as an explicit instruction
-- from the **owner**, and this is an instruction from the **person**. They
-- produce the same restraint and they are not the same fact, and collapsing
-- them would lose the difference exactly when somebody asks why an account was
-- left alone.
--
-- Kept rather than deleted when it is lifted, because "they asked us to stop
-- in March and later started a conversation themselves" is a thing an owner
-- may need to see. `revoked_at` is how it stops applying; nothing removes the
-- row.
CREATE TABLE IF NOT EXISTS do_not_contact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  channel text NOT NULL,
  handle text NOT NULL,
  -- The numeric id where the channel gives one, because a handle is a name
  -- somebody can change and an id is who they are.
  remote_user_id text,
  -- THEY_ASKED when it came from something they wrote, OWNER when the owner
  -- set it. Both bind; only the provenance differs.
  source text NOT NULL DEFAULT 'THEY_ASKED',
  -- The sentence that caused it, so the decision can be checked rather than
  -- taken on trust. Never the whole message.
  evidence text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_reason text,
  CONSTRAINT do_not_contact_source_check CHECK (source IN ('THEY_ASKED', 'OWNER'))
);

-- One live entry per person per agent. A second would make the question
-- "are they on the list" ambiguous, which is the one thing it must not be.
CREATE UNIQUE INDEX IF NOT EXISTS do_not_contact_live_idx
  ON do_not_contact (agent_id, channel, lower(handle)) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS do_not_contact_agent_idx ON do_not_contact (agent_id, created_at DESC);

-- What the owner keeps saying yes and no to.
--
-- One row per kind of request, not per request: the whole point is to learn
-- that a family of proposals keeps being refused, and a row per proposal would
-- only ever describe proposals that are already gone.
--
-- This affects ranking and nothing else. There is no column here that could
-- grant a permission, skip an approval, or widen what a Plugin may do, and
-- there must never be one: `agent_capability_permissions` is the only store
-- that decides what an agent may do, and this is a store about what is worth
-- putting in front of somebody first.
CREATE TABLE IF NOT EXISTS owner_decision_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- What makes two requests the same question. Built from the request kind,
  -- the action, and the subject, never from the wording.
  fingerprint text NOT NULL,
  -- The coarse family, kept alongside the fingerprint so a brand new
  -- fingerprint can still inherit what its family has learned.
  family text NOT NULL,
  accepted integer NOT NULL DEFAULT 0,
  rejected integer NOT NULL DEFAULT 0,
  -- Decayed on read rather than on a timer, so nothing has to sweep this and
  -- a signal nobody looks at cannot go stale in a way anybody notices.
  last_decision_at timestamptz NOT NULL DEFAULT now(),
  last_rejected_at timestamptz,
  -- The owner's own words, when they gave any. Never shown to a model.
  last_reason text
);

CREATE UNIQUE INDEX IF NOT EXISTS owner_decision_signals_key
  ON owner_decision_signals (agent_id, fingerprint);

CREATE INDEX IF NOT EXISTS owner_decision_signals_family_idx
  ON owner_decision_signals (agent_id, family);

-- How the runtime is coping, which is not the same question as whether the
-- session is signed in.
--
-- `accounts.status` already answers the second, and answers it well: it has
-- CHALLENGE_REQUIRES_USER, SESSION_EXPIRED and NEEDS_AUTH, and AI17Z stops on
-- all three. What it cannot say is "signed in, working, and being told to slow
-- down so often that the agent should stop going looking for a while". That is
-- what these are for, and they sit beside the status rather than inside it so
-- that neither can quietly become the other.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS health text NOT NULL DEFAULT 'HEALTHY',
  -- In words, for the panel. "Eleven rate limits in the last hour" is a
  -- reason; DEGRADED on its own is a colour.
  ADD COLUMN IF NOT EXISTS health_reason text,
  -- When optional growth may be considered again. Null when nothing is held.
  ADD COLUMN IF NOT EXISTS health_until timestamptz,
  ADD COLUMN IF NOT EXISTS health_changed_at timestamptz;

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_health_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_health_check
  CHECK (health IN ('HEALTHY', 'DEGRADED', 'COOLDOWN', 'HUMAN_ACTION_REQUIRED'));
