# Reading X

One place AI17Z reads X from, and everything that reads X going through it.

> **Not to be confused with `X_INTELLIGENCE.md`,** which is about asking a model
> provider to search X's index server-side during a call. That is a different
> capability with a different failure mode, it is off by default, and it costs
> money. This document is about reading X through the browser the owner is
> already signed in to, which costs nothing and is how everything else works.

## Why it exists

"Learn from this account" was wired to twscrape: a Python library needing a
separate install, a place on PATH inside the worker, and X accounts of its own
in its own credential database. No packaged installation has any of that, so it
reported unavailable everywhere and the feature did nothing.

**The lesson is not that twscrape was the wrong library.** It is that a brittle
scraper was wired directly into a product feature, so when it died the feature
died with it and there was nowhere else for it to go. This layer is that
nowhere-else-to-go, made somewhere.

## The shape

```
packages/channels/src/x/intelligence/
  contract.ts      types, outcomes, provenance, freshness, budget
  pageGraphql.ts   primary backend: X's own JSON, fetched inside the page
  pageDom.ts       fallback backend: the rendered page
  index.ts         the facade, routing, per-capability health
  cache.ts         bounded in-process cache
```

`XIntelligenceBackend` requires only `readiness()` and `resolveUser()`.
Everything else is optional, and **routing is capability by capability rather
than backend by backend** — so one backend losing search does not cost the
product its profile reads.

Capabilities: `resolveUser` · `getUser` · `getUserPosts` · `getPost` ·
`getThread` · `searchPosts`.

Every answer is an `XReadResult<T>` — `{ outcome, detail, data, provenance }` —
and provenance carries which backend answered, when it read, whether it was
cached, and **what it could not see**. A partial answer is never presented as a
complete one.

**Ids are always strings.** A 19-digit X id is past what a JS number holds, and
parsed as one it silently becomes a different id.

## The primary backend asks X for its own data

X's web app fetches its timelines from GraphQL and draws the page from that, so
scraping the drawn page reads a *rendering* of an answer that was already
structured. `pageGraphql` asks for the JSON instead.

**The fetch runs inside the page**, so it goes out as the signed-in session's
own request. Every consequence of that is deliberate:

- No second authentication. No cookie export, no `ct0` paste, no second X
  login, no account pool.
- **No credential ever reaches Node**, so none can reach a log, a trace, a crash
  report or a model. `tests/unit/packagedEnvironment.test.ts` asserts it.
- No new dependency on any platform. It is the browser AI17Z already ships.
- Immutable ids, exact counts, conversation ids, long-form `note_tweet` text,
  and the viewer's own follow relationship with the account being read.

**Operation ids are discovered from X's own loaded bundles**, because a
hard-coded id dies silently as an empty timeline. A miss degrades to the DOM
backend rather than to nothing.

## Falling back is a decision, not a reflex

| Outcomes | What happens |
| --- | --- |
| `SCHEMA_CHANGED`, `UNAVAILABLE`, `EMPTY` | Try the next reader. This is what the rendered page is for. |
| `NOT_FOUND`, `PROTECTED`, `NEEDS_SIGN_IN`, `CHALLENGE`, `RATE_LIMITED` | **Stop.** |

A protected account is protected however it is read; a challenge is a person's
to answer; a rate limit means stop. Retrying those on another backend is how a
read turns into hammering, and in the challenge case it is how an automation
starts arguing with a security check.

**When a fallback does happen the answer says so**, appended to
`provenance.gaps`. A persona built from approximate data is a smaller claim than
one built from exact data, and the difference has to survive the trip.

Every consumer implements the same three-way split, in the layer's own
vocabulary rather than re-deriving it:

- `packages/channels/src/x/radarIntelligence.ts` — a refusal ends the poll; it
  does not send a monitor to scroll the same page.
- `packages/channels/src/x/read.ts` — a refusal becomes a classified
  `PipelineError`, so a rate limit is retried later, a missing post never is,
  and a sign-in goes to a person.

## What reads through it

| Consumer | What it asks for |
| --- | --- |
| Persona import (`apps/worker/src/personaFromX.ts`) | Identity, then a bounded authored timeline. One collector for both "Learn from this account" and the advanced screen's sync. |
| Radar monitors (`radarIntelligence.ts`) | `mention_search`, `reply_search`, `tracked_keyword` and `tracked_account`. `notifications` and `own_threads` read surfaces the layer has no operation for and stay on the page. |
| X capabilities (`packages/runtime/src/xCapabilities.ts` via `x/read.ts`) | `x.read_post`, `x.read_thread`, `x.read_profile`, `x.search`. |
| People (`apps/worker/src/accountIntelligence.ts`) | A profile and recent posts, recorded so a screen can show somebody without reading X per card. |

**Nothing else may read X directly.** A feature that needs something the layer
does not expose extends the layer.

## What the radar gained, and why it mattered

The monitors scraped a rendered page, which carries neither the author's numeric
id nor an exact engagement count. Both absences travelled the whole way down and
each met a piece of code that had been waiting years for it:

- `events.remote_author_id` was null for everything discovered, so relationship
  memory could only key on a handle — and somebody who renames themselves became
  a second person, the exact discontinuity the relationships table exists to
  prevent.
- `findOpportunities` has weighed a crowded thread against an empty one since it
  was written. Nothing ever populated a reply count.

`tests/integration/radarEvidence.test.ts` asserts the whole trip rather than any
one hop of it.

**An absent count still means absent.** A rendered article abbreviates counts to
"1.2K", so a backend that cannot see an exact number reports none — and none
must never arrive downstream as a zero, or every unmeasured post becomes an
apparently empty thread worth speaking into.

## Cache and freshness

`resolveUser` is cached; `getUserPosts` deliberately is not — a collection asks
once, and holding megabytes to serve a rare repeat costs more than it saves.
`FRESHNESS_SECONDS`: LIVE 60s, RECENT 10m, MODERATE 6h, ARCHIVAL 7d, and **the
caller chooses**, because an engagement chance goes stale in minutes and last
month's posts describe a voice just as well as today's.

**Refusals are never cached.** A cached "rate limited" goes on being true after
it stops being true.

The cache is module-global and lives in the worker's memory. That is why
`x_account_observations` exists: the API owns no browser and cannot ask, so a
People screen has to read what was recorded rather than read X per card. See
`DATA_MODEL.md`.

**Watch out in tests:** call `forgetXReads()` in `beforeEach` when resolving the
same handle twice, or eight routing tests pass alone and fail together.

## What it must never become

There is **no post, like, follow, repost or message anywhere in this contract
and there must never be.** Acting on X belongs to the engagement pipeline,
behind its policies, approvals, exact-target verification and audit trail. A
read layer that grew a `follow()` would route around every one of them, and the
fact that a third-party library happens to expose one is not a reason to.

`tests/unit/xIntelligenceRouting.test.ts` pins the exact exported surface, and
`tests/unit/xCapabilities.test.ts` pins the exact set of `x.` capabilities. A
new method or a new capability fails a test until somebody writes it down
deliberately, which is the review this most needs.

Nothing here evades anything: bounded reads at ordinary speed through a session
somebody signed in to themselves. No CAPTCHA solving, no challenge answering, no
fingerprint spoofing, no account rotation, no proxy rotation.
