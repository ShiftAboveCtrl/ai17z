-- Watching a repository, so an agent knows what its project actually did.
--
-- An agent whose whole subject is a piece of software, and which has no idea
-- what shipped in it, is reduced to repeating whatever it was told once. It
-- cannot say what changed, cannot answer "is that fixed yet", and its project
-- updates are marketing copy rather than news -- because it has no source of
-- fact about the thing it talks about all day.
--
-- This is that source of fact. A repository is watched, its events become
-- evidence with a URL anybody can check, and deliberation decides which of them
-- are worth anybody's attention. Most are not: a typo fix is not a post.
--
-- ### Read only, and structurally so
--
-- Nothing here pushes, merges, closes, comments or releases. There is no column
-- for a write and no code path that could use one. An agent that could act on a
-- repository is a different product with a different threat model, and this is
-- not a foundation for one.
--
-- ### Polling, because a local installation has no address
--
-- GitHub supports webhooks and they are the better mechanism when they can be
-- used. AI17Z runs on somebody's own machine behind their own router, which
-- usually has nowhere for GitHub to deliver to -- so the durable mechanism is a
-- conditional poll, and a webhook can be an optimisation for installations that
-- happen to be reachable. `etag` is what makes that cheap: GitHub answers 304
-- to a matching conditional request and does not charge it against the rate
-- limit at all.
--
-- ### The same scheduling shape as everything else
--
-- `next_poll_at` in the row, claimed by the statement that moves it forward.
-- The account poller, the feed watcher and the wake loop all do this, and
-- `docs/architecture/CADENCE.md` allows one timing engine.
CREATE TABLE repo_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Which agent is watching. Null means the installation is watching it for
  -- everybody, which is the sensible default for a project several agents care
  -- about.
  agent_id      uuid REFERENCES agents (id) ON DELETE CASCADE,

  -- Only GitHub today. Named rather than assumed so a second forge is a value
  -- rather than a second table.
  provider      text NOT NULL DEFAULT 'github' CHECK (provider IN ('github')),
  -- "owner/name", exactly as the forge spells it.
  repo          text NOT NULL,

  /*
    Which kinds of activity to follow.

    A list rather than a boolean per kind, because an owner watching a project
    for releases and an owner watching it for issues want genuinely different
    things and neither wants the other's noise.
  */
  kinds         jsonb NOT NULL DEFAULT '["RELEASE","COMMIT","PULL_REQUEST","ISSUE"]'::jsonb,

  enabled       boolean NOT NULL DEFAULT true,

  -- Conditional-request bookkeeping, per kind, so one quiet endpoint does not
  -- reset another's. GitHub does not charge a 304 against the rate limit.
  etags         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The newest thing already seen, per kind. What makes a restart resume
  -- rather than re-announce a month of history.
  cursors       jsonb NOT NULL DEFAULT '{}'::jsonb,

  /*
    An optional token, for a repository that is not public.

    Sealed under the master key exactly as a provider API key is, readable only
    through the repository function that opens it, and never selected into
    anything the API can return. Absent for a public repository, which is the
    ordinary case and needs no credential at all.

    Fine-grained and read-only is the documented requirement; nothing here can
    use more than read access because nothing here writes.
  */
  sealed_token  text,
  token_fingerprint text,

  poll_seconds  integer NOT NULL DEFAULT 900 CHECK (poll_seconds BETWEEN 120 AND 86400),
  next_poll_at  timestamptz NOT NULL DEFAULT now(),
  last_poll_at  timestamptz,
  last_success_at timestamptz,
  status        text NOT NULL DEFAULT 'UNKNOWN'
                  CHECK (status IN ('UNKNOWN','HEALTHY','DEGRADED','FAILING','DISABLED')),
  last_error    text,
  consecutive_failures integer NOT NULL DEFAULT 0,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per repository per watcher. A second subscription to the same
-- repository would poll it twice and announce everything twice, so the database
-- refuses it rather than trusting whoever is adding it.
CREATE UNIQUE INDEX repo_sources_key
  ON repo_sources (owner_user_id, provider, lower(repo), coalesce(agent_id::text, 'all'));
CREATE INDEX repo_sources_due_idx ON repo_sources (next_poll_at) WHERE enabled;

-- What the repository actually did.
--
-- Kept rather than only turned into observations, for the same reason `events`
-- is kept: an agent asked "what shipped in Beta 3.1" must answer from the
-- record rather than from whatever it happened to notice at the time, and a
-- claim about a release with no URL behind it is a claim nobody can check.
CREATE TABLE repo_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     uuid NOT NULL REFERENCES repo_sources (id) ON DELETE CASCADE,

  kind          text NOT NULL CHECK (kind IN ('RELEASE','COMMIT','PULL_REQUEST','ISSUE','WORKFLOW')),
  -- The forge's own id for it: a tag, a sha, a number. The idempotency anchor.
  remote_id     text NOT NULL,

  title         text NOT NULL DEFAULT '',
  body          text NOT NULL DEFAULT '',
  url           text NOT NULL DEFAULT '',
  actor         text,
  -- What the forge says happened to it, where that is a distinct thing from
  -- the kind: opened, closed, merged, published, failed.
  state         text,
  occurred_at   timestamptz,

  -- The fields worth keeping from the answer, never the whole payload. A
  -- verbatim archive of somebody else's API is a schema this project does not
  -- control and did not agree to.
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,

  seen_at       timestamptz NOT NULL DEFAULT now()
);

-- One row per thing, whatever happens. A poll that overlaps the last one is
-- the ordinary case, not a contrived one.
CREATE UNIQUE INDEX repo_events_key ON repo_events (source_id, kind, remote_id);
CREATE INDEX repo_events_recent_idx ON repo_events (source_id, occurred_at DESC NULLS LAST);
