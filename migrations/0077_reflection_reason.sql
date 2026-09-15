-- ---------------------------------------------------------------------------
-- Why reflection did not run
-- ---------------------------------------------------------------------------
--
-- `reflect` already worked out the reason -- no classifier configured, a
-- timeout, an answer in the wrong shape, an exception -- and returned it as
-- `why`. The wake then threw it away, and the only trace was a `log.debug`,
-- which is below the default level. So a reflection that failed and one that
-- correctly found nothing were the same two zeros on the screen.
--
-- That is the shape of defect this codebase has already paid for twice: a
-- failure turned into silence that reads exactly like a correct quiet result.
-- The X reader spent an entire release in that state.
--
-- Nullable rather than defaulted: a row from before this existed genuinely
-- does not know, and '' would claim it did.
ALTER TABLE agent_reflections ADD COLUMN why text;

COMMENT ON COLUMN agent_reflections.why IS
  'Why reflection produced nothing, when the reason was not simply that there was nothing to say. Never raw model reasoning.';
