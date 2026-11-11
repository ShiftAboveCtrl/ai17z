-- Separate from resolved context so disabled jobs keep their original content bytes.
CREATE TABLE post_media_decisions (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  decision jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
