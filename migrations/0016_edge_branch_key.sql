-- AI17Z 0016: a node may have several outgoing edges, one per outcome.
--
-- The original unique key was (version, from, to), which is the wrong shape once
-- edges carry a branch: a condition node routing true and false to the same
-- downstream node is legitimate, and two edges on the same branch is the error.

ALTER TABLE pipeline_edges
  DROP CONSTRAINT pipeline_edges_pipeline_version_id_from_key_to_key_key;

ALTER TABLE pipeline_edges
  ADD CONSTRAINT pipeline_edges_branch_key
    UNIQUE (pipeline_version_id, from_key, branch);
