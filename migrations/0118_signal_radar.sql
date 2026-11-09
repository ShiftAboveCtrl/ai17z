-- Prospective observations, serialized by the parent source row.
CREATE TABLE signal_baselines (
  source_id uuid NOT NULL REFERENCES radar_sources(id) ON DELETE CASCADE,
  watch_key text NOT NULL,
  watch jsonb NOT NULL,
  state jsonb,
  last_read jsonb,
  reason text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, watch_key)
);

CREATE TABLE signal_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES radar_sources(id) ON DELETE CASCADE,
  watch_key text NOT NULL,
  generation integer NOT NULL,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  evidence jsonb NOT NULL,
  idea_id uuid REFERENCES content_ideas(id) ON DELETE SET NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, watch_key, generation, agent_id)
);
CREATE INDEX signal_candidates_source_time ON signal_candidates(source_id, created_at DESC);
