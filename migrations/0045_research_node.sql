-- RESEARCH: a pipeline node that looks things up off-platform.
--
-- Same enum-with-a-CHECK trap as 0044, on the other table. Both were widened in
-- the same change because both enums grew for the same feature, and widening
-- one of two is how this bites the time after next.

ALTER TABLE pipeline_nodes DROP CONSTRAINT IF EXISTS pipeline_nodes_kind_check;
ALTER TABLE pipeline_nodes
  ADD CONSTRAINT pipeline_nodes_kind_check
    CHECK (kind IN (
      'TRIGGER','FILTER','RESOLVE_CONTEXT','MEDIA_RESOLVE','RESEARCH','RELATIONSHIP','STANCE',
      'ENGAGEMENT_DECISION','INTENT','RETRIEVE_MEMORY','ASSEMBLE_PERSONA','GENERATE',
      'VALIDATE','VOICE','QUALITY_GATE','STANCE_CHECK','CONDITION','APPROVAL_GATE',
      'DELAY','EXECUTE_ACTION','MEMORY_WRITE','PERSIST','END'
    ));
