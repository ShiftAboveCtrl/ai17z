-- The agent's public paper season arc: at most one entry post, one standing
-- post and one recap per league entry. The unique key is the cap: a loop that
-- re-proposes cannot create a second post of a kind, whatever it does.
CREATE TABLE league_season_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES league_entries(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('ENTRY','STANDING','RECAP')),
  status text NOT NULL CHECK (status IN ('skipped','proposed','closed')),
  -- Why nothing was proposed, or why it was closed. Shown to the owner.
  reason text NOT NULL,
  -- The figures the post was built from, so the send can check them again.
  facts jsonb,
  idea_id uuid UNIQUE REFERENCES content_ideas(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_id, kind)
);
CREATE INDEX league_season_posts_agent ON league_season_posts(agent_id, updated_at DESC);
