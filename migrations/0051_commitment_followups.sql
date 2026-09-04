-- Making a promise something that actually gets kept.
--
-- Commitments were detected and recorded and then nothing ever looked at them
-- again: no due date was set, so `commitments_open_idx` indexed a column that
-- was always null, and an agent that said "I'll check this later" produced a
-- row nobody read. That is worse than not detecting it at all, because the row
-- looks like tracking.
--
-- The follow-up runs as an ordinary job. A commitment coming due manufactures a
-- SCHEDULED_TRIGGER event carrying its brief, exactly as an original post does,
-- so it goes through the same ten pipeline steps -- persona, memory, voice,
-- policy, cadence, execution -- and needs no second scheduler, no second
-- idempotency scheme and no second set of guarantees to keep in step.

ALTER TABLE commitments
  -- The thread it was promised in, so the follow-up lands in the conversation
  -- rather than as a message out of nowhere.
  ADD COLUMN conversation_id uuid REFERENCES conversations (id) ON DELETE SET NULL,
  -- What was being answered when the promise was made.
  ADD COLUMN source_event_id uuid REFERENCES events (id) ON DELETE SET NULL,
  -- The job that carried out the follow-up, distinct from job_id, which is the
  -- job that made the promise.
  ADD COLUMN followup_job_id uuid REFERENCES jobs (id) ON DELETE SET NULL,
  -- How many times following up has been attempted. The guard against a
  -- promise that quietly retries for ever, which is the failure mode a
  -- reminder system has.
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  -- What happened in the end, in words, for the owner.
  ADD COLUMN outcome text NOT NULL DEFAULT '';

-- OPEN | DUE | COMPLETED | CANCELLED | FAILED
--
-- DONE and DROPPED were the old words for two of these. Renamed rather than
-- kept alongside: two vocabularies for one column is how a status check ends up
-- missing half the rows.
UPDATE commitments SET status = 'COMPLETED' WHERE status = 'DONE';
UPDATE commitments SET status = 'CANCELLED' WHERE status = 'DROPPED';

ALTER TABLE commitments DROP CONSTRAINT commitments_status_check;
ALTER TABLE commitments
  ADD CONSTRAINT commitments_status_check
    CHECK (status IN ('OPEN', 'DUE', 'COMPLETED', 'CANCELLED', 'FAILED'));

-- The claim query: what is ready to be followed up. Partial, because only OPEN
-- rows with a date are ever candidates and that is a small slice of the table.
DROP INDEX IF EXISTS commitments_open_idx;
CREATE INDEX commitments_due_idx ON commitments (due_at)
  WHERE status = 'OPEN' AND due_at IS NOT NULL;
CREATE INDEX commitments_agent_idx ON commitments (agent_id, status, created_at DESC);
