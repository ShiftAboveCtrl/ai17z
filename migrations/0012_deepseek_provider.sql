-- AI17Z 0012: DeepSeek as a first-class provider.
--
-- DeepSeek speaks the OpenAI chat-completions shape, but making the owner
-- configure it as an unnamed "generic endpoint" means they supply the base URL
-- from memory and get no sensible model defaults. It is named here instead.

ALTER TABLE provider_credentials
  DROP CONSTRAINT provider_credentials_provider_check;

ALTER TABLE provider_credentials
  ADD CONSTRAINT provider_credentials_provider_check
    CHECK (provider IN ('openai', 'anthropic', 'openrouter', 'deepseek', 'ollama', 'openai_compatible', 'mock'));
