# CLAUDE.md

Guidance for Claude Code working in this repository.

## The rename: XBAM became AI17Z

Product name, UI, and documentation say AI17Z. These deliberately still say XBAM,
because they carry data or wiring and renaming them would break a working install:

| Kept | Why |
| --- | --- |
| `@xbam/*` package names | Internal only; renaming touches every import for no user benefit |
| Postgres database `xbam`, volumes `xbam_*`, compose project | Renaming means migrating or losing data |
| `XBAM_*` environment variables | Still read, in both directions, see below |
| `VITE_XBAM_API_URL` | Build-time wiring |

`applyBrandCompatibility()` in `packages/shared/src/env.ts` mirrors every
`XBAM_*` variable to `AI17Z_*` and back, explicit values always winning. The
master key resolves `AI17Z_MASTER_KEY` first and falls back to
`XBAM_MASTER_KEY`, so secrets sealed before the rename stay readable.
`tests/unit/brandCompat.test.ts` proves it. Never break that fallback.

## What AI17Z is

A local-first platform for running autonomous agents. An agent is an identity, a
memory, a model, a policy, and a set of channels it can act on. The runtime is
generic: X, OpenRouter, a persona, and a reply are all configuration.

AI17Z descends from a working system called AI4CZ, which lives at
`C:\Users\ta0as\OneDrive\Desktop\ai4cz`. AI17Z kept its ideas and replaced its
architecture.

## Hard boundary: the legacy directory

`../ai4cz` is **immutable evidence**. Read it. Never write to it, install into
it, format it, rebuild it, migrate it in place, or copy secrets out of it.
`tools/import-ai4cz` opens its SQLite database read-only and touches nothing
else. If you change the importer, re-verify with a file listing diff before and
after a run.

## Commands

```bash
npm run db:up              # Postgres in Docker on port 55432
npm run migrate            # apply pending migrations
npm run migrate:status     # show applied / pending / drifted
npm run dev                # api + worker + web together
npm run dev:api            # http://localhost:8787
npm run dev:worker         # job worker, channel poller, browser tasks
npm run dev:web            # http://localhost:5173
npm run typecheck          # tsc over every package and app
npm test                   # vitest: unit + integration (needs Postgres)
npm run import:ai4cz -- --dry-run
```

Integration tests use a sibling `xbam_test` database, created automatically from
`DATABASE_URL`. They truncate between cases, so never point `DATABASE_URL` at
data you care about.

## Architecture

```
apps/api      Fastify HTTP layer. Owns no browsers.
apps/worker   Job worker, channel poller, browser task runner. Owns all browsers.
apps/web      React SPA.

packages/shared      Isomorphic zod contracts + node-side crypto/logger/env.
packages/database    pg pool, migrator, one repository per domain.
packages/jobs        Postgres queue: claim, lease, recover, back off.
packages/models      Model gateway + provider adapters.
packages/memory      Six memory scopes, retrieval, write policy.
packages/prompts     Ten-layer prompt engine.
packages/channels    ChannelAdapter contract, mock channel, X adapter.
packages/browser     Playwright session manager, failure screenshots.
packages/tools       Tool contract and built-in tools.
packages/runtime     Validator, policy gates, ingest, pipeline state machine.
```

Internal packages export TypeScript source directly and run under `tsx`. There
is no build step for them. `apps/web` is the only thing that bundles.

### The rule that keeps this clean

Nothing downstream of a channel adapter may know what X looks like. No selector,
no cookie, no vendor payload leaves `packages/channels`. Memory, prompts, policy,
and job state operate only on the normalised shapes in
`packages/shared/src/contracts`.

## Job state

Jobs advance through settled states, each committed before the next step starts:

```
RECEIVED -> CONTEXT_RESOLVED -> MEMORY_RESOLVED -> GENERATED -> VALIDATED
         -> EXECUTED | DRY_RUN_COMPLETED
```

`*_ING` states are held under a worker lease. If the lease expires, the recovery
sweep returns the job to the settled state before that step (`IN_FLIGHT_RESUME`
in `contracts/enums.ts`). This is why a restart resumes rather than restarts.

Failures are classified, never guessed:

- `PipelineError.retryable` schedules a jittered backoff and keeps the job
- `PipelineError.permanent` stops the job with a reason
- `PipelineError.review` sends it to a person

Anything that escapes classification is treated as retryable and logged.

## Idempotency

Three layers, all enforced by unique indexes rather than by application logic:

1. `events (channel, account, remote_event_id)` — an event is recorded once
2. `jobs.idempotency_key` — one job per event per action per agent
3. `actions.idempotency_key` (partial, real actions only) — one remote action

Plus `actions.content_signature` to suppress identical text to the same target,
and `legacy_action_ledger` for signatures inherited from AI4CZ, which used sha1.

When you touch execution, ask: can this send the same message twice?

## Database rules

- Schema changes go in a new numbered file in `migrations/`. Never edit an
  applied migration; the migrator reports drift and refuses to re-run it.
- Multi-table writes go through `withTransaction`.
- Foreign keys and unique constraints are the contract. Do not work around them
  in application code.
- Trace events reference `jobs`, and trace writes use their own connection, so
  never emit a trace for a row that is still inside an open transaction.

## Browsers

Only the worker opens a browser. A Chromium profile can be held by one process
at a time, so the API records intent in `browser_tasks` and the worker executes
it. If you add a session action, add it there, not to the API.

Playwright is pinned exactly, in three places that must move together:
`packages/browser/package.json`, `docker/worker.Dockerfile`, and the root
`@playwright/test`. The image ships binaries for one release only, so a caret
range means the container fails on first launch with a missing-file error that
never mentions versions. `tests/unit/playwrightVersion.test.ts` enforces it.

A containerised worker cannot drive a browser on the host. For real sessions, run
the worker on the machine that has the browser. See
`docs/operations/BROWSER_SESSIONS.md`.

## Secrets

Provider API keys are sealed with AES-256-GCM under `AI17Z_MASTER_KEY` and are
readable only through `providers.getDecryptedApiKey`. They must never appear in
an API response, a log line, an audit row, or a trace. `redact()` in
`packages/shared/src/logger.ts` blanks anything key-shaped.

## Identity policy

The platform default is that an agent may not claim to be human. AI4CZ hard-coded
the opposite into its prompt; AI17Z makes it an explicit, versioned policy field
(`identity.mayDenyBeingAI`, default false) that the validator enforces. Do not
add a code path that bypasses it.

## Conventions

- `verbatimModuleSyntax` is on: use `import type` for type-only imports.
- Errors carry a class and a human sentence. `500 Internal Server Error` is not
  an acceptable thing for a user to read.
- Comments explain why, not what. If a constant was chosen for a reason, say the
  reason.
- No `any`, no empty `catch {}` without a comment explaining the deliberate
  swallow, no `console.log` outside the logger.

## Testing

- Unit tests for pure logic: validators, normalisers, extractors, prompt render.
- Integration tests run against real Postgres, because unique indexes carry the
  guarantees and a mock would test the wrong thing.
- New runtime behaviour needs a test that would fail without it.
