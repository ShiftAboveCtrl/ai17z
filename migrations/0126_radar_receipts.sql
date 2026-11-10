-- Two bounded follow-ups to a real published observation. Actions remain truth.
CREATE TABLE signal_receipts (
  id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  action_id uuid NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  window_hours integer NOT NULL CHECK (window_hours IN (1,24)),
  due_at timestamptz NOT NULL,
  evidence jsonb NOT NULL,
  idea_id uuid UNIQUE REFERENCES content_ideas(id) ON DELETE SET NULL,
  now_read jsonb,
  verdict text CHECK (verdict IN ('changed','unchanged','unavailable')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reading','offered','skipped','unavailable')),
  reason text NOT NULL DEFAULT 'Waiting for the follow-up window.',
  checked_at timestamptz,
  PRIMARY KEY (action_id, window_hours)
);
CREATE INDEX signal_receipts_due ON signal_receipts(due_at) WHERE status='pending';
