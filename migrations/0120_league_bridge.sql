-- Paper league bridge: a local agent as an entrant in a Studio paper league season.
-- See docs/architecture/STUDIO_LEAGUE_BRIDGE.md.
--
-- Everything here is simulated. A league entry names a PAPER mandate and nothing
-- in these tables can hold a wallet, a key or a signature.

CREATE TABLE league_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  owner_id uuid REFERENCES users (id) ON DELETE SET NULL,
  season_slug text NOT NULL CHECK (season_slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  -- Sent to Studio as the idempotency key of the entry, so a retry after a
  -- crash is the same entry and never a second one. Random, and derived from
  -- nothing about the agent.
  entry_key uuid NOT NULL DEFAULT gen_random_uuid(),
  alias text NOT NULL CHECK (char_length(alias) BETWEEN 3 AND 24),
  -- The season exactly as it was validated and applied. Kept so that a Studio
  -- that cannot be reached leaves a season to keep running on paper, and so a
  -- later answer that differs can be recognised as a change to frozen rules.
  season jsonb NOT NULL CHECK (jsonb_typeof(season) = 'object'),
  rules_hash text NOT NULL CHECK (rules_hash ~ '^[0-9a-f]{64}$'),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  fills_accepted_until timestamptz NOT NULL,
  -- Whether the owner said, when entering, that the season may replace the
  -- paper mandate the agent already had. Kept so a resumed entry does what the
  -- owner agreed to and nothing wider. A LIVE mandate is never replaced.
  replace_paper_mandate boolean NOT NULL DEFAULT false,
  -- Null until Studio has accepted the entry. The mandate is written only after
  -- that, so an entry Studio refused never replaced anything of the owner's.
  remote_entry_id text CHECK (remote_entry_id IS NULL OR remote_entry_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  mandate_id uuid REFERENCES trade_mandates (id),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'ENDED', 'REFUSED')),
  status_reason text CHECK (status_reason IS NULL OR char_length(status_reason) <= 300),
  last_problem text CHECK (last_problem IS NULL OR char_length(last_problem) <= 300),
  last_season_check_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at AND ends_at <= fills_accepted_until),
  CHECK (status <> 'ACTIVE' OR (remote_entry_id IS NOT NULL AND mandate_id IS NOT NULL))
);

-- One entry per agent per season, ever: a refused or ended entry is history,
-- not a slot to be reused with different rules.
CREATE UNIQUE INDEX league_entries_agent_season ON league_entries (agent_id, season_slug);
-- And one live entry per agent, because an agent has one mandate.
CREATE UNIQUE INDEX league_entries_one_live ON league_entries (agent_id) WHERE status IN ('PENDING', 'ACTIVE');
CREATE UNIQUE INDEX league_entries_entry_key ON league_entries (entry_key);
CREATE INDEX league_entries_open ON league_entries (status) WHERE status IN ('PENDING', 'ACTIVE');

-- What an entry may not be edited to. The season rules are frozen at Studio and
-- the same fields are frozen here, so a row cannot be made to describe a
-- different season than the one Studio agreed to.
CREATE FUNCTION league_entries_frozen() RETURNS trigger AS $$
BEGIN
  IF NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.season_slug IS DISTINCT FROM OLD.season_slug
     OR NEW.entry_key IS DISTINCT FROM OLD.entry_key
     OR NEW.rules_hash IS DISTINCT FROM OLD.rules_hash
     OR NEW.season IS DISTINCT FROM OLD.season
     OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
     OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
     OR NEW.fills_accepted_until IS DISTINCT FROM OLD.fills_accepted_until
     OR NEW.replace_paper_mandate IS DISTINCT FROM OLD.replace_paper_mandate
     OR NEW.alias IS DISTINCT FROM OLD.alias THEN
    RAISE EXCEPTION 'A league entry''s season and alias are frozen once it is recorded.';
  END IF;
  IF OLD.remote_entry_id IS NOT NULL AND NEW.remote_entry_id IS DISTINCT FROM OLD.remote_entry_id THEN
    RAISE EXCEPTION 'A league entry''s Studio id cannot change.';
  END IF;
  IF OLD.mandate_id IS NOT NULL AND NEW.mandate_id IS DISTINCT FROM OLD.mandate_id THEN
    RAISE EXCEPTION 'A league entry''s mandate cannot change.';
  END IF;
  IF OLD.status IN ('ENDED', 'REFUSED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'A finished league entry does not reopen.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER league_entries_frozen BEFORE UPDATE ON league_entries
  FOR EACH ROW EXECUTE FUNCTION league_entries_frozen();

-- One row per paper fill this agent made under the season's mandate. The
-- payload is what was (or will be) sent, written once: a fill is not edited
-- after the fact, here or at Studio.
CREATE TABLE league_fill_reports (
  entry_id uuid NOT NULL REFERENCES league_entries (id) ON DELETE CASCADE,
  intent_id uuid NOT NULL REFERENCES trade_intents (id),
  -- Sent as the idempotency key of the fill. Derived from the entry key and the
  -- intent, so it names nothing local.
  fill_key text NOT NULL CHECK (fill_key ~ '^f[0-9a-f]{31}$'),
  filled_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND payload->'simulated' = 'true'::jsonb),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  -- LOCAL_ONLY: made outside the season window or past the report deadline, so
  -- never sent. It is kept, and shown, rather than dropped.
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'ACCEPTED', 'REJECTED', 'LOCAL_ONLY')),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 300),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  reported_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entry_id, intent_id)
);

CREATE UNIQUE INDEX league_fill_reports_key ON league_fill_reports (fill_key);
CREATE INDEX league_fill_reports_due ON league_fill_reports (entry_id, next_attempt_at) WHERE state = 'PENDING';

CREATE FUNCTION league_fill_reports_frozen() RETURNS trigger AS $$
BEGIN
  IF NEW.entry_id IS DISTINCT FROM OLD.entry_id
     OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
     OR NEW.fill_key IS DISTINCT FROM OLD.fill_key
     OR NEW.filled_at IS DISTINCT FROM OLD.filled_at
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash THEN
    RAISE EXCEPTION 'A reported paper fill is not edited.';
  END IF;
  IF OLD.state <> 'PENDING' AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'A settled paper fill report does not change state.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER league_fill_reports_frozen BEFORE UPDATE ON league_fill_reports
  FOR EACH ROW EXECUTE FUNCTION league_fill_reports_frozen();
