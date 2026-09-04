-- Conditions of the installation that need a person.
--
-- Deliberately not a second inbox. The inbox in `repositories/mentions.ts`
-- answers "who said something and did they get an answer" out of jobs, events
-- and actions; nothing here duplicates that. This is the other question: what
-- is wrong with the installation itself -- an account locked out, a provider
-- failing, a limit reached, a worker that stopped -- which no job represents,
-- because the whole problem is that jobs are not being produced.
--
-- The unique index is what makes this quiet. A poller that fails every thirty
-- seconds must produce one notification with a count, not two thousand rows,
-- and the constraint enforces that rather than application logic. It is partial
-- on `acknowledged_at IS NULL`, so once somebody has seen and dismissed a
-- problem, the same problem happening again is allowed to be news.

CREATE TABLE IF NOT EXISTS notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      uuid REFERENCES agents(id) ON DELETE CASCADE,
  account_id    uuid REFERENCES accounts(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  severity      text NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  title         text NOT NULL,
  body          text NOT NULL DEFAULT '',
  -- What to do about it, if there is something. Empty when there is not, rather
  -- than a made-up suggestion.
  action_label  text,
  action_href   text,
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- The identity of the problem, not of the occurrence.
  dedupe_key    text NOT NULL,
  occurrences   integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),

  acknowledged_at timestamptz,
  acknowledged_by text,

  -- Set when acknowledging with "and do not tell me again for a while". Until
  -- this passes, the same problem recurring updates the acknowledged row rather
  -- than raising a new one.
  muted_until   timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS notifications_open_dedupe
  ON notifications (dedupe_key) WHERE acknowledged_at IS NULL;

CREATE INDEX IF NOT EXISTS notifications_open
  ON notifications (severity, last_seen_at DESC) WHERE acknowledged_at IS NULL;

CREATE INDEX IF NOT EXISTS notifications_agent
  ON notifications (agent_id, last_seen_at DESC);

-- Finding an acknowledged row for the same problem, to decide whether a mute is
-- still running before raising a fresh one.
CREATE INDEX IF NOT EXISTS notifications_acknowledged_dedupe
  ON notifications (dedupe_key, acknowledged_at DESC) WHERE acknowledged_at IS NOT NULL;
