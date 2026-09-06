-- AI17Z 0057: Google Gemini as a first-class provider.
--
-- Google publishes an OpenAI-compatible endpoint at
-- https://generativelanguage.googleapis.com/v1beta/openai/ which takes the same
-- Bearer key, the same chat-completions request shape, and answers GET /models
-- with the same list shape. So the existing OpenAI-compatible adapter drives it
-- without a new one, exactly as DeepSeek in 0012 and xAI in 0049.
--
-- Named rather than left to the generic endpoint for the same reason as those
-- two: somebody configuring an unnamed endpoint has to supply the base URL from
-- memory, gets no default model, and cannot be told which key format to paste.
--
-- The native Gemini API at /v1beta/models/*:generateContent is a different
-- shape. It is not used here, and nothing in AI17Z depends on it -- if a
-- capability ever needs it, that is a new adapter rather than a change to this
-- constraint.

ALTER TABLE provider_credentials
  DROP CONSTRAINT provider_credentials_provider_check;

ALTER TABLE provider_credentials
  ADD CONSTRAINT provider_credentials_provider_check
    CHECK (provider IN ('openai', 'anthropic', 'openrouter', 'deepseek', 'xai', 'google', 'ollama', 'openai_compatible', 'mock'));
