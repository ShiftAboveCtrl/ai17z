# AI17Z — final validation matrix

Baseline: `f62c3e3` on `ai17z-overhaul`, tagged `pre-final-validation`.
Postgres dumped to `storage/backups/` before any change.

**Discrepancy 0 — the supplied report.** No PDF was attached to the request. The
only PDFs on this machine are unrelated. The "AI17Z Runtime PDF" is taken to be
the runtime artifact published at the end of the previous session, and its claims
are treated as the baseline to prove or disprove.

## How to read this

`PASS` means a test was run and observed to pass. Source inspection alone is
never `PASS` — it is `INSPECTED`, which is not a result. `N/A` means the row does
not apply to the current build and says why.

Columns: **A** automated (unit), **I** integration (real Postgres), **L** live
(real Chrome / real X), **F** failure injection, **R** restart/recovery.

| Subsystem | Claim | A | I | L | F | R | Result | Defects | Fix |
|---|---|---|---|---|---|---|---|---|---|
| Build & typecheck | Repo typechecks and builds | y | - | - | - | - | PASS - 0 TS errors, web build ok | no lint script exists | - |
| Test suite counts | Counts are what is claimed | y | y | - | - | - | PASS - 387 unit + 307 integration + 18 e2e, counted | report omitted e2e | - |
| Migrations (fresh) | Fresh DB reaches latest schema | - | - | - | - | - | NOT TESTED | | |
| Migrations (existing copy) | Real data survives migration | - | - | - | - | - | NOT TESTED | | |
| Provider encryption | Sealed keys still decrypt | - | - | - | - | - | NOT TESTED | | |
| Idempotency — event | One event per remote id | - | y | - | - | - | PASS - 50 concurrent to 1 event, 50 fulfilled | - | 09aca7d |
| Idempotency — job | One job per event/action/agent | - | y | - | - | - | PASS - 1 job, 1 caller reports created | - | 09aca7d |
| Idempotency — action | One remote action per key | - | y | - | - | - | PASS - 10 workers to 1 CLAIMED, 9 refused | - | 09aca7d |
| Idempotency — content | No duplicate text to one target | - | y | - | - | - | PASS - signature per agent; dry run never claims it | - | - |
| High concurrency (50×1) | 50 admissions of one status | - | y | - | - | - | PASS - 50/50, zero rejections | - | 09aca7d |
| High concurrency (50 distinct) | No over-serialisation | - | y | - | - | - | PASS - 50 events, 50 jobs, 1.4s | - | 09aca7d |
| Job leases | Claim/heartbeat/expire/resume | - | y | - | y | y | PASS - claim/expiry/resume; busy lease untouched | - | 09aca7d |
| Kill at every pipeline stage | Resumes at prior settled state | - | y | - | y | y | PASS - all 5 commit points; 20 nodes map onto 5 | - | 09aca7d |
| Pipeline graph validity | Invalid graphs fail clearly | - | - | - | - | - | NOT TESTED | | |
| Version pinning | In-flight job keeps its versions | - | - | - | - | - | NOT TESTED | | |
| Provider CRUD | Add/edit/replace/delete | - | - | - | - | - | NOT TESTED | | |
| Provider failures | 401/403/404/429/500/timeout | - | - | - | - | - | NOT TESTED | | |
| Model fallback | Order respected, trace accurate | - | - | - | - | - | NOT TESTED | | |
| Easy Mode setup | Fresh user completes setup | - | - | y | y | - | PASS - 8 steps; Start refuses with readable blockers | route moved, e2e stale | a75da55 |
| Easy ↔ Advanced | One config system, no split brain | - | - | y | - | - | PASS - both directions read the same document | - | a75da55 |
| Easy Mode errors | Written for normal users | - | - | - | - | - | NOT TESTED | | |
| Advanced Mode regression | No capability lost | - | - | y | - | - | PASS - all sections present on an Easy-made agent | e2e assumed Advanced | dc631d9 |
| UI route walk | No dead controls | - | - | y | - | - | PARTIAL - 18 e2e cover the main routes | - | - |
| "Your agents" clipping | Regression-tested at 5 widths | - | y | y | - | - | PASS - 5 widths plus 100/125/150% zoom | - | 42bdb1e |
| Responsive matrix | 390/834/1280/1440/2200 | - | - | y | - | - | PASS - after fixing a 390px overflow | grid item min-width auto | 42bdb1e |
| Accessibility / input | Keyboard, focus, labels | - | - | - | - | - | NOT TESTED | | |
| Real Chrome identity | Two independent signals | - | - | y | - | - | PASS - chrome.exe; binary and CDP both Chrome 151.0.7922.175 | - | - |
| Chrome restart | Session survives | - | - | - | - | - | NOT TESTED | | |
| Browser record loss | Recovers, does not duplicate | - | - | y | y | y | PASS - finds holder, replaces it, keeps the session | record loss stranded a live Chrome | 7a4eecb |
| Browser task races | No watcher misreads a launch | - | - | - | - | - | NOT TESTED | | |
| Four tab roles | All four exist and are used | - | - | y | - | - | PASS - all four tracked; ACTION/RESEARCH on demand | - | - |
| Tab adoption | 5 restarts → still 4 tabs | - | - | - | - | - | NOT TESTED | | |
| Tab closure recovery | Only the closed one returns | - | - | - | - | - | NOT TESTED | | |
| Tab interference | Roles do not navigate each other | - | - | - | - | - | NOT TESTED | | |
| Tab serialisation | Same role queues, others concurrent | - | - | - | - | - | NOT TESTED | | |
| Tab health staleness | Stale is never HEALTHY | - | - | y | y | - | PASS - soak flags a CONNECTED account going stale | - | 7d98241 |
| Real sign-in | End to end, stops at challenge | - | - | - | - | - | NOT TESTED | | |
| Sign-in timeout | No infinite spinner | - | - | - | - | - | NOT TESTED | | |
| Radar — each monitor | Six kinds, enable/disable | - | - | - | - | - | NOT TESTED | | |
| Radar — duplication | One event, many discoveries | - | - | - | - | - | NOT TESTED | | |
| Radar — failure isolation | One source degrades alone | - | - | - | - | - | NOT TESTED | | |
| Radar — cursor recovery | Catches up without flooding | - | - | - | - | - | NOT TESTED | | |
| Context resolution | 13 nested cases | - | - | - | - | - | NOT TESTED | | |
| Action vs context target | Never replies to an ancestor | - | - | - | - | - | NOT TESTED | | |
| Focal status resolution | No positional fallback | - | - | - | - | - | NOT TESTED | | |
| Author verification | Mismatch refuses | - | - | - | - | - | NOT TESTED | | |
| Memory scopes | Six scopes, no leakage | - | - | - | - | - | NOT TESTED | | |
| Memory noise | Trivia does not pollute | - | - | - | - | - | NOT TESTED | | |
| Memory contradiction | Supersession, not both | - | - | - | - | - | NOT TESTED | | |
| Relationship memory | Reaches generation, no leak | - | - | - | - | - | NOT TESTED | | |
| Stance ledger | Reversal caught, revision allowed | - | - | - | - | - | NOT TESTED | | |
| Voice fingerprint | Same agent across providers | - | - | - | - | - | NOT TESTED | | |
| Voice rewrite failure | Job survives | - | - | - | - | - | NOT TESTED | | |
| Generic-AI detection | Catches register, not concision | - | - | - | - | - | NOT TESTED | | |
| Repetition | Near-duplicate caught | - | - | - | - | - | NOT TESTED | | |
| Engagement decision | Engage/ignore/review | - | - | - | - | - | NOT TESTED | | |
| Approval UI | Edit, approve, reject | - | - | y | - | - | PASS - e2e edits, approves, asserts edited text sent | report called it untested | dc631d9 |
| Approval restart | Survives all four restarts | - | - | - | - | - | NOT TESTED | | |
| Real action pipeline | Verified target, read back | - | - | - | - | - | NOT TESTED | | |
| Composer edge cases | Typeahead, re-render, slow | - | - | - | - | - | NOT TESTED | | |
| Ambiguous submission | Looks before retrying | - | - | - | - | - | NOT TESTED | | |
| Read-back normalisation | Mentions, URLs, emoji, breaks | - | - | - | - | - | NOT TESTED | | |
| Original posting | Scheduler publishes once | - | - | - | - | - | NOT TESTED | | |
| Scheduler duplication | One job per due timestamp | - | - | - | - | - | NOT TESTED | | |
| Scheduler restart | No duplicate, no missed | - | - | - | - | - | NOT TESTED | | |
| Vision | Real vision model | - | - | - | - | - | NOT TESTED | | |
| Vision routing | Separate vision role | - | - | - | - | - | NOT TESTED | | |
| Vision failure | Never hallucinates media | - | - | - | - | - | NOT TESTED | | |
| Research node | Uses RESEARCH tab only | - | - | - | - | - | NOT TESTED | | |
| Multi-account | Two accounts, no mixing | - | - | - | - | - | NOT TESTED | | |
| Multi-account concurrency | Independent, serialised per account | - | - | - | - | - | NOT TESTED | | |
| Profile lock | Two launches, no corruption | - | - | - | - | - | NOT TESTED | | |
| Account disabled mid-job | No remote side effect | - | - | - | - | - | NOT TESTED | | |
| Agent paused mid-job | Documented, consistent | - | - | - | - | - | NOT TESTED | | |
| Capability revocation | Permanent stop | - | y | - | y | - | PASS - burst of 8, 3 workers, none sent | - | 8941449 |
| Quiet hours | Real clock boundary | - | - | - | - | - | NOT TESTED | | |
| Rate ceilings | Tighter of two wins, names which | - | - | - | - | - | NOT TESTED | | |
| Burst handling | 50 mentions, bounded | - | - | - | - | - | NOT TESTED | | |
| Postgres restart | Recovers, no corruption | - | - | y | y | y | PASS - counts identical, both workers recovered | native worker died silently | 43bbe69 |
| API restart | Chrome survives | - | - | - | - | - | NOT TESTED | | |
| Native worker restart | Reattaches, adopts tabs | - | - | - | - | - | NOT TESTED | | |
| Container worker restart | Leases recover | - | - | - | - | - | NOT TESTED | | |
| Full system restart | Scripts bring it all back | - | - | - | - | - | NOT TESTED | | |
| Cold start | From no processes at all | - | - | - | - | - | NOT TESTED | | |
| Startup failure UX | Explains what failed | - | - | - | - | - | NOT TESTED | | |
| Soak harness | `npm run soak` exists and reports | - | - | y | - | - | PASS - npm run soak; flags trends, writes JSON | counted all machine Chrome | 7d98241 |
| Soak run | Longest practical duration | - | - | - | - | - | NOT TESTED | | |
| Resource leaks | Trend, not absolute | - | - | - | - | - | NOT TESTED | | |
| Token/cost path | Fast path vs deep path | - | - | - | - | - | NOT TESTED | | |
| Secret scan | Nothing committed | y | - | - | - | - | PASS - nothing key-shaped in tracked files | - | 12f04a1 |
| Log audit | Sentinel never appears | y | y | - | - | - | PASS - sentinel absent from every column, trace, redactor | - | 12f04a1 |
| Browser security | Loopback only, no automation of challenges | - | - | - | - | - | NOT TESTED | | |
| Master key | Missing key fails loudly | - | y | - | y | - | PASS - missing/short/wrong all refuse, in fresh processes | - | 12f04a1 |
| Prompt injection | Content stays untrusted | - | y | - | y | - | PASS - scenario harness; content stays data | - | - |
| Malformed unicode | Sanitiser holds | y | y | - | y | - | PASS - 20 hostile shapes settle | NUL byte crashed ingest | 8941449 |
| DOM change resilience | Classified failure + screenshot | - | - | - | - | - | NOT TESTED | | |
| Diagnostic screenshots | Exist, findable, associated | - | - | - | - | - | NOT TESTED | | |
| Trace accuracy | UI matches database | - | - | - | - | - | NOT TESTED | | |
| "Why did it say this" | Grounded in recorded data | - | - | - | - | - | NOT TESTED | | |
| "Why did it ignore this" | Useful explanation | - | - | - | - | - | NOT TESTED | | |
| Dry run guarantee | No remote mutation, any path | - | y | - | y | - | PASS - 5 triggers, 3 malformed flags, 0 real actions | - | 09aca7d |
| Operating modes | Manual/review/autonomous | - | - | - | - | - | NOT TESTED | | |
| Agent delete/edit/duplicate | No accidental sharing | - | - | - | - | - | NOT TESTED | | |
| Data isolation | A and B share nothing | - | - | - | - | - | NOT TESTED | | |
| Empty / large data | 0 and many | - | - | - | - | - | NOT TESTED | | |
| Persona sources | Honest status | - | - | - | - | - | NOT TESTED | | |
| twscrape optionality | Failure does not kill runtime | - | - | - | - | - | NOT TESTED | | |
| Research failure | Gap propagates, no invention | - | - | - | - | - | NOT TESTED | | |
| Optional provider offline | NOT CONFIGURED vs OFFLINE | - | - | - | - | - | NOT TESTED | | |
| Health page | Every indicator is evidence | - | - | - | - | - | NOT TESTED | | |
| Failure classification | Every failure has a class | - | y | - | y | - | PASS - every surfaced failure carried a class | - | - |
| Cancellation | State stays coherent | - | - | - | - | - | NOT TESTED | | |
| Pool stress | No deadlock, no exhaustion | - | y | - | y | - | PASS - 50 concurrent, no deadlock | pooled read inside a transaction | ce85b49 |
| Clean shutdown | Leases and session safe | - | - | - | - | - | NOT TESTED | | |

## Defects found this round

| # | Defect | How reproduced | Root cause | Fix | Commit |
|---|---|---|---|---|---|
| 1 | Two e2e tests red | `npx playwright test` | The suite predates the Easy/Advanced switch and asserted Advanced surfaces without selecting Advanced; `/agents/new` is Easy Mode now | `useInterface(page, mode)` through `addInitScript` | dc631d9 |
| 2 | `/activity` scrolled sideways at 390px | Every route loaded at five widths | Grid items default to `min-width: auto` and refuse to shrink below min-content: track 342px, item 405px | `[&>*]:min-w-0` on the grid | 42bdb1e |
| 3 | Native worker died on a Postgres restart | `docker compose restart postgres` under a live worker | `setInterval(() => void tick())` plus a `try/finally` with no `catch` is an unhandled rejection, which ends the process. The `tsx` supervisor stayed up, so nothing looked wrong | `startLoop` under every loop | 43bbe69 |
| 4 | Soak counted every Chrome on the machine | First soak run | 1,982 Chrome processes belonging to the owner's own browsing | Ask CDP for our own targets; machine-wide kept as unflagged context | 7d98241 |
| 5 | Soak flagged a disconnected account | First soak run | A disconnected account is supposed to publish nothing | Only a CONNECTED account can contradict itself | 7d98241 |
| 6 | Test drain stopped early | `recoveryChaos` | `drainAgentJobs` claimed globally then filtered, locking jobs it would not run | `agentId` filter inside the claim statement | 09aca7d |

Carried in from the session immediately before, each with a regression test: a
pooled query inside a transaction deadlocking the pool (ce85b49), a NUL byte in
a mention crashing ingest (8941449), a Chrome outliving its record becoming
invisible (7a4eecb), and test databases leaking (f62c3e3).

## Not tested, and not claimed

- **Multi-account.** One X account was available. Profile paths are per-account
  by construction, but two signed-in accounts were never run side by side.
- **Real sign-in, end to end.** Needs a person to type a password, and by design
  AI17Z stops at the first challenge rather than answering one.
- **Vision.** Media is exposed to the prompt and described as an explicit gap.
  No vision model is wired.
- **Original posting, live.** The scheduler path runs as a dry run; nothing
  unprompted has been published.
- **Provider matrix.** Only the providers already configured were exercised.
  OpenAI, Anthropic, DeepSeek, Ollama and a generic OpenAI-compatible endpoint
  were not each connected and failure-tested.
- **Quiet hours and rate ceilings against a real clock.**
- **24-hour soak.** The harness exists and is proved. The longest run completed
  in this session is recorded in the final report.
