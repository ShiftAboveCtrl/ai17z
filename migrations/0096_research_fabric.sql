-- The Research Fabric: outside evidence, where it came from, and how far it
-- may be believed.
--
-- One store for every feature that reads the outside world on an owner's
-- behalf: Agent Foundry, persona sources, knowledge collections, chat and the
-- reply research step. Three ideas carry it.
--
-- An OBJECT is the thing itself: one X post, one documentation page, one file
-- at a commit. It is keyed on what it is (`x:status:123`), never on where it
-- was found, so the same post read on X, copied by two TwStalker hosts and
-- surfaced by a search engine is one object.
--
-- A SIGHTING is one family's copy of an object. One per family: TwStalker's
-- five hosts showing the same post are one mirror saying it five times, and
-- counting them as five would let a mirror outvote the platform. Every URL the
-- family showed it at is kept, so provenance survives the collapse.
--
-- A RUN is one piece of research, durable, advanced by the worker a stage at a
-- time so a restart resumes it rather than starting over.
--
-- Everything here is untrusted text. Nothing read from a page, a mirror or a
-- repository is ever an instruction; the prompt layer fences it as quoted
-- content, and nothing in this schema has a column a command could live in.

CREATE TABLE research_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Null for research not yet about an agent: a Foundry run before the agent exists.
  agent_id         uuid REFERENCES agents (id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('FOUNDRY_SETUP', 'FOUNDRY_IMPROVE', 'PERSONA_REFRESH', 'OWNER_REQUEST', 'KNOWLEDGE_DISCOVERY')),
  -- What was asked, in the owner's words, and the plan made from it.
  brief            jsonb NOT NULL DEFAULT '{}'::jsonb,
  plan             jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'CANCELLED')),
  -- The last stage committed, and what each stage found, in words.
  stage            text NOT NULL DEFAULT 'UNDERSTANDING',
  stage_log        jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- What the run may spend, and what it has spent.
  budget           jsonb NOT NULL DEFAULT '{}'::jsonb,
  spent            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- A stage runs under a lease. A lease that expires returns the run to the
  -- stage it was on, which is why a stage writes nothing it cannot write again.
  claimed_by       text,
  lease_expires_at timestamptz,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  attempts         integer NOT NULL DEFAULT 0,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);
CREATE INDEX research_runs_due_idx ON research_runs (next_attempt_at) WHERE status IN ('QUEUED', 'RUNNING');
CREATE INDEX research_runs_owner_idx ON research_runs (owner_id, created_at DESC);
CREATE INDEX research_runs_agent_idx ON research_runs (agent_id, created_at DESC) WHERE agent_id IS NOT NULL;

CREATE TABLE research_objects (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  object_key            text NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('POST', 'REPLY', 'QUOTE', 'PROFILE', 'WEB_PAGE', 'DOC_PAGE', 'REPO_FILE', 'SEARCH_RESULT', 'OWNER_TEXT')),
  platform              text,
  external_id           text,
  canonical_url         text,
  author                text,
  in_reply_to           text,
  published_at          timestamptz,
  -- The best reading of the thing so far: the highest-tier sighting's text.
  content               text NOT NULL,
  content_hash          text NOT NULL,
  language              text,
  completeness          text NOT NULL CHECK (completeness IN ('FULL', 'PARTIAL', 'SNIPPET')),
  best_tier             text NOT NULL CHECK (best_tier IN ('PRIMARY_PLATFORM', 'OFFICIAL_PROJECT', 'OFFICIAL_REPOSITORY', 'DIRECT_AUTHORITATIVE', 'OWNER_SUPPLIED', 'SEARCH_INDEX', 'PUBLIC_MIRROR', 'ARCHIVE', 'UNKNOWN')),
  best_family           text NOT NULL,
  -- Whether the platform itself has been seen to carry it. A mirror's copy
  -- that X has never confirmed is evidence of a claim, not of a post.
  confirmed_on_platform boolean NOT NULL DEFAULT false,
  normalization_version integer NOT NULL,
  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, object_key)
);
CREATE INDEX research_objects_author_idx ON research_objects (owner_id, lower(author)) WHERE author IS NOT NULL;

CREATE TABLE research_sightings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id     uuid NOT NULL REFERENCES research_objects (id) ON DELETE CASCADE,
  -- The run that last saw it. A later run seeing it again moves this.
  run_id        uuid REFERENCES research_runs (id) ON DELETE SET NULL,
  family        text NOT NULL CHECK (family IN ('X', 'SEARCH_ENGINE', 'TWSTALKER', 'SOTWE', 'WEB', 'GITHUB', 'DOCUMENTATION', 'OWNER', 'PLUGIN', 'ARCHIVE')),
  tier          text NOT NULL CHECK (tier IN ('PRIMARY_PLATFORM', 'OFFICIAL_PROJECT', 'OFFICIAL_REPOSITORY', 'DIRECT_AUTHORITATIVE', 'OWNER_SUPPLIED', 'SEARCH_INDEX', 'PUBLIC_MIRROR', 'ARCHIVE', 'UNKNOWN')),
  completeness  text NOT NULL CHECK (completeness IN ('FULL', 'PARTIAL', 'SNIPPET')),
  -- Every address this family showed it at. Five TwStalker hosts, one row.
  original_urls text[] NOT NULL DEFAULT '{}',
  content       text NOT NULL,
  content_hash  text NOT NULL,
  -- This family's text differs from the object's best reading. Recorded, never
  -- merged: a hybrid of two copies is a post nobody wrote.
  disagrees     boolean NOT NULL DEFAULT false,
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb,
  fetched_at    timestamptz NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (object_id, family)
);

-- Which objects a run gathered, so a proposal can cite exactly what it read.
CREATE TABLE research_run_objects (
  run_id    uuid NOT NULL REFERENCES research_runs (id) ON DELETE CASCADE,
  object_id uuid NOT NULL REFERENCES research_objects (id) ON DELETE CASCADE,
  PRIMARY KEY (run_id, object_id)
);
CREATE INDEX research_run_objects_object_idx ON research_run_objects (object_id);

-- Whether each outside source can be asked, held between runs. A source that
-- served a bot check or kept failing is left alone until `open_until`, so one
-- broken mirror cannot cost every run its whole time budget.
CREATE TABLE research_source_health (
  family        text PRIMARY KEY,
  state         text NOT NULL CHECK (state IN ('AVAILABLE', 'DEGRADED', 'UNAVAILABLE', 'NOT_CONFIGURED')),
  detail        text,
  failures      integer NOT NULL DEFAULT 0,
  open_until    timestamptz,
  last_ok_at    timestamptz,
  checked_at    timestamptz NOT NULL DEFAULT now()
);
