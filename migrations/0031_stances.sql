-- Stance ledger: what the agent thinks, and why.
--
-- Nothing recorded what an agent had already said. It could be sceptical about
-- something on Monday and enthusiastic on Thursday with no record that anything
-- had changed, which is the single most obvious way a persistent agent stops
-- reading as one person.
--
-- The point is not to freeze an opinion. It is to make a change of mind a
-- deliberate, recorded act rather than an accident of which context happened to
-- be retrieved.

CREATE TABLE stances (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

  -- What the position is about. Normalised for lookup; the display form is kept
  -- separately so "Project Q" does not become "project q" on screen.
  subject      text NOT NULL,
  subject_key  text NOT NULL,

  -- POSITIVE | NEGATIVE | MIXED | NEUTRAL | UNCERTAIN. Coarse on purpose: a
  -- finer scale would imply a precision that is not there.
  position     text NOT NULL
                 CHECK (position IN ('POSITIVE','NEGATIVE','MIXED','NEUTRAL','UNCERTAIN')),
  -- The position in the agent's own words, as it would say it.
  summary      text NOT NULL,
  -- 0-1. How firmly it is held, which decides whether contradicting it is a
  -- conflict or simply a development.
  confidence   numeric(4,3) NOT NULL DEFAULT 0.5,

  status       text NOT NULL DEFAULT 'ACTIVE'
                 CHECK (status IN ('ACTIVE','SUPERSEDED','RETIRED')),
  -- Set when this position was replaced, pointing at what replaced it. The old
  -- row stays: a change of mind is history, not a correction.
  superseded_by uuid REFERENCES stances(id) ON DELETE SET NULL,

  -- Owner-authored stances are never revised automatically.
  pinned       boolean NOT NULL DEFAULT false,

  created_at         timestamptz NOT NULL DEFAULT now(),
  last_reinforced_at timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- One active position per subject. Two live contradictory stances on the same
  -- thing is the state this table exists to prevent.
  UNIQUE (agent_id, subject_key, status) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX stances_active_idx ON stances (agent_id, subject_key) WHERE status = 'ACTIVE';
CREATE INDEX stances_agent_idx ON stances (agent_id, last_reinforced_at DESC);

-- What the position rests on. A stance with no evidence is an assertion, and
-- the same rule that governs persona traits applies here.
CREATE TABLE stance_evidence (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stance_id    uuid NOT NULL REFERENCES stances(id) ON DELETE CASCADE,
  -- said | observed | told_by_owner | imported
  kind         text NOT NULL DEFAULT 'said',
  excerpt      text NOT NULL,
  job_id       uuid REFERENCES jobs(id) ON DELETE SET NULL,
  event_id     uuid REFERENCES events(id) ON DELETE SET NULL,
  action_id    uuid REFERENCES actions(id) ON DELETE SET NULL,
  remote_url   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX stance_evidence_stance_idx ON stance_evidence (stance_id, created_at DESC);

-- Things the agent said would happen, so it can be asked about them later.
CREATE TABLE predictions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  stance_id    uuid REFERENCES stances(id) ON DELETE SET NULL,
  claim        text NOT NULL,
  confidence   numeric(4,3) NOT NULL DEFAULT 0.5,
  -- When it should be looked at again. Null when the claim has no horizon.
  review_at    timestamptz,
  -- OPEN | CORRECT | WRONG | UNRESOLVABLE. Only a person decides which.
  outcome      text NOT NULL DEFAULT 'OPEN'
                 CHECK (outcome IN ('OPEN','CORRECT','WRONG','UNRESOLVABLE')),
  outcome_note text NOT NULL DEFAULT '',
  job_id       uuid REFERENCES jobs(id) ON DELETE SET NULL,
  remote_url   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

CREATE INDEX predictions_due_idx ON predictions (agent_id, review_at) WHERE outcome = 'OPEN';

-- Things the agent said it would do. "I'll look into that" is a promise to
-- somebody, and forgetting it is worse than never having said it.
CREATE TABLE commitments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  relationship_id uuid REFERENCES relationships(id) ON DELETE SET NULL,
  -- What was promised, in the agent's own words.
  promise         text NOT NULL,
  recipient_handle text,
  -- OPEN | DONE | DROPPED
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DONE','DROPPED')),
  -- How sure the detector was. A casual turn of phrase is not an obligation,
  -- so a low-confidence commitment is recorded but never acted on.
  confidence      numeric(4,3) NOT NULL DEFAULT 0.5,
  due_at          timestamptz,
  job_id          uuid REFERENCES jobs(id) ON DELETE SET NULL,
  remote_url      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);

CREATE INDEX commitments_open_idx ON commitments (agent_id, due_at) WHERE status = 'OPEN';
