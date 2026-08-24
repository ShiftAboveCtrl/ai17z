-- XBAM 0002: agents and their versioned persona / policy / pipeline documents.

CREATE TABLE agents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  slug         text NOT NULL,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  avatar_url   text,
  avatar_mode  text NOT NULL DEFAULT 'PORTRAIT_25D'
               CHECK (avatar_mode IN ('IMAGE', 'PORTRAIT_25D', 'MODEL_3D')),
  state        text NOT NULL DEFAULT 'DRAFT'
               CHECK (state IN ('DRAFT', 'ACTIVE', 'PAUSED', 'ERROR')),
  last_error   text,
  -- Pointers to the currently active versions. Set after the version rows exist.
  persona_version_id  uuid,
  policy_version_id   uuid,
  pipeline_version_id uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agents_owner_slug_key ON agents (owner_id, slug);

CREATE TABLE personas (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   uuid NOT NULL UNIQUE REFERENCES agents (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE persona_versions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id           uuid NOT NULL REFERENCES personas (id) ON DELETE CASCADE,
  version              integer NOT NULL,
  identity_kind        text NOT NULL DEFAULT 'FICTIONAL'
                       CHECK (identity_kind IN ('FICTIONAL','INSPIRED_BY','BRAND','REAL_PERSON_AUTHORIZED','DISCLOSED_AI')),
  display_name         text NOT NULL,
  biography            text NOT NULL DEFAULT '',
  personality          text NOT NULL DEFAULT '',
  tone                 text NOT NULL DEFAULT '',
  style_guidelines     text NOT NULL DEFAULT '',
  style_examples       jsonb NOT NULL DEFAULT '[]'::jsonb,
  topics               jsonb NOT NULL DEFAULT '[]'::jsonb,
  language_policy      text NOT NULL DEFAULT '',
  response_length      text NOT NULL DEFAULT 'SHORT'
                       CHECK (response_length IN ('TERSE','SHORT','MEDIUM','LONG','ADAPTIVE')),
  prohibited_behaviors jsonb NOT NULL DEFAULT '[]'::jsonb,
  custom_instructions  text NOT NULL DEFAULT '',
  change_note          text NOT NULL DEFAULT '',
  created_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (persona_id, version)
);

CREATE TABLE policies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   uuid NOT NULL UNIQUE REFERENCES agents (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE policy_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id   uuid NOT NULL REFERENCES policies (id) ON DELETE CASCADE,
  version     integer NOT NULL,
  config      jsonb NOT NULL,
  change_note text NOT NULL DEFAULT '',
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_id, version)
);

ALTER TABLE agents
  ADD CONSTRAINT agents_persona_version_fk FOREIGN KEY (persona_version_id)
      REFERENCES persona_versions (id) ON DELETE SET NULL,
  ADD CONSTRAINT agents_policy_version_fk FOREIGN KEY (policy_version_id)
      REFERENCES policy_versions (id) ON DELETE SET NULL;
