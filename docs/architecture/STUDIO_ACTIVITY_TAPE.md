# Studio public activity tape

Frozen protocol 1 contract. Core implements the outbound client and projection;
Studio must implement the receiving endpoint and public rendering described here.
`tests/support/activityStudioServer.ts` is a contract server, not evidence that
the deployed Studio implements this protocol.

## Consent and owner operations

Two independent decisions are required:

* Installation setting `studio.activity_tape.enabled`, initially false. The local
  authenticated owner uses `GET` or `PUT /api/studio/activity-tape`; PUT accepts
  only `{ "enabled": true|false }` and returns `{enabled, changedAt}`.
* Explicit `ALLOWED` permission for the agent's `studio.activity_tape` capability,
  through the existing capability permission routes. Missing, DISABLED and
  OWNER_APPROVAL permissions prohibit background delivery. The capability is a
  READ with `audience: 'OWNER'`, `unsetPermission: 'DISABLED'`. Its owner-chat
  invocation previews normalized rows and cannot enable publishing or scrub.

Linking, control, live view and takeover do not enable the tape. Pausing the tape
sends no announcement, token request or event request. Requests already in flight
can finish. Core rechecks the switch and grants immediately before transport.
Turning it back on starts at that opt-in time; it does not publish activity from
the paused period. A newly allowed capability also starts at its grant time.

`POST /api/studio/activity-tape/scrub` accepts only `{ "id": "action:<uuid>" }`
(also `paper:` and `radar:`). Authentication is required. It records an audited
local tombstone and returns `{ "queued": true }`. Source evidence is preserved.
Scrubs are retried in every enabled batch and never evicted locally. The bounded
queue holds 200 distinct ids; a new id beyond that returns 409 with a sentence
instructing the owner to remove it in Studio. Repeating a scrub is harmless.
While the switch is off, scrubs stay queued and nothing is sent. Studio must also
offer the linked owner immediate deletion and pause in its own interface so an
owner can remove a public item while core is paused, offline or unlinked.

## Request

```text
POST {linked Studio origin}/api/v1/installation/activity-tape
Authorization: DPoP <installation access token>
DPoP: <installation proof>
Content-Type: application/json
```

Uses the same `authed()` transport as control, token acquisition, origin pinning,
redirect refusal and one refresh on 401. DPoP is ES256, with fresh `iat`, unique
`jti`, `htm: POST`, `htu` equal to the origin plus this path, and `ath` bound to
the short lived access token. Studio must verify the signature, registered
installation key, token binding, freshness and replay protection. Bearer tokens
alone are insufficient. Installation and owner identity come from authentication,
never from a client-selected owner id.

```json
{
  "protocol": 1,
  "events": [
    {
      "id": "action:00000000-0000-4000-8000-000000000001",
      "agent_id": "00000000-0000-4000-8000-000000000002",
      "kind": "REPLY",
      "at": "2026-11-09T10:00:00.000Z",
      "dry_run": false,
      "target_handle": null,
      "paper": null
    },
    {
      "id": "paper:00000000-0000-4000-8000-000000000003",
      "agent_id": "00000000-0000-4000-8000-000000000002",
      "kind": "PAPER_FILL",
      "at": "2026-11-09T10:00:01.000Z",
      "dry_run": true,
      "target_handle": null,
      "paper": { "simulated": true, "size_base_units": "42", "asset": "SOL", "verdict": "PAPER_FILLED" }
    }
  ],
  "remove": []
}
```

The schema is `packages/shared/src/contracts/studioActivityTape.ts`. Every object
is strict. Studio must reject unknown fields, unsupported protocol versions,
oversized batches and malformed objects before persisting anything. There are at
most 50 events and 200 removal ids. The kinds are exactly REPLY, POST, PAPER_FILL
and RADAR_HIT. Identifiers are namespaced source-row UUIDs. `agent_id` is an opaque
local agent UUID, not a name, handle or account id.

`target_handle` is always null. The task's explicit privacy requirement overrides
the backlog's proposed target handle: people the agent spoke to stay private.
`dry_run` is the recorded boolean for an action, true for a paper fill, and null
for a radar discovery because the question does not apply to that observation.
`paper` exists only for PAPER_FILL; it must have `simulated: true` and
`verdict: PAPER_FILLED`. Size is the actual simulated input spent (`inBase`), in
the input asset's base units, never the maximum requested amount. Asset is its
bounded display symbol, not an asset identity or wallet address. Core maps known
native assets to their symbols and refuses malformed labels. No price, decimals,
asset address or conversion is inferred. Size and asset can independently be null.

## Delivery and acknowledgement

The existing worker sweep calls the tape independently of control. A persisted
atomic claim permits one batch attempt per installation per minute, including
failed attempts. The existing transport may refresh once on 401. Core reads at
most 50 eligible rows in timestamp, event id, agent id order. Timestamps are
normalized to milliseconds consistently with the persisted delivery cursor.
Only a successful acknowledgement advances that cursor. A lost acknowledgement
or restart replays the same row identities; it must never create duplicate items.

The cutoff is fifteen minutes, additionally bounded by the installation enable
time and each capability's grant time. Expired rows are skipped even after an
outage. Future timestamps, pending or failed actions, direct messages, and LIVE
trade intents are excluded. Empty projections with no scrubs send nothing.
There is no event spool or second event store. Actions come from `actions`, paper
fills from PAPER/PAPER_FILLED `trade_intents` with a simulated postcondition, and
radar observations from `event_discoveries` on an agent's linked account.
An observation proves discovery on that linked account, not a model decision or
an endorsement. The only added persistence is settings for consent, attempt time,
acknowledged cursor and removal ids. No migration is needed.

Studio must atomically apply removals first, then insert new events, and return:

```json
{ "protocol": 1, "accepted": true }
```

The status must be 200 and the acknowledgement must mean the whole batch is
durably committed. Anything else leaves the cursor unchanged. Deduplication key:
`(authenticated installation, agent_id, event.id)`. First accepted content wins.
A removal id applies to every agent copy of that id for this installation.
Permanent Studio tombstones take precedence over all replays, even a delayed
batch arriving after removal. Never permit one installation to alter another's
events, bindings or tombstones. The endpoint returns no commands or instructions.

Network failure, an unlinked or revoked installation, unsupported Studio routes,
and a refused acknowledgement produce no successful delivery. Core never
fabricates activity. Studio is responsible for transactionality, permanent
deduplication and tombstones, authenticated agent-to-public-terminal binding,
owner moderation, retention, and signed-out rendering. Unknown local agents must
not attach themselves to an existing terminal by UUID alone.

## Privacy and public rendering

The projection constructs every output field explicitly and never selects source
text or private objects. Never accept or publish memories, prompts, conversations,
drafts, raw reasoning, browser frames, sessions, cookies, credentials, secrets,
wallets, account handles, target references, URLs, remote message ids, persona or
private guidance. There is no model-authored summary or free-text verdict.

Studio renders null or redacted fields as **unavailable**, never zero, an empty
holding, a guessed handle or a clean risk result. It labels dry runs visibly and
every paper fill **simulated paper**, including copied/shared representations.
It must not present the tape as financial advice, a trade signal or evidence of
future returns. Escape all rendered values and do not turn symbols into links.
The tape is a bounded live view of committed rows, not a complete audit journal;
late commits behind the cursor and rows that age out can be absent. Silence and
missing heartbeats mean unavailable or stale, never proof of zero activity.
Studio marks the feed stale after fifteen minutes without new received activity.
Owner pause does not erase prior public copies; scrub removes Studio's copy and
cannot revoke copies a visitor already made.

## Verification boundary

Targeted unit tests pin the allowlist, unknown-field refusal, nullable gaps,
simulated labels and OWNER/permission refusals. Integration tests use throwaway
Postgres and the loopback contract server to exercise the real client, signature
and token binding, real source projections, switch-off silence, grant revocation,
bounded batches, retries, deduplication and scrubbing. They do not exercise a
deployed Studio, public rendering, real channel execution or a live trading path.
