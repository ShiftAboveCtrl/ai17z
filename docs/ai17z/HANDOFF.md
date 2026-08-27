# AI17Z overhaul — handoff

Branch `ai17z-overhaul`. 14 commits, 136 files, +8050/−386.
**225 unit and integration tests, 9 end-to-end tests, all passing.**

This document says what was built, what was verified by running it, and what
was not. The last section is the important one.

---

## A. What changed, in one line each

| Commit | What |
| --- | --- |
| `f1d4059` | Audit of the XBAM baseline against the specification |
| `9688c1c` | The rename, without touching data or secrets |
| `707c5a8` | Provider system: DeepSeek first-class, real retries, reasoning controls |
| `bb38472` | Browser Host: route browser work to a worker that has a browser |
| `fbf8200` | Five enforceable autonomy modes |
| `787fcb1` | The stored pipeline graph is what actually runs |
| `e322ca3` | Persona sources: learn an identity from a corpus, with provenance |
| `884be24` | Cadence: one place decides when an account is read and may act |
| `057acbe` | Capabilities: what an agent may do, granted explicitly |
| `3fe6f01` | Eleven sign-in states, a watched login, a hard stop at every challenge |
| `7eebfc0` | Windows start and stop scripts |
| `edccdc8` | Async UX: what is happening, for how long, how to stop |
| `87a475e` | Documentation and invariants |
| `20dc6b5` | Approval clock race |

---

## B. The rename kept every secret readable

`applyBrandCompatibility()` mirrors every `XBAM_*` variable to `AI17Z_*` and
back, explicit values winning. The master key resolves `AI17Z_MASTER_KEY` first
and falls back to `XBAM_MASTER_KEY`, so secrets sealed before the rename stay
decryptable. `tests/unit/brandCompat.test.ts` proves it.

Deliberately still say XBAM, because renaming them would break a working
install: `@xbam/*` package names, the `xbam` database, `xbam_*` volumes,
`XBAM_*` environment variables, `VITE_XBAM_API_URL`.

**No key was regenerated. No secret was migrated. Nothing was re-sealed.**

---

## C. The legacy directory was not touched

`../ai4cz` was read and never written. Its top-level modification time is
unchanged from before this work began. The importer opens its SQLite database
read-only.

No AI4CZ cookie, browser profile, or credential was imported. Legacy secrets in
that directory should be considered exposed and rotated at your convenience;
none of them are used by AI17Z.

---

## D. Cadence

Per-account, versioned, in the database. The poller has no schedule of its own:
it asks which accounts are due, and the claim moves `next_poll_at` forward in
the same statement.

An account with no cadence row runs on the defaults, so this changed nothing
about existing behaviour until edited. See `docs/architecture/CADENCE.md`.

---

## E. Capabilities

`action_type` says what an agent attempts; capabilities say what it may do.
Checked at ingest *and* immediately before execution — the second check is what
stops a job whose permission was revoked while it sat in the queue, and it fails
that job permanently.

Migration 0019 grants existing links exactly what they could already do.
**Nothing gained a permission by upgrading.** See
`docs/architecture/CAPABILITIES.md`.

---

## F. Sign-in and security challenges

**AI17Z never types a password and never answers a security challenge.**

CAPTCHA, two-factor, emailed or texted codes, hardware keys, unusual-login
confirmation, locked accounts — every one of them puts the account into
`CHALLENGE_REQUIRES_USER`, leaves the window open and untouched, and stops the
watcher reading the page you are typing into.

`observeAuthPage` has no branch that clicks, fills, or dismisses anything. The
test fails if any of those are ever called. See `docs/architecture/SIGN_IN.md`.

---

## G. Persona sources

Corpus items are evidence, not memory. Raw posts never enter a prompt; derived
traits do, and each cites the items it came from.

Verified live: 9 items in, 6 useful, 3 excluded with reasons, 13 traits derived.
See `docs/architecture/PERSONA_SOURCES.md`.

---

## H. Real Chrome

A containerised worker has no browser and no display. Browser work is routed to
a worker that has one, by capability, decided at ingest and enforced in the
claim query.

Verified end to end in an earlier phase: Docker API → `browser_tasks` → native
Windows worker → CDP → real Chrome 151 → correctly reported the X session as
signed out.

---

## I. The scripts

`.\start-ai17z.ps1` and `.\stop-ai17z.ps1`. Verified by running the full cycle:
stop, start, native worker up as `role=browser`, stop again.

Two bugs were found by running them rather than reading them — docker's progress
output on stderr, and npm needing its `.cmd` shim on Windows.

---

## J. What was verified by running it

- Full test suite, four consecutive clean runs: **225 passing**
- End-to-end suite against the real Docker stack: **9 passing**
- `npm run typecheck` clean across every package, app, and the E2E project
- All 21 migrations applied, no drift
- The UI opened in a real browser at 375, 834, 1440 and 2200px — no horizontal
  overflow at any width
- Cadence and permissions panels render and hold correct state on a real account
- Persona sync run against the live API
- Start and stop scripts run for real

---

## K. Bugs found by testing, not by reading

1. **`security key` matched the two-factor pattern** before the hardware-key
   one, so a key prompt told you to go and find a code.
2. **A Playwright error broke the mobile layout.** It contains a file path and a
   box-drawing rule, neither of which has anywhere to wrap.
3. **Permission ticks were in the DOM when revoked**, only made transparent, so
   copied or screen-read text claimed everything was granted.
4. **Approved jobs used the wrong clock.** `run_at` came from the application
   while the claim compares against Postgres `now()`. A few milliseconds of
   disagreement meant a just-approved job was not yet due. It presented as a
   test failing about one run in five.
5. **A new workspace 404'd the Docker build**, which read as a network problem.
   A guard test now asserts every workspace manifest is listed in each
   Dockerfile.

---

## L. What does not work, and why

### twscrape is not installed here

`/api/persona-source-kinds` reports `x_public: unavailable — "twscrape" is not
on PATH where the worker runs`. This is the adapter reporting honestly, not a
failure. `pip install twscrape` enables it. **The manual paste source works and
needs nothing.** The live reply path is Playwright-driven and unaffected either
way.

### No real model provider is configured

Only `mock` and an `ollama` entry exist, and Ollama is not running on this
machine (`error: Ollama network error: fetch failed`).

The adapters for OpenAI, OpenRouter, DeepSeek, Anthropic, Ollama and generic
OpenAI-compatible endpoints are written and wired with correct base URLs. **They
have not been exercised against the real services**, because no API key has been
added. The mock provider proves the pipeline end to end; it does not prove any
particular vendor's API.

To find out: add a key in Settings and press Test Connection.

### The X accounts are not currently connected

| Account | State |
| --- | --- |
| `@ai4cz_binance` | `ERROR` — stale message from a containerised worker that tried a managed launch before browser routing existed |
| `@shiftabovectrl` | `NEEDS_AUTH` |
| `@shiftabovectr` | `ERROR` |

The stale error is cosmetic and clears on the next Test session, which will now
route to the native worker. Reconnecting requires you to sign in yourself, by
design.

### Not built

- **Proactive posting on a schedule.** Cadence governs reading and rate-limits
  acting; it does not yet schedule an agent to post unprompted.
- **Channels other than X and mock.** Discord, Telegram, Slack, email and HTTP
  are in the channel enum and have no adapters.
- **The sign-in watcher has been unit-tested, not lived through.** Every state
  transition and every challenge signal is covered by tests against a fake page.
  A real X sign-in with a real 2FA prompt has not been performed in this
  session, because doing so needs your credentials.

---

## M. Things a future session must not break

Listed as invariants in `CLAUDE.md`. The load-bearing ones:

- The `XBAM_MASTER_KEY` fallback. Breaking it makes stored API keys unreadable.
- Both capability checks. Removing the execution one means a revoked permission
  does not stop a queued job.
- `CHALLENGE_REQUIRES_USER` staying out of `ACCOUNT_STATUSES_IN_PROGRESS`.
  Otherwise the watcher polls a page somebody is typing a code into.
- One cadence engine. A second timer puts the system back where it started.
- Playwright pinned in three places that move together.
- `../ai4cz` is read-only.

---

## N. Where to start reading

`docs/architecture/OVERVIEW.md`, then `CADENCE.md`, `CAPABILITIES.md`,
`SIGN_IN.md`, `PERSONA_SOURCES.md`. `CLAUDE.md` is the short version.

---

## O. To run it

```powershell
.\start-ai17z.ps1
```

Then open http://localhost:8080.

---

## P. The honest summary

The architecture is complete and tested. The plumbing that can be proven without
your credentials has been proven, by running it rather than by reading it.

What remains unproven is everything that needs a real account or a real API key:
no vendor API has been called with a live key, and no real X sign-in has been
completed. Those are the first two things to try, and both will tell you
immediately whether they work — Test Connection for a provider, Open sign-in for
an account.
