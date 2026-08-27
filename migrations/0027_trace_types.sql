-- Trace types for the social intelligence stages.
--
-- Third time this pattern has bitten: an enum grows in the contract, the code
-- writes the new value, and the CHECK constraint still lists the old set. The
-- write fails at the database and nothing catches it until the feature is used.
-- tests/integration/statusConstraints.test.ts now covers this one too.

ALTER TABLE trace_events DROP CONSTRAINT IF EXISTS trace_events_type_check;
ALTER TABLE trace_events
  ADD CONSTRAINT trace_events_type_check
    CHECK (type IN (
      'JOB_CREATED','JOB_CLAIMED','CONTEXT_RESOLVED','MEMORY_SELECTED','PROMPT_ASSEMBLED',
      'MODEL_REQUEST_STARTED','MODEL_REQUEST_COMPLETED','MODEL_REQUEST_FAILED',
      'VALIDATION_PASSED','VALIDATION_FAILED','APPROVAL_REQUESTED','APPROVAL_DECIDED',
      'ACTION_STARTED','TARGET_VERIFIED','TARGET_VERIFICATION_FAILED','ACTION_COMPLETED',
      'ACTION_FAILED','ACTION_SKIPPED_DUPLICATE','DRY_RUN_STOPPED','MEMORY_WRITTEN',
      'JOB_RETRY_SCHEDULED','JOB_FAILED_PERMANENT','JOB_RECOVERED','JOB_CANCELLED',
      'DIAGNOSTIC_CAPTURED',
      'MEDIA_RESOLVED','RELATIONSHIP_LOADED','STANCE_SELECTED','STANCE_CONFLICT',
      'STANCE_REVISED','ENGAGEMENT_DECIDED','INTENT_SELECTED','VOICE_COMPILED',
      'QUALITY_SCORED','REPETITION_DETECTED'
    ));
