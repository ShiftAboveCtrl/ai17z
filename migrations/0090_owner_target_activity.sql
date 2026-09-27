-- An account the owner named on purpose is not a stranger the agent found.
--
-- `tracked_account` discovery has always worked. What did not survive was the
-- owner's intent: the monitor emits POST, the reconciler translated POST to
-- KEYWORD_MATCH, and from that moment the one account somebody had explicitly
-- asked the agent to follow was indistinguishable from a stranger matched on a
-- word. It then inherited every guard built to stop an agent pestering
-- strangers.
--
-- Measured on a live installation: the agent replied to its owner-designated
-- target twice, and `cooldownDaysPerAuthor: 4` locked out that exact account
-- for four days. Nine of the target's posts were discovered, recorded, and
-- produced no job and no recorded reason at all.
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_type_check;
ALTER TABLE events
  ADD CONSTRAINT events_type_check
  CHECK (type = ANY (ARRAY[
    'MENTION', 'REPLY', 'DIRECT_MESSAGE', 'NEW_MESSAGE', 'KEYWORD_MATCH',
    'TARGET_ACCOUNT_ACTIVITY', 'WEBHOOK', 'SCHEDULED_TRIGGER', 'MANUAL_TRIGGER'
  ]::text[]));

-- What the agent knows about each account the owner told it to follow.
--
-- Deliberately beside `radar_sources` rather than instead of it. That table
-- already holds the owner's intent, the enabled flag, the polling schedule,
-- the health and the discovery cursor, and it is already the thing the
-- scheduler claims from. A second table describing the same watch would drift
-- from the one the radar actually reads.
--
-- What it cannot hold is the per-target *engagement* record: when the agent
-- last acted on this target, on which post, how often lately. That is what
-- lives here, one row per target per agent, keyed on the radar source so the
-- watch and its record cannot come apart.
CREATE TABLE IF NOT EXISTS agent_target_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- The watch this is the record of. Dropping the watch drops the record.
  source_id uuid NOT NULL REFERENCES radar_sources(id) ON DELETE CASCADE,
  /*
    How much attention the owner asked for.

    WATCH        read it for context, never act on it
    PRIORITIZE   consider it ahead of broad growth, ordinary judgement applies
    ENGAGE       deliberately consider every new eligible post

    ENGAGE is the strongest and still decides: "always considered" is not
    "always answered". A post it declines records why.
  */
  mode text NOT NULL DEFAULT 'PRIORITIZE',
  /*
    X's own numeric id for the account, where it is known.

    A handle is a name somebody can change; the id is who they are. Null until
    something has read the profile, because inventing one would be worse than
    admitting it is not known yet.
  */
  remote_user_id text,
  -- Display metadata only. Never the thing anything is matched on when an id
  -- is available.
  handle text NOT NULL,
  display_name text,
  -- The newest post seen from this target, and when.
  last_seen_post_id text,
  last_seen_at timestamptz,
  -- The newest post actually put in front of the agent's judgement. Behind
  -- `last_seen` when discovery is ahead of deliberation, which is normal.
  last_processed_post_id text,
  last_processed_at timestamptz,
  -- The last time the agent did something public about this target.
  last_interaction_at timestamptz,
  last_interaction_post_id text,
  -- Public actions in the trailing window, for pacing. Counted from `actions`
  -- when it matters; kept here so a cheap check does not need a join.
  recent_interactions integer NOT NULL DEFAULT 0,
  -- Set when pacing is holding this target back, with the moment it lifts.
  paced_until timestamptz,
  paced_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_target_state_mode_check CHECK (mode IN ('WATCH', 'PRIORITIZE', 'ENGAGE'))
);

-- One record per agent per watch. Two would make "when did we last act on
-- them" a question with two answers.
CREATE UNIQUE INDEX IF NOT EXISTS agent_target_state_key
  ON agent_target_state (agent_id, source_id);

CREATE INDEX IF NOT EXISTS agent_target_state_agent_idx ON agent_target_state (agent_id);

/*
  What became of each eligible target post.

  The fault this closes is not that the agent declined things. It is that nine
  posts produced no job and no reason, so nobody could tell whether they had
  been considered and refused or never looked at. A disposition row per post
  means "seen, considered, and here is why not" is answerable, and an owner
  asking "did it notice this?" gets a fact rather than a shrug.

  One row per (target, post). The unique index is what makes the writer safe to
  call repeatedly, which it is: the same post is re-found on every poll.
*/
CREATE TABLE IF NOT EXISTS target_post_dispositions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  target_state_id uuid NOT NULL REFERENCES agent_target_state(id) ON DELETE CASCADE,
  -- The post, by X's own id.
  remote_post_id text NOT NULL,
  -- The event it became, so the full record is reachable without copying it.
  event_id uuid REFERENCES events(id) ON DELETE SET NULL,
  -- The job, when one was created.
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  disposition text NOT NULL,
  -- A sentence, always. "COOLDOWN" is a code; "already answered them twice in
  -- this conversation" is something an owner can act on.
  reason text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT target_post_dispositions_check CHECK (disposition IN (
    'CONSIDERING',
    'AWAITING_APPROVAL',
    'INTERACTED',
    'INTENTIONAL_NO_ACTION',
    'DUPLICATE',
    'ALREADY_HANDLED',
    'COOLDOWN',
    'POLICY_REFUSAL',
    'ACCOUNT_DEGRADED',
    'STALE',
    'BLOCKED_EXTERNAL',
    'WATCH_ONLY'
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS target_post_dispositions_key
  ON target_post_dispositions (target_state_id, remote_post_id);

CREATE INDEX IF NOT EXISTS target_post_dispositions_agent_idx
  ON target_post_dispositions (agent_id, decided_at DESC);
