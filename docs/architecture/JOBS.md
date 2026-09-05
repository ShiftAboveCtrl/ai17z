# Jobs and the runtime

## Why a job table

The legacy system passed work between processes as mutable JSON files in the
project root. It worked, but nothing could be recovered, retried, inspected, or
run twice safely. AI17Z makes work a row.

A job is durable, has an explicit lifecycle, records every attempt, and is safe
to process more than once.

## Lifecycle

Settled states, each committed before the next step begins:

```
RECEIVED
  -> CONTEXT_RESOLVED
  -> MEMORY_RESOLVED
  -> GENERATED
  -> VALIDATED
  -> EXECUTED | DRY_RUN_COMPLETED
```

Held states, which need something outside the runtime:

```
WAITING_FOR_APPROVAL   a person must approve, edit, or reject
REVIEW_REQUIRED        validation failed, or retries ran out
PERMANENT_FAILURE      it cannot succeed; retrying would not help
CANCELLED              a person rejected it
```

In-flight states (`CONTEXT_RESOLVING`, `MEMORY_RETRIEVING`, `GENERATING`,
`VALIDATING`, `EXECUTING`) exist only while a worker holds the lease.

## Claiming

```sql
UPDATE jobs SET locked_by = $1, lock_expires_at = now() + ...
 WHERE id IN (
   SELECT id FROM jobs
    WHERE status = ANY($3) AND run_at <= now()
      AND (locked_by IS NULL OR lock_expires_at < now())
    ORDER BY priority, run_at
    FOR UPDATE SKIP LOCKED
    LIMIT $4
 )
```

`SKIP LOCKED` is what lets several workers run concurrently without ever handing
the same job to two of them. There is no coordination beyond this statement.

## Recovery

A worker renews its lease while it works. If it dies, the lease expires and the
recovery sweep returns the job to the settled state before the step it was in:

```
CONTEXT_RESOLVING  -> RECEIVED
MEMORY_RETRIEVING  -> CONTEXT_RESOLVED
GENERATING         -> MEMORY_RESOLVED
VALIDATING         -> GENERATED
EXECUTING          -> VALIDATED
```

The sweep runs at worker start and periodically thereafter. This is why
`docker compose restart` costs nothing: work resumes, it does not restart, and
it is never lost.

A job recovered from `EXECUTING` is the interesting case. It re-enters the
execute step, where the action idempotency claim tells it the action already
happened, and it completes without sending anything.

## Failure classification

Every failure path either throws a classified error or is wrapped by the step
runner with a documented default.

| Class | Meaning | What happens |
| --- | --- | --- |
| `RETRYABLE` | Transient: timeout, network, rate limit, DOM not rendered yet | Jittered exponential backoff, up to `policy.safety.maxAttempts`, then escalated to review |
| `PERMANENT` | Cannot improve: source deleted, blocked handle, malformed config | Job stops with a reason |
| `REVIEW_REQUIRED` | Needs judgement: target unverifiable, validation failed, output rejected | A person decides |

Nothing is deleted because it failed. The legacy poster dropped a reply whenever
the page failed to render once; here that is a retry with a screenshot attached.

## Idempotency

Three independent layers, all enforced by the schema:

1. **Ingest.** `events` is unique on `(channel, account, remote_event_id)`.
   Re-ingesting an event returns the original row and creates nothing.
2. **Job.** `jobs.idempotency_key` is `channel|account|remote_event|action|agent`.
   One job, forever.
3. **Action.** `actions.idempotency_key` is unique for real actions (dry runs
   are exempt, since they may repeat freely). Claiming is the insert; a second
   claimant sees `ALREADY_EXECUTED` and stops.

Two more layers guard content rather than identity:

- `actions.content_signature` stops the same text reaching the same target
  twice, even from a different event.
- `legacy_action_ledger` gives the same guarantee for replies the previous
  system sent, using its sha1 signature format.

## Attempts and trace

`job_attempts` records every step of every attempt with its outcome.
`trace_events` records the narrative: what was resolved, what was retrieved, what
the model was asked, what it said, what was verified, what was sent. Both are
keyed by job id, which is what makes the trace view a complete answer rather
than a summary.

## Running the pipeline

`runJob` advances a claimed job as far as it will go, up to eight steps per
claim, committing each settled state. It stops at any held state. The worker
loop then releases the lease and moves on.

Steps live in `packages/runtime/src/steps.ts`. Each reads the job bundle, does
one thing, and settles the status. A step that returns without settling is
treated as an internal error and sent to review rather than allowed to spin.
