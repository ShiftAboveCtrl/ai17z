-- ENGAGEMENT_DECISION and INTENT node kinds, and the branches they need.
--
-- Silence has to be somewhere the graph actually goes. A decision not to reply
-- that is expressed as a thrown error is a failure, and this is not one.

ALTER TABLE pipeline_nodes DROP CONSTRAINT IF EXISTS pipeline_nodes_kind_check;
ALTER TABLE pipeline_nodes
  ADD CONSTRAINT pipeline_nodes_kind_check
    CHECK (kind IN (
      'TRIGGER','FILTER','RESOLVE_CONTEXT','MEDIA_RESOLVE','RELATIONSHIP','STANCE',
      'ENGAGEMENT_DECISION','INTENT','RETRIEVE_MEMORY','ASSEMBLE_PERSONA','GENERATE',
      'VALIDATE','STANCE_CHECK','CONDITION','APPROVAL_GATE','DELAY','EXECUTE_ACTION',
      'MEMORY_WRITE','PERSIST','END'
    ));
