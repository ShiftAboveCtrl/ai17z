-- The "before" a narrative pulse compares against, so a subject can be called rising only when an earlier
-- measurement of it exists. One row per agent, window end and subject that cleared the distinct-author floor:
-- a share and a count, never an author, a handle or post text. A subject missing from an earlier snapshot was
-- below the floor then, which is not a measured zero, so absence is never read as one.
CREATE TABLE narrative_pulse_snapshots (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  window_end timestamptz NOT NULL,
  term text NOT NULL CHECK (char_length(term) BETWEEN 3 AND 41),
  share numeric(6,5) NOT NULL CHECK (share > 0 AND share <= 1),
  authors integer NOT NULL CHECK (authors >= 3),
  -- Posts that could be placed in the window, so a thin sample is visible afterwards.
  posts integer NOT NULL CHECK (posts >= 12),
  PRIMARY KEY (agent_id, window_end, term)
);
CREATE INDEX narrative_pulse_snapshots_window ON narrative_pulse_snapshots(agent_id, window_end DESC);
