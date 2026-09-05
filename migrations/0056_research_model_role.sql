-- The `research` model role.
--
-- Some providers can run a search on their own side during a call and answer
-- with citations, reaching X's own index -- which a logged-out browser cannot
-- search at all. That is a different provider and a different bill from the
-- model that writes the reply, so it is a role rather than a flag on the
-- primary.
--
-- Widened in the same change that introduces it. Four enums here have a CHECK
-- behind them, and growing one without the constraint fails at the database
-- while passing every unit test. It has cost a broken sign-in once already.

ALTER TABLE model_configs DROP CONSTRAINT IF EXISTS model_configs_role_check;
ALTER TABLE model_configs
  ADD CONSTRAINT model_configs_role_check
    CHECK (role IN (
      'primary',
      'fallback_1',
      'fallback_2',
      'classifier',
      'vision',
      'transcription',
      'critic',
      'voice_rewrite',
      'research'
    ));
