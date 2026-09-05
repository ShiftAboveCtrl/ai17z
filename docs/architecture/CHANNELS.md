# Channels

## The contract

A channel adapter is the only part of AI17Z that knows what a specific platform
looks like:

```ts
interface ChannelAdapter {
  connect(ctx): Promise<ConnectionResult>;
  disconnect(ctx): Promise<void>;
  healthCheck(ctx): Promise<HealthResult>;
  ingestEvents(ctx, options): Promise<NormalizedEvent[]>;
  resolveContext(ctx, event): Promise<ResolvedContext>;
  verifyAction(ctx, request): Promise<VerificationResult>;
  executeAction(ctx, request): Promise<ActionResult>;
  captureDiagnostics(ctx, reason): Promise<DiagnosticCapture | null>;
}
```

Nothing platform-specific may cross this line. No selectors, no cookies, no
vendor payloads. Everything downstream sees `NormalizedEvent` and
`ResolvedContext`, which are the same shape for every channel.

## Mock

Complete and deterministic, with no external dependency. Events are injected
through the API rather than polled. It runs the entire pipeline — context,
memory, prompt, model, validation, verification, execution, trace — with no
network, no credentials, and no way to touch a real account.

This is not a stub. It is how the runtime is developed and tested, and how a new
user watches an agent think before connecting anything.

## X

A production-grade reference adapter, ported from the parts of AI4CZ that
demonstrably worked.

**Exact target resolution** is the idea worth keeping. Every target is
normalised to one canonical form:

```
1234567890123
https://twitter.com/u/status/1234567890123?s=20
https://x.com/u/status/1234567890123/photo/1
        -> https://x.com/u/status/1234567890123
```

Acting means anchoring to the exact post by status id:

```
article[data-testid="tweet"]:has(a[href*="/status/<id>"])
```

and never to whatever is visible first. If the article cannot be found, the
adapter refuses. A reply sent to an unverified article is worse than a reply that
never goes out.

**Before acting** the adapter checks that the page is not a deleted-post page,
that the anchored article really reports the expected status id, and that its
author is not this account. Only then does it open the composer.

**After acting** it reads back, looking for its own reply. The legacy poster
treated "the modal closed" as success; here that only begins verification.

**On failure** it captures a screenshot, attaches it to the failing action, and
records a diagnostic you can open from the job page.

Selectors live in `packages/channels/src/x/selectors.ts`. When X changes its
markup, that is the file to edit.

### What the X adapter deliberately does not do

The legacy project contained roughly 900 lines of humanisation: randomised typing
cadence, mouse drift, simulated video watching, adaptive hibernation, night-time
sleep. AI17Z keeps short randomised settle delays, because the X timeline is
virtualised and acting on a stale frame is the single largest source of flaky
automation. It does not reimplement the rest. Evading platform protections is
not a product feature here.

### Status

The X adapter is written but has not been run against a live signed-in account.
Its pure logic is unit tested; its browser behaviour is not, and X markup changes
without notice. Treat the first live run as a dry run.

## Not implemented

Discord, Telegram, Slack, email, and generic HTTP webhooks appear in the channel
enum and the account schema but have no adapter. Selecting one produces a clear
error naming the implemented channels rather than failing obscurely.

Adding one means implementing the eight methods above and registering it. Nothing
else in the system needs to change.

## Sessions

Channels that drive a browser get a session, in one of two modes:

- **Managed** — AI17Z launches Chromium against a persistent profile directory it
  owns, one per account.
- **CDP** — AI17Z attaches to a Chrome you started yourself with
  `--remote-debugging-port`.

The adapter does not care which. In both cases AI17Z never handles the account
password: "Open sign-in" opens a real window on the login page and the person
signs in themselves.

Because a Chromium profile can only be held by one process at a time, the API
never opens a browser. It records intent in `browser_tasks` and the worker
carries it out.
