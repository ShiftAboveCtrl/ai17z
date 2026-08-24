-- XBAM 0003: pipelines as versioned graphs, not a hard-coded sequence.

CREATE TABLE pipelines (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   uuid NOT NULL UNIQUE REFERENCES agents (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pipeline_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES pipelines (id) ON DELETE CASCADE,
  version     integer NOT NULL,
  name        text NOT NULL DEFAULT 'Default pipeline',
  change_note text NOT NULL DEFAULT '',
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pipeline_id, version)
);

CREATE TABLE pipeline_nodes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_version_id uuid NOT NULL REFERENCES pipeline_versions (id) ON DELETE CASCADE,
  key                 text NOT NULL,
  kind                text NOT NULL CHECK (kind IN (
                        'TRIGGER','RESOLVE_CONTEXT','RETRIEVE_MEMORY','ASSEMBLE_PERSONA',
                        'GENERATE','VALIDATE','APPROVAL_GATE','EXECUTE_ACTION','PERSIST')),
  label               text NOT NULL DEFAULT '',
  config              jsonb NOT NULL DEFAULT '{}'::jsonb,
  position_x          real NOT NULL DEFAULT 0,
  position_y          real NOT NULL DEFAULT 0,
  sort_order          integer NOT NULL DEFAULT 0,
  UNIQUE (pipeline_version_id, key)
);

CREATE TABLE pipeline_edges (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_version_id uuid NOT NULL REFERENCES pipeline_versions (id) ON DELETE CASCADE,
  from_key            text NOT NULL,
  to_key              text NOT NULL,
  condition           text,
  UNIQUE (pipeline_version_id, from_key, to_key)
);

ALTER TABLE agents
  ADD CONSTRAINT agents_pipeline_version_fk FOREIGN KEY (pipeline_version_id)
      REFERENCES pipeline_versions (id) ON DELETE SET NULL;
