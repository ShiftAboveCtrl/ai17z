-- Null retains the legacy single-post representation. Thread text is approved as one unit.
ALTER TABLE dev_updates ADD COLUMN parts jsonb, ADD COLUMN approved_parts jsonb;
ALTER TABLE dev_updates ADD CONSTRAINT dev_update_parts_shape CHECK (
  parts IS NULL OR (jsonb_typeof(parts) = 'array' AND jsonb_array_length(parts) BETWEEN 2 AND 6)
);
ALTER TABLE dev_updates ADD CONSTRAINT dev_update_approved_parts_shape CHECK (
  approved_parts IS NULL OR (parts IS NOT NULL AND jsonb_typeof(approved_parts) = 'array'
    AND jsonb_array_length(approved_parts) = jsonb_array_length(parts))
);
