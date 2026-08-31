-- Actions had no updated_at, and the stale-EXECUTING recovery filtered on one.
--
-- `claimAction` retakes an action left EXECUTING by a worker that died, but only
-- if it has been sitting there longer than the stale window -- and it asked that
-- question with `updated_at < now() - interval ...` against a table that has no
-- such column. So the whole recovery branch raised "column updated_at does not
-- exist" instead of recovering anything, every time it was reached. It is
-- reached exactly when a reply fails and retries, which is the moment it is
-- most needed.
--
-- Backfilled from executed_at where there is one and created_at otherwise, so
-- existing rows get a truthful timestamp rather than a fresh one that would make
-- every historical stuck action look like it just started.
ALTER TABLE actions ADD COLUMN updated_at timestamptz;

UPDATE actions SET updated_at = COALESCE(executed_at, created_at);

ALTER TABLE actions
  ALTER COLUMN updated_at SET NOT NULL,
  ALTER COLUMN updated_at SET DEFAULT now();

-- Every write to an action goes through claimAction or completeAction, but a
-- trigger is what makes that true rather than a convention: a status left
-- behind by a path that forgot to touch the column would look permanently
-- fresh and never be recovered.
CREATE OR REPLACE FUNCTION actions_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER actions_set_updated_at
  BEFORE UPDATE ON actions
  FOR EACH ROW EXECUTE FUNCTION actions_touch_updated_at();
