# Telegram groups as an agent channel

**An agent in a crypto community group.** The owner puts the agent's own bot in a
Telegram group, and the agent answers when it is @mentioned or when somebody
replies to one of its messages. Nothing else in the group is read.

Session 1 built the backend. Session 2 (the end of this page) is the screens and
the operations around it.

This is **not** the owner notification transport described in
[NOTIFICATIONS.md](NOTIFICATIONS.md). That bot speaks for the installation to
its owner and takes their commands from one paired chat. This one speaks for an
agent, in public groups, and takes no commands. They are kept apart on purpose:
see "Two bots, kept apart".

## What it does

A Telegram account is an ordinary `accounts` row with `channel = 'telegram'`.
Its messages are ordinary events, its replies run the ordinary pipeline, and its
actions go through the ordinary action boundary (claim, verify, execute, record).
The adapter in `packages/channels/src/telegram/` is the only code that knows what
a Telegram update looks like.

| File | Owns |
| --- | --- |
| `telegram/client.ts` | Bot API calls, the shapes it answers with, error classification |
| `telegram/normalise.ts` | Update to event, event to context. Pure. Decides what is addressed to the bot. |
| `telegram/index.ts` | The `ChannelAdapter`: poll, verify, send once, react, read a group |
| `runtime/src/telegramBotGuard.ts` | Keeps the agent's bot apart from the notification bot |
| `runtime/src/telegramChannelConnect.ts` | Linking a bot, choosing groups |
| `runtime/src/telegramCapabilities.ts` | The `telegram.*` capabilities |
| `database/src/repositories/telegramChannel.ts` | The token, the groups, the update offset, the outbox |
| `migrations/0116_telegram_channel.sql` | `telegram_bots`, `telegram_chats`, `telegram_outbox` |

Out of scope on purpose: webhooks, private chats, channels, edited messages,
photos and files, inline mode, forum-topic handling beyond replies, a second
scheduler, a second budget engine.

## Setting it up (an owner)

1. **Make a bot for the agent.** In Telegram, message `@BotFather`, send
   `/newbot`, and copy the token it gives you. Use a bot made for this agent. It
   must not be the bot that sends you notifications, and AI17Z refuses that one.
2. **Leave Group Privacy on.** It is on by default. In BotFather: `/mybots`, the
   bot, Bot Settings, Group Privacy, Turn on. AI17Z refuses a bot with privacy
   off, because that bot could read every message in a group and AI17Z only needs
   mentions and replies. While you are there, check Allow Groups is on.
3. **Do not set a webhook** on the bot. AI17Z reads it with `getUpdates`, and a
   webhook means something else is receiving its messages.
4. **Link it.** `POST /api/accounts/telegram` with `{ "token": "..." }`. The token
   is checked with Telegram first, then sealed under `AI17Z_MASTER_KEY`. The
   account's handle is the bot's username.
5. **Add the bot to the group.** Group info, Add member, search the username. If
   you change Group Privacy afterwards, remove the bot and add it again, because
   Telegram applies the setting when the bot joins.
6. **Allow the group.** AI17Z cannot see a chat id anywhere in Telegram's apps, so
   give it a link instead. In the group, long-press any message, Copy Message
   Link, which looks like `https://t.me/c/1234567890/5`. Then
   `PUT /api/accounts/:id/telegram/chats` with `{ "chat": "<that link>" }`. The
   chat id is `-100` followed by the first number (`-1001234567890`), which is
   also accepted. AI17Z checks the bot is a member before it keeps the group.
   Only groups and supergroups can be allowed, not channels or private chats.
7. **Link an agent and decide what it may do.** Link the agent to the account.
   Writes start off: link it with action type `NONE` to give it `READ` and
   `GENERATE` only, then grant `REPLY` on the account when you want it to answer
   (and `REACT` if you want it to react). An agent in review mode asks you before
   each reply.

To stop: `POST /api/accounts/:id/disconnect` drops the sealed token and switches
the account off. The allowed groups are kept. `DELETE
/api/accounts/:id/telegram/chats/:chatId` removes one. After `/revoke` in
BotFather, `PUT /api/accounts/:id/telegram/bot` stores the new token for the same
bot. A different bot is a different account.

`GET /api/accounts/:id/telegram` returns `{ hasToken, botUsername, chats }`. The
token is never returned by any route, logged, or put in a trace or an audit row, and
the tests search every other table for it.

## What the agent reads

The adapter polls with `getUpdates` (long polling, held open for a few seconds,
`AI17Z_TELEGRAM_POLL_HOLD_S`). There is no webhook, so no inbound port, tunnel or
hostname. Only `message` updates are requested. The ordinary poller and the
account's cadence decide when it comes round again.

A message becomes an event only if **all** of these hold, in `normalise.ts`:

- it is in a group or supergroup whose id the owner allowed;
- it was written by a person: no bot, no "via bot", no sender at all;
- it has text (or a caption);
- it @mentions the bot, by a `mention` entity matching its username or a
  `text_mention` of its id, **or** it replies to one of the bot's own messages.

Anything else yields nothing: no event, no row, no log line, and **no reply**.
Telling a stranger that the bot is not allowed in their group would confirm that
it is alive and listening, so a group that was not allowed is dropped silently.
Telegram's own privacy mode already withholds most other messages; this is the
second wall, and it holds if the owner switches privacy off.

| Message | Event type |
| --- | --- |
| @mention of the bot | `MENTION` |
| reply to a message the bot sent (with or without a mention) | `REPLY` |

- Identity is `telegram:<chat id>:<message id>`. It is the `remoteEventId`, the
  `remoteMessageId` and the action target. Message ids are only unique inside a
  chat, so the chat is part of the name. A name is never an identity: the author
  is `remoteAuthorId` (the numeric user id), and the handle falls back to
  `user:<id>` for people with no username.
- The unique index on `events (channel, account, remote_event_id)` makes reading a
  page twice harmless.
- `raw.addressedToAgent` is true: a mention or a reply to the bot is addressed to
  it by definition.
- **The offset.** `telegram_bots.update_offset` is the next `getUpdates` offset.
  The adapter reports one past everything it read, kept or dropped; the poller
  commits it only after the events were ingested, and only if the row's
  `poll_version` has not moved, so a poll that outlived its claim cannot write an
  old offset over a new one. A failure in between re-reads the batch, and the
  event index makes that a no-op.
- **Context.** The Bot API cannot read a group's history or look a message up. The
  only earlier turn is the message being replied to, which Telegram puts inside
  the update. `resolveContext` builds the conversation from that and says so in
  its `note`. An agent that needs more must be told it in the message.

## What the agent may do

`ChannelAdapter.capabilities` is `['REPLY', 'REACT']`.

**Reply** is the ordinary pipeline action behind the `REPLY` grant. The grant is
checked at ingest, so unpermitted work never queues, and again immediately
before execution, where a revoked grant fails the job permanently. A reply goes to
the message that addressed the agent (`reply_parameters`), as plain text, with link
previews off. It is limited to 4096 characters. The adapter verifies, immediately
before sending, that the group is still on the allowed list and that the bot is
still a member and not muted in it.

**Send once.** `sendMessage` has no idempotency key and the Bot API cannot read a
chat back, so the only memory of "this went out" is ours. `telegram_outbox` is
written **before** the request (`SENDING`) and settled after (`SENT`, with the
message it produced):

- a key already `SENT` returns the earlier result and sends nothing;
- a request Telegram **refused** (a 4xx with a JSON error) proves nothing was
  sent, so the row is deleted and the job may try again;
- anything else (a dropped connection, a timeout, a 502) may have been delivered.
  The row stays `SENDING`, and the next attempt goes to a person as a review
  (`telegram_send_unknown`) instead of posting a second copy in a public group.
  `wasAlreadyDone` answers `done: false, conclusive: false` for it, so a recovery
  path does not read it as proof of absence;
- reusing a key with different content is refused.

**429.** Telegram's `retry_after` becomes `PipelineError.retryable` carrying
`retryAfterMs`. The pipeline sends that to `waitForLimit`, which waits the stated
time and charges no attempt. The poller treats it as a floor on the account's
next poll.

**Capabilities.** Model-callable, pinned by `tests/unit/telegramCapabilities.test.ts`:

| Capability | Effect | Default |
| --- | --- | --- |
| `telegram.read_chat` | reads title, description and member count of an *allowed* group | allowed (read, low risk) |
| `telegram.react` | puts one emoji (a closed list) on a message in an allowed group | **disabled** until the owner grants it, and needs the `REACT` grant on the account |

There is no `telegram.reply`, `read_message` or `read_history`: replying is a
pipeline action, and the Bot API has no reads for the rest. A reaction is a
desired state, so setting it twice leaves one; it is claimed as a durable action,
so a second call in the same job reports `alreadyDone`. The toolpack's summary
says that replying is set on the account.

## Two bots, kept apart

| | Notification bot | Agent bot |
| --- | --- | --- |
| Speaks for | the installation, to its owner | one agent, in allowed groups |
| Token | sealed in `settings` (`notifications.telegram`) | sealed in `telegram_bots`, per account |
| Update offset | `updateOffset` in that settings document | `telegram_bots.update_offset` |
| Reads | one paired chat, a closed list of verbs | mentions and replies in allowed groups |
| Code | `telegram.ts`, `telegramApi.ts`, `telegramCommands.ts`, `notifyTransport.ts` (unchanged) | `packages/channels/src/telegram/`, the files above |

If one token served both, each `getUpdates` would acknowledge the other's
messages, a member of a public group could type at the owner's command surface,
and a bot sitting in public groups would be able to read the owner's
notifications. So:

- the agent side refuses the notification bot's token, and any other token for the
  same bot (the numeric id at the front of a token is the bot id), **before**
  Telegram is asked anything;
- the same check runs every time the agent's token is opened, because the owner
  can connect the notification transport to the same bot afterwards and that
  transport does not know about this channel. The poll then fails with
  `telegram_shared_bot`, makes no request, and the account settles at
  `NEEDS_AUTH`;
- `telegram_bots.bot_id` is unique, so one bot cannot be two accounts;
- the offsets live in different stores, and polling one never touches the other;
- `tests/unit/telegramSeparation.test.ts` reads the source and fails if either side
  names the other's tables, settings or modules, and
  `tests/integration/telegramSeparation.test.ts` proves the rest against the
  database, including that text typed to the agent bot never reaches the owner's
  command surface.

## Failure and health

| What Telegram said | What AI17Z does |
| --- | --- |
| 401 / 404 | `telegram_auth_failed`, permanent. The poller moves the account to `NEEDS_AUTH`, which takes it out of the due list, so a revoked token is not polled every few minutes. |
| 403 | `telegram_forbidden`, permanent (removed from the group, or blocked). |
| 409 | `telegram_conflict`, retryable after five minutes: something else is reading this bot or a webhook was set. |
| 429 | retryable with `retry_after`; `waitForLimit` for jobs, a floor for the poller. |
| 5xx, no answer, unreadable | retryable for reads; **unknown** for a send (see above). |
| other 4xx | permanent, with Telegram's reason, never the request. |

Error messages never contain a URL (the token is part of it) or a request body.
The agent start preflight and the health panel treat a Telegram account that is
not `CONNECTED` as a problem, like a signed-out browser account.

## Tests

No test reaches Telegram. `tests/support/fakeTelegram.ts` replaces the HTTP
boundary with a fake Bot API (`getUpdates` that acknowledges by offset, privacy
and webhook settings, memberships, `retry_after`, a delivered-but-lost send), and
everything else is real: the adapter, the repositories, the poller and the
pipeline.

## Session 2

- Screens: link a bot, paste a token, add and remove groups, with the BotFather
  steps shown where the owner needs them; Telegram in the agent setup flows.
- Finding a group without a link: a list of groups the bot was added to (from
  `my_chat_member`), so allowing one is a click and not a copied link.
- Resolving a send that ended without an answer: show the review item with the
  group, and let the owner mark it sent or not sent.
- A dedicated long-poll loop, so latency does not depend on the cadence engine.
- Forum topics: keep a conversation to its topic. Reactions to the agent's own
  messages as signals.
- Photos and captions as context, and per-chat reply spacing for busy groups.
- Real Telegram validation with a throwaway bot in a throwaway group. Session 1
  used no real Telegram request and no real credential.
