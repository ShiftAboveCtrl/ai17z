-- What an agent is currently thinking about, and what it means to do about it.
--
-- AI17Z agents already have identity, persona, voice, six memory scopes,
-- relationships, stances and commitments. What they have never had is a
-- *present tense*: something that says what this agent is interested in right
-- now, what it is unsure about, what it is trying to find out, and what it has
-- recently learned. Without that an agent is reactive -- it answers what it is
-- asked, and when nothing is asked it has nothing to say, so a posting schedule
-- either stays silent or invents filler.
--
-- This is the durable state behind persistent autonomous deliberation. It is
-- deliberately **not** a mind, a consciousness or a stream of thought, and
-- nothing in the product may describe it as one. It is a bounded working set of
-- structured conclusions, each carrying the evidence it rests on.
--
-- ### What this is not, and must not become
--
-- **Not a second memory.** `memories` keeps what the agent knows across six
-- scopes and stays the place durable knowledge lives. This keeps what is
-- *currently in play*, which is a smaller, faster-moving, bounded thing.
-- Reflection promotes from here into memory; it does not duplicate memory here.
--
-- **Not a chain-of-thought store.** Every row is a conclusion, its evidence and
-- its confidence. Raw model reasoning is never written here, never shown to an
-- owner and never sent to X.
--
-- **Not a second event store.** Observation reads what the pipeline already
-- wrote -- events, actions, jobs, memories, stances, discoveries. Nothing here
-- copies a post.
--
-- **Not a second scheduler.** `agent_wake` carries a due time and is claimed by
-- the same statement that moves it forward, exactly as `feed_subscriptions` and
-- the account poller do. `docs/architecture/CADENCE.md` allows one timing
-- engine and this is that engine's shape.

-- ---------------------------------------------------------------------------
-- The working set: what is on this agent's mind
-- ---------------------------------------------------------------------------
CREATE TABLE agent_attention (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,

  -- What kind of thing this is. Separate values rather than one "thought",
  -- because they behave differently: a CURIOSITY wants researching, a CONCERN
  -- wants watching, a LESSON wants promoting into memory, and a QUESTION is
  -- answered or it is not.
  kind         text NOT NULL CHECK (kind IN (
                 'INTEREST',    -- a subject this agent keeps returning to
                 'CURIOSITY',   -- something it wants to understand better
                 'CONCERN',     -- something that might be going wrong
                 'HYPOTHESIS',  -- a claim it holds provisionally
                 'QUESTION',    -- an open question it cannot yet answer
                 'LESSON',      -- something it learned from what happened
                 'NARRATIVE',   -- a conversation in its world it is following
                 'IDEA'         -- something it might want to say
               )),

  -- The conclusion, in one sentence, in the agent's own register. Bounded
  -- because a working set of essays is a working set nobody reads.
  summary      text NOT NULL,
  -- Why it matters, when that is not obvious from the summary alone.
  detail       text NOT NULL DEFAULT '',

  /*
    What made this salient, kept as the factors rather than as a number.

    `docs/ENGINEERING.md`: the reasons matter more than the scores. A single
    opaque model judgement is not inspectable and cannot be argued with, so the
    contributing factors are stored and the score is their sum. An owner
    looking at why their agent is preoccupied with something gets sentences.
  */
  salience     integer NOT NULL DEFAULT 0,
  factors      jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- 0-1. How sure the agent is that this is true, separate from how much it
  -- matters. A high-salience low-confidence item is exactly what research is
  -- for, and collapsing the two loses that.
  confidence   numeric(4,3) NOT NULL DEFAULT 0.5,

  /*
    What this rests on, as references rather than as copies.

    Every entry names a kind and an id inside AI17Z, or a URL that was actually
    read. An item with no evidence is an assertion -- the same rule persona
    traits already live under.
  */
  evidence     jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Where it came from, so a trace can say which reflection produced it.
  origin       text NOT NULL DEFAULT 'REFLECTION',

  state        text NOT NULL DEFAULT 'ACTIVE'
                 CHECK (state IN ('ACTIVE','RESOLVED','SUPERSEDED','RETIRED')),
  -- Set when a later, better-evidenced item replaced this one. The old row
  -- stays: being able to say "I thought X, then I found out Y" is the whole
  -- point of keeping it, and it is how stances already work.
  superseded_by uuid REFERENCES agent_attention (id) ON DELETE SET NULL,
  -- In the agent's own words, for a resolved or retired item.
  resolution   text NOT NULL DEFAULT '',

  /*
    Dedupe key. Two observations of the same thing must reinforce one item
    rather than fill the working set with near-duplicates -- which is the
    failure mode of every "let the model write down what it noticed" design.
  */
  fingerprint  text NOT NULL,

  -- How many separate observations have pointed at this. Reinforcement is what
  -- separates a passing remark from something the agent actually cares about.
  reinforcements integer NOT NULL DEFAULT 1,

  first_observed_at timestamptz NOT NULL DEFAULT now(),
  last_reinforced_at timestamptz NOT NULL DEFAULT now(),
  -- When deliberation should look at this again. Null means "no particular
  -- time"; decay handles those.
  review_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One item per thing, per kind, per agent. The constraint is what makes
-- reinforcement possible at all: without it the "same thought again" case is a
-- second row and the agent looks obsessive rather than consistent.
CREATE UNIQUE INDEX agent_attention_key ON agent_attention (agent_id, kind, fingerprint);
-- "What is on its mind", which is the question the screen and the prompt both ask.
CREATE INDEX agent_attention_live_idx ON agent_attention (agent_id, state, salience DESC);
CREATE INDEX agent_attention_review_idx ON agent_attention (agent_id, review_at) WHERE state = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- What the agent is trying to do
-- ---------------------------------------------------------------------------
CREATE TABLE agent_goals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,

  summary      text NOT NULL,
  -- Why it took this on. A goal without a reason is a goal nobody can judge,
  -- and the owner has to be able to judge them.
  reason       text NOT NULL DEFAULT '',

  -- Who decided. An owner's goal outranks one the agent set itself, and an
  -- agent may never retire an owner's.
  origin       text NOT NULL DEFAULT 'AGENT' CHECK (origin IN ('AGENT','OWNER')),
  -- An owner can pin a goal so deliberation may not abandon or decay it.
  pinned       boolean NOT NULL DEFAULT false,

  priority     integer NOT NULL DEFAULT 50,
  status       text NOT NULL DEFAULT 'ACTIVE'
                 CHECK (status IN ('ACTIVE','PAUSED','COMPLETED','ABANDONED')),
  -- 0-100, moved by reflection when something actually advanced it.
  progress     integer NOT NULL DEFAULT 0,
  -- What has happened towards it, as references.
  evidence     jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Why it ended, in the agent's own words. An abandoned goal that cannot say
  -- why is indistinguishable from one that was forgotten.
  resolution   text NOT NULL DEFAULT '',

  next_review_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

CREATE INDEX agent_goals_live_idx ON agent_goals (agent_id, status, priority DESC);

-- ---------------------------------------------------------------------------
-- What deliberation did, and what came of it
-- ---------------------------------------------------------------------------
CREATE TABLE agent_reflections (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,

  -- LIGHT is triggered by something happening; PERIODIC runs on the wake
  -- schedule; DEEP consolidates occasionally. Three rather than one because
  -- they cost different amounts and answer different questions.
  kind         text NOT NULL CHECK (kind IN ('LIGHT','PERIODIC','DEEP')),

  -- What it looked at and what it produced. Counts rather than contents: this
  -- table is the audit trail, not a second copy of the working set.
  considered   integer NOT NULL DEFAULT 0,
  produced     integer NOT NULL DEFAULT 0,
  reinforced   integer NOT NULL DEFAULT 0,
  retired      integer NOT NULL DEFAULT 0,

  /*
    One sentence an owner can read.

    Never raw model reasoning. "Do nothing" is a legitimate and common outcome
    and is recorded as one -- an agent that reflects and concludes there is
    nothing new is behaving correctly, and a screen that shows only the runs
    that produced something would make that look like a broken feature.
  */
  summary      text NOT NULL DEFAULT '',
  -- Which model was asked, when one was. Deterministic passes name none.
  model        text,
  duration_ms  integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_reflections_recent_idx ON agent_reflections (agent_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- When the agent next thinks
-- ---------------------------------------------------------------------------
--
-- One row per agent. The due time lives in the row and the claim moves it
-- forward in the same statement that selects it, which is what stops two
-- workers waking one agent and stops a restart waking every agent at once.
-- This is the shape `feed_subscriptions` and the account poller already use.
CREATE TABLE agent_wake (
  agent_id     uuid PRIMARY KEY REFERENCES agents (id) ON DELETE CASCADE,

  enabled      boolean NOT NULL DEFAULT false,

  /*
    How much the agent may do on its own, as a ladder rather than a switch.

    OBSERVE   gather evidence, score it, and stop
    THINK     also reflect, research, and update its own working set
    SUGGEST   also put candidates where the owner can see them
    ACT       also let candidates reach the existing policy and approval gates

    ACT is never a bypass. Everything it produces still passes the engagement
    heuristic, the policy gates, cadence, rate limits, idempotency and
    exact-target verification, exactly as an owner-triggered action does.
  */
  autonomy     text NOT NULL DEFAULT 'OBSERVE'
                 CHECK (autonomy IN ('OBSERVE','THINK','SUGGEST','ACT')),

  -- Seconds between ordinary wakes, and between deep consolidations.
  interval_seconds      integer NOT NULL DEFAULT 1800 CHECK (interval_seconds BETWEEN 300 AND 86400),
  deep_interval_seconds integer NOT NULL DEFAULT 86400 CHECK (deep_interval_seconds BETWEEN 3600 AND 604800),

  next_wake_at timestamptz NOT NULL DEFAULT now(),
  last_wake_at timestamptz,
  next_deep_at timestamptz NOT NULL DEFAULT now(),
  last_deep_at timestamptz,

  -- What the last wake decided, in a sentence. "Nothing new since the last
  -- look" is the most common and most important one to be able to show.
  last_reason  text NOT NULL DEFAULT '',
  -- How many wakes in a row produced nothing. Used to back off, so a quiet
  -- agent stops costing model calls rather than asking the same question every
  -- half hour for ever.
  quiet_wakes  integer NOT NULL DEFAULT 0,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_wake_due_idx ON agent_wake (next_wake_at) WHERE enabled;
