# Notifications

Telling the owner that something needs them.

## The problem this exists for

AI17Z runs on somebody's own computer. That is the point of it, and it is also
the reason a notification is hard: when an account is locked out of X at three
in the morning, the web UI is on a screen nobody is looking at, there is no
server to send an email from, and no account with anybody to send it through.

An agent that stops quietly and waits to be discovered is the failure mode. It
does not look like an outage; it looks like an agent with nothing to say.

## The shape

```
runtime condition
  -> OwnerNotification          does this deserve a person's attention?
  -> dedupe, severity, mute     has it already been said?
  -> transports                 say it
     -> web UI (a poll)
     -> Telegram
```

Each stage is a separate decision and they are made in one place each.

`packages/runtime/src/notify.ts` decides **whether something is worth saying**.
`packages/database/src/repositories/notifications.ts` decides **whether it has
already been said**, through a partial unique index rather than through code.
`packages/runtime/src/notifyTransport.ts` is the last step and only the last
step: it takes something that has already survived both and delivers it.

**No subsystem calls a transport directly.** Not the browser code, not the
poller, not a provider adapter. If they did, the answer to "why did I get eleven
messages about one broken browser" would be spread across eleven files, and each
of them would have to reimplement the mute.

## What is a notification and what is not

- A mention waiting for an answer is the **inbox**. It is work, it is already
  listed, and duplicating it produces two places to clear the same thing — one
  of which will be wrong.
- A job that failed and will retry is **activity**. Nobody needs waking for
  something the system is already handling.
- An account locked out of X, a worker that stopped, an agent with no model:
  these produce no job at all, which is exactly why a screen built out of jobs
  cannot show them. They are what this is for.

Severity is about what happens if it is ignored, never about how alarming the
words are.

| | |
| --- | --- |
| `CRITICAL` | the agent is not working and will not start working by itself |
| `WARNING` | it is working, but something is degraded or about to stop it |
| `INFO` | worth knowing, nothing is broken |

## Transports

A transport is four things: a name, whether it is configured, whether it wants a
given notification, and how to deliver one. Three properties are required of all
of them.

**Failing is not an error anybody else hears about.** A notification is a
courtesy. If Telegram is down, the agent whose job raised the condition carries
on, and the failure is recorded where a person can see it — on the settings
screen, not in a log.

**Delivery never runs inside the raising path.** It is a separate sweep in the
worker, immediately after the notification sweep. A slow HTTPS call cannot hold
a pipeline step open, and a notification raised a moment ago still goes out on
this pass rather than the next.

**Nothing is said twice.** What has been delivered is recorded per transport, so
a transport connected later does not replay a week of history. A notification
declined by a preference is recorded as delivered too — otherwise switching a
category on would send everything it had ever refused, which is the worst
possible first impression of a new setting.

A failure does *not* mark the notification delivered, so a transient outage
delays a message rather than losing it. One failure stops that transport for the
round: if Telegram is rate limiting, the next forty attempts fail identically,
and a transport failing never stops the others running.

## Telegram

Chosen because every call is an **outbound HTTPS request** from the machine
AI17Z runs on. No webhook, so no inbound port, no tunnel, no public hostname,
nothing exposed. A laptop behind a router reaches a phone anywhere with nothing
in the middle that belongs to us.

**It is not a channel.** No agent reads from it, writes to it, or knows it
exists. `packages/channels` carries an agent's identity; this carries the
installation's. Nothing an owner types into Telegram makes AI17Z do anything: a
bot token is a bearer credential and a chat is not an authenticated session.

**It is not a second opinion about what is worth saying.** Everything has
already been raised, deduped and severity-assigned. Telegram only chooses which
categories reach a phone.

### The token

Sealed with AES-256-GCM under `AI17Z_MASTER_KEY`, exactly like a provider API
key. It is typed once into the local UI, is never returned by any API route,
never logged, never in a trace, never in an agent export. Anyone holding it can
read everything the bot has been sent and post as it.

There is deliberately **no fingerprint** in the status either. A fingerprint
confirms a guess, and for a bearer credential that is worth something.

Disconnecting removes the sealed token rather than keeping it "in case". A
disconnected transport holding a live credential is a credential nobody is
watching.

### Pairing, and why there is a code

A bot can be messaged by anybody who knows its username, and `getUpdates`
returns all of it. **Taking the first chat that appears would hand the owner's
notifications to whoever found the bot first** — account handles, failure
reasons, which agent is stopped.

So connecting is two steps. The token is validated against Telegram with
`getMe` before it is stored, because a token that turns out to be wrong three
hours later, silently, at the moment it was needed, is the failure this whole
feature exists to prevent. Then AI17Z shows a six-digit code, and only the chat
that sends that exact code becomes the recipient. The update is acknowledged on
acceptance, so the code cannot be replayed out of the backlog by somebody who
read it over a shoulder.

Incoming messages are read **only** during pairing. Reading them continuously
would make this a channel.

### Catching up

The moment a chat is paired, everything currently open is marked delivered
without being sent, and the confirmation message says how many were left in the
app. Somebody who has just pasted a bot token does not want a fortnight of
history arriving at once; forty messages is how a transport gets disconnected
again immediately.

### The heartbeat

The transport lives in the worker, so the one thing it can never report is the
worker having stopped. A notification that AI17Z is down cannot be sent by
AI17Z, and nothing in a local-first design fixes that from the inside.

So the owner can ask for a message on a schedule, and **absence becomes the
signal**. A heartbeat that does not arrive says what no notification could.

Off by default: a message every six hours saying nothing happened is how
somebody learns to ignore the channel. A heartbeat that fails raises nothing of
its own — the next one will fail the same way, and the silence is the point.

### Formatting

HTML rather than Markdown, because notification text contains handles, paths and
model names, and Markdown's underscores and asterisks turn those into formatting
or into a parse error. Everything interpolated is escaped: an error containing a
`<` would otherwise fail the send, so the notification about the broken thing
would itself be broken.

Link previews are disabled. The action href is almost always a localhost address
the phone cannot reach, so the message says where to go in AI17Z rather than
offering a dead link.

## Adding a transport

Implement `NotificationTransport`, register it in the worker's startup beside
`installTelegramTransport()`, and map any new notification kind to a category.
An unmapped kind falls into `runtime` rather than being dropped, so a condition
added later arrives loud rather than silently undeliverable.

Registration is an explicit list rather than discovery, so the set of things that
can message the owner is something a person can read.
