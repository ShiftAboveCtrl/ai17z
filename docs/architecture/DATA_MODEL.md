# Data model

One PostgreSQL database holds everything: configuration, queue, memory, and
trace. Migrations live in `migrations/` and are applied in filename order, each
in its own transaction.

## Identity

| Table | Notes |
| --- | --- |
| `users` | The local owner. Password stored as a scrypt hash. |
| `sessions` | Opaque server-side tokens, so a session can be revoked immediately. |
| `app_settings` | Key/value application state. |
| `audit_events` | Who changed what. Never records secret values. |

## Agents and their versioned documents

| Table | Notes |
| --- | --- |
| `agents` | The central object. Points at the currently active persona, policy, and pipeline versions. |
| `personas` / `persona_versions` | Every persona edit creates a version. Nothing is overwritten. |
| `policies` / `policy_versions` | Policy is a validated JSONB document; the zod schema in `contracts/policy.ts` is its shape. |
| `pipelines` / `pipeline_versions` / `pipeline_nodes` / `pipeline_edges` | The pipeline as a graph. Immutable per version. |

Versioning is not bookkeeping. Each job records the persona, policy, pipeline,
and prompt template version it was admitted under, so editing a persona while a
job is in flight cannot change what that job is permitted to do.

## Accounts and providers

| Table | Notes |
| --- | --- |
| `accounts` | External accounts, owned by the user and independent of any agent. |
| `agent_accounts` | Which agents act on which accounts, and on which event types. |
| `browser_sessions` | Session mode (managed profile or attached CDP), status, last check. Never stores cookies. |
| `browser_tasks` | Browser intents recorded by the API and executed by the worker. At most one active per account. |
| `provider_credentials` | API keys sealed with AES-256-GCM. `sealed_api_key` is never selected by the public column list. |
| `model_configs` | Per agent, per role (primary, fallback_1, fallback_2, classifier). |

Accounts are separate from agents on purpose: an account can move between
agents, and one agent can drive several.

## The runtime

| Table | Notes |
| --- | --- |
| `events` | Immutable record of something that happened. Unique on `(channel, account, remote_event_id)`. |
| `jobs` | The unit of work. Unique on `idempotency_key`. |
| `job_attempts` | Every attempt of every step, with its outcome. |
| `conversations` / `messages` | Normalised conversation history, independent of channel. |
| `approvals` | One pending decision per job. |
| `actions` | Outbound actions. Unique `idempotency_key` for real actions; unique `content_signature` for executed ones. |
| `action_attempts` | Per-attempt record, optionally linked to a diagnostic. |
| `model_calls` | One row per provider attempt, written before and after the call. Stores prompt layers and raw output. |
| `trace_events` | The narrative, keyed by job. |

## Memory

| Table | Notes |
| --- | --- |
| `memories` | Six scopes. Unique on `(agent_id, scope, scope_key, content_hash)`. GIN full-text index on content. |
| `memory_retrievals` | Which memories a specific job used, their rank, and the reason each was chosen. |

`memory_retrievals` is what makes the trace able to answer "why did it remember
this?" — the justification is recorded at the moment of the decision, not
reconstructed afterwards.

## Prompts, tools, artifacts

| Table | Notes |
| --- | --- |
| `prompt_templates` / `prompt_template_versions` | Ten ordered layers as data. Seeded from code, then editable. |
| `tools` / `agent_tools` | The catalogue and the per-agent enablement. |
| `artifacts` | Screenshots and uploads. Stores a path relative to the storage directory, never an absolute host path. |
| `diagnostics` | A failure with its URL, target, message, and screenshot. |
| `import_runs` / `import_fingerprints` | Migration bookkeeping, so an import can be repeated safely. |
| `legacy_action_ledger` | Actions performed by a previous system, in that system's own signature format. |

## Conventions

- `timestamptz` everywhere; the application deals in ISO strings.
- Enum-like columns use `text` with a `CHECK`, which is far easier to evolve than
  a Postgres enum.
- Deletion is explicit: cascade where a child is meaningless without its parent
  (an agent's memories), `SET NULL` where the record should outlive the
  reference (an audit row whose actor was removed).
- Unique indexes carry the guarantees. Application code does not re-implement
  them, and must not work around them.
