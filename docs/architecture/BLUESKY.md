# Bluesky

**A second network for the same agent.** One identity, one memory and one policy,
reaching Bluesky as well as X, over the AT Protocol's HTTP API. No browser.

This document is the account of what exists, why it is shaped the way it is and,
at the end, what is still to do. Session 1 built the backend; session 2 added the
screens, the words, the operations around it and the two reads that were missing.

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
- Nothing is marked read on the owner's behalf (no `updateSeen`). Where the last
  poll stopped is a mark on the account; see Notification paging below.
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
- Session 2: `tests/unit/blueskyConnect.test.ts` (reconnect settings, the shared
  sign-in sentences), `tests/unit/blueskyAdapter.test.ts` (attachments, paging),
  `tests/unit/accountHealth.test.ts` (words per network),
  `tests/integration/blueskyOperations.test.ts` (start check, Health, owner
  notifications, bursts and the mark, unreadable pictures) and the scheduled post,
  reconnect and disconnect cases in `blueskyChannel.test.ts`.

## Session 2

### The screens

A Bluesky account is linked from three places and they share one form,
`BlueskyConnect` (`apps/web/src/components/BlueskyConnect.tsx`): the Easy setup
wizard (a network choice, X or Bluesky, at the account step), the Advanced wizard
(a Bluesky channel with a handle and an app password), and the agent page's
"Connect another account". The help text is `AppPasswordHelp`, said before the
field because the mistake it prevents is pasting the main password.

- The password lives in component state while the form is open and is cleared the
  moment it is sent. It is never in a URL, a log or local storage, and the answer
  is the account row.
- In the Advanced wizard the password is proved **before the agent is created**, so
  a refusal creates nothing and a retry does not make a second agent.
- The account's own screen (`SessionPanel`) shows none of X's panels for Bluesky
  (no browser configuration, identity evidence, radar, Open sign-in, Capture or
  Clear session). It shows the sign-in state in plain sentences, the same form to
  store a new app password (which is also how a lapsed account is fixed, because
  linking is idempotent), the server it is on, and the cadence panel, which is the
  same engine for any channel.
- Reconnect and Disconnect in Settings do something real: disconnect ends the
  session on Bluesky's side, and reconnect signs in with the stored app password
  and reports what came of it (`reconnectBlueskyAccount`), because an account that
  was only switched back on would never be polled and no window exists to sign in
  through.

The words are `describeSignIn` in `packages/shared/src/contracts/signIn.ts`, the
one place the start check, the Health screen, the owner notification and the
account screen get their sentences, so they cannot give a person four different
fixes.

### Words that said X

The breaker and the budget serve any channel that spends from the one budget, and
their sentences used to name X. `platformName(channel)` in `accountHealth.ts`
now names the right network in `judgeHealth`, `settleCapacity`, `readAllowance` and
`writeAllowance`, and the channel travels from the account row. X is the default,
so every X sentence is unchanged.

### Start check, Health and notifications

- `startPreflight` no longer treats a Bluesky account as a browser account or as
  an error state. A lapsed or challenged account blocks the start in
  `describeSignIn`'s words, and a connected account with no stored app password
  is a blocker too. No browser worker is asked for.
- The Health screen no longer reports "No session required" for a channel that has
  no browser but does have a sign-in (`channelHasSignIn`, from an adapter's
  `signInKind`).
- The sweep raises the same two notifications for Bluesky as for X, in Bluesky's
  words. A challenge notice no longer says "the browser window is open".

### A scheduled post, end to end

`originatePost` was already channel generic. `tests/integration/blueskyChannel.test.ts`
now proves it on a Bluesky account against the fixture server: a post is
originated from the idea backlog, runs the ten steps, and is published with no
reply refs; a dry run publishes nothing and keeps the idea; and revoking `POST`
after the job is queued fails it **permanently** and sends nothing.

### Pictures

`ingestEvents` is unchanged, but `resolveContext` now hands the media step an
inventory in the shape it already understands (`meta.inventory`, and
`meta.parentInventory` when the mention carries nothing but the post above does):
images with their address and alt text, a video as its poster frame, a link card as
a link, and a quoted post with its own pictures. An attachment this file does not
recognise becomes an item that cannot be read, so it is never silently dropped.
What happens next is the ordinary path: with no vision model the item is skipped
with a stated reason, the trace records a gap, and the prompt's NOT UNDERSTOOD
block makes the reply say so. Proved in `tests/integration/blueskyOperations.test.ts`.
Nothing is fetched or described by the channel itself.

### Notification paging

One page of 50 was read per poll and nothing was marked seen. Now the account
keeps a mark, `settings.bluesky.notificationsSeenThrough`, the newest `indexedAt`
among the events it ingested:

- With no mark (a new link) the poll reads one page, because linking is not a
  reason to ingest history.
- With one it pages back until it meets something older than the mark, up to four
  pages a poll, so a burst larger than a page is read to its end. Past that bound
  it says so in a warning instead of spending the budget on history.
- The mark moves **only after every event was ingested** (`advanceNotificationWatermark`,
  called by the poller), in one forward-only statement, so a crash between reading
  and ingesting re-reads and a late poller cannot pull it back. The unique index on
  the event is still the real deduplication.
- Nothing is marked read on Bluesky (`updateSeen` is deliberately not used): that
  would change what the owner sees in their own app.

A reconnect keeps the mark and replaces the server address (`settingsAfterReconnect`),
so a reconnect that names no server goes back to bsky.social and does not keep an
earlier custom one.

## Not verified

Everything is proved against the fixture server and the scratch stack. **Nothing has
been run against bsky.social with a real account.** The assumptions to confirm on a
throwaway account, with a person present:

- `listNotifications` honours the `reasons` filter and `cursor` (the adapter
  filters again client side, so it is correct either way);
- `getPostThread` accepts `parentHeight = 13`;
- `listRecords` returns newest first (the scan checks the order it received rather
  than trusting it, and reports an unclear page as not conclusive);
- the `embed` view shapes the AppView really returns for images, video, link cards
  and quoted posts;
- the real limits on `createSession` and on writes.

## Left for a later session

Deliberately not done, and none of it is needed for an agent to answer people:

1. **Engagement and discovery.** `engage.ts` hard codes `x.like` and `x.repost`, and
   the radar and discovery are X only. An agent on Bluesky answers people who write
   to it and posts from its backlog; it does not yet like on its own or go looking.
   Wire `bluesky.like` into `engage.ts` if wanted.
2. **The real-network check** of the list above, on a throwaway account.
3. **`README.md` and `CLAUDE.md`.** Mention Bluesky, name the app password
   arrangement and `AI17Z_BLUESKY_UNSAFE_DEV_ORIGIN`.
4. **Agent packages.** Check `portableAgent` carries no Bluesky credential. It
   should not, since credentials are a separate table and are not exported.
5. **Other places that still say X only**, found while looking and left alone:
   `studio/shared.tsx` ("Connect an X account"), the Lab (`LabView.tsx`,
   `lab.ts` read X only), and the account picker in `SettingsPage` for new accounts.
6. **Outbound media, direct messages, follows, reposts, quote posts.** Out of scope
   in the spec.
