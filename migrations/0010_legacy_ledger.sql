-- XBAM 0010: compatibility ledger for actions performed by a previous system.
--
-- AI4CZ recorded what it had posted as `targetKey|sha1(text)` lines in
-- posted_index.json. XBAM signs content with sha256, so those 182 entries cannot
-- be matched by the modern signature. Importing them here, and checking them
-- with their original hash before executing, is what stops a migration from
-- re-posting a year of replies.

CREATE TABLE legacy_action_ledger (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  source           text NOT NULL,
  channel          text NOT NULL,
  target_ref       text,
  -- Verbatim signature as the previous system wrote it.
  legacy_signature text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, legacy_signature)
);
CREATE INDEX legacy_action_ledger_target_idx ON legacy_action_ledger (agent_id, target_ref);
