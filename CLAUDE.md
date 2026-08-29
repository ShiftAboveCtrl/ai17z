# CLAUDE.md

Guidance for Claude Code working in this repository.

## The rename: XBAM became AI17Z

Product name, UI, and documentation say AI17Z. These deliberately still say XBAM,
because they carry data or wiring and renaming them would break a working install:

| Kept | Why |
| --- | --- |
| `@xbam/*` package names | Internal only; renaming touches every import for no user benefit |
| Postgres database `xbam`, volumes `xbam_*`, compose project | Renaming means migrating or losing data |
| `XBAM_*` environment variables | Still read, in both directions, see below |
| `VITE_XBAM_API_URL` | Build-time wiring |

`applyBrandCompatibility()` in `packages/shared/src/env.ts` mirrors every
`XBAM_*` variable to `AI17Z_*` and back, explicit values always winning. The
master key resolves `AI17Z_MASTER_KEY` first and falls back to
`XBAM_MASTER_KEY`, so secrets sealed before the rename stay readable.
`tests/unit/brandCompat.test.ts` proves it. Never break that fallback.

## What AI17Z is

A local-first platform for running autonomous agents. An agent is an identity, a
memory, a model, a policy, and a set of channels it can act on. The runtime is
generic: X, OpenRouter, a persona, and a reply are all configuration.

AI17Z descends from a working system called AI4CZ, which lives at
`C:\Users\ta0as\OneDrive\Desktop\ai4cz`. AI17Z kept its ideas and replaced its
architecture.

## Hard boundary: the legacy directory

`../ai4cz` is **immutable evidence**. Read it. Never write to it, install into
it, format it, rebuild it, migrate it in place, or copy secrets out of it.
`tools/import-ai4cz` opens its SQLite database read-only and touches nothing
else. If you change the importer, re-verify with a file listing diff before and
after a run.

## Commands

```bash
npm run db:up              # Postgres in Docker on port 55432
npm run migrate            # apply pending migrations
npm run migrate:status     # show applied / pending / drifted
npm run dev                # api + worker + web together
npm run dev:api            # http://localhost:8787
npm run dev:worker         # job worker, channel poller, browser tasks
npm run dev:web            # http://localhost:5173
npm run typecheck          # tsc over every package and app
npm test                   # vitest: unit + integration (needs Postgres)
npm run import:ai4cz -- --dry-run
```

Integration tests use a sibling `xbam_test` database, created automatically from
`DATABASE_URL`. They truncate between cases, so never point `DATABASE_URL` at
data you care about.

## Architecture

```
apps/api      Fastify HTTP layer. Owns no browsers.
apps/worker   Job worker, channel poller, browser task runner. Owns all browsers.
apps/web      React SPA.

packages/shared      Isomorphic zod contracts + node-side crypto/logger/env.
packages/database    pg pool, migrator, one repository per domain.
packages/jobs        Postgres queue: claim, lease, recover, back off.
packages/models      Model gateway + provider adapters.
packages/memory      Six memory scopes, retrieval, write policy.
packages/prompts     Ten-layer prompt engine.
packages/channels    ChannelAdapter contract, mock channel, X adapter.
packages/browser     Playwright session manager, failure screenshots.
packages/persona     Corpus normalising, scoring, and trait derivation.
packages/tools       Tool contract and built-in tools.
packages/runtime     Validator, policy gates, ingest, pipeline state machine.
```

Internal packages export TypeScript source directly and run under `tsx`. There
is no build step for them. `apps/web` is the only thing that bundles.

### The rule that keeps this clean

Nothing downstream of a channel adapter may know what X looks like. No selector,
no cookie, no vendor payload leaves `packages/channels`. Memory, prompts, policy,
and job state operate only on the normalised shapes in
`packages/shared/src/contracts`.

## Job state

Jobs advance through settled states, each committed before the next step starts:

```
RECEIVED -> CONTEXT_RESOLVED -> MEMORY_RESOLVED -> GENERATED -> VALIDATED
         -> EXECUTED | DRY_RUN_COMPLETED
```

`*_ING` states are held under a worker lease. If the lease expires, the recovery
sweep returns the job to the settled state before that step (`IN_FLIGHT_RESUME`
in `contracts/enums.ts`). This is why a restart resumes rather than restarts.

Failures are classified, never guessed:

- `PipelineError.retryable` schedules a jittered backoff and keeps the job
- `PipelineError.permanent` stops the job with a reason
- `PipelineError.review` sends it to a person

Anything that escapes classification is treated as retryable and logged.

## Idempotency

Three layers, all enforced by unique indexes rather than by application logic:

1. `events (channel, account, remote_event_id)` — an event is recorded once
2. `jobs.idempotency_key` — one job per event per action per agent
3. `actions.idempotency_key` (partial, real actions only) — one remote action

Plus `actions.content_signature` to suppress identical text to the same target,
and `legacy_action_ledger` for signatures inherited from AI4CZ, which used sha1.

When you touch execution, ask: can this send the same message twice?

## Database rules

- Schema changes go in a new numbered file in `migrations/`. Never edit an
  applied migration; the migrator reports drift and refuses to re-run it.
- Multi-table writes go through `withTransaction`.
- Foreign keys and unique constraints are the contract. Do not work around them
  in application code.
- Trace events reference `jobs`, and trace writes use their own connection, so
  never emit a trace for a row that is still inside an open transaction.

## Browsers

Only the worker opens a browser. A Chromium profile can be held by one process
at a time, so the API records intent in `browser_tasks` and the worker executes
it. If you add a session action, add it there, not to the API.

Playwright is pinned exactly, in three places that must move together:
`packages/browser/package.json`, `docker/worker.Dockerfile`, and the root
`@playwright/test`. The image ships binaries for one release only, so a caret
range means the container fails on first launch with a missing-file error that
never mentions versions. `tests/unit/playwrightVersion.test.ts` enforces it.

A containerised worker cannot drive a browser on the host. For real sessions, run
the worker on the machine that has the browser. See
`docs/operations/BROWSER_SESSIONS.md`.

## Secrets

Provider API keys are sealed with AES-256-GCM under `AI17Z_MASTER_KEY` and are
readable only through `providers.getDecryptedApiKey`. They must never appear in
an API response, a log line, an audit row, or a trace. `redact()` in
`packages/shared/src/logger.ts` blanks anything key-shaped.

## Cadence

Timing is per account, versioned, and lives in the database. There is one engine
(`packages/runtime/src/cadence.ts`) and every question about when something may
happen goes through it. Do not add a second timer.

The poller has no schedule: it asks which accounts are due, and the claim moves
`next_poll_at` forward in the same statement, which is what stops two workers
polling one account and stops a restart stampeding every account at once.

Account ceilings and agent `policy.rate` limits both apply and the tighter wins.
The verdict must name which one bound.

Quiet hours cover reading as well as acting, and an unusable timezone fails
open. An agent that visibly ignores a bad setting beats one that mysteriously
stops. See `docs/architecture/CADENCE.md`.

## Capabilities

`agent_accounts.action_type` says what an agent *attempts*.
`agent_account_capabilities` says what it *may do*. Keep those separate.

Capabilities are checked twice: at ingest, so unpermitted work never queues, and
again immediately before execution, because a grant revoked while a job is
queued has to stop that job. The second check fails the job **permanently** —
retrying cannot restore a revoked permission. Do not remove either check.

`linkAgentAccount` grants the defaults itself. A link with no grants is an agent
that silently does nothing. See `docs/architecture/CAPABILITIES.md`.

## Browser engines

Modes are named after the **binary**, never after the arrangement. "Managed
profile" said nothing about what was running, and its default meant Playwright's
Chromium while the UI implied otherwise.

| Engine | Binary |
| --- | --- |
| `GOOGLE_CHROME` | the installed `chrome.exe`, spawned by AI17Z, attached over CDP |
| `MICROSOFT_EDGE` | the installed Edge, same arrangement |
| `PLAYWRIGHT_CHROMIUM` | Playwright's bundled Chromium, chosen deliberately |
| `CUSTOM_CDP` | whatever is at a URL somebody supplies |

**There is no fallback between them.** Asking for Google Chrome and getting
Chromium because Chrome was missing is a failure with instructions, never a
substitution. `findBrowser` refuses a binary whose version resource does not say
Google Chrome, even at a Chrome-shaped path.

**Real Chrome is spawned, then attached — not launched by Playwright.** This is
what AI4CZ and AI4YI did and it buys two things: Chrome outlives the worker, so
restarting AI17Z does not close a window somebody is signing into; and AI17Z
picks the executable itself, so it can report which binary is running rather
than trusting a resolver. See `docs/legacy-real-chrome-analysis.md`.

**Identity is proved by two independent signals**, both stored and shown: the
executable AI17Z chose, and what the running browser reported over CDP. A claim
resting on one of them is a claim taken on trust.

**Chrome refuses `--remote-debugging-port` on the default profile directory
since version 136.** Every CDP path needs its own `--user-data-dir`.

**The debug port binds to loopback.** AI4YI's one refinement over AI4CZ, and the
reason: a debug port reachable from the network is a signed-in browser anyone
can drive.

**A stored profile path is not trusted across machines.** The containerised
worker writes `/app/...`, which on Windows becomes `C:pp\...` — a second,
empty profile with none of the session in it. `resolveProfileDir` derives the
path locally from the account id.

**Launching is locked per account.** Two callers arriving together used to start
two browsers. Across processes the account lease is the guard; in-process it is
`openOnce`.

**Chrome must be closed gracefully before it is killed.** Cookies and local
storage are flushed on a clean shutdown, so force-killing a browser somebody
just signed in with loses the session that was the point. And killing only the
spawned pid leaves renderers holding the profile lock, after which the next
launch hands off to the old instance and exits without opening a port.

**Profile seeding does not carry a login on Windows and must never be the
onboarding path.** Chrome 127+ App-Bound Encryption ties cookies to Chrome's own
identity. Kept as an experimental fallback that says so when it runs.

**Attaching to a running Chrome is not implemented.** Chrome 144 can hand a live
session to an agent after an explicit permission at
`chrome://inspect/#remote-debugging`, but the mechanism is not documented well
enough to build against. It is shown as unavailable rather than offered.

**Tests that use Playwright Chromium prove nothing about Chrome.** Only
`tests/integration/realChrome.test.ts` may be cited as evidence, and it skips
loudly rather than passing where Chrome is absent.

**PowerShell scripts must stay ASCII**, and must kill process **trees**. A `.ps1`
without a BOM is read as ANSI and an em dash becomes a smart quote that
terminates a string; and `npm run dev:worker` starts tsx which starts the worker,
so killing the recorded pid leaks the one that matters.

## Sign-in and security challenges

**AI17Z never types a password and never answers a security challenge.**

When a service asks for a CAPTCHA, a second factor, an emailed or texted code, a
hardware key, confirmation of an unusual login, or presents a locked account, the
account enters `CHALLENGE_REQUIRES_USER`, the window is left open and untouched,
and the watcher stops reading the page. There is no setting for this and no code
path around it.

`observeAuthPage` only looks — it has no branch that clicks, fills, or dismisses
anything, and `tests/unit/authObservation.test.ts` fails if any of those are
called. A challenge is checked before the login form, because several challenge
screens also carry an input box.

`CHALLENGE_REQUIRES_USER` must stay out of `ACCOUNT_STATUSES_IN_PROGRESS`, or the
watcher will keep polling a page somebody is typing a code into.

All platform-specific knowledge of what a challenge looks like stays in
`packages/channels/src/x/selectors.ts`. See `docs/architecture/SIGN_IN.md`.

## Persona sources

Source material is evidence, not memory. Raw corpus items never enter a prompt;
derived traits do, and every trait cites the items it came from. A trait without
evidence is an assertion.

Fingerprint before scoring, so duplicates collapse before they can weight
anything. Never exclude on length alone — a two-word reply can be the strongest
signal there is. Keep excluded items: exclusion decides what to learn from, not
what to remember. See `docs/architecture/PERSONA_SOURCES.md`.

## The social layer

The provider supplies intelligence; AI17Z supplies identity. Everything below
exists so the same agent reads as the same agent whichever model wrote the
draft. `docs/architecture/SOCIAL.md` is the full account.

**Silence is a branch, not an error.** `ENGAGEMENT_DECISION` has three wired
outcomes. A decision not to reply ends the job as `CANCELLED` with its reasons
recorded — never as a thrown failure.

**The reasons matter more than the scores.** "Reply value 18" tells nobody
anything. Every heuristic here carries the factors that produced it through to
the UI, and a score without its reasons is not shippable.

**Identity is the post, not where it was found.** Several radar monitors will
see the same mention; the reconciler merges on the remote status id and the
existing unique index is what makes that safe. Never add a second event store.

**Media that could not be read is an explicit gap.** The prompt says so and the
model is told to admit it. Never let an unread image pass silently.

**Vision uses the `vision` role only.** Falling back to the primary model sends
an image to something that cannot read it and gets a confident description of
nothing.

**Relationships and stances are learned from what was published.** Not from
drafts, not from dry runs. A dry run is explicitly not a public position, and an
unanswered mention is not a conversation.

**A changed stance supersedes rather than overwrites.** The old row is what lets
the agent say it changed its mind. Only a straight reversal of a firmly held
position is a conflict — an agent that cannot move from certain to hedged is
stuck, not consistent.

**The voice fingerprint is measurements, not adjectives.** "Tone: dry" is a
label each provider reads differently. The free deterministic pass runs whatever
the voice score is, because the score cannot see a helpdesk sign-off on a
correctly-sized reply. A rewrite that scores worse is discarded, and a failed
rewrite never fails the job.

**The generic-AI score is about register, never about origin.** It must never be
presented as evidence that text was machine-written.

**Hostility is met with DEFLECT, never CHALLENGE.** Escalating is how an agent
ends up in a fight on its owner's behalf.

**Nothing infers anything sensitive about anybody.** Relationship memory holds
what happened between the agent and a person; the entity graph records that two
things were named together and makes no other claim.

## The three-tab X runtime

One page doing everything is why reading used to break posting. An account keeps
three role-bound tabs in the one real Chrome: `ACTION` for replies, posts and the
verification before them; `MENTIONS` for search and own threads; `NOTIFICATIONS`
for X's own surface as an independent source.

A tab is identified by `window.name` (`ai17z-tab:<ROLE>`), not by an in-process
map, so a worker reattaching to a running Chrome adopts the tabs it already has
instead of opening three more every restart. Every lease re-asserts the tag,
because a cross-origin navigation clears it.

Different roles run concurrently; two operations on the same role queue behind
each other. A closed tab is recreated on its own without restarting the browser
or touching the other two. **Never add a fourth role without a reason a person
would recognise**, and never let a monitor navigate the action tab.

The worker publishes tab health to `browser_sessions.tabs` every ten seconds,
because the API owns no browsers and cannot ask. Anything older than 90 seconds
is treated as "no browser running" whatever the snapshot says. See
`docs/architecture/X_RUNTIME.md`.

## Nested mentions and conversation context

Target identity and semantic context are separate problems, and conflating them
is how an agent replies to the wrong person. `ResolvedContext.targetRef` is the
action target, derived from the incoming post's own status id;
`ResolvedContext.conversation` is context and may never influence where an action
goes. The X adapter asserts they agree and fails permanently if they do not.

The focal post is found by looking for the article that links to its own status
id, exactly as AI4CZ did, and **there is no positional fallback**: no match means
`focal_article_not_found` and a stop.

What AI4CZ did not do, and `packages/channels/src/x/conversation.ts` does: walk
the whole ancestor chain. On a status page X has already resolved the reply chain
and renders the path from root to focal above it, so the ancestors are "the
articles before the focal" and sibling branches are excluded structurally rather
than filtered afterwards.

`resolveBranch` is pure and takes article snapshots, so eleven fixtures in
`tests/unit/xConversation.test.ts` pin the behaviour rather than a live browser.
Case 4 — a mention four levels deep — is the AI4CZ regression. See
`docs/legacy-nested-mentions.md`.

## Easy Mode

Easy Mode is a view over the same configuration, not a second system. There is no
`easy_setup` table: `packages/runtime/src/easyMode.ts` projects eleven answers
onto the same versioned persona, policy, cadence, radar sources and posting
schedule the advanced screens edit, and reads them back.

Two properties, both tested. The round trip is a fixed point, so opening the
setup screen and pressing save does not change an agent. And the projection is
deliberately partial in one direction: Advanced can express things Easy has no
word for, and `readEasyView` reports each in a sentence instead of flattening it.
**An Easy Mode save must never overwrite a setting it does not show.**

Easy Mode simplifies configuration, never intelligence. An agent set up there
still gets relationship memory, stance consistency, thread context, multimodal
context, the voice compiler, anti-repetition, multi-source discovery and
exact-target verification. Do not add an Easy Mode control that turns one off.

Every Easy Mode control must map to something a code path actually reads. "Only
verified accounts" sat in the contract with nothing behind it until
`content.requireVerifiedAuthor` and the audience gate existed. See
`docs/architecture/EASY_MODE.md`.

## Posting

An agent may say something nobody asked for, on a schedule that is a ceiling
rather than a timetable. Coming due means looking at the idea backlog; an empty
backlog means silence, and `agent_posting.last_reason` records that. **A timer
firing is not a reason to speak.**

A post is manufactured as a `SCHEDULED_TRIGGER` event carrying the brief, so it
runs the same ten pipeline steps as a reply. Its idempotency key is anchored to
the idea. A post has no target, so its content signature is taken against the
account — without that, the "already sent this exact text" check simply does not
apply to posts.

## Enums with CHECK constraints

Four enums have a database CHECK behind them: account statuses, trace types,
pipeline node kinds, and model roles. Growing one without widening its
constraint fails at the database and passes every unit test — it has cost a
broken sign-in once already.

`tests/integration/statusConstraints.test.ts` writes every value of every one of
them. Add to it when you add an enum with a constraint.

## Long operations

Anything that can outlast a person's patience shows what it is doing, how long
it has been doing it, and how to stop. `Working` and `RetryablePanel` in
`apps/web/src/components/ui.tsx` exist so that is one decision, not twenty. A
bare spinner on a multi-second operation is a bug.

Machine-generated text — file paths, stack frames, box-drawing rules — must wrap
(`break-words`) wherever it is displayed, or it pushes the layout wider than a
phone.

## Identity policy

The platform default is that an agent may not claim to be human. AI4CZ hard-coded
the opposite into its prompt; AI17Z makes it an explicit, versioned policy field
(`identity.mayDenyBeingAI`, default false) that the validator enforces. Do not
add a code path that bypasses it.

## Conventions

- `verbatimModuleSyntax` is on: use `import type` for type-only imports.
- Errors carry a class and a human sentence. `500 Internal Server Error` is not
  an acceptable thing for a user to read.
- Comments explain why, not what. If a constant was chosen for a reason, say the
  reason.
- No `any`, no empty `catch {}` without a comment explaining the deliberate
  swallow, no `console.log` outside the logger.

## Testing

- Unit tests for pure logic: validators, normalisers, extractors, prompt render.
- Integration tests run against real Postgres, because unique indexes carry the
  guarantees and a mock would test the wrong thing.
- New runtime behaviour needs a test that would fail without it.
