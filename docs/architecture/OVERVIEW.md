# Architecture overview

## The shape of it

```
CHANNEL EVENT
      |
      v
EVENT INGEST            immutable row, unique on (channel, account, remote id)
      |
      v
DURABLE JOB             one per event per action per agent
      |
      v
CONTEXT RESOLUTION      the adapter identifies the exact remote target
      |
      v
MEMORY RETRIEVAL        each scope queried under its own limit, with reasons
      |
      v
PERSONA + POLICY        pinned to the versions the job was admitted under
      |
      v
MODEL EXECUTION         fallback chain, every attempt persisted
      |
      v
OUTPUT VALIDATION       repairs recorded, failures escalated
      |
      v
APPROVAL GATE           autonomous, review-before-action, or manual only
      |
      v
ACTION EXECUTION        claimed exactly once
      |
      v
TARGET VERIFICATION     verified again immediately before acting
      |
      v
RESULT + MEMORY + TRACE
```

## Processes

**api** serves the HTTP layer. It reads and writes the database and owns no
browsers and no jobs.

**worker** claims jobs, polls channels that must be polled, and executes browser
tasks. It is the only process that opens a browser.

**web** is a static bundle. In Docker, nginx serves it and proxies `/api` to the
API so the browser sees one origin.

**postgres** holds everything: configuration, queue, memory, and trace. There is
no second datastore, no broker, and no cache tier. That is a deliberate ceiling
on operational cost, not an oversight.

## Packages

| Package | Responsibility |
| --- | --- |
| `@xbam/shared` | Contracts (zod), errors, crypto, logger, env. The contracts subpath is isomorphic and is the only thing the browser imports. |
| `@xbam/database` | Connection pool, transactions, migrator, one repository per domain. All SQL lives here. |
| `@xbam/jobs` | The queue: claiming with `FOR UPDATE SKIP LOCKED`, leases, recovery, backoff. |
| `@xbam/models` | One `generate()` over five provider adapters plus a deterministic mock. |
| `@xbam/memory` | Six scopes, deterministic retrieval, the write policy, the fact extractor. |
| `@xbam/prompts` | Ten prompt layers rendered from versioned template data. |
| `@xbam/channels` | The `ChannelAdapter` contract, the mock channel, the X adapter. |
| `@xbam/browser` | Playwright sessions (managed profile or attached CDP) and failure screenshots. |
| `@xbam/tools` | Tool contract, registry, and built-in tools. |
| `@xbam/runtime` | Validator, policy gates, ingest, the pipeline state machine, approvals. |

Internal packages export TypeScript source and run under `tsx`. There is no
build artefact to drift from its source — the file you edit is the file that
runs. This is a direct response to the legacy system, where the code that
actually ran was a hand-edited `dist/` file that no longer matched its source.

## What is deliberately absent

No Redis, no message broker, no workflow engine, no agent framework, no vector
database. Each would have to earn its operational cost, and at this scale none
of them do. The queue is a table with a status column and a lease. Semantic
retrieval is a documented extension point, not a dependency.

## Boundaries worth keeping

**Channels are sealed.** Nothing downstream of `packages/channels` knows what X
looks like. Selectors live in one file; the rest of the system sees only
`NormalizedEvent` and `ResolvedContext`.

**One process owns browsers.** A Chromium profile can only be held once, so the
API records intent in `browser_tasks` and the worker carries it out.

**Configuration is versioned data.** Persona, policy, pipeline, and prompt
template are rows, not code, and every job records the versions it ran under.
An edit mid-flight cannot change what a running job was permitted to do.

**Failures are classified, never guessed.** Retryable, permanent, or a human
decides. Nothing is silently dropped.
