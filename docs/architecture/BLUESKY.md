# Bluesky

**A second network for the same agent.** One identity, one memory and one policy,
reaching Bluesky as well as X, over the AT Protocol's HTTP API. No browser.

This document is the account of session 1: what exists, why it is shaped the way
it is, and, at the end, exactly what session 2 has to finish.

## What it is, and what it deliberately is not

A Bluesky account is an ordinary `accounts` row with `channel = 'bluesky'`. Its
mentions are ordinary events, its replies run the ordinary ten pipeline steps, and
its actions go through the ordinary action boundary. The adapter in
`packages/channels/src/bluesky/` is the only code that knows what a notification
or a record looks like; everything above it reads `NormalizedEvent` and
`ResolvedContext`, as for every channel.

In scope: link with an app password, poll mentions, replies and quotes through the
existing cadence, read the thread, post, reply and like, and a small set of
`bluesky.*` read capabilities.

Out of scope, on purpose: direct messages, follow, repost, quote posting, media
upload, link cards, a second scheduler, a second budget engine, and anything that
reads Bluesky outside `packages/channels`.

## Files

| File | Owns |
| --- | --- |
| `bluesky/client.ts` | XRPC over `safeFetch`, the in memory session cache, error classification |
| `bluesky/normalise.ts` | Notification to event, thread to branch, post to context. Pure. |
| `bluesky/text.ts` | The 300 grapheme limit, mentions, links and tags as facets with UTF-8 byte offsets |
| `bluesky/uri.ts` | at:// URIs and bsky.app addresses, and what a post reference may be |
| `bluesky/reads.ts` | Reading a post, a thread and a profile in the normalised shapes |
| `bluesky/index.ts` | The `ChannelAdapter` |
| `runtime/src/blueskyConnect.ts` | Linking an account: prove, then keep, then seal |
| `runtime/src/blueskyCapabilities.ts` | The `bluesky.*` capabilities |
| `shared/src/contracts/blueskyDomain.ts` | `BlueskyPost`, `BlueskyProfile`, `BlueskyThread` |
| `migrations/0114_bluesky_channel.sql` | Widens the one CHECK that names channels |

## Linking an account, and the app password

`POST /api/accounts/bluesky` takes `{ identifier, appPassword, serviceUrl? }`
and calls `connectBlueskyAccount`.

1. The details are **proved against Bluesky before anything is saved.** A typo
   creates neither an account row nor a sealed credential.
2. Only the app password form (`xxxx-xxxx-xxxx-xxxx`) is accepted. Anything else
   is refused with a sentence about where to make one, before Bluesky is asked
   anything. That protects the owner: an app password can be revoked alone and
   cannot change the account's email or delete it, and the main password can do
   both. It also means the emailed-code challenge cannot arise at all.
3. The password is sealed with AES-256-GCM under `AI17Z_MASTER_KEY` into
   `account_credentials`, the table an X sign-in already uses (username is the
   handle or email, password is the app password). There is no new table, and
   deleting the account cascades.

Where the password can and cannot be:

- It reaches the adapter only through `ChannelContext.credentials()`, a function
  that opens the sealed row at the moment `createSession` needs it. It is never a
  field on the context, so a context that is logged or kept in a closure holds
  nothing.
- It crosses the wire once per sign-in, in the `createSession` body, and nowhere
  else. No error message echoes a request body.
- It is never in an API response, a log line, a trace, an audit row or
  `browser_tasks.params`. `tests/integration/blueskyChannel.test.ts` checks the
  last claim by searching **every row of every table** (as text) for the password
  and the session tokens, apart from the sealed table.
- The session tokens (`accessJwt`, `refreshJwt`) live only in the memory of the
  process. A restart costs one sign-in. `jwt` was added to the logger's redaction
  pattern, because `accessJwt` does not match `token`.

`serviceUrl` is for an account on its own server (PDS); the default is
`https://bsky.social`. Only an origin is kept. It must be https. The single
exception is `AI17Z_BLUESKY_UNSAFE_DEV_ORIGIN`, an exact origin named by whoever
runs the process (the same arrangement as `AI17Z_STUDIO_UNSAFE_DEV_ORIGIN`), which
is how the tests reach a fixture server on loopback. Requests go through
`safeFetch` with redirects refused, because the request carries a bearer token.

`POST /api/accounts` refuses `channel: 'bluesky'` and points here, so a row with
no working sign-in cannot be made by naming a handle.

## Security challenges

`AuthFactorTokenRequired` is the server asking for a code it emailed. AI17Z never
answers one:

- connecting reports `CHALLENGE_REQUIRES_USER` and tries nothing else (one
  request, no retry), and the link is refused with a sentence;
- a poll that meets one moves an already linked account to
  `CHALLENGE_REQUIRES_USER` with `challengeKind = 'EMAIL_CODE'`.

Wrong or revoked details move the account to `NEEDS_AUTH`. Both statuses take the
account out of the due list (the poller only claims `CONNECTED` accounts), which
matters: Bluesky limits how many sessions an account may create, and an account
whose password was revoked must not be polled back into that limit every few
minutes. `tests/integration/blueskyChannel.test.ts` pins both.

## Reading what people sent

The poller is unchanged. It asks which accounts are due, the account's cadence
decides when it comes round again, and `ingestEvents` makes one
`app.bsky.notification.listNotifications` call for the reasons `mention`, `reply`
and `quote`. Likes, reposts, follows and the agent's own words are not events.

| Notification | Event type |
| --- | --- |
| `mention` | `MENTION` |
| `reply` | `REPLY` |
| `quote` | `MENTION` |

- **Identity is the post's at:// URI.** It is the `remoteEventId`, the
  `remoteMessageId` and the action target. It names the author by DID, so a
  rename does not make two people. The unique index on
  `events (channel, account, remote_event_id)` makes polling the same page twice
  harmless, and `tests/integration/blueskyChannel.test.ts` polls it three times.
- `remoteConversationId` is the thread root's URI, `parentRemoteMessageId` the
  parent's.
- `raw.addressedToAgent` is true: a mention, reply or quote is addressed to the
  agent by definition, which the engagement heuristic reads instead of guessing.
- Nothing is marked read on the owner's behalf (no `updateSeen`). The page is
  read again each poll and the index does the deduplication.
- A count the server leaves out stays out. Absent is not zero.
- `authorVerified` is three valued: true, false, or null for "the network did not
  say".

### One budget

Every read spends from the one budget. `spendsReadBudget(channel)` in
`capacity.ts` names the channels that do (X and Bluesky). The ledger and the
breaker are keyed on the account, so no second engine exists:

- the poller calls `checkReadCapacity(account, 'DIRECT')` before it reads, notes
  the read with `noteXRead`, and records a failure with `noteXFailure`;
- `stepResolveContext` checks and notes the thread read for a reply, exactly as
  for X;
- the model-callable reads go through the same check as `BROAD` work, which
  yields first;
- a 429 becomes `PipelineError.retryable('bluesky_rate_limited')` carrying the
  wait the server stated (`ratelimit-reset`, then `retry-after`), and its sentence
  contains "rate limited" and "429", which is what `classifyXSignal` recognises as
  pushback. One of them moves the breaker to DEGRADED, as on X.

`tests/integration/blueskyChannel.test.ts` exhausts an account's budget and
asserts the next poll makes **no** request to the server.

## Understanding the thread

`resolveContext` makes one `app.bsky.feed.getPostThread` call with
`depth = 0` and `parentHeight = 13`. The AppView has already resolved the reply
chain, so the ancestors are the `parent` links of the focal node (root first,
direct parent last) and sibling branches are excluded structurally.

- The action target is the incoming post's own URI. If the server answers with a
  different post as the focus, the job fails permanently with
  `focal_post_mismatch` and nothing is sent.
- A parent that is blocked or deleted ends the chain there, and the context says
  so in `note` instead of pretending the thread starts later.
- A deleted incoming post is a permanent failure: there is nothing to answer.

## Acting

`verifyAction` fetches the target post fresh (`app.bsky.feed.getPosts`) and
returns the evidence a reply needs:

- A reply quotes its **parent** and its **root**, each by URI and CID. If the
  parent is itself a reply the root is the one it already names, otherwise the
  parent is the root. The CID is taken from the post at verification time, never
  from the event.
- It refuses when the author has blocked the account (`author.viewer.blockedBy`)
  or limited replies (`viewer.replyDisabled`), and when the text is over 300
  graphemes or 3000 bytes. **A draft is never shortened.** A too long draft goes
  to a person.

`executeAction` verifies again, stops at the boundary on a dry run, and then:

- writes `app.bsky.feed.post` through `com.atproto.repo.createRecord`, with
  facets. A mention is resolved to a DID (`resolveHandle`) before it is sent, and
  one that does not resolve stays text, so nobody is mentioned by mistake. Spans
  are UTF-8 **byte** offsets, tested with an emoji ahead of the mention;
- writes `app.bsky.feed.like`, treating an existing like as success (`viewer.like`
  on the target), because a like is a desired state;
- renews an expired session once, with the refresh token and not the password. A
  write is safe to repeat after a renewal because the server turned it away for
  its token before doing anything.

### A write whose answer was lost

A refusal tells us nothing was written. A request that got no answer tells us
nothing at all, and retrying it blindly is how a post goes out twice. So on a
transport failure the adapter reads the account's own repository
(`com.atproto.repo.listRecords`, which is the authority and does not lag):

- found: the action is reported as executed, with the URI that was written;
- not found, and the scan provably reached back past the age an action could
  have: retryable;
- anything else: `REVIEW_REQUIRED` with a sentence, for a person.

`wasAlreadyDone` uses the same scan for a recovered action, and returns
`conclusive: true` only when the scan covered the window (or the whole
collection).

## Capabilities

There are two layers, and they are the same two layers X has.

**The account's grants** (`agent_account_capabilities`): `READ`, `GENERATE`,
`REPLY`, `POST`, `LIKE`. They are channel generic and are checked twice, at
ingest and again before execution, and a revoked grant fails the job
**permanently** with `capability_not_granted`. This is what "`bluesky.post` and
`bluesky.reply` permissions" mean: posting and replying are the `POST` and `REPLY`
grants on a Bluesky account, performed by the pipeline behind the validator,
cadence, rate limits, idempotency and exact target verification. They are
deliberately **not** model callable: a capability that published directly would be
a second execution path, and X has no `x.post` for the same reason.
`tests/integration/blueskyChannel.test.ts` revokes `REPLY` between ingest and
execution and asserts nothing was sent, and that an ungranted `REPLY` records the
event and queues nothing.

**The registry** (`agent_capability_permissions`), pinned exactly by
`tests/unit/blueskyCapabilities.test.ts`:

| Id | Effect | Risk | Default |
| --- | --- | --- | --- |
| `bluesky.read_post` | READ | LOW | allowed |
| `bluesky.read_thread` | READ | LOW | allowed |
| `bluesky.read_profile` | READ | LOW | allowed |
| `bluesky.like` | WRITE | MEDIUM | disabled |

`bluesky.like` lands in `performCapabilityAction`, never a direct call, under a
key derived from the job's. `actionIdempotencyKeyFor` takes the channel so the
pipeline and the capability executor spell a Bluesky like the same way
(`bluesky.like`, not `x.like`).

They sit in a `bluesky` Toolpack whose summary says plainly that replying and
posting are set on the account. Ids start with `bluesky.`, so an installed Plugin
(`plugin_<id>.<name>`) can never claim them.

## Tests

No test reaches the real Bluesky network. `tests/support/fakeBluesky.ts` is a
fixture server on loopback with real response shapes and strict behaviour: an
unknown token is a 400 `ExpiredToken`, a reply quoting a parent at the wrong CID
is rejected, a rate limit is a 429 with `ratelimit-reset`, and a write can be made
to succeed and then drop the connection.

- `tests/unit/blueskyCapabilities.test.ts`: the pinned surface, effects, defaults,
  argument refusal.
- `tests/unit/blueskyText.test.ts`: grapheme and byte limits, facet byte offsets,
  post references.
- `tests/unit/blueskyAdapter.test.ts`: sessions, challenge, rate limit, events,
  thread, reply refs, facets, like, lost answer, secrecy of the password.
- `tests/integration/blueskyChannel.test.ts`: link, poll, ten steps, reply,
  duplicate polls, revoked grant, budget, NEEDS_AUTH and challenge, and the
  every-table secret sweep.
- `tests/integration/statusConstraints.test.ts`: every `CHANNELS` value is
  accepted by the database.
- `tests/unit/capabilityTarget.test.ts`: the Bluesky like key agrees with its
  capability.

## Not verified

Everything above is proved against the fixture server. **Nothing has been run
against bsky.social or a real PDS.** The assumptions to confirm on a throwaway
account, with a person present:

- `listNotifications` honours the `reasons` filter (the adapter filters again
  client side, so it is correct either way);
- `getPostThread` accepts `parentHeight = 13`;
- `listRecords` returns newest first (the scan checks the order it received rather
  than trusting it, and reports an unclear page as not conclusive);
- the real limits on `createSession` and on writes.

## What session 2 must finish

Session 1 is the backend. Nothing in the web app knows about Bluesky yet.

1. **Onboarding UI.** An "Add a Bluesky account" form posting to
   `/api/accounts/bluesky` (handle or email, app password, optional server), with
   the app password help text and the sentences the API already returns. The
   generic Accounts section and `CreateAgent.tsx` list channels from
   `/api/channels` and branch on `channel === 'x'`; `POST /api/accounts` now
   refuses `bluesky` with a pointer, so both must route to the new form.
2. **Account screen.** Show `NEEDS_AUTH` and `CHALLENGE_REQUIRES_USER` for a
   Bluesky account with the fix ("store a new app password"; re-posting to
   `/api/accounts/bluesky` is the reconnect, and is idempotent). The credentials
   routes in `sessions.ts` are gated on `signInWithCredentials`, so they report
   `supported: false` for Bluesky; either add a Bluesky branch or point the UI at
   the connect route. Hide the X only panels (`BrowserTabsPanel`, `SessionPanel`)
   for Bluesky.
3. **Words that say X.** The capacity and health sentences in `accountHealth.ts`
   ("X asked this account to slow down...") reach a Bluesky account unchanged, as
   the integration log shows. Make them channel neutral, with their tests.
4. **Agent start and health.** `agentStart.ts` preflight and `health.ts` /
   `accountIsWell` should check a Bluesky account's sign-in (the adapter's
   `healthCheck` exists) rather than only browser state. Confirm the owner
   notification path (`notify.ts`, Telegram) fires for `NEEDS_AUTH` and
   `CHALLENGE_REQUIRES_USER` on this channel.
5. **Posting unprompted.** A `POST` on Bluesky is tested at the adapter, and a
   `REPLY` is tested through the whole pipeline. A scheduled post through
   `originate.ts` and the idea backlog on a Bluesky account is not tested end to
   end.
6. **Engagement and discovery.** `engage.ts` hard codes `x.like` and `x.repost`,
   and the radar and discovery are X only. An agent on Bluesky answers people who
   write to it; it does not yet like or go looking on its own. Wire
   `bluesky.like` into `engage.ts` if wanted.
7. **Media.** An incoming image is counted (`imageCount`) and not read. The prompt
   must say it could not be read, the way it does for X ("media that could not be
   read is an explicit gap"); check that `stepResolveMedia` does so for a Bluesky
   event. Outbound media is out of scope.
8. **Notification paging.** One page of 50 is read per poll and nothing is
   marked seen. A burst of more than 50 qualifying notifications between polls
   would leave the oldest unread. If that matters, persist a cursor on the account
   (not in memory) or use `updateSeen` deliberately.
9. **The real network.** Run the "Not verified" list above against a throwaway
   account.
10. **Docs.** Mention Bluesky in the README and in `CLAUDE.md` (the rules it
    already states cover this channel; a short section naming the app password
    arrangement and `AI17Z_BLUESKY_UNSAFE_DEV_ORIGIN` would do). Check that
    agent packages (`portableAgent`) carry no Bluesky credential; they should not,
    since credentials are a separate table and are not exported.
