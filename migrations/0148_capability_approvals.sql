CREATE TABLE capability_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  capability_id text NOT NULL,
  input jsonb NOT NULL,
  input_sha256 text NOT NULL CHECK (length(input_sha256) = 64),
  source text NOT NULL CHECK (source IN ('GOAL_PLAN','REPLY','OWNER_CHAT')),
  source_ref text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','DENIED','EXPIRED','DONE','FAILED')),
  why text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_reason text,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  audience text NOT NULL CHECK (audience IN ('OWNER','PUBLIC')),
  origin jsonb,
  execution_key uuid UNIQUE,
  execution_started_at timestamptz,
  result_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, capability_id, source, source_ref, input_sha256)
);

CREATE INDEX capability_approvals_queue ON capability_approvals (created_at)
  WHERE status IN ('PENDING','APPROVED');
CREATE INDEX capability_approvals_agent ON capability_approvals (agent_id, created_at DESC);

-- Revocation is terminal even if the owner enables the grant again before a
-- queued approval runs. Deleting a grant is revocation too, not a reset.
CREATE FUNCTION revoke_capability_approvals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.permission = 'DISABLED' THEN
    UPDATE capability_approvals SET status = 'FAILED', result_reason = 'Permission was revoked. This proposal cannot run.'
      WHERE agent_id = COALESCE(NEW.agent_id, OLD.agent_id) AND capability_id = COALESCE(NEW.capability_id, OLD.capability_id)
        AND status IN ('PENDING','APPROVED');
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER revoke_capability_approvals
  AFTER INSERT OR UPDATE OF permission OR DELETE ON agent_capability_permissions
  FOR EACH ROW EXECUTE FUNCTION revoke_capability_approvals();
