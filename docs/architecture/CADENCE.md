# Cadence

**When an account is read from, and when it may act.**

## The problem this replaced

Timing lived in three places that never spoke to each other:

| Where | What it decided | Scope |
| --- | --- | --- |
| `XBAM_POLL_INTERVAL_MS` | how often to poll every account | global |
| `policy.rate.*` | how often an agent could act | per agent |
| `AI17Z_WORKER_POLL_MS` | how often to look for jobs | global |

One number governed every account regardless of how busy it was. A dormant
account and one receiving a mention a minute were checked at the same rate, and
none of it was visible or changeable from the UI.

## The model

Cadence is per **account**, versioned like policy, and stored in the database:

```
cadences (one per account)
  └── cadence_versions (config jsonb, version, change_note, created_by)
accounts.cadence_version_id ──┘
```

An account with no cadence row runs on the defaults. Adding cadence to an
existing install changes nothing until somebody edits it.

### Polling

```ts
{
  enabled: true,
  intervalSeconds: 120,     // base gap while there is activity
  jitterPercent: 20,        // random spread on every gap
  batchLimit: 10,           // events pulled per read
  backoffWhenIdle: true,    // double the gap per empty read
  maxIntervalSeconds: 1800, // ceiling the backoff will not pass
}
```

**Jitter** exists because a fixed heartbeat is both a poor citizen on a remote
service and a distinctive pattern. The goal is to be unremarkable, not hidden.

**Idle backoff** doubles the gap for each consecutive empty read, capped, and
resets to the base interval the moment anything arrives. A dormant account costs
almost nothing.

### Acting

```ts
{ maxActionsPerHour: 0, maxActionsPerDay: 0, minSecondsBetweenActions: 0 }
```

Zero means the account sets no ceiling of its own. These sit *alongside* the
agent's `policy.rate` limits, and the tighter of the two applies. The verdict
names which one bound, because "rate limited" without saying whose limit it was
is the kind of message that wastes an afternoon.

Account ceilings are shared by every agent posting through that handle — two
agents on one account are one account to the remote service.

### Quiet hours

Cover reading *and* acting. Polling an account that may not act on what it finds
is just noise.

An unusable timezone **fails open**. An agent that visibly ignores a bad setting
is better than one that mysteriously stops.

## The schedule is in the database

The poller has no schedule of its own. It wakes on a short tick
(`AI17Z_POLL_TICK_MS`, default 5s), asks which accounts are due, and each
account's cadence decides when it comes round again.

```sql
UPDATE accounts SET next_poll_at = now() + interval
 WHERE id IN (SELECT id FROM accounts
               WHERE enabled AND status = 'CONNECTED' AND channel <> 'mock'
                 AND (next_poll_at IS NULL OR next_poll_at <= now())
               ORDER BY next_poll_at NULLS FIRST LIMIT $1
               FOR UPDATE SKIP LOCKED)
RETURNING ...
```

The claim moves `next_poll_at` forward in the same statement as the read. Two
workers cannot both decide an account is due, and a restart does not return
every account to "poll now".

## Where it is enforced

- `packages/runtime/src/cadence.ts` — the engine. `nextPollDelayMs`,
  `checkAccountCadence`, `withinQuietHours`, `msUntilAwake`, `jitter`
- `apps/worker/src/poller.ts` — asks for due accounts, records the outcome
- `packages/runtime/src/policyGate.ts` — `checkActionRate` checks the account
  cadence before the agent policy

## Environment

`AI17Z_POLL_TICK_MS` and `AI17Z_POLL_ACCOUNTS_PER_TICK` govern how often the
worker *looks* for due accounts, not how often any account is polled. Editing
them is a throughput decision; editing cadence is a behaviour decision.
