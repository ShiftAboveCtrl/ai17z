# Models

## One interface

```ts
interface ProviderAdapter {
  kind: ProviderKind;
  defaultBaseUrl: string;
  requiresApiKey: boolean;
  generate(request): Promise<ProviderResponse>;
  health(request): Promise<ProviderHealth>;
}
```

Agents are configured with a provider credential plus a model name. Nothing above
this layer knows which vendor answered.

| Provider | Notes |
| --- | --- |
| `openai` | Chat completions. |
| `openrouter` | Chat completions, same shape. |
| `openai_compatible` | Any endpoint speaking that shape. Base URL required. |
| `anthropic` | `/v1/messages`, with the system prompt split out. |
| `ollama` | `/api/chat`. No key. Being offline never fails the platform. |
| `mock` | Deterministic, local, free. |

## The mock provider

Behaviour is steered by the model name, which makes failure paths testable
without a network:

| Model | Behaviour |
| --- | --- |
| `mock-echo` | A short reply derived from the incoming message |
| `mock-fixed:TEXT` | Always returns `TEXT` |
| `mock-fail` | Fails retryably |
| `mock-fail-permanent` | Fails permanently |
| `mock-empty` | Returns whitespace, exercising the empty-output path |
| `mock-long` | Returns text past a typical channel limit |

Same input, same output, every time.

## Fallback

An agent may configure `primary`, `fallback_1`, `fallback_2`, and `classifier`.
Generation walks the chain in order:

- Each provider gets two attempts, so one transient blip is absorbed without
  waiting for the job-level backoff.
- A permanent error skips the second attempt and moves to the next role, because
  a missing API key will not fix itself in 50 milliseconds.
- Every attempt writes a `model_calls` row before the request and updates it
  after, so a provider outage costs the job nothing: the attempt is on record and
  the next role or the next retry picks it up.
- `policy.budget.maxModelCallsPerJob` is a hard ceiling across the whole chain.

If the chain is exhausted, the last error is rethrown with its classification,
and the job retries or escalates accordingly.

## Errors

HTTP status decides retryability: 408, 409, 425, 429, and 5xx are retryable;
everything else is permanent. Timeouts and network failures are retryable.

An empty completion is a failure, not a success. The legacy system treated one as
a reason to silently mark the mention processed and drop it; here it is a
retryable error with the finish reason recorded.

## Cost

`model_calls` stores prompt and completion tokens for every provider that reports
them. Estimated cost is only computed when the operator has configured real rates
on the model config (`costPer1kPromptUsd`, `costPer1kCompletionUsd`). Guessing a
price per model would be worse than showing nothing, so an unconfigured model
reports no cost rather than a fabricated one.

`policy.budget.maxCostUsdPerDay` is enforced before generation, and only has
effect where rates are configured.

## Secrets

Keys are sealed with AES-256-GCM under `XBAM_MASTER_KEY` and readable only
through `providers.getDecryptedApiKey`, which is called by the gateway and the
connection tester. The public column list in the providers repository does not
include `sealed_api_key`, so a key cannot reach an API response by accident.

The UI shows an 8-character fingerprint, which is enough to tell two keys apart
and not enough to reconstruct either.
