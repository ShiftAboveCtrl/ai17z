-- Config edits update updated_at too. Keep a separate permission floor so they
-- cannot silently discard pending activity. The previous timestamp is the only
-- available floor for existing decisions, so preserve it during migration.
ALTER TABLE agent_capability_permissions
  ADD COLUMN permission_changed_at timestamptz;

UPDATE agent_capability_permissions SET permission_changed_at = updated_at;

ALTER TABLE agent_capability_permissions
  ALTER COLUMN permission_changed_at SET DEFAULT now(),
  ALTER COLUMN permission_changed_at SET NOT NULL;

CREATE FUNCTION record_capability_permission_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.permission IS DISTINCT FROM OLD.permission THEN
    NEW.permission_changed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER capability_permission_changed
  BEFORE UPDATE OF permission ON agent_capability_permissions
  FOR EACH ROW EXECUTE FUNCTION record_capability_permission_change();
