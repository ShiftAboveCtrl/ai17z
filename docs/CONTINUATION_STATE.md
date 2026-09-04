# AI17Z Continuation State

Operational continuity for the next session. Not a progress report. Update it
whenever the execution state materially changes.

## Canonical source

- Path: `C:\Users\ta0as\OneDrive\Desktop\XBAM`
- Branch: `main`
- Current commit: `67d562b`
- Unpushed commits: 20 (deliberate; the release state is not coherent yet)

## Golden runtime

- Path: `C:\Users\ta0as\ai17z-test`
- Commit it is running: `f768553`
- Schema: `0047_reply_triggers.sql`
- Agent: Ava, account `@ai17zos`, ACTIVE
- **DO NOT MODIFY DIRECTLY. DO NOT PROMOTE YET.**

Its native worker executes `C:\Users\ta0as\ai17z-test` source, verified: that
checkout has no `packages/browser/src/watchdog.ts` and zero references to
`superviseSession`. Restarting it therefore runs the old code and applies none
of the XBAM fixes. The isolation model is intact.

Known condition, not yet fixed there: its Chrome holds ~15 pages, twelve of them
the same `x.com/home` timeline, which is the accumulation the reconciliation work
in XBAM fixes. It arrives with the controlled promotion, not before.

## Scratch instance (disposable, safe to destroy)

- Database `ui_scratch` on `localhost:55460` (container `ai17z-testdb`)
- API on 8799, web on 5199, started from XBAM with
  `XBAM_API_PORT=8799 XBAM_BROWSER_ENABLED=0`
- Owner `scratch@example.test`, agents "Scratch Agent" and "Second Agent"
- Test database for the suite: `postgres://xbam:xbam@localhost:55460/xbam`

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

Begin §59-70. Start with the posting pipeline: idea → relevance → draft →
persona/voice → policy → cadence → execute → verify → history. Preserve every
existing dry-run and idempotency protection. Then the owner-facing idea queue,
then Outreach.

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

## Known defects still open

- An Easy Mode save with no changes still creates a persona version through the
  Easy route. The Advanced route no longer does. Same fix, not yet applied to
  `routes/easy.ts`.
- Browser-pane screenshots return black frames in this environment. Verify
  through the DOM instead; it is more precise anyway.

## Migrations

- Latest: `0049_xai_provider.sql`
- Empty database: 49 applied, 0 skipped, no drift
- Existing-database upgrade: NOT YET RUN

## Test baseline

- Last full run at `67d562b`: 1182 passed, 108 files, 0 failed
- Typecheck: clean (verify by exit code, never by grepping for "error TS" —
  tsc colourises between the words)
- Command: `DATABASE_URL="postgres://xbam:xbam@localhost:55460/xbam" npm test`

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
