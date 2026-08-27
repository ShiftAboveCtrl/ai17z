-- MEDIA_RESOLVE as a pipeline node kind.
--
-- Fourth instance of the same pattern, and the last one that will be found by
-- accident: tests/integration/statusConstraints.test.ts now writes every value
-- of every enum that has a CHECK constraint behind it, so the next enum to grow
-- without its constraint fails in the suite rather than in production.

ALTER TABLE pipeline_nodes DROP CONSTRAINT IF EXISTS pipeline_nodes_kind_check;
ALTER TABLE pipeline_nodes
  ADD CONSTRAINT pipeline_nodes_kind_check
    CHECK (kind IN (
      'TRIGGER','FILTER','RESOLVE_CONTEXT','MEDIA_RESOLVE','RETRIEVE_MEMORY','ASSEMBLE_PERSONA',
      'GENERATE','VALIDATE','CONDITION','APPROVAL_GATE','DELAY','EXECUTE_ACTION',
      'MEMORY_WRITE','PERSIST','END'
    ));
