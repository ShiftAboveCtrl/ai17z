-- XBAM 0005: the durable runtime. Events are immutable, jobs are the unit of work.

CREATE TABLE conversations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id               uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  account_id             uuid REFERENCES accounts (id) ON DELETE SET NULL,
  channel                text NOT NULL,
  remote_conversation_id text NOT NULL,
  remote_user_id         text,
  remote_handle          text,
  started_at             timestamptz NOT NULL DEFAULT now(),
  last_activity_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, channel, remote_conversation_id)
);
CREATE INDEX conversations_handle_idx ON conversations (agent_id, lower(remote_handle));
CREATE INDEX conversations_activity_idx ON conversations (agent_id, last_activity_at DESC);

CREATE TABLE messages (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id           uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  direction                 text NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  remote_message_id         text,
  parent_remote_message_id  text,
  author_remote_id          text,
  author_handle             text,
  body                      text NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now()
);
-- Null remote ids are allowed (dry runs, mock); duplicates of a real id are not.
CREATE UNIQUE INDEX messages_remote_key ON messages (conversation_id, remote_message_id)
  WHERE remote_message_id IS NOT NULL;
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);

-- Immutable record of something that happened on a channel.
CREATE TABLE events (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel                  text NOT NULL,
  account_id               uuid REFERENCES accounts (id) ON DELETE SET NULL,
  type                     text NOT NULL CHECK (type IN (
                             'MENTION','REPLY','DIRECT_MESSAGE','NEW_MESSAGE','KEYWORD_MATCH',
                             'WEBHOOK','SCHEDULED_TRIGGER','MANUAL_TRIGGER')),
  remote_event_id          text NOT NULL,
  remote_message_id        text,
  remote_author_id         text,
  remote_author_handle     text,
  remote_author_display    text,
  remote_conversation_id   text,
  parent_remote_message_id text,
  remote_url               text,
  text                     text NOT NULL DEFAULT '',
  payload                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at              timestamptz,
  ingested_at              timestamptz NOT NULL DEFAULT now()
);
-- The ingest-side idempotency anchor: one row per remote event per account.
CREATE UNIQUE INDEX events_remote_key ON events (channel, coalesce(account_id::text, 'none'), remote_event_id);
CREATE INDEX events_ingested_idx ON events (ingested_at DESC);

CREATE TABLE jobs (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                  uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  agent_id                  uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  account_id                uuid REFERENCES accounts (id) ON DELETE SET NULL,
  conversation_id           uuid REFERENCES conversations (id) ON DELETE SET NULL,
  channel                   text NOT NULL,
  action_type               text NOT NULL,
  status                    text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN (
                              'RECEIVED','CONTEXT_RESOLVING','CONTEXT_RESOLVED','MEMORY_RETRIEVING',
                              'MEMORY_RESOLVED','GENERATING','GENERATED','VALIDATING','VALIDATED',
                              'WAITING_FOR_APPROVAL','EXECUTING','EXECUTED','DRY_RUN_COMPLETED',
                              'RETRYABLE_FAILURE','PERMANENT_FAILURE','REVIEW_REQUIRED','CANCELLED')),
  attempt_count             integer NOT NULL DEFAULT 0,
  max_attempts              integer NOT NULL DEFAULT 5,
  priority                  integer NOT NULL DEFAULT 100,
  dry_run                   boolean NOT NULL DEFAULT false,
  run_at                    timestamptz NOT NULL DEFAULT now(),
  locked_by                 text,
  lock_expires_at           timestamptz,
  -- Frozen configuration this job was admitted under, so replays are honest.
  persona_version_id        uuid REFERENCES persona_versions (id) ON DELETE SET NULL,
  policy_version_id         uuid REFERENCES policy_versions (id) ON DELETE SET NULL,
  pipeline_version_id       uuid REFERENCES pipeline_versions (id) ON DELETE SET NULL,
  prompt_template_version_id uuid,
  resolved_context          jsonb,
  generated_output          text,
  validated_output          text,
  error_class               text CHECK (error_class IN ('RETRYABLE','PERMANENT','REVIEW_REQUIRED')),
  last_error                text,
  idempotency_key           text NOT NULL UNIQUE,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  context_resolved_at       timestamptz,
  memory_resolved_at        timestamptz,
  generated_at              timestamptz,
  validated_at              timestamptz,
  approved_at               timestamptz,
  executed_at               timestamptz
);
-- The claim query: pending status + due + unlocked, highest priority first.
CREATE INDEX jobs_claim_idx ON jobs (status, run_at, priority);
CREATE INDEX jobs_agent_idx ON jobs (agent_id, created_at DESC);
CREATE INDEX jobs_lease_idx ON jobs (lock_expires_at) WHERE locked_by IS NOT NULL;
CREATE INDEX jobs_event_idx ON jobs (event_id);

CREATE TABLE job_attempts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  attempt     integer NOT NULL,
  step        text NOT NULL,
  worker_id   text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome     text CHECK (outcome IN ('OK','RETRYABLE','PERMANENT','REVIEW_REQUIRED')),
  error_class text,
  error       text,
  UNIQUE (job_id, attempt, step)
);
CREATE INDEX job_attempts_job_idx ON job_attempts (job_id, started_at);
