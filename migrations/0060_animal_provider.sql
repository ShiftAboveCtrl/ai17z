-- Animal mode, as a provider kind.
--
-- `provider_credentials.provider` has a CHECK behind it, and growing the list
-- in TypeScript without widening the constraint fails at the database and
-- passes every unit test -- the same trap as 0012, 0049 and 0057.
-- `tests/integration/statusConstraints.test.ts` walks PROVIDER_KINDS and writes
-- one credential of every kind, so this stays honest.
--
-- A provider rather than a flag somewhere in the pipeline, because the runtime
-- already knows how to route a role to a provider, fall back, trace and count
-- tokens. Selecting an animal is selecting a model, so cadence, policy, rate
-- limits, capabilities, approvals, the validator and duplicate suppression all
-- still apply to an agent that has nothing to say but "honk".
--
-- It needs no API key, which is why `requiresApiKey` is false on the adapter
-- and why nothing here creates a credential row automatically: an owner still
-- chooses it deliberately, exactly as they choose Ollama.

ALTER TABLE provider_credentials DROP CONSTRAINT IF EXISTS provider_credentials_provider_check;
ALTER TABLE provider_credentials ADD CONSTRAINT provider_credentials_provider_check
  CHECK (provider IN ('openai','anthropic','openrouter','deepseek','xai','google','ollama','openai_compatible','mock','animal'));
