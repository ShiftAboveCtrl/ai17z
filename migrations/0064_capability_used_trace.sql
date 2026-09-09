-- The model choosing a capability is a new kind of trace, and trace types have
-- a CHECK behind them: growing the enum without widening this passes every unit
-- test and fails at the database the first time it is written.
--
-- Distinct from RESEARCH_DONE, which is the runtime deciding to look something
-- up before the prompt is assembled. This one is the model asking, mid-answer,
-- and it is traced for the same reason every other decision is -- an owner has
-- to be able to see what their agent asked for and what it was told.
ALTER TABLE trace_events DROP CONSTRAINT IF EXISTS trace_events_type_check;
ALTER TABLE trace_events
  ADD CONSTRAINT trace_events_type_check
    CHECK (type IN ('JOB_CREATED', 'JOB_CLAIMED', 'CONTEXT_RESOLVED', 'MEMORY_SELECTED', 'PROMPT_ASSEMBLED', 'MODEL_REQUEST_STARTED', 'MODEL_REQUEST_COMPLETED', 'MODEL_REQUEST_FAILED', 'VALIDATION_PASSED', 'VALIDATION_FAILED', 'APPROVAL_REQUESTED', 'APPROVAL_DECIDED', 'ACTION_STARTED', 'TARGET_VERIFIED', 'TARGET_VERIFICATION_FAILED', 'ACTION_COMPLETED', 'ACTION_FAILED', 'ACTION_SKIPPED_DUPLICATE', 'DRY_RUN_STOPPED', 'MEMORY_WRITTEN', 'JOB_RETRY_SCHEDULED', 'JOB_FAILED_PERMANENT', 'JOB_RECOVERED', 'JOB_CANCELLED', 'DIAGNOSTIC_CAPTURED', 'MEDIA_RESOLVED', 'RELATIONSHIP_LOADED', 'STANCE_SELECTED', 'STANCE_CONFLICT', 'STANCE_REVISED', 'ENGAGEMENT_DECIDED', 'INTENT_SELECTED', 'VOICE_COMPILED', 'QUALITY_SCORED', 'REPETITION_DETECTED', 'RESEARCH_DONE', 'ACTION_BLOCKED', 'CAPABILITY_USED'));
