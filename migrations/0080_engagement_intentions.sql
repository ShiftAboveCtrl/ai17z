-- ---------------------------------------------------------------------------
-- Likes and reposts an agent decided on by itself
-- ---------------------------------------------------------------------------
--
-- Deliberation could already turn a thought into something to *say*: a strong,
-- reinforced item becomes a row in `content_ideas`, which the posting engine
-- reads. It had no way to decide that a specific post was worth *acknowledging*,
-- because every path to a like or a repost went through a model calling a
-- capability inside a job somebody else had started. An agent that reads its
-- timeline all day and cannot like anything is not participating, it is
-- lurking.
--
-- This is the missing intention, and it is only an intention. Nothing here
-- executes: the runner hands each one to `performCapabilityAction`, the same
-- executor the `x.like` and `x.repost` capabilities already use, so
-- idempotency, the stale-retake check, exact-target verification and the
-- action ledger are all the ones that already exist. There is no second
-- executor and no second scheduler -- `next_attempt_at` is claimed the same way
-- the account poller, the feed watcher, the repository watcher and the wake
-- loop claim theirs.
--
-- Why a table rather than `content_ideas`: an idea has no target and a like is
-- nothing *but* a target. Putting them together would mean a nullable target on
-- every post idea and a nullable brief on every like, and the posting engine
-- would have to learn to skip rows that are not for it.
CREATE TABLE agent_engagements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,

  -- LIKE is an acknowledgement. REPOST is the agent telling its own audience to
  -- read something, which is a much larger claim and carries a much higher bar.
  kind         text NOT NULL CHECK (kind IN ('LIKE', 'REPOST')),

  -- The post itself. `remote_id` is what the action is anchored to, because a
  -- URL can be written several ways for one post and an idempotency key built
  -- on the spelling would let the same like through twice.
  remote_id    text NOT NULL,
  remote_url   text NOT NULL DEFAULT '',
  author_handle text NOT NULL DEFAULT '',
  -- Enough of the post to recognise it on a screen. Never the whole thing:
  -- this table is a decision, not a copy of somebody's timeline.
  excerpt      text NOT NULL DEFAULT '',

  -- What it scored and why, in the same shape the working set uses, so the
  -- owner-facing screen renders a like's reasons exactly as it renders an
  -- attention item's. A score with no reasons is not shippable.
  score        integer NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  factors      jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence   numeric(3,2) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  -- Where the agent got the idea: the attention item it came off, when it came
  -- off one.
  attention_id uuid REFERENCES agent_attention (id) ON DELETE SET NULL,

  /*
    PROPOSED is what SUGGEST produces and what an owner looks at.
    APPROVED is an owner saying yes to one.
    DONE, DECLINED and FAILED are settled.

    A proposal is never silently dropped: something that stops being worth
    doing is DECLINED with a reason, because "why did it not like that" is a
    fair question and an empty table cannot answer it.
  */
  status       text NOT NULL DEFAULT 'PROPOSED'
                 CHECK (status IN ('PROPOSED','APPROVED','DONE','DECLINED','FAILED')),
  reason       text NOT NULL DEFAULT '',

  -- The job the execution ran under, so a like is traceable exactly like a
  -- reply is.
  job_id       uuid REFERENCES jobs (id) ON DELETE SET NULL,

  attempts     integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One proposal per post per kind per agent. The agent noticing the same post
-- four times is one decision, not four, and this is what makes the claim below
-- safe without any application logic.
CREATE UNIQUE INDEX agent_engagements_target_idx
  ON agent_engagements (agent_id, kind, remote_id);

-- The claim: due proposals, oldest first.
CREATE INDEX agent_engagements_due_idx
  ON agent_engagements (next_attempt_at)
  WHERE status IN ('PROPOSED', 'APPROVED');

CREATE INDEX agent_engagements_recent_idx ON agent_engagements (agent_id, created_at DESC);
