-- Agent Foundry: research-backed setup as a proposal a person reviews.
--
-- A Foundry run is a research run (research_runs, kind FOUNDRY_SETUP,
-- FOUNDRY_IMPROVE or PERSONA_REFRESH). What it adds is this: the items it
-- proposes, each against a setting that already exists, and the record of what
-- the owner accepted, edited and rejected.
--
-- There is no Foundry copy of a persona, a policy or a belief. `current` is a
-- snapshot of the setting when the item was proposed, kept so the review can
-- show OLD against PROPOSED and so an item whose setting changed underneath it
-- can be noticed. Applying writes through the ordinary repositories as a new
-- version of each setting.

CREATE TABLE foundry_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES research_runs (id) ON DELETE CASCADE,
  section          text NOT NULL CHECK (section IN ('IDENTITY', 'STYLE', 'MUST_NEVER', 'INSTRUCTIONS', 'TOPICS', 'BELIEFS', 'KNOWLEDGE', 'PERSONA_SOURCES', 'RADAR', 'CAPABILITIES', 'AUTONOMY', 'LANGUAGE', 'LEARNING', 'TESTS')),
  -- Stable within a run, so a stage that runs twice updates rather than duplicates.
  item_key         text NOT NULL,
  title            text NOT NULL,
  current_value    jsonb,
  proposed_value   jsonb NOT NULL,
  -- What the owner changed it to, when they edited it.
  owner_value      jsonb,
  rationale        text NOT NULL,
  confidence       numeric(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence         jsonb NOT NULL DEFAULT '[]'::jsonb,
  counter_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  assessment       text NOT NULL DEFAULT 'NEW' CHECK (assessment IN ('ALREADY_CORRECT', 'MISSING', 'WEAK', 'STALE', 'CONTRADICTORY', 'UNSUPPORTED', 'NEW')),
  status           text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'ACCEPTED', 'EDITED', 'REJECTED', 'APPLIED', 'SUPERSEDED')),
  decided_at       timestamptz,
  applied_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, section, item_key)
);
CREATE INDEX foundry_items_run_idx ON foundry_items (run_id, section);

-- What was applied, when, by whom, and what it produced: the setup report.
CREATE TABLE foundry_applications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL REFERENCES research_runs (id) ON DELETE CASCADE,
  agent_id    uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  applied_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  accepted    integer NOT NULL,
  rejected    integer NOT NULL,
  report      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX foundry_applications_agent_idx ON foundry_applications (agent_id, created_at DESC);
