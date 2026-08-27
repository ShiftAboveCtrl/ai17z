-- Cadence: when an account may be read from and acted on.
--
-- Timing used to live in three unrelated places: a global poll interval env var,
-- the per-agent rate policy, and the worker queue interval. One number governed
-- every account regardless of how busy it was. Cadence is per account, versioned
-- like policy, and the engine that reads it is the only thing that decides when.

CREATE TABLE cadences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cadence_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cadence_id  uuid NOT NULL REFERENCES cadences(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  config      jsonb NOT NULL,
  change_note text NOT NULL DEFAULT '',
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cadence_id, version)
);

ALTER TABLE accounts
  ADD COLUMN cadence_version_id uuid REFERENCES cadence_versions(id) ON DELETE SET NULL,
  -- Poll scheduling state. next_poll_at is the whole schedule: the poller asks
  -- for due accounts rather than sweeping every account on a global timer.
  ADD COLUMN next_poll_at timestamptz,
  ADD COLUMN last_polled_at timestamptz,
  -- Drives idle backoff. Reset to 0 the moment a poll returns anything.
  ADD COLUMN empty_poll_streak integer NOT NULL DEFAULT 0;

CREATE INDEX accounts_next_poll_idx ON accounts (next_poll_at)
  WHERE enabled AND status = 'CONNECTED';

-- Existing accounts become due immediately and pick up the default cadence.
UPDATE accounts SET next_poll_at = now();
