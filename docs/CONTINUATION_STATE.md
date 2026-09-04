# AI17Z Continuation State

Operational continuity for the next session. Not a progress report. Update it
whenever the execution state materially changes.

## Canonical source

- Path: `C:\Users\ta0as\OneDrive\Desktop\XBAM`
- Branch: `main`
- Current commit: `1773282`
- Unpushed commits: 41 (deliberate; the release state is not coherent yet)

### Ports: this checkout owns the defaults

| | Postgres | API | Web |
| --- | --- | --- | --- |
| XBAM (development) | 55432 | 8787 | 5173 |
| ai17z-test (running installation) | 55532 | 8887 | 8090 |

The installation was moved off the defaults on 2026-09-04 so the two can never
collide. Before that, `npm run migrate` from this checkout read a DATABASE_URL
pointing at 55432 and applied three unreleased migrations to the live system
while reporting only "Applied 3 migration(s)". The CLI now prints
`host:port/database` before it does anything.

There is no third database. The ad-hoc scratch container on 55460 is gone;
tests derive their own per-process database from DATABASE_URL, so they run
against 55432 and never touch `xbam` itself.

## Golden runtime

- Path: `C:\Users\ta0as\ai17z-test`
- Commit it is running: `f768553`
- Schema: its own checkout has 47 migrations; the database also carries
  0048-0050 from the mistake above. Harmless: all three are additive, and the
  migrator iterates over files, so applied rows without a file are ignored.
- Ports: 55532 / 8887 / 8090. Open it at http://localhost:8090
- Agent: Ava, account `@ai17zos`, ACTIVE
- **DO NOT MODIFY DIRECTLY. DO NOT PROMOTE YET.**

Its native worker executes `C:\Users\ta0as\ai17z-test` source, verified: that
checkout has no `packages/browser/src/watchdog.ts` and zero references to
`superviseSession`. Restarting it therefore runs the old code and applies none
of the XBAM fixes. The isolation model is intact.

Known condition, not yet fixed there: its Chrome holds ~15 pages, twelve of them
the same `x.com/home` timeline, which is the accumulation the reconciliation work
in XBAM fixes. It arrives with the controlled promotion, not before.

## Development database

- `postgres://xbam:xbam@localhost:55432/xbam`, container `xbam-postgres-1`,
  brought up with `npm run db:up`. This is the .env default, so no command
  needs an override any more.

## Completed sections

§0-2 preservation and audit · §4-13 query planner, evidence, authority ranking ·
§14-19 TokenResolver and disambiguation · §20-29 knowledge end to end, with
AI17Z's own docs as the proving case · §30-36 Easy/Advanced reconciliation ·
§37-40 tool policy diagnostics · §41-47 provider states, model discovery, xAI ·
§48-49 rename and model removal · §50-52 autosave and version semantics ·
§53-56 shared validation contract · §57-58 performance · §71-75 browser
recovery, watchdog, tab reconciliation

## Partial sections

- **§115** migrations: 49 apply cleanly to an empty database. The representative
  existing-database upgrade has NOT been done and is required before promotion.

## Remaining sections

- §59-70 posting, content brain, idea queue, Outreach
- §76-91 supervisor, desktop launcher, tray, installer, updates, release flow
- §92-113 remaining ultimate-agent features
- §114+ final validation, three frozen runs, promotion

## Current exact task

§76-91 in progress. Done so far: the worker component in health, the supervisor
(process supervision plus a heartbeat watchdog), restart, update, and a
launcher with a Start Menu entry.

Left in §76-91: the release flow -- version stamping, checksums, tags, and a
release-cleanliness check. No tray application; the Start Menu launcher covers
what a tray would have, and a tray needs a native shell nothing else here
requires. §82 (code signing) stays user-blocked on a certificate.

Then §92-113, then §114+.

What §59-70 came to, for the record. The posting pipeline itself was already
complete and correct end to end; everything broken sat either side of it:

- the idea lifecycle -- a claimed idea had no way back, so every failure
  silently spent one and the agent went quiet claiming an empty backlog
- idea ageing and a shelf life, since the claim took the oldest thought first
- the harvester, which captured questions that could never have become a post:
  eighteen of twenty-seven in a real backlog
- the Content screen, which did not exist
- radar typing 'POST' as MENTION, so watching an account meant replying to
  everything it posted as though addressed
- context-only sources discarding what they found instead of keeping it
- outreach as a first-class decision with its own bar, cap, cooldown and
  review mode, rather than inheriting "answers every mention\"

## Uncommitted work

None. Working tree clean at `67d562b`.

## Important discovered invariants

- `window.name` is not durable identity for a tab; a cross-origin navigation
  clears it. Adoption reconciles by tag, then by page shape, and closes what
  nothing claims. Never closes a sign-in, challenge, composer or blank tab.
- Settings must be read under the branded name (`AI17Z_*`). Reading `XBAM_*`
  directly makes an explicitly set `AI17Z_*` silently ignored, because every
  pre-rename `.env` still carries the legacy name.
- Every API route answers 200 with an `{ ok, data }` envelope; `ok()` sets the
  status, so a `reply.code()` above it is discarded.
- One content hash, exported from `memories.ts`. A second implementation made a
  knowledge refresh delete everything it had just written.
- Providers disagree on the status for a rejected key: xAI answers 400, not 401.
  Classification reads the body as well as the status.
- Retrieval ranks by the rarest query term first; `ts_rank` alone lets a common
  word outrank the term that identifies the answer.
- Research is bounded to 60s total across all lookups. Unbounded it averaged
  636s and reached 7,985s against 5.3s for generation.
- An Easy Mode save must never reset a field only Advanced can set.
- Compare configuration by content, never by `JSON.stringify`. A document read
  back from jsonb has its keys in a different order, so a literal comparison
  reports a change on every save. `sameContent` in `@xbam/shared`.
- Owning an agent is not permission to write a row id. Scope a sub-resource
  write by agent in the SQL, not in the route.
- Adding a package `exports` subpath needs a matching vitest alias, listed
  before the bare package name. `packageExports.test.ts` enforces both.
- A claimed content idea must have a way back. Five endings, and the one that
  matters has no code running to hook, so it is reconciled rather than hooked.
- Speaking first is not answering. Every engagement strategy is written about
  mentions, so applying one to a watched keyword makes a spam machine.
- One switch, never two that have to agree in different screens. The outreach
  policy alone decides whether KEYWORD_MATCH triggers; nothing is kept in sync.
- A setting nothing reads is a capability the product does not have. Check for
  a code path before shipping a control.
- A process being alive is not a worker running. `tsx watch` kept a dead
  worker's process up; the heartbeat is the only thing that tells them apart.
- Never hardcode a port in a script. Three separate instances so far: the start
  script's readiness poll, its Open line, and a doctor remedy.
- Ask whether an operation can succeed before stopping anything for it.

## Known defects still open

- Browser-pane screenshots return black frames in this environment. Verify
  through the DOM instead; it is more precise anyway.

## Migrations

- Latest: `0050_content_idea_lifecycle.sql`
- Empty database: 50 applied, 0 skipped, no drift
- Existing-database upgrade: NOT YET RUN

## Test baseline

- Last full run at `8c5c87d`: 1265 passed, 0 failed
- Typecheck: clean (verify by exit code, never by grepping for "error TS" —
  tsc colourises between the words)
- Command: `npm test` (the .env default is now the right database)

## User-blocked items

- **§82 code signing.** Needs an OV or EV certificate the user purchases
  (DigiCert or Sectigo, roughly $200-600/year; EV carries SmartScreen
  reputation immediately, OV earns it). Everything around it — installer,
  deterministic packaging, checksums, signing hooks, timestamping, release
  workflow, documentation — is buildable without it and is not blocked.

## Golden-runtime promotion status

NOT STARTED. Requires, in order: representative database upgrade proven on a
copy, release-candidate validation, three frozen-source runs on one commit,
release cleanliness check, backup of the real `ai17z-test`, then promotion.
