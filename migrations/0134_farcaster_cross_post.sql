-- One voice across X and Farcaster.
--
-- Posting a copy of the agent's own post to Farcaster is an owner opt-in per
-- Farcaster account. No row means off, and a row defaults to off, so the only
-- way to turn it on is for somebody to say so. The same row is read again at
-- send, which makes it the kill switch for jobs that were queued before it was
-- switched off.
CREATE TABLE farcaster_posting (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  enabled    boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- What became of one idea on one other network. The unique key is the second
-- guard behind the job's own idempotency key: one idea, one target account,
-- and a rehearsal is kept apart from the real thing so it never spends it.
-- A skip is recorded with its reason, because an opted-in account that is
-- silently left out looks exactly like one that was posted to.
CREATE TABLE cross_posts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  idea_id           uuid NOT NULL REFERENCES content_ideas(id) ON DELETE CASCADE,
  origin_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel           text NOT NULL,
  dry_run           boolean NOT NULL,
  job_id            uuid REFERENCES jobs(id) ON DELETE SET NULL,
  status            text NOT NULL CHECK (status IN ('QUEUED', 'SKIPPED')),
  reason            text NOT NULL DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idea_id, target_account_id, dry_run)
);
CREATE INDEX cross_posts_agent_idx ON cross_posts (agent_id, created_at DESC);
