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
| Build & typecheck | Repo typechecks and builds | — | — | — | — | — | TODO | | |
| Test suite counts | Counts are what is claimed | — | — | — | — | — | TODO | | |
| Migrations (fresh) | Fresh DB reaches latest schema | — | — | — | — | — | TODO | | |
| Migrations (existing copy) | Real data survives migration | — | — | — | — | — | TODO | | |
| Provider encryption | Sealed keys still decrypt | — | — | — | — | — | TODO | | |
| Idempotency — event | One event per remote id | — | — | — | — | — | TODO | | |
| Idempotency — job | One job per event/action/agent | — | — | — | — | — | TODO | | |
| Idempotency — action | One remote action per key | — | — | — | — | — | TODO | | |
| Idempotency — content | No duplicate text to one target | — | — | — | — | — | TODO | | |
| High concurrency (50×1) | 50 admissions of one status | — | — | — | — | — | TODO | | |
| High concurrency (50 distinct) | No over-serialisation | — | — | — | — | — | TODO | | |
| Job leases | Claim/heartbeat/expire/resume | — | — | — | — | — | TODO | | |
| Kill at every pipeline stage | Resumes at prior settled state | — | — | — | — | — | TODO | | |
| Pipeline graph validity | Invalid graphs fail clearly | — | — | — | — | — | TODO | | |
| Version pinning | In-flight job keeps its versions | — | — | — | — | — | TODO | | |
| Provider CRUD | Add/edit/replace/delete | — | — | — | — | — | TODO | | |
| Provider failures | 401/403/404/429/500/timeout | — | — | — | — | — | TODO | | |
| Model fallback | Order respected, trace accurate | — | — | — | — | — | TODO | | |
| Easy Mode setup | Fresh user completes setup | — | — | — | — | — | TODO | | |
| Easy ↔ Advanced | One config system, no split brain | — | — | — | — | — | TODO | | |
| Easy Mode errors | Written for normal users | — | — | — | — | — | TODO | | |
| Advanced Mode regression | No capability lost | — | — | — | — | — | TODO | | |
| UI route walk | No dead controls | — | — | — | — | — | TODO | | |
| "Your agents" clipping | Regression-tested at 5 widths | — | — | — | — | — | TODO | | |
| Responsive matrix | 390/834/1280/1440/2200 | — | — | — | — | — | TODO | | |
| Accessibility / input | Keyboard, focus, labels | — | — | — | — | — | TODO | | |
| Real Chrome identity | Two independent signals | — | — | — | — | — | TODO | | |
| Chrome restart | Session survives | — | — | — | — | — | TODO | | |
| Browser record loss | Recovers, does not duplicate | — | — | — | — | — | TODO | | |
| Browser task races | No watcher misreads a launch | — | — | — | — | — | TODO | | |
| Four tab roles | All four exist and are used | — | — | — | — | — | TODO | | |
| Tab adoption | 5 restarts → still 4 tabs | — | — | — | — | — | TODO | | |
| Tab closure recovery | Only the closed one returns | — | — | — | — | — | TODO | | |
| Tab interference | Roles do not navigate each other | — | — | — | — | — | TODO | | |
| Tab serialisation | Same role queues, others concurrent | — | — | — | — | — | TODO | | |
| Tab health staleness | Stale is never HEALTHY | — | — | — | — | — | TODO | | |
| Real sign-in | End to end, stops at challenge | — | — | — | — | — | TODO | | |
| Sign-in timeout | No infinite spinner | — | — | — | — | — | TODO | | |
| Radar — each monitor | Six kinds, enable/disable | — | — | — | — | — | TODO | | |
| Radar — duplication | One event, many discoveries | — | — | — | — | — | TODO | | |
| Radar — failure isolation | One source degrades alone | — | — | — | — | — | TODO | | |
| Radar — cursor recovery | Catches up without flooding | — | — | — | — | — | TODO | | |
| Context resolution | 13 nested cases | — | — | — | — | — | TODO | | |
| Action vs context target | Never replies to an ancestor | — | — | — | — | — | TODO | | |
| Focal status resolution | No positional fallback | — | — | — | — | — | TODO | | |
| Author verification | Mismatch refuses | — | — | — | — | — | TODO | | |
| Memory scopes | Six scopes, no leakage | — | — | — | — | — | TODO | | |
| Memory noise | Trivia does not pollute | — | — | — | — | — | TODO | | |
| Memory contradiction | Supersession, not both | — | — | — | — | — | TODO | | |
| Relationship memory | Reaches generation, no leak | — | — | — | — | — | TODO | | |
| Stance ledger | Reversal caught, revision allowed | — | — | — | — | — | TODO | | |
| Voice fingerprint | Same agent across providers | — | — | — | — | — | TODO | | |
| Voice rewrite failure | Job survives | — | — | — | — | — | TODO | | |
| Generic-AI detection | Catches register, not concision | — | — | — | — | — | TODO | | |
| Repetition | Near-duplicate caught | — | — | — | — | — | TODO | | |
| Engagement decision | Engage/ignore/review | — | — | — | — | — | TODO | | |
| Approval UI | Edit, approve, reject | — | — | — | — | — | TODO | | |
| Approval restart | Survives all four restarts | — | — | — | — | — | TODO | | |
| Real action pipeline | Verified target, read back | — | — | — | — | — | TODO | | |
| Composer edge cases | Typeahead, re-render, slow | — | — | — | — | — | TODO | | |
| Ambiguous submission | Looks before retrying | — | — | — | — | — | TODO | | |
| Read-back normalisation | Mentions, URLs, emoji, breaks | — | — | — | — | — | TODO | | |
| Original posting | Scheduler publishes once | — | — | — | — | — | TODO | | |
| Scheduler duplication | One job per due timestamp | — | — | — | — | — | TODO | | |
| Scheduler restart | No duplicate, no missed | — | — | — | — | — | TODO | | |
| Vision | Real vision model | — | — | — | — | — | TODO | | |
| Vision routing | Separate vision role | — | — | — | — | — | TODO | | |
| Vision failure | Never hallucinates media | — | — | — | — | — | TODO | | |
| Research node | Uses RESEARCH tab only | — | — | — | — | — | TODO | | |
| Multi-account | Two accounts, no mixing | — | — | — | — | — | TODO | | |
| Multi-account concurrency | Independent, serialised per account | — | — | — | — | — | TODO | | |
| Profile lock | Two launches, no corruption | — | — | — | — | — | TODO | | |
| Account disabled mid-job | No remote side effect | — | — | — | — | — | TODO | | |
| Agent paused mid-job | Documented, consistent | — | — | — | — | — | TODO | | |
| Capability revocation | Permanent stop | — | — | — | — | — | TODO | | |
| Quiet hours | Real clock boundary | — | — | — | — | — | TODO | | |
| Rate ceilings | Tighter of two wins, names which | — | — | — | — | — | TODO | | |
| Burst handling | 50 mentions, bounded | — | — | — | — | — | TODO | | |
| Postgres restart | Recovers, no corruption | — | — | — | — | — | TODO | | |
| API restart | Chrome survives | — | — | — | — | — | TODO | | |
| Native worker restart | Reattaches, adopts tabs | — | — | — | — | — | TODO | | |
| Container worker restart | Leases recover | — | — | — | — | — | TODO | | |
| Full system restart | Scripts bring it all back | — | — | — | — | — | TODO | | |
| Cold start | From no processes at all | — | — | — | — | — | TODO | | |
| Startup failure UX | Explains what failed | — | — | — | — | — | TODO | | |
| Soak harness | `npm run soak` exists and reports | — | — | — | — | — | TODO | | |
| Soak run | Longest practical duration | — | — | — | — | — | TODO | | |
| Resource leaks | Trend, not absolute | — | — | — | — | — | TODO | | |
| Token/cost path | Fast path vs deep path | — | — | — | — | — | TODO | | |
| Secret scan | Nothing committed | — | — | — | — | — | TODO | | |
| Log audit | Sentinel never appears | — | — | — | — | — | TODO | | |
| Browser security | Loopback only, no automation of challenges | — | — | — | — | — | TODO | | |
| Master key | Missing key fails loudly | — | — | — | — | — | TODO | | |
| Prompt injection | Content stays untrusted | — | — | — | — | — | TODO | | |
| Malformed unicode | Sanitiser holds | — | — | — | — | — | TODO | | |
| DOM change resilience | Classified failure + screenshot | — | — | — | — | — | TODO | | |
| Diagnostic screenshots | Exist, findable, associated | — | — | — | — | — | TODO | | |
| Trace accuracy | UI matches database | — | — | — | — | — | TODO | | |
| "Why did it say this" | Grounded in recorded data | — | — | — | — | — | TODO | | |
| "Why did it ignore this" | Useful explanation | — | — | — | — | — | TODO | | |
| Dry run guarantee | No remote mutation, any path | — | — | — | — | — | TODO | | |
| Operating modes | Manual/review/autonomous | — | — | — | — | — | TODO | | |
| Agent delete/edit/duplicate | No accidental sharing | — | — | — | — | — | TODO | | |
| Data isolation | A and B share nothing | — | — | — | — | — | TODO | | |
| Empty / large data | 0 and many | — | — | — | — | — | TODO | | |
| Persona sources | Honest status | — | — | — | — | — | TODO | | |
| twscrape optionality | Failure does not kill runtime | — | — | — | — | — | TODO | | |
| Research failure | Gap propagates, no invention | — | — | — | — | — | TODO | | |
| Optional provider offline | NOT CONFIGURED vs OFFLINE | — | — | — | — | — | TODO | | |
| Health page | Every indicator is evidence | — | — | — | — | — | TODO | | |
| Failure classification | Every failure has a class | — | — | — | — | — | TODO | | |
| Cancellation | State stays coherent | — | — | — | — | — | TODO | | |
| Pool stress | No deadlock, no exhaustion | — | — | — | — | — | TODO | | |
| Clean shutdown | Leases and session safe | — | — | — | — | — | TODO | | |

## Defects

Numbered as found. Each gets: reproduction, root cause, fix, regression test,
commit.

_(none yet)_
