-- XBAM 0008: tools, artifacts, diagnostics, migration bookkeeping.

CREATE TABLE tools (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text NOT NULL UNIQUE,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  kind         text NOT NULL DEFAULT 'BUILTIN' CHECK (kind IN ('BUILTIN','HTTP','CUSTOM')),
  input_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled_globally boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_tools (
  agent_id   uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  tool_id    uuid NOT NULL REFERENCES tools (id) ON DELETE CASCADE,
  enabled    boolean NOT NULL DEFAULT false,
  config     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, tool_id)
);

CREATE TABLE artifacts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('SCREENSHOT','PORTRAIT','UPLOAD','EXPORT','HTML_SNAPSHOT')),
  job_id     uuid REFERENCES jobs (id) ON DELETE CASCADE,
  action_id  uuid REFERENCES actions (id) ON DELETE CASCADE,
  account_id uuid REFERENCES accounts (id) ON DELETE SET NULL,
  agent_id   uuid REFERENCES agents (id) ON DELETE CASCADE,
  mime_type  text NOT NULL,
  -- Path relative to XBAM_STORAGE_DIR. Never an absolute host path.
  rel_path   text NOT NULL,
  bytes      integer NOT NULL DEFAULT 0,
  meta       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX artifacts_job_idx ON artifacts (job_id);

CREATE TABLE diagnostics (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid REFERENCES jobs (id) ON DELETE CASCADE,
  action_id   uuid REFERENCES actions (id) ON DELETE CASCADE,
  account_id  uuid REFERENCES accounts (id) ON DELETE SET NULL,
  channel     text NOT NULL,
  kind        text NOT NULL,
  url         text,
  target_ref  text,
  error_class text,
  message     text NOT NULL DEFAULT '',
  artifact_id uuid REFERENCES artifacts (id) ON DELETE SET NULL,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX diagnostics_job_idx ON diagnostics (job_id, created_at DESC);
CREATE INDEX diagnostics_account_idx ON diagnostics (account_id, created_at DESC);

ALTER TABLE action_attempts
  ADD CONSTRAINT action_attempts_diagnostic_fk FOREIGN KEY (diagnostic_id)
      REFERENCES diagnostics (id) ON DELETE SET NULL;

-- Legacy import bookkeeping. Importers are idempotent; this records each run.
CREATE TABLE import_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source      text NOT NULL,
  agent_id    uuid REFERENCES agents (id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  report      jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

-- Natural keys already imported, so a repeat import updates instead of duplicating.
CREATE TABLE import_fingerprints (
  source      text NOT NULL,
  entity_type text NOT NULL,
  natural_key text NOT NULL,
  entity_id   uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, entity_type, natural_key)
);
