-- Model roles for the multimodal and voice stages.
--
-- Vision, transcription, criticism and voice rewriting are different jobs, and
-- an agent may want a different provider for each: a vision model that can read
-- a chart, a cheap local model for classification, whatever writes best for the
-- voice pass.
--
-- Widened in the same change that introduces them. The last time an enum grew
-- without its CHECK constraint, every write of the new values failed at the
-- database and nothing caught it until somebody used the feature.

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
      'voice_rewrite'
    ));
