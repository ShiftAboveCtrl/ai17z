# Capabilities

**What an agent is permitted to do through one account.**

## Intent and permission are different questions

An `agent_accounts` link carried a single `action_type`. That one field was
answering two questions at once:

1. What does this agent *do* when an event arrives here?
2. What is this agent *allowed* to do here?

Conflating them meant an agent could reply or post but never both, and nothing
anywhere recorded a decision to permit anything.

The link still answers the first question. Capabilities answer the second.

```
agent_accounts.action_type   → what it will attempt
agent_account_capabilities   → what it may do
```

When the two disagree — a link that responds with `REPLY` while `REPLY` is
revoked — the agent reads the account and stays silent. The UI says so, because
that is otherwise a puzzling silence.

## The vocabulary

| Capability | Permits |
| --- | --- |
| `READ` | ingesting events from this account at all |
| `GENERATE` | running the model to produce a draft; required even for a dry run |
| `REPLY` `POST` `DIRECT_MESSAGE` `LIKE` `REACT` `CALL_TOOL` `CALL_API` | executing that action type |

The action capabilities share their names with `ActionType` deliberately: there
is no translation table between "what it will try" and "what it may do", and so
no translation table to get wrong.

## Checked twice, on purpose

**At ingest** (`packages/runtime/src/ingest.ts`) — work that is not permitted
never reaches the queue. An event arriving without permission to answer it is
still recorded: revoking permission is not the same as pretending nothing
happened.

**At execution** (`packages/runtime/src/steps.ts`) — a permission revoked while a
job is already queued has to stop that job, and only this check can. The failure
is **permanent**: no amount of retrying restores a revoked grant.

The integration test that matters revokes a grant between ingest and execution
and asserts nothing was sent.

## Granting

`linkAgentAccount` grants the defaults itself — `READ`, `GENERATE`, and the
link's own action type — rather than leaving it to the caller. A link with no
grants is an agent that silently does nothing, and a caller that forgot is
indistinguishable from one that meant to revoke everything.

Editing which events trigger an agent does **not** touch what it may do.

`setGrants` replaces the whole set inside one transaction. A partially applied
permission change is the one outcome that must not be possible.

## Migration 0019

The backfill grants existing links exactly what they could already do: `READ`,
`GENERATE`, and their `action_type`. Nothing gains a permission by upgrading.
