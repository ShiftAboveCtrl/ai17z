-- What an agent may trade inside, every trade it proposed, and the stops.
--
-- The division of labour is the point. A model may author a row in
-- trade_intents; it may not author a mandate, widen one, clear a pause, or
-- reach anything that signs. Everything between an intent and a chain is
-- arithmetic over these rows, decided by packages/runtime/src/tradingRisk.ts.
--
-- Amounts are numeric strings of the smallest unit, as text, for the same
-- reason wallet_intents keeps its params in jsonb rather than a float column:
-- a chain amount outgrows every binary float and most integer types, and a
-- rounding error here is somebody's money. Nothing in this schema is a
-- float, and nothing adds two amounts in SQL.
--
-- This is the generic framework. No venue arithmetic, no addresses of any
-- real contract and no signing live here or anywhere in this repository:
-- those belong to first-party adapters the owner installs.

-- How an owner says what an agent may do with money, and nothing wider.
CREATE TABLE trade_mandates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id              uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  -- Who wrote it. A mandate has an author, and it is never the agent.
  owner_id              uuid REFERENCES users (id) ON DELETE SET NULL,
  -- PAPER never signs anything, whatever else the mandate allows.
  mode                  text NOT NULL DEFAULT 'PAPER' CHECK (mode IN ('PAPER', 'LIVE')),
  approval              text NOT NULL DEFAULT 'OWNER_APPROVES_EACH'
                          CHECK (approval IN ('OWNER_APPROVES_EACH', 'AUTONOMOUS_WITHIN_MANDATE')),
  venues                jsonb NOT NULL,
  networks              jsonb NOT NULL,
  -- Empty denies everything. An agent with no allowed asset trades nothing.
  allowed_assets        jsonb NOT NULL DEFAULT '[]'::jsonb,
  max_per_trade         text NOT NULL,
  max_per_day           text NOT NULL,
  max_open_exposure     text NOT NULL,
  max_open_positions    integer NOT NULL CHECK (max_open_positions >= 0),
  max_slippage_bps      integer NOT NULL CHECK (max_slippage_bps BETWEEN 0 AND 10000),
  max_price_impact_bps  integer NOT NULL CHECK (max_price_impact_bps BETWEEN 0 AND 10000),
  min_liquidity_base    text NOT NULL,
  max_fee_base          text NOT NULL,
  quote_max_age_ms      integer NOT NULL CHECK (quote_max_age_ms BETWEEN 250 AND 300000),
  expires_at            timestamptz,
  paused                boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- Superseded rather than edited, so "what was it allowed to do then" has an
  -- answer after the owner changes their mind.
  retired_at            timestamptz
);
-- One live mandate per agent. Several agents, several mandates.
CREATE UNIQUE INDEX trade_mandates_live_idx ON trade_mandates (agent_id) WHERE retired_at IS NULL;

-- Every trade that was proposed, and what became of it.
--
-- This table is the financial journal. It is one table rather than two
-- because the thing worth reconciling after a crash is the intent itself:
-- splitting the record from the decision is how a journal ends up describing
-- a trade nobody can find.
--
-- The lifecycle is committed before each step, and the states from SIGNED
-- onwards are the window where something irreversible may exist without AI17Z
-- knowing its outcome. The rule for that window is to ask the chain or the
-- broker about the identity already held. UNKNOWN is a state, not a synonym
-- for failure, and nothing re-signs out of it.
CREATE TABLE trade_intents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id              uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  -- RESTRICT, not CASCADE: a mandate that authorised a real trade cannot be
  -- deleted out from under the record of it.
  mandate_id            uuid NOT NULL REFERENCES trade_mandates (id) ON DELETE RESTRICT,
  -- Which wallet or signer, by reference. No secret is ever in this table.
  wallet_id             uuid REFERENCES agent_wallets (id) ON DELETE RESTRICT,
  mode                  text NOT NULL CHECK (mode IN ('PAPER', 'LIVE')),
  venue                 text NOT NULL,
  network               text,
  side                  text NOT NULL CHECK (side IN ('BUY', 'SELL')),
  -- Exact identity: chain plus contract or mint, or venue plus instrument.
  -- Never a ticker.
  asset_in              jsonb NOT NULL,
  asset_out             jsonb NOT NULL,
  max_in                text NOT NULL,
  min_out               text NOT NULL,
  max_slippage_bps      integer NOT NULL CHECK (max_slippage_bps BETWEEN 0 AND 10000),
  max_price_impact_bps  integer NOT NULL CHECK (max_price_impact_bps BETWEEN 0 AND 10000),
  max_fee_base          text NOT NULL,
  -- The snapshot this was decided from, kept so it can be revalidated rather
  -- than trusted.
  quote                 jsonb NOT NULL,
  -- The state read immediately before execution, which is what actually
  -- authorised it. Null until that read happens.
  executed_on           jsonb,
  expires_at            timestamptz NOT NULL,
  status                text NOT NULL CHECK (status IN ('DRAFTED', 'RISK_REJECTED', 'AWAITING_APPROVAL', 'APPROVED',
                                                        'SIMULATED', 'SIGNED', 'SUBMITTED', 'UNKNOWN', 'CONFIRMED',
                                                        'FAILED', 'EXPIRED', 'CANCELLED', 'PAPER_FILLED')),
  -- Why the gate said what it said. Kept because "why did it not do that" is
  -- a fair question weeks later.
  risk_reasons          jsonb,
  simulation            jsonb,
  approved_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  approved_at           timestamptz,
  -- One intent per decision. A retry carries the same key and finds the first
  -- row rather than making a second trade.
  idempotency_key       text NOT NULL UNIQUE,
  -- Written before anything is handed to a network or a broker, so a crash in
  -- between leaves an identity to ask about rather than a reason to send
  -- again. Exactly the rule wallet_intents.tx_hash exists for.
  tx_identity           text,
  broadcast_at          timestamptz,
  receipt               jsonb,
  -- What was checked after the fact, against what the intent promised.
  postcondition         jsonb,
  error                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trade_intents_agent_idx ON trade_intents (agent_id, created_at DESC);
-- Recovery asks for exactly this: rows that may have left something behind.
CREATE INDEX trade_intents_in_flight_idx ON trade_intents (status)
  WHERE status IN ('SIGNED', 'SUBMITTED', 'UNKNOWN');
-- One transaction identity belongs to one intent. If a reconciliation ever
-- tries to attach a hash that is already somebody else's, the database says
-- no rather than the application hoping it noticed.
CREATE UNIQUE INDEX trade_intents_tx_identity_idx ON trade_intents (tx_identity) WHERE tx_identity IS NOT NULL;

-- The stops, at every scope that can hold one.
--
-- Rows rather than a column because a pause is a thing somebody did, with a
-- reason and a time, and because the global scope belongs to nobody's agent.
-- Read at execution time rather than cached with the decision: a pause earns
-- its keep precisely when something has already been approved.
CREATE TABLE trade_pauses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope       text NOT NULL CHECK (scope IN ('GLOBAL', 'RUNTIME', 'AGENT', 'VENUE', 'WALLET')),
  -- Null for GLOBAL, which refers to nothing smaller than everything.
  target      text,
  reason      text NOT NULL,
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Lifted rather than deleted, so the history of a stop survives it.
  lifted_at   timestamptz,
  lifted_by   uuid REFERENCES users (id) ON DELETE SET NULL
);
-- One live pause per scope and target. A second attempt finds the first.
CREATE UNIQUE INDEX trade_pauses_live_idx ON trade_pauses (scope, coalesce(target, '')) WHERE lifted_at IS NULL;
CREATE INDEX trade_pauses_active_idx ON trade_pauses (scope) WHERE lifted_at IS NULL;
