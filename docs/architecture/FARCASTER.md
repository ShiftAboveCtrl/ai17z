# Farcaster channel: session 1 decision
1. Baseline: origin/main 52ad84c9 has no farcaster/neynar/warpcast implementation; Bluesky f3340465 is a structure reference only.
2. API: use an operator-supplied Snapchain node's Hub-compatible HTTP API, with no hosted API subscription or default public node.
3. Reads: /v1/castsByMention, /v1/castsByParent, /v1/castsByFid and /v1/castById; paginate and key events by full cast hash.
4. Writes: locally sign protobuf messages with @farcaster/core and POST application/octet-stream to /v1/submitMessage for casts, likes and recasts.
5. Signer: an owner-authorized Ed25519 app key, sealed with AES-256-GCM under the master key; never hold a custody wallet key or use Neynar custody.
6. Authorization: the owner registers the app signer for the FID; current gasless KEY_ADD supports scopes and a sliding TTL, while existing onchain keys remain supported.
7. Cost: no API fee on an existing self-run node; hardware, bandwidth and Farcaster registration/storage still cost money (the node guide estimates about $100/month on AWS).
8. Limits: no universal HTTP quota is documented; operator limits and HTTP 429 Retry-After apply, plus the existing per-account read budget and cadence engine.
9. Neynar: hosted reads/writes require an API key or x402 payment; managed signer UUIDs add a custodian, so neither is required by this implementation; paid onboarding is deferred.
10. Sources: https://snapchain.farcaster.xyz/reference/httpapi/httpapi ; https://snapchain.farcaster.xyz/reference/httpapi/message ; https://snapchain.farcaster.xyz/guides/writing-messages ; https://snapchain.farcaster.xyz/guides/running-a-node ; https://docs.neynar.com/reference/quickstart .

## Session 1 operation

Create an account with channel `farcaster`, the decimal FID in `remoteAccountId`,
and public settings `{ "farcaster": { "hubUrl": "https://snapchain.example.invalid" } }`.
Supply an actual operator-run node origin. HTTPS is required except on loopback;
credentials, paths, query strings and extra settings are rejected.

Authenticated owners can PUT `{ "signerKey": "<32-byte-app-key-in-hex>" }` to
`/api/accounts/:id/farcaster/signer`. This seals the authorized Ed25519 app key
under the existing master key and calls `validateMessage`, without submitting a
cast. GET and PUT return only `{ "hasSigner": true | false }`. DELETE, or the
ordinary account disconnect route, removes the local key and disables the account
atomically. This does not revoke its remote authorization. Reconnect validates a
stored key; without one it settles at `NEEDS_AUTH`. A node change disconnects the
account, invalidates pending validation and resets its pagination cursor. Reconnect
explicitly after changing nodes. Late validation cannot undo a newer owner action.

The ordinary channel poller reads one page per cadence claim, alternating mentions
with the account's casts and their direct replies. Opaque pagination state advances
only after ingestion. Events deduplicate on the full cast hash through the existing
event/job indexes. Thread reads retain the incoming target and fetch at most twelve
ancestors. All HTTP reads, including validation, verification and recovery, use the
existing per-account capacity ledger and quiet hours. Node rate limits honor
`Retry-After`; there is no separate scheduler or budget. A node's HTTP 429 is
recorded as `RATE_LIMITED` pushback by its error code (`farcaster_rate_limited`),
never by matching X's wording; no other Farcaster error counts as pressure.

Authors and mentions are shown by username (`alice`, `@alice`), read from the
node's `/v1/userDataByFid` and cached per node and FID (1000 entries, one hour,
absences included). Identity is still the numeric FID: `remoteAuthorId`, cast
references and dedup keys never use the name. A name is used only if the node
returned it for the same FID and it is a plain username; otherwise, or when the
lookup fails or is refused, the display falls back to `fid:<n>` and the read
itself still succeeds. Each lookup is a charged read; one batch makes at most 25
and stops at the first pushback.

The own-cast walk reads newest first and ends at the newest cast the previous walk
saw (`ownSeen` in the cursor), so only new casts have their replies read. The
poller does not pass `since`; the cursor carries the boundary. Replies to older
own casts that do not mention the account are therefore no longer rediscovered.

POST and REPLY use pipeline account grants. The pinned model-callable capabilities
are `farcaster.read_cast`, `farcaster.read_thread`, `farcaster.like` and
`farcaster.recast`. Writes default to disabled and recheck grants and cadence.
Targets use `farcaster:<FID>:<full-0x-cast-hash>`. Casts are limited to 320 UTF-8
bytes. Likes and recasts are desired states. Before submission, signed protobuf
bytes are stored under the durable action key; retries resend the same hash, even
after a lost response or a process restart. Reusing a key with different content
is rejected. Dry runs never submit messages.

## Session 2

Add owner onboarding UI and the app-key authorization/renewal/revocation flow,
then validate against an authorized real node. Improve incremental polling for
large histories: this version walks all pages and relies on database deduplication,
so historical replies can take multiple cadence cycles to discover. No real
Farcaster request or credential was used during session 1 verification.
