-- AI17Z 0049: xAI as a first-class provider.
--
-- Verified against the official documentation at docs.x.ai before writing this:
-- the inference API is POST /v1/chat/completions at https://api.x.ai/v1, taking
-- a Bearer key, with the OpenAI request and response shape -- messages, model,
-- choices, usage -- so the existing OpenAI-compatible adapter drives it without
-- a new one.
--
-- Named rather than left as the generic endpoint for the same reason DeepSeek
-- was in 0012: an owner configuring an unnamed endpoint has to supply the base
-- URL from memory and gets no sensible default model.
--
-- SuperGrok is not this. It is a consumer subscription to the Grok apps, and
-- the documented route to the API is an API key created in the xAI console
-- against purchased credits. Nothing in the official documentation says a
-- SuperGrok subscription grants API access, so AI17Z does not imply that it
-- does and does not offer a way to sign in with one.

ALTER TABLE provider_credentials
  DROP CONSTRAINT provider_credentials_provider_check;

ALTER TABLE provider_credentials
  ADD CONSTRAINT provider_credentials_provider_check
    CHECK (provider IN ('openai', 'anthropic', 'openrouter', 'deepseek', 'xai', 'ollama', 'openai_compatible', 'mock'));
