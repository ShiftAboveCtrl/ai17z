# AI17Z — open-source release validation

Written from what was run, not from what was intended. Where something was not
tested it says so, and where a claim rests on inference rather than evidence it
says that too.

**Classification: RELEASE CANDIDATE.**

Every release blocker is clear and no known high-severity defect remains. It is
not called ready for public release because two things a public user would meet
have not been verified: a clean Ubuntu machine, and connecting a second X
account. Neither failed. Neither was run.

---

## Build

| | |
| --- | --- |
| Branch | `ai17z-overhaul` |
| Frozen commit for the three-run | `8f8626f` |
| Tag | `ai17z-oss-rc`, moved to the tip after defects 12 and 13 |
| Checkpoint before this round | `pre-open-source-hardening` |
| Database backup taken first | `storage/backups/xbam-preoss-*.dump` |

## Tests

| Kind | Files | Tests |
| --- | --- | --- |
| Unit | 31 | 411 |
| Integration (real Postgres), of which | 40 | 352 |
| &nbsp;&nbsp;— real Google Chrome | 1 | 18 |
| End to end (Playwright, running app) | 4 | 18 |
| **Total automated** | **75** | **781** |
| Scenario harness (real model, real account, dry run) | 1 | 20 situations |

Counted from the runner, not repeated from a previous report.

The unit and integration suite was run three times from the same frozen commit,
with the tree verified unchanged afterwards:

```
frozen at: 8f8626f
typecheck errors: 0     <- WRONG, see below
run 1:  762 passed (762)
run 2:  756 passed | 6 skipped (762)
run 3:  762 passed (762)
SOURCE UNCHANGED: 8f8626f
```

**Correction: the typecheck line above was false.** `tsc` puts colour codes
between the words "error" and "TS", so the `grep -c 'error TS'` this and several
other checks relied on matched nothing and reported zero however many errors
there were. At that commit there were five: four in
`tests/integration/monitorScroll.test.ts` (a required field missing from a test
fixture) and, once the reply-planning work started, one in the web app --
including the one that mattered, `'vision'` not being assignable, because there
was no vision row on the screen that sets model roles.

None of them affected the running system, and CI would have caught all five
because it runs `npm run typecheck` directly rather than grepping it. But the
number in this document was not measured, and the test counts beside it were.
`--pretty false` is now on the typecheck script so the output is greppable, and
the count below was taken after that change.

The six skips in run 2 are the real-Chrome suite, which skips rather than
passes when a Chrome from a previous run still holds the profile. Nothing else
differed between runs.

Reading that output rather than its last line found two more defects (12 and 13
below). After fixing them, at the tip:

```
typecheck: clean (verified with colour off, and by exit code)
Test Files  74 passed (74)
     Tests  816 passed (816)      no unhandled errors
```

That is one run, not three. The three-run above stands as the frozen evidence;
what changed after it is a test helper, a five-line guard in the worker loop,
and this document.

The 18 end-to-end tests were run twice, against two different installations:

| Target | Credentials | Result |
| --- | --- | --- |
| This installation, Docker stack on :8080 | existing owner | 18 passed |
| A throwaway instance on an empty database | the documented defaults | 18 passed |

The second is the contributor's path and is the more interesting one: it created
the owner through the bootstrap screen, walked Easy Mode from nothing, added a
provider, ran a dry run, and held a job for approval — all on a database that
was empty forty seconds earlier. The instance was then destroyed with its
volumes, and the working installation still had its four agents.

The E2E suite uses Playwright's own Chromium and proves nothing about Google
Chrome. Only `tests/integration/realChrome.test.ts` may be cited for that, and
it skips loudly rather than passing where Chrome is absent.

---

## Defects found and fixed this round

Each was found by running something, not by reading it.

| # | Defect | How it was found | Root cause |
| --- | --- | --- | --- |
| 1 | The wrong-target guard had stopped guarding | Auditing siblings of the hidden-dialog bug | `composerReplyingTo` read `SEL.dialog.first()`, which is the hidden one, got empty text, found no "Replying to" line and returned `[]` — and the caller only acts on a non-empty result |
| 2 | No scrolling in the function all six monitors use | Same audit | The previous session fixed the poller; `harvest` in `monitors.ts` still read only what X had rendered on arrival. That was the ceiling on everything an agent could discover |
| 3 | An article's id read from the post it quoted, in the discovery path | Same audit | First `/status/` link wins, and a quoted post links to itself. A quoted-post mention would have been discovered under the wrong status |
| 4 | 1,077 leaked Chrome processes | The real-Chrome suite failing on a profile lock | `process.kill(pid)` ends the browser and leaves renderers holding the profile |
| 5 | Cryptic Docker bind error on a second instance | Actually starting one | Ports were not checked before Docker was asked to bind them |
| 6 | My home directory in `.env.example` | Scanning tracked files | The file every new user copies carried `C:/Users/…/ai4cz` |
| 7 | My email as the E2E default | Same | `helpers.ts` defaulted to a real address |
| 8 | The twscrape account database was tracked | Clean-room clone listing | Empty, but it would carry credentials the moment anybody used it |
| 9 | A high-severity dependency nothing imported | `npm audit` | `@fastify/static`, four advisories, zero imports |
| 10 | Research read three blurbs instead of an answer | Product review | DuckDuckGo snippets rarely answer a question |
| 11 | Brave's "Searching" read as the answer | Building the above | The page holds a constant length while fetching, so a stability-based wait settles on a status word |
| 12 | Nine E2E failures saying only "never reached the agents page" | The frozen three-run | Taking my address out of the defaults was right, but there is exactly one owner and login will not say which half was wrong, so running the suite against an installation that already has one now fails silently. It reports its own cause |
| 13 | The guard against a worker dying on a failed tick did not cover a tick that throws before it returns | Five unhandled errors in the three-run output, under a green summary line | Only a rejected promise was caught. A synchronous throw leaves the timer callback uncaught, which is fatal — and the test passed anyway, because `setInterval` keeps firing after its callback throws, so counting ticks proved nothing |

---

## Isolation

### Two agents in one installation

Ten automated tests, all passing. An event admitted for one account reaches only
that account and only its agent, in both directions and when both arrive at the
same moment. A memory written for one is never retrieved for the other, checked
through the retrieval table as well as the search. Each account gets its own
profile directory and neither is a parent of the other. The browser lock refuses
a second worker on the same account while letting a different account proceed —
a global lock would have made two agents take turns at the speed of the slowest
browser operation.

### Two installations on one machine

**Verified live, not by inspection.** A second clone with its own instance name
and ports, both stacks running together:

```
ai17z-instance2-postgres-1  :55440      xbam-postgres-1  :55432
ai17z-instance2-api-1       :8797       xbam-api-1       :8787
ai17z-instance2_xbam_pgdata             xbam_xbam_pgdata
```

Both APIs answering. Four agents in one database, zero in the other. Stopping
the second left the first healthy with its four agents.

The default project name stays `xbam` deliberately: changing it points an
existing installation at an empty database. The data is not destroyed, but the
stack comes up as though it were a fresh install.

---

## Real Google Chrome

Verified after all packaging changes:

```
executable    C:\Program Files\Google\Chrome\Application\chrome.exe
binary says   Google Chrome 152.0.7977.65
CDP says      Chrome/152.0.7977.65
engine/mode   GOOGLE_CHROME / MANAGED   (spawned, then attached)
tabs          ACTION, MENTIONS, NOTIFICATIONS, RESEARCH — all READY
```

Two independent signals, both stored. No Playwright Chromium substitution
anywhere in the X runtime.

---

## Social Radar

| Monitor | Automated | Live | Scroll |
| --- | --- | --- | --- |
| notifications | yes | yes, healthy | shared `harvest` |
| mention_search | yes | yes, healthy | shared `harvest` |
| reply_search | yes | yes, healthy | shared `harvest` |
| own_threads | yes | yes, healthy | shared `harvest` |
| tracked_account | code path shared | not configured here | shared `harvest` |
| tracked_keyword | code path shared | not configured here | shared `harvest` |

Four regression tests drive `harvest` against a synthetic feed that behaves like
an infinite one — five articles, more on scroll, then no more. They prove it
walks past the first screen, stops at the high-water mark, gives up when the feed
stops growing rather than scrolling forever, and never returns the account its
own posts.

Notifications keeps its own tab. The three search-shaped monitors share one.
That is deliberate: either surface can miss what the other catches, and sharing a
tab would make them queue.

---

## Actions

| Path | Result |
| --- | --- |
| Reply, live | Verified in the previous round; 18 replies published and read back |
| Original post, live | **Verified.** First unprompted post published, confirmed on the timeline |
| Dry-run reply | Verified — zero real actions across five trigger types |
| Dry-run original post | Verified — and it neither spends the idea nor takes the real idempotency key |
| Approval, through the UI | Verified — holds, edits, approves, asserts the edited text is what went out |

The live post took five fixes to get out, all found only by attempting it:
posting enabled but bound to no account, POST never granted, `dryRun` hardcoded
false, a rehearsal spending the idea, and a rehearsal taking the real key. Then
the composer: X renders two `role="dialog"` nodes and the first is hidden, so
the code scoped the submit button to the page behind the dialog and watched a
permanently disabled button while the real one sat enabled.

---

## Security

| Check | Result |
| --- | --- |
| Secret scan, tracked files | Clean — nothing key-shaped |
| Secret scan, last 40 commits | Clean |
| X session cookies | None tracked |
| Personal data (username, email, domain) | None in any tracked file |
| Runtime state tracked | None; `.env`, `storage/`, `accounts.db` all ignored |
| Log sentinel | Passes — absent from every text/jsonb column, every trace, and the redactor in seven shapes |
| Master key | Generated per installation; missing, short and wrong keys all refuse, tested in fresh processes |
| Dependency audit | 1 high removed; 2 moderate documented as accepted with reasons |

CI enforces the first four on every pull request, printing locations and never
values.

---

## Clean-room install

**Windows: verified.** A fresh clone of the final commit into a new directory,
following the README only:

- No `.env`, no `storage/`, no `node_modules` came with it
- `install-ai17z.ps1` generated its own master key — fingerprint `8d5f180f`,
  different from the development one
- Typecheck: 0 errors
- 400 unit tests passing in the clean checkout

And separately, a fresh **running** installation: an instance on its own ports
with an empty database and its own master key (`8ce21de3`). It came up needing
an owner, and the full 18-test end-to-end suite passed against it using the
credentials the repository documents — first run, nothing pre-seeded, no
environment variables. Torn down afterwards with `docker compose down -v`; the
working installation was checked before and after and still had its four agents.

---

## Platform support

| Platform | Status |
| --- | --- |
| Windows 11 + Docker Desktop + Google Chrome | **Verified end to end**, including real X, real posting and a clean-room install |
| Ubuntu Desktop | **Not verified.** Scripts written, syntax-checked, logic exercised. Nobody has taken a clean Ubuntu machine through the flow |
| Ubuntu Server, headless | **Not supported.** Connecting an X account opens a real browser window for a person to sign in to |

The Ubuntu scripts run and their branches behave correctly when exercised on
this machine — the doctor correctly reports Chrome missing at Linux paths and no
display. That is not an Ubuntu test and is not claimed as one.

### What a contributor would need to do to verify Ubuntu

1. A clean Ubuntu Desktop machine or VM with a display.
2. Install Docker Engine, Node 20+, and Google Chrome (not Chromium).
3. `git clone`, `./install-ai17z.sh`, `./start-ai17z.sh`.
4. `./doctor-ai17z.sh` — expect every row PASS except the ones that say NOT
   CONFIGURED.
5. Open the web UI, create an owner, create an agent through Easy Mode.
6. Connect an X account and sign in when the Chrome window opens.
7. Report what the doctor said and what, if anything, differed.

---

## Not tested, and not claimed

- **A second X account.** One was available. Profile paths and locks are
  per-account by construction and tested as such, but two signed-in X accounts
  have never run side by side.
- **Ubuntu, as above.**
- **Vision.** Media is exposed to the prompt and described as an explicit gap.
  No vision model is wired, and the agent says it could not see rather than
  pretending.
- **The full provider matrix.** DeepSeek, Ollama and the mock are configured
  here. OpenAI, Anthropic, OpenRouter and a generic OpenAI-compatible endpoint
  were not each connected and failure-tested.
- **Quiet hours and rate ceilings against a real clock.** Unit-tested only.
- **A 24-hour soak.** The harness exists, is proved, and flags trends rather
  than readings. The longest run in these sessions was minutes.

---

## Release blockers

| Blocker | Status |
| --- | --- |
| Wrong-target reply | Clear — guard restored, focal post found by its own id, no positional fallback |
| Duplicate remote action | Clear — three index-enforced layers, tested under 50-way contention |
| Cross-account leakage | Clear — ten tests |
| Cross-instance leakage | Clear — two live instances |
| Secret committed | Clear — tree and history |
| Fresh installation failure | Clear — clean-room verified on Windows |
| Browser profile collision | Clear — per account, per instance |
| Silent worker death | Clear — every loop guarded, proved against a live Postgres restart |
| Social Radar blindness | Clear — all six monitors now scroll |
| Mention search first viewport only | Clear |
| Broken provider setup | Clear — Easy Mode walked end to end |
| Easy Mode dead-end | Clear — Start refuses an unrunnable agent in plain words |
| Dry-run side effect | Clear — every trigger, and the posting path |
| Database corruption | Not observed across restarts, kills and concurrency |
| Hard dependency on local folders | Clear — nothing references them |

---

## What needs you

Everything that could be done in code has been. These cannot:

1. ~~Choose a licence.~~ **Done: MIT.** `LICENSE` at the root, declared in
   `package.json`, and the README says so. Nothing in 372 dependencies argued
   with it — no copyleft anywhere in the tree. The copyright line reads
   "AI17Z contributors"; put your own name or handle there if you would rather
   hold it personally.
2. **Create the public repository** and set its description and topics.
3. **Verify Ubuntu**, or find somebody who can. Steps above.
4. **Connect a second X account**, if multi-account matters to you.
5. **Take screenshots** for the README, if you want them — using demo data, not
   your own timeline.
6. **Leave the soak running**: `npm run soak`, then read
   `storage/soak/<started>.json`.
