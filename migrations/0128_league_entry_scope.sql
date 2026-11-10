-- A refusal of an alias leaves history but allows a fresh keyed attempt.
ALTER TABLE league_entries ADD COLUMN refusal_code text;
-- A relink ends the old binding without consuming the new link's season entry.
ALTER TABLE league_entries ADD COLUMN end_code text;
DROP INDEX league_entries_agent_season;
CREATE UNIQUE INDEX league_entries_agent_season ON league_entries (agent_id, season_slug)
  WHERE (status <> 'REFUSED' OR refusal_code IS NULL OR refusal_code NOT IN ('alias_taken', 'invalid_alias'))
    AND (status <> 'ENDED' OR end_code IS DISTINCT FROM 'link_changed');

-- Existing entries have no provable binding. The runtime ends them instead of
-- assigning them to whichever installation happens to be linked at migration.
ALTER TABLE league_entries ADD COLUMN installation_id text;
ALTER TABLE league_entries ADD COLUMN linked_at timestamptz;
ALTER TABLE league_entries ADD COLUMN studio_origin text;

CREATE FUNCTION league_entries_scope_frozen() RETURNS trigger AS $$
BEGIN
  IF NEW.installation_id IS DISTINCT FROM OLD.installation_id
     OR NEW.linked_at IS DISTINCT FROM OLD.linked_at
     OR NEW.studio_origin IS DISTINCT FROM OLD.studio_origin
     OR (OLD.status = 'REFUSED' AND NEW.refusal_code IS DISTINCT FROM OLD.refusal_code) THEN
    RAISE EXCEPTION 'A league entry keeps its original link and refusal.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER league_entries_scope_frozen BEFORE UPDATE ON league_entries
  FOR EACH ROW EXECUTE FUNCTION league_entries_scope_frozen();
