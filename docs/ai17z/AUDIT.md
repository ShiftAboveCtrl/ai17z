# AI17Z audit of the XBAM baseline

Assessed against the AI17Z specification at commit `1152cf0`
(`release-candidate` = `aea27d5`, plus the Playwright runtime fix).

## Already implemented and working

| Capability | Evidence |
| --- | --- |
| Durable job pipeline, leases, recovery | `packages/jobs`, integration tests |
| Three-layer idempotency by unique index | `migrations/0005`, `0006`, tests |
| Six memory scopes, retrieval with reasons | `packages/memory` |
| Ten-layer versioned prompt engine | `packages/prompts` |
| Persona/policy/pipeline/template pinned per job | `jobs.*_version_id` |
| Encrypted provider secrets, never returned | `providers.getDecryptedApiKey` |
| Structured trace per job | `trace_events` |
| Mock channel, end-to-end | `packages/channels/src/mock` |
| X adapter logic: canonical IDs, exact-target anchoring, read-back | `packages/channels/src/x` |
| Browser session manager, managed + CDP, screenshots | `packages/browser` |
| Playwright version alignment | pinned 1.62.1 in all three places, guarded by test |
| Browser channel selection (real Chrome / Edge / Chromium) | `browser_sessions.channel` |

## Implemented but inaccessible from the UI

| Capability | Gap |
| --- | --- |
| `classifier` model role | Stored and selectable, never called by the runtime |
| Replay | No UI entry point |
| Pipeline versions | Stored and rendered, but not interpreted |
| Cost ceilings | Enforced only when per-model rates are configured |

## Partially implemented

| Capability | State |
| --- | --- |
| Providers | OpenAI / OpenRouter / OpenAI-compatible / Anthropic / Ollama / mock. **DeepSeek absent.** No retry count, no reasoning effort, no per-call ceiling |
| Autonomy modes | 3 of 5: `AUTONOMOUS`, `REVIEW_BEFORE_ACTION`, `MANUAL_ONLY`. **`OFF` and `MONITOR_ONLY` absent** |
| Account states | 5 of 11: no `STARTING_BROWSER`, `BROWSER_READY`, `AWAITING_LOGIN`, `AUTHENTICATING`, `CHALLENGE_REQUIRES_USER`, `SESSION_EXPIRED`, `TIMEOUT` |
| Timeouts | Present but mostly hard-coded constants, not configuration |
| Async UX | Browser tasks poll to completion; no elapsed time, no cancel |

## Broken for the stated goal

| Problem | Cause |
| --- | --- |
| "Real Chrome" does not use Windows Chrome | The worker runs in a Linux container. `channel: 'chrome'` resolves inside the container, where no Chrome exists |
| Interactive login incomplete | `OPEN_AUTH` opens a window only where the worker runs, i.e. headless in Docker |
| No login detection loop | Nothing watches for the sign-in to complete |

## Missing entirely

- **Browser Host** — no native process owning local browsers (`apps/` has api, web, worker only)
- **PersonaSource / twscrape** — no corpus ingestion, scoring, or trait derivation
- **Cadence engine** — polling is a single env var, not per-account versioned config
- **Executable pipeline DAG** — `pipeline.ts` dispatches a fixed `STEPS` map; stored edges are never read
- **Granular capabilities** — one `action_type` per agent-account link, no per-capability grants
- **Account-level action serialization** — no mutex; two jobs on one account can race the same profile

## Implementation order

Follows the specification's own sequence, highest user value first within it.
