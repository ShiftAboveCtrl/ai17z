# AI17Z Continuation State

Operational continuity for the next session. Not a progress report. Update it
whenever the execution state materially changes.

## Canonical source

- Path: this checkout
- Branch: `main`
- Current commit: `337bad8` plus the version work
- Unpushed commits: 45 (deliberate; the release state is not coherent yet)

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

- Path: `~/ai17z-test`
- Commit it is running: `f768553`
- Schema: its own checkout has 47 migrations; the database also carries
  0048-0050 from the mistake above. Harmless: all three are additive, and the
  migrator iterates over files, so applied rows without a file are ignored.
- Ports: 55532 / 8887 / 8090. Open it at http://localhost:8090
- Agent: Ava, account `@ai17zos`, ACTIVE
- **DO NOT MODIFY DIRECTLY. DO NOT PROMOTE YET.**

Its native worker executes `~/ai17z-test` source, verified: that
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

None. §115 is done -- see "The existing-database upgrade, in full" in
`docs/final-validation-matrix.md`.

## Remaining sections

- §59-70 posting, content brain, idea queue, Outreach
- §76-91 supervisor, desktop launcher, tray, installer, updates, release flow
- §92-113 remaining ultimate-agent features
- §114+ final validation, three frozen runs, promotion

## Current exact task

§76-91 is done except code signing. Begin §92-113.

What it came to: the worker component in health (a stack with a dead worker
reported healthy on every component it had), the supervisor with a heartbeat
watchdog (a process being alive is not a worker running), restart, update,
a launcher with a Start Menu entry, the release-cleanliness check, and a
version an installation can actually report.

No tray application. The Start Menu launcher covers what a tray would have, and
a tray needs a native shell nothing else here requires. No checksums or release
artefacts either: installation is a git clone, so there is no artefact to
checksum -- `npm run release:check` is what guards a publish instead.

§82 (code signing) stays user-blocked on a certificate.

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
- A control character in source is almost always a shell escape that was
  interpreted. It compiles, runs, matches nothing, and reads correctly. Five in
  one afternoon; `npm run release:check` is what catches them now.
- Never write a file through a shell heredoc when it contains a regex. Use the
  Write tool, or repair afterwards and verify.

## Known defects still open

- Browser-pane screenshots return black frames in this environment. Verify
  through the DOM instead; it is more precise anyway.

## Migrations

- Latest: `0050_content_idea_lifecycle.sql`
- Empty database: 50 applied, 0 skipped, no drift
- Existing-database upgrade: DONE 2026-09-04, on a copy of the running
  installation. Rolled back to 0047, upgraded to 0050, every row count
  identical, no drift, and the sealed provider credential still opens. The copy
  and its dump were deleted; both held real content and a sealed key.

## Running the suite

It launches real Chrome. On a machine already running an installation and a dev
stack, the full run takes 20-40 minutes rather than 10. Stop the dev stack
before a release run and expect the wait.

Two things that look like a hang and are not:

- `npm test | tail` shows nothing until the very end, because tail buffers.
  Redirect to a file and watch it instead.
- The main vitest process sits near zero CPU throughout. Its forks do the work,
  so that reading says nothing about progress.

Both together are convincing enough that a healthy run was killed on this
evidence once. The reliable signal is whether the log file is still growing.

Killing a run leaves its Chrome processes behind. They are identifiable by their
profile path (`ai17z-chrome-test-*` under the temp directory) and are safe to
kill by that filter; nothing else matches it.

## Test baseline

- Last full run at `337bad8`: 1283 passed, 120 files, 0 failed
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

Requires, in order:

1. ~~representative database upgrade proven on a copy~~ DONE
2. ~~release cleanliness check~~ DONE (`npm run release:check`, in CI)
3. release-candidate validation -- the NOT TESTED rows in the validation matrix
4. three frozen-source runs on one commit
5. backup of the real installation
6. promotion

Still NOT STARTED from 3 onwards.
