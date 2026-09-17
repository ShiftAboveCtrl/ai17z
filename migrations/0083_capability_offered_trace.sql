-- What the model was shown, as distinct from what it used.
--
-- "The agent did not look it up" has two causes with one symptom: the
-- capability was never offered, or it was offered and the model did not take
-- it. The first is a shortlisting problem and the second is a prompt problem,
-- and without this row an owner cannot tell them apart. Measured while adding
-- capability shortlisting: asked what a repository shipped, an agent answered
-- "I couldn't check" while `github.read_activity` was on its menu, and there
-- was no way to see that from the outside.
--
-- Trace types have a CHECK behind them, so growing the enum without widening
-- this passes every unit test and fails at the database the first time it is
-- written. `tests/integration/statusConstraints.test.ts` writes every value of
-- every constrained enum for exactly this reason.
ALTER TABLE trace_events DROP CONSTRAINT IF EXISTS trace_events_type_check;
ALTER TABLE trace_events
  ADD CONSTRAINT trace_events_type_check
    CHECK (type IN ('JOB_CREATED', 'JOB_CLAIMED', 'CONTEXT_RESOLVED', 'MEMORY_SELECTED', 'PROMPT_ASSEMBLED', 'MODEL_REQUEST_STARTED', 'MODEL_REQUEST_COMPLETED', 'MODEL_REQUEST_FAILED', 'VALIDATION_PASSED', 'VALIDATION_FAILED', 'APPROVAL_REQUESTED', 'APPROVAL_DECIDED', 'ACTION_STARTED', 'TARGET_VERIFIED', 'TARGET_VERIFICATION_FAILED', 'ACTION_COMPLETED', 'ACTION_FAILED', 'ACTION_SKIPPED_DUPLICATE', 'DRY_RUN_STOPPED', 'MEMORY_WRITTEN', 'JOB_RETRY_SCHEDULED', 'JOB_FAILED_PERMANENT', 'JOB_RECOVERED', 'JOB_CANCELLED', 'DIAGNOSTIC_CAPTURED', 'MEDIA_RESOLVED', 'RELATIONSHIP_LOADED', 'STANCE_SELECTED', 'STANCE_CONFLICT', 'STANCE_REVISED', 'ENGAGEMENT_DECIDED', 'INTENT_SELECTED', 'VOICE_COMPILED', 'QUALITY_SCORED', 'REPETITION_DETECTED', 'RESEARCH_DONE', 'ACTION_BLOCKED', 'CAPABILITY_USED', 'CAPABILITY_OFFERED'));
