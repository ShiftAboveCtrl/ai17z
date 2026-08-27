-- RELATIONSHIP as a pipeline node kind, and as a prompt layer.
--
-- Both enums have a CHECK constraint behind them, widened here in the same
-- change that introduces the values.

ALTER TABLE pipeline_nodes DROP CONSTRAINT IF EXISTS pipeline_nodes_kind_check;
ALTER TABLE pipeline_nodes
  ADD CONSTRAINT pipeline_nodes_kind_check
    CHECK (kind IN (
      'TRIGGER','FILTER','RESOLVE_CONTEXT','MEDIA_RESOLVE','RELATIONSHIP','RETRIEVE_MEMORY',
      'ASSEMBLE_PERSONA','GENERATE','VALIDATE','CONDITION','APPROVAL_GATE','DELAY',
      'EXECUTE_ACTION','MEMORY_WRITE','PERSIST','END'
    ));
