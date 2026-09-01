# Contributing

You do not need an X account, a Google Chrome installation, or anybody's API
keys to work on almost all of this. The parts that genuinely need them are
separated and named so nobody mistakes one for the other.

## Getting set up

```bash
git clone REPLACE_WITH_AI17Z_GITHUB_URL ai17z
cd ai17z
./install-ai17z.sh        # or .\install-ai17z.ps1 on Windows
npm run db:up
npm run migrate
```

Then either the whole stack:

```bash
./start-ai17z.sh
```

or the pieces, in separate terminals, when you want the logs in front of you:

```bash
npm run dev:api           # http://localhost:8787
npm run dev:web           # http://localhost:5173
npm run dev:worker        # jobs, channel polling, browser tasks
```

## Running the tests

```bash
npm run typecheck
npm test                  # unit and integration; integration needs Postgres
npx playwright test       # end to end, against a running stack
```

Integration tests create their own database per test process, named
`xbam_test_<pid>_<random>`, and truncate between cases. Never point
`DATABASE_URL` at data you care about.

The suite needs no credentials. If a test asks you for one, that is a bug in the
test.

## The three kinds of test

**Unit** for pure logic: validators, normalisers, extractors, prompt rendering,
the conversation resolver. Fast, no database.

**Integration** against real Postgres, because the unique indexes carry the
guarantees and a mock would test the wrong thing. If you are changing anything
about idempotency, recovery or isolation, this is where it belongs.

**End to end** with Playwright against a running application, using its own
Chromium. These prove nothing about Google Chrome and do not claim to — only
`tests/integration/realChrome.test.ts` may be cited for that, and it skips
loudly rather than passing when Chrome is absent.

There is a fourth thing that is not a test: `tools/scenarios/run.mts` drives the
whole pipeline against a real account with a real model and reports what the
agent actually said. Every job is asserted to be a dry run before the pipeline
touches it.

## What a change needs

New runtime behaviour needs a test that would fail without it. Not a test that
exercises the code — one that fails if you revert the change.

Prefer a test against a synthetic page over one against X. X changes its DOM
without notice, and a test that depends on today's markup is a test that will
fail for a reason unrelated to your change.

## Things worth knowing before you change them

Read `CLAUDE.md`. It is long, and every paragraph in it is there because
something went wrong once. The short version:

- **Only the worker opens a browser.** A container cannot drive Chrome on the
  host, so the API records intent in `browser_tasks` and a native worker
  executes it.
- **Google Chrome is spawned, then attached to.** Never launched by Playwright,
  and never silently substituted with Chromium.
- **Three layers of idempotency, all unique indexes.** Not application logic.
  When you touch execution, ask: can this send the same message twice?
- **A dry run must never reach the remote.** Any path, any trigger.
- **Nothing answers a security challenge.** No CAPTCHA, no 2FA, no unusual-login
  confirmation. There is no setting for this and no code path around it.
- **Playwright is pinned in three places that must move together.** The Docker
  image ships browser binaries for one release only.

## Style

- `verbatimModuleSyntax` is on: use `import type` for type-only imports.
- No `any`. No empty `catch {}` without a comment saying why the swallow is
  deliberate. No `console.log` outside the logger.
- Comments explain *why*, not *what*. If a constant was chosen for a reason,
  say the reason.
- Errors carry a class and a human sentence. `500 Internal Server Error` is not
  an acceptable thing for somebody to read.

## Before opening a pull request

```bash
npm run typecheck && npm test
```

CI runs the same, plus the web build and a secret scan, against a real Postgres
and with no credentials of any kind.
