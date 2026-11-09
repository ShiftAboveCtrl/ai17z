-- One row per answered "check this mint" request, so the limits on it survive a
-- restart and cannot be spent twice by two workers.
--
-- The row is also the record the owner confirms a watch against. Nothing in this
-- table is created from a stranger's text except the request itself: the watch
-- columns are written only by the owner's own confirmation.
CREATE TABLE mint_check_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  -- One request per job, which is what makes a retried job return its first answer.
  job_id uuid NOT NULL UNIQUE REFERENCES jobs (id) ON DELETE CASCADE,
  channel text NOT NULL,
  -- channel:remote author id, the same shape the social paper limits use.
  asker_key text NOT NULL,
  asker_handle text,
  -- Null when the message named none, or several, and was refused.
  mint text,
  chain text,
  outcome text NOT NULL CHECK (outcome IN ('CARD', 'POINTER', 'REFUSED')),
  -- A pointer names the card it points at.
  points_to uuid REFERENCES mint_check_requests (id) ON DELETE SET NULL,
  -- Written only by the owner's confirmation. Null means nobody has decided.
  watch_state text CHECK (watch_state IS NULL OR watch_state IN ('WATCHING')),
  watched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome = 'REFUSED') = (mint IS NULL)),
  CHECK (watch_state IS NULL OR outcome = 'CARD')
);
CREATE INDEX mint_check_requests_asker ON mint_check_requests (agent_id, asker_key, created_at DESC);
CREATE INDEX mint_check_requests_card ON mint_check_requests (agent_id, mint, created_at DESC) WHERE outcome = 'CARD';
