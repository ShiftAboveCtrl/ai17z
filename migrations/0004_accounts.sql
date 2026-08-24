-- XBAM 0004: external accounts, browser sessions, model providers.
-- Accounts are separate from agents so an account can move between agents and
-- one agent can drive several accounts.

CREATE TABLE accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  channel             text NOT NULL CHECK (channel IN ('mock','x','discord','telegram','slack','email','http')),
  remote_account_id   text,
  handle              text NOT NULL,
  display_name        text NOT NULL DEFAULT '',
  status              text NOT NULL DEFAULT 'DISCONNECTED'
                      CHECK (status IN ('DISCONNECTED','CONNECTING','CONNECTED','NEEDS_AUTH','ERROR')),
  enabled             boolean NOT NULL DEFAULT true,
  capabilities        jsonb NOT NULL DEFAULT '[]'::jsonb,
  settings            jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_health_check_at timestamptz,
  last_health_status  text,
  last_activity_at    timestamptz,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX accounts_channel_handle_key ON accounts (owner_id, channel, lower(handle));

CREATE TABLE agent_accounts (
  agent_id            uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  trigger_event_types jsonb NOT NULL DEFAULT '["MENTION"]'::jsonb,
  action_type         text NOT NULL DEFAULT 'REPLY'
                      CHECK (action_type IN ('REPLY','POST','DIRECT_MESSAGE','LIKE','REACT','CALL_TOOL','CALL_API','NONE')),
  enabled             boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, account_id)
);
CREATE INDEX agent_accounts_account_idx ON agent_accounts (account_id);

CREATE TABLE browser_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL UNIQUE REFERENCES accounts (id) ON DELETE CASCADE,
  mode           text NOT NULL DEFAULT 'MANAGED' CHECK (mode IN ('MANAGED','CDP')),
  profile_dir    text,
  cdp_url        text,
  status         text NOT NULL DEFAULT 'UNKNOWN',
  last_checked_at timestamptz,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_credentials (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider         text NOT NULL CHECK (provider IN ('openai','anthropic','openrouter','ollama','openai_compatible','mock')),
  label            text NOT NULL,
  base_url         text,
  -- AES-256-GCM sealed with XBAM_MASTER_KEY. Never leaves the server.
  sealed_api_key   text,
  key_fingerprint  text,
  available_models jsonb NOT NULL DEFAULT '[]'::jsonb,
  default_model    text,
  timeout_ms       integer NOT NULL DEFAULT 60000,
  enabled          boolean NOT NULL DEFAULT true,
  last_checked_at  timestamptz,
  last_status      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, label)
);

CREATE TABLE model_configs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id               uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  role                   text NOT NULL CHECK (role IN ('primary','fallback_1','fallback_2','classifier')),
  provider_credential_id uuid NOT NULL REFERENCES provider_credentials (id) ON DELETE RESTRICT,
  model                  text NOT NULL,
  parameters             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, role)
);
