-- Persona syncs run where the tool lives.
--
-- x_public shells out to twscrape, which has its own account database on the
-- machine it was installed on. The API runs in a container with neither, so a
-- sync started there reported "twscrape is not on PATH" even when it was
-- installed and working a few inches away.
--
-- Same reasoning as browsers: the API records intent, and the worker that has
-- the tool does the work.

ALTER TABLE persona_sources
  -- What was asked for, so the worker knows what to do without a second table.
  ADD COLUMN pending_request jsonb,
  ADD COLUMN claimed_by text,
  ADD COLUMN claimed_at timestamptz;

CREATE INDEX persona_sources_pending_idx ON persona_sources (claimed_at NULLS FIRST)
  WHERE pending_request IS NOT NULL;
