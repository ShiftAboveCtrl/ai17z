-- An owner opts one agent in to using the coin alerts they keep on Studio as the
-- universe of one radar source. The list is exact mints and nothing else: no
-- wallet, size or entry price has a column here, so none can be imported.
CREATE TABLE studio_coin_alert_bindings (
  agent_id uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  installation_id text NOT NULL,
  origin text NOT NULL,
  linked_at text NOT NULL,
  next_sync_at timestamptz NOT NULL DEFAULT now(),
  -- The last list Studio confirmed, kept when Studio cannot be reached.
  mints jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Why entries of that list were not used: a reason per entry, never its text.
  skipped jsonb NOT NULL DEFAULT '[]'::jsonb,
  confirmed_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
