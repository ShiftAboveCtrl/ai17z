-- Development updates: a project tells its owner's agent what shipped.
--
-- A coding assistant working on a project knows what was just finished and why
-- it matters, and the agent that talks about that project usually does not. This
-- is the narrow door between them. The sender hands over a summary somebody has
-- already decided is public, the owner decides whether it goes out (or lets it
-- go out on its own, within a ceiling), and the post runs through the same
-- action boundary as everything else the agent publishes.
--
-- ### What is deliberately not here
--
-- No repository is read. There is no column for a diff, a file, a path or a
-- token the sender used, and nothing a submission refused for safety is stored
-- at all: the audit row for a refusal carries reason codes and nothing else.
-- A rejected update keeps its fingerprints, so the same thing is not offered
-- again, and loses its words.
--
-- ### Two credentials, two tables of power
--
-- The sender token belongs to one project. It can submit and read what it
-- submitted, and has no path to approving, changing the mode, or reaching any
-- other project. Only its hash is kept. The owner acts through an ordinary
-- signed-in session.
CREATE TABLE dev_update_projects (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Stable, chosen by the owner, and what the sender names. Lower case so two
  -- spellings of one project are one project.
  project_key          text NOT NULL CHECK (project_key ~ '^[a-z0-9][a-z0-9._-]{1,62}$'),
  display_name         text NOT NULL,
  agent_id             uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  account_id           uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- DRAFT: every update waits for the owner. AUTO: the owner has said updates
  -- may go out unattended, still inside the ceiling, spacing and every gate the
  -- agent's own policy applies.
  mode                 text NOT NULL DEFAULT 'DRAFT' CHECK (mode IN ('DRAFT', 'AUTO')),
  enabled              boolean NOT NULL DEFAULT true,
  -- Two a day is a project that is moving; more is a changelog bot.
  daily_cap            integer NOT NULL DEFAULT 2 CHECK (daily_cap BETWEEN 1 AND 6),
  min_spacing_minutes  integer NOT NULL DEFAULT 240 CHECK (min_spacing_minutes BETWEEN 30 AND 1440),
  -- New projects rehearse. Nothing reaches a real account until the owner
  -- turns this off, so mapping an account is never the same act as posting.
  rehearse             boolean NOT NULL DEFAULT true,
  sender_token_hash    text UNIQUE,
  -- The last four characters, so an owner can tell which token a client holds.
  sender_token_hint    text,
  sender_token_issued_at timestamptz,
  last_dispatch_reason text NOT NULL DEFAULT '',
  -- When the dispatcher last looked at this project, whatever it decided. The
  -- dispatcher takes the least recently considered first, so a handful of
  -- projects that are always blocked cannot keep the rest from being reached.
  last_considered_at   timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, project_key)
);

CREATE TABLE dev_updates (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL REFERENCES dev_update_projects (id) ON DELETE CASCADE,
  kind                 text NOT NULL CHECK (kind IN ('FEATURE', 'FIX', 'IMPROVEMENT', 'MILESTONE', 'RELEASE')),
  -- Emptied when the owner rejects the update. Fingerprints stay.
  title                text NOT NULL DEFAULT '',
  summary              text NOT NULL DEFAULT '',
  why                  text NOT NULL DEFAULT '',
  evidence             jsonb NOT NULL DEFAULT '[]'::jsonb,
  post_text            text NOT NULL DEFAULT '',
  -- What the owner approved, when it differs from what was proposed. What is
  -- approved is what is published: nothing regenerates it afterwards.
  approved_text        text,
  fact_fingerprint     text NOT NULL,
  text_fingerprint     text NOT NULL,
  evidence_keys        text[] NOT NULL DEFAULT '{}',
  client_request_id    text,
  status               text NOT NULL CHECK (status IN (
                         'PENDING_REVIEW', 'APPROVED', 'DISPATCHED', 'PUBLISHED', 'REHEARSED',
                         'SKIPPED', 'REJECTED', 'FAILED', 'CANCELLED')),
  -- Why it is in that status, in a sentence.
  status_reason        text NOT NULL DEFAULT '',
  job_id               uuid REFERENCES jobs (id) ON DELETE SET NULL,
  remote_url           text,
  -- Every transition, with who caused it and why.
  history              jsonb NOT NULL DEFAULT '[]'::jsonb,
  decided_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  decided_at           timestamptz,
  dispatched_at        timestamptz,
  finished_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Duplicates are refused by the index, not by a read before the write: two
-- submissions of the same thing arriving together is the case this exists for.
CREATE UNIQUE INDEX dev_updates_fact_once ON dev_updates (project_id, fact_fingerprint);
CREATE UNIQUE INDEX dev_updates_text_once ON dev_updates (project_id, text_fingerprint);
CREATE UNIQUE INDEX dev_updates_request_once ON dev_updates (project_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
CREATE INDEX dev_updates_by_status ON dev_updates (project_id, status, created_at);
CREATE INDEX dev_updates_dispatched ON dev_updates (project_id, dispatched_at) WHERE dispatched_at IS NOT NULL;
CREATE UNIQUE INDEX dev_updates_job_once ON dev_updates (job_id) WHERE job_id IS NOT NULL;
