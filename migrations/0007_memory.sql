-- XBAM 0007: multi-scope memory and the retrieval audit trail.

CREATE TABLE memories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  scope           text NOT NULL CHECK (scope IN ('THREAD','USER','PERSONA','ACCOUNT','KNOWLEDGE','EPISODIC')),
  memory_type     text NOT NULL CHECK (memory_type IN (
                    'CONVERSATION_TURN','FACT','PREFERENCE','COMMITMENT','STYLE_EXAMPLE','DOCUMENT','SUMMARY','EVENT_ARCHIVE')),
  account_id      uuid REFERENCES accounts (id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations (id) ON DELETE CASCADE,
  remote_user_id  text,
  remote_handle   text,
  content         text NOT NULL,
  summary         text,
  importance      real NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  confidence      real NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
  pinned          boolean NOT NULL DEFAULT false,
  source_event_id uuid REFERENCES events (id) ON DELETE SET NULL,
  source_job_id   uuid REFERENCES jobs (id) ON DELETE SET NULL,
  -- sha256 of the normalised content; the dedupe anchor within a scope bucket.
  content_hash    text NOT NULL,
  -- Denormalised bucket so the unique index below can be simple and exact.
  scope_key       text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_accessed_at timestamptz,
  expires_at      timestamptz
);
CREATE UNIQUE INDEX memories_dedupe_key ON memories (agent_id, scope, scope_key, content_hash);
CREATE INDEX memories_user_idx ON memories (agent_id, scope, lower(remote_handle), importance DESC, created_at DESC);
CREATE INDEX memories_conversation_idx ON memories (conversation_id, created_at);
CREATE INDEX memories_agent_scope_idx ON memories (agent_id, scope, created_at DESC);
CREATE INDEX memories_expiry_idx ON memories (expires_at) WHERE expires_at IS NOT NULL;
-- Full-text index backing deterministic keyword retrieval for KNOWLEDGE/PERSONA.
CREATE INDEX memories_content_fts_idx ON memories USING gin (to_tsvector('simple', content));

-- Why a memory was used in a specific generation. Never let retrieval be a black box.
CREATE TABLE memory_retrievals (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id     uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  memory_id  uuid NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  rank       integer NOT NULL,
  score      real NOT NULL DEFAULT 0,
  reason     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, memory_id)
);
CREATE INDEX memory_retrievals_job_idx ON memory_retrievals (job_id, rank);

-- Prompt templates are versioned data, not string literals inside a worker.
CREATE TABLE prompt_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE prompt_template_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES prompt_templates (id) ON DELETE CASCADE,
  version     integer NOT NULL,
  -- Ordered array of {key,title,role,template} objects rendered by the engine.
  layers      jsonb NOT NULL,
  is_active   boolean NOT NULL DEFAULT false,
  change_note text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);
CREATE UNIQUE INDEX prompt_template_active_key ON prompt_template_versions (template_id) WHERE is_active;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_prompt_template_version_fk FOREIGN KEY (prompt_template_version_id)
      REFERENCES prompt_template_versions (id) ON DELETE SET NULL;
