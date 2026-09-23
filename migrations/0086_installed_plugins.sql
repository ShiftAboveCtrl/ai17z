-- Plugins an owner installed, and nothing about what an agent may do with them.
--
-- The split matters. `agent_capability_permissions` already holds exactly one
-- decision per agent per capability, and a Plugin's enabled state is computed
-- from those rather than stored here. Two places recording what an agent may
-- do is how something ends up allowed on one screen and refused by another,
-- and this repository has already paid for that once.
--
-- So this table answers a different question: which Plugins exist on this
-- installation, where each came from, what it declared, and what was approved.
-- Built-in Plugins have no row at all, because they are the toolpacks that
-- ship with the application and are versioned with it.
--
-- The manifest is kept verbatim rather than exploded into columns. What was
-- approved at install time is the thing worth being able to show later, and a
-- normalised copy is a second version of it that can disagree.
CREATE TABLE installed_plugins (
  -- The Plugin's own id from its manifest, which is also the namespace every
  -- capability it contributes is registered under. Primary key, so installing
  -- a second Plugin claiming an existing id is refused by the database rather
  -- than by whichever code path happened to check.
  id              text PRIMARY KEY,
  source          text NOT NULL CHECK (source IN ('LOCAL', 'AI17Z_REGISTRY')),
  version         text NOT NULL,
  -- Recorded beside the manifest deliberately. A later version arriving under
  -- a different publisher is a substitution rather than an update, and the
  -- only way to notice is to have kept what the first one said.
  publisher       text NOT NULL,
  -- Of the manifest bytes as received. What was approved and what is running
  -- can then be compared, which is the whole point of approving anything.
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  manifest        jsonb NOT NULL,
  installed_at    timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Non-secret configuration an owner supplied, per agent per Plugin.
--
-- Per agent rather than per installation, because two agents on one machine
-- are two different people as far as an API is concerned, and because this has
-- to travel with an agent in a package the way its other settings do.
--
-- Secrets are not here. A secret goes through the same sealed store a provider
-- key uses, under the master key, and is referenced by name. A value in this
-- table is one that may appear in an API response and in a shared agent file,
-- which is exactly the set of values that must never include a credential.
CREATE TABLE agent_plugin_config (
  agent_id   uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  plugin_id  text NOT NULL,
  config     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, plugin_id)
);

-- A secret an owner supplied for a Plugin, sealed.
--
-- Separate from `agent_plugin_config` rather than a flag on it, because the
-- difference is not a property of the row, it is which code may read it. The
-- sealed value is readable only through the repository function that opens it,
-- the same arrangement `provider_credentials` uses, and nothing selects this
-- table into an API response.
CREATE TABLE agent_plugin_secrets (
  agent_id   uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  plugin_id  text NOT NULL,
  config_key text NOT NULL,
  -- AES-256-GCM under AI17Z_MASTER_KEY, exactly like a provider key.
  sealed     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, plugin_id, config_key)
);

-- What a Plugin's declared operations have spent, for the quota it declared.
--
-- An hour bucket rather than a rolling window, because a ceiling somebody can
-- reason about beats one that is exactly fair. The unique key is what makes
-- two workers counting the same hour safe.
CREATE TABLE plugin_call_budget (
  agent_id   uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  plugin_id  text NOT NULL,
  hour       timestamptz NOT NULL,
  calls      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, plugin_id, hour)
);

CREATE INDEX plugin_call_budget_hour ON plugin_call_budget (hour);
