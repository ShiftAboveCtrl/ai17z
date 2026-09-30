-- An agent's own wallet, and every transaction an owner asked it to make.
--
-- The secret is sealed under the installation's master key exactly like a
-- provider API key, and is read only by the wallet core when the owner submits
-- a transaction they approved. It is never returned by any route, written to a
-- log, an audit row or a trace, or placed in a browser task.
CREATE TABLE agent_wallets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  family         text NOT NULL CHECK (family IN ('EVM', 'SOLANA')),
  address        text NOT NULL,
  sealed_secret  text NOT NULL,
  -- Which adapter made it, so a later adapter knows what it is reading.
  adapter        text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- The owner said they have a backup of the master key and the database.
  backed_up_at   timestamptz,
  -- Retired rather than deleted: a wallet may still hold something.
  retired_at     timestamptz
);
-- One live wallet per family per agent.
CREATE UNIQUE INDEX agent_wallets_live_idx ON agent_wallets (agent_id, family) WHERE retired_at IS NULL;

CREATE TABLE wallet_intents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id        uuid NOT NULL REFERENCES agent_wallets (id) ON DELETE RESTRICT,
  agent_id         uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  owner_id         uuid REFERENCES users (id) ON DELETE SET NULL,
  network          text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('NATIVE_TRANSFER', 'TOKEN_TRANSFER')),
  params           jsonb NOT NULL,
  -- One intent per owner request. A second click finds the first.
  idempotency_key  text NOT NULL UNIQUE,
  status           text NOT NULL CHECK (status IN ('DRAFTED', 'AWAITING_APPROVAL', 'APPROVED', 'SUBMITTING', 'SUBMITTED',
                                                   'CONFIRMED', 'FAILED', 'REJECTED', 'EXPIRED', 'UNKNOWN')),
  simulation       jsonb,
  -- The digest of exactly what would be signed; the owner approves this value.
  digest           text,
  approved_digest  text,
  approved_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  approved_at      timestamptz,
  -- Written before the transaction is handed to the network, so a crash in
  -- between leaves a hash to check rather than a reason to send again.
  tx_hash          text,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  submitted_at     timestamptz
);
CREATE INDEX wallet_intents_agent_idx ON wallet_intents (agent_id, created_at DESC);
