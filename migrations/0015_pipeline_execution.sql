-- AI17Z 0015: the pipeline graph becomes the thing that actually runs.
--
-- Until now the executor dispatched from a fixed map keyed by job status, and
-- the stored graph was a drawing of it. A job now records which node it is on,
-- so the edges in the database are the edges the runtime follows.

ALTER TABLE jobs
  ADD COLUMN current_node_key text;

COMMENT ON COLUMN jobs.current_node_key IS
  'Node the job is about to run. Null means start at the trigger.';

-- Conditions pick an outgoing edge by name, so an edge needs a stable label
-- rather than a free-text note.
ALTER TABLE pipeline_edges
  ADD COLUMN branch text NOT NULL DEFAULT 'next';

COMMENT ON COLUMN pipeline_edges.branch IS
  'Which outcome of the source node this edge represents: next, true, false, approved, rejected.';

-- A node kind set wide enough to express the pipelines the product promises.
ALTER TABLE pipeline_nodes
  DROP CONSTRAINT pipeline_nodes_kind_check;

ALTER TABLE pipeline_nodes
  ADD CONSTRAINT pipeline_nodes_kind_check
    CHECK (kind IN (
      'TRIGGER','FILTER','RESOLVE_CONTEXT','RETRIEVE_MEMORY','ASSEMBLE_PERSONA','GENERATE',
      'VALIDATE','CONDITION','APPROVAL_GATE','DELAY','EXECUTE_ACTION','MEMORY_WRITE','PERSIST','END'));
