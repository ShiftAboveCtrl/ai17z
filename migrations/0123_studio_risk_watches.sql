-- An owner binds one local account to the installation's Studio universe.
CREATE TABLE studio_risk_bindings (
  agent_id uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  may_trigger boolean NOT NULL DEFAULT false,
  installation_id text NOT NULL,
  origin text NOT NULL,
  linked_at text NOT NULL,
  next_sync_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz,
  expires_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Delivery metadata over retained signal evidence, not another crossing store.
CREATE TABLE studio_risk_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- studio_risk_bindings.id is UNIQUE, so it can be referenced; a removed binding takes its queue with it.
  binding_id uuid NOT NULL REFERENCES studio_risk_bindings(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES radar_sources(id) ON DELETE CASCADE,
  observation_key text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  last_error text,
  UNIQUE(source_id, observation_key)
);
CREATE INDEX studio_risk_outbox_pending ON studio_risk_outbox(next_attempt_at) WHERE delivered_at IS NULL;
