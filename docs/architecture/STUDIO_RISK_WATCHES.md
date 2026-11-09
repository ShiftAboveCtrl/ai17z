# Studio risk watches: installation contract v1

Core inspected Studio `feat/risk-inbox`: `risk_watches`, `risk_observations`,
`risk_events`, the holder access rules and `planSample` exist. That branch has
no installation risk routes. This document and the strict schemas in
`packages/shared/src/contracts/studioRisk.ts` define the missing contract.
`tests/support/riskStudioServer.ts` implements it for core tests; it is not
evidence that deployed Studio supports it.

The owner explicitly binds one local agent and one of its linked accounts with
`PUT /api/agents/:id/studio-risk-watches`, body
`{ accountId, enabled, mayTrigger }`. Both switches default off. Linking alone
exports nothing. GET on the same route returns binding and delivery status.
Only that local owner may bind; a model cannot enable it. A new installation
link needs a new local opt-in. Disabled and removed watches stop prospectively.

All Studio requests are outbound through `studioInstallationRequest` with the
linked installation's DPoP key. There are no inbound ports or callback URLs.

## Studio owes

- `GET /api/v1/installation/risk-watches`: validate DPoP, token binding, expiry,
  method, URL and proof replay, then resolve the installation's owner. Apply the
  same active-holder permission as the inbox sampler. Return 403 on lost access,
  401 on revocation, otherwise `{ protocol: 1, generated_at, watches }`.
  Each enabled watch is `{ id, mint, kind, threshold, interval_seconds }`.
  No labels, guidance, instructions, local agent or account identity cross.
  At most five unique watches; an empty list authoritatively removes them all.
- `POST /api/v1/installation/risk-watches/observations`: accept the strict
  `{ protocol: 1, observations }` batch, at most 50. Each observation has
  `observation_id`, `watch_id`, `watch_revision`, `source: "jupiter"`, `mint`, `before` and `after`.
  Before is null for a baseline, otherwise both readings are
  `{ value, observed_at }`. These are evidence, never an imported verdict.
- Recheck ownership, standing, enabled watch, exact mint and current condition
  before accepting. Validate time, numeric ranges and the digest described below.
  Return `{ protocol: 1, accepted: [observation_id] }` only after committing.
  Unique `(installation, observation_id)` plus a content digest refuses changed
  content under an old key. Replay returns the same acknowledgement.
- Use the existing observation store and locked `planSample` transition, not a
  parallel event store. Persist source and source time. Deduplicate both by
  import key and by the existing `(watch, observation)` constraint; overlapping
  native and installation reads must never create two events for one crossing.
  Ignore older readings. A first sample establishes a baseline without an event.
  The local before value is contextual evidence, not authority over Studio's
  baseline. Studio must evaluate its own locked watch against the after value.
- Display the source, both times, definitions and gaps; keep the existing
  holder access, unsubscribe and read-history behavior. The local core APIs and
  Radar read model expose provenance and posting reasons. Studio owns its UI.

`observation_id` is SHA-256 of JSON.stringify on this ordered tuple:
`[watch_id, watch_revision, mint, source, after.observed_at, after.value]`.
`watch_revision` is SHA-256 of JSON.stringify on `[id, mint, kind, threshold]`
from the current watch document. Studio must recompute it on the locked watch
before accepting, so queued evidence for an edited condition cannot establish
its replacement's baseline. Core materializes a new source for a new revision.
The id contains no
installation, local agent, account, handle or owner identity. Retries keep the
entire original payload, including before. A new installation link never sends
the former link's pending observations.

## Meaning and execution

Kinds are `LIQUIDITY_BELOW` (index liquidity USD), `TOP_HOLDERS_ABOVE`
(index top-holder percentage) and `DEVELOPER_SHARE_ABOVE` (index developer
percentage). These use the same Jupiter token profile as Studio. They must not
be substituted with the local radar's median pool liquidity or largest token
account sum: those measure different things. Developer attribution can be wrong;
pool and exchange accounts can inflate concentration. Zero liquidity without a
recorded first pool is missing. Invalid, absent or stale figures never establish
or clear a baseline. A missing index timestamp stays unavailable; fetch time is
not substituted. Core comparisons require a reading at most five minutes old, a strictly newer
source time and a valid clear before another crossing.

One `market_signal` radar source per bound watch has a `Studio risk watch` label,
an exact mint, metric and watch identity. It uses the existing source claims and
upstream machine quotas. The existing radar tick synchronizes at most once per
minute per binding. No timer, X read, wallet, trade or signer is added. Existing
X readers still use `checkReadCapacity` before and `noteXRead` after every read.

A crossing queues an informational owner notification through `notify.ts`
before inserting a candidate in the same transaction. Notification transport
delivery remains asynchronous and respects owner preferences; actual receipt
cannot be promised before posting. Posting is separately opt-in, bound to the
local agent and account, and goes only through `content_ideas` and the existing
signal posting path. Reticence, strong-pitch refusal, engagement, cadence,
capacity, capabilities and identity policy remain in force, including checks at
send. The evidence never advises buying or selling or calls a token safe.

Snapshots older than 15 minutes or from the future are refused. Failed sync
suspends that binding's sources; recovery starts a new baseline rather than
turning an unobserved gap into a change. Invalid documents change no universe.
Pending write-back is durable, limited to 50 per sweep and discarded from delivery
after 24 hours or after removal/rebinding. Missing acknowledgements are retried
with the original keys. The worker never reports an acknowledgement it did not
receive, and nothing depends on Studio being available for unrelated work.

## Owner screens

The agent's Accounts section (inside an account's session) holds the two opt-in
switches, both off until the owner turns them on, with one sentence each. The
Radar panel marks every source, baseline and candidate that came from Studio
using `provenance` (`STUDIO_RISK_WATCH` or `OWNER`), computed from the
`studioRisk` config key and never from a label, and shows each candidate's
recorded reason in sentences. A Studio source has no remove control because the
next sync recreates it; `DELETE /api/accounts/:id/radar/:sourceId` refuses it
with a sentence. The crossing notification opens
`/settings?account=<id>&focus=radar`.
