-- XBAM 0006: outbound actions, approvals, model calls, trace.

CREATE TABLE approvals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid NOT NULL UNIQUE REFERENCES jobs (id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  original_output text NOT NULL DEFAULT '',
  edited_output   text,
  note            text,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz,
  decided_by      uuid REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX approvals_status_idx ON approvals (status, requested_at);

CREATE TABLE actions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  agent_id          uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  account_id        uuid REFERENCES accounts (id) ON DELETE SET NULL,
  channel           text NOT NULL,
  type              text NOT NULL,
  status            text NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','EXECUTING','EXECUTED','DRY_RUN','FAILED','SKIPPED_DUPLICATE')),
  dry_run           boolean NOT NULL DEFAULT false,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_ref        text,
  remote_action_id  text,
  remote_action_url text,
  verification      jsonb,
  -- Execution-side idempotency: at most one real remote action per key, ever.
  idempotency_key   text NOT NULL,
  content_signature text,
  error_class       text CHECK (error_class IN ('RETRYABLE','PERMANENT','REVIEW_REQUIRED')),
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  executed_at       timestamptz
);
-- Dry runs may repeat freely; a real action key may exist at most once.
CREATE UNIQUE INDEX actions_idempotency_key ON actions (idempotency_key) WHERE dry_run = false;
CREATE INDEX actions_job_idx ON actions (job_id);
CREATE INDEX actions_agent_idx ON actions (agent_id, created_at DESC);
-- Second dedupe layer, inherited from the AI4CZ posted_index concept: never send
-- byte-identical text to the same remote target twice.
CREATE UNIQUE INDEX actions_content_signature_key ON actions (agent_id, content_signature)
  WHERE dry_run = false AND content_signature IS NOT NULL AND status = 'EXECUTED';

CREATE TABLE action_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id     uuid NOT NULL REFERENCES actions (id) ON DELETE CASCADE,
  attempt       integer NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  outcome       text,
  error_class   text,
  error         text,
  diagnostic_id uuid,
  UNIQUE (action_id, attempt)
);

CREATE TABLE model_calls (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                 uuid REFERENCES jobs (id) ON DELETE CASCADE,
  agent_id               uuid REFERENCES agents (id) ON DELETE SET NULL,
  provider_credential_id uuid REFERENCES provider_credentials (id) ON DELETE SET NULL,
  purpose                text NOT NULL DEFAULT 'GENERATE',
  provider               text NOT NULL,
  model                  text NOT NULL,
  model_role             text,
  attempt                integer NOT NULL DEFAULT 1,
  status                 text NOT NULL DEFAULT 'STARTED' CHECK (status IN ('STARTED','COMPLETED','FAILED')),
  parameters             jsonb NOT NULL DEFAULT '{}'::jsonb,
  prompt_layers          jsonb,
  prompt_text            text,
  raw_output             text,
  request_id             text,
  latency_ms             integer,
  prompt_tokens          integer,
  completion_tokens      integer,
  estimated_cost_usd     numeric(12,6),
  error_class            text,
  error                  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  completed_at           timestamptz
);
CREATE INDEX model_calls_job_idx ON model_calls (job_id, created_at);
CREATE INDEX model_calls_agent_day_idx ON model_calls (agent_id, created_at DESC);

CREATE TABLE trace_events (
  id       bigserial PRIMARY KEY,
  job_id   uuid REFERENCES jobs (id) ON DELETE CASCADE,
  agent_id uuid REFERENCES agents (id) ON DELETE CASCADE,
  type     text NOT NULL,
  level    text NOT NULL DEFAULT 'info' CHECK (level IN ('debug','info','warn','error')),
  message  text NOT NULL DEFAULT '',
  data     jsonb NOT NULL DEFAULT '{}'::jsonb,
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trace_events_job_idx ON trace_events (job_id, id);
CREATE INDEX trace_events_agent_idx ON trace_events (agent_id, at DESC);
