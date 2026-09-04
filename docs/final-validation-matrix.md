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
| Migrations (fresh) | Fresh DB reaches latest schema | - | y | - | - | - | PASS - 50 applied, 0 skipped, no drift, on an empty database | | |
| Migrations (existing copy) | Real data survives migration | - | y | - | - | - | PASS - running installation dumped, restored, rolled back to 0047, upgraded to 0050; every count identical, no drift | | |
| Provider encryption | Sealed keys still decrypt | - | y | - | - | - | PASS - the real sealed credential opens after the upgrade, under the installation's own master key | | |
| Idempotency — event | One event per remote id | - | y | - | - | - | PASS - 50 concurrent to 1 event, 50 fulfilled | - | 09aca7d |
| Idempotency — job | One job per event/action/agent | - | y | - | - | - | PASS - 1 job, 1 caller reports created | - | 09aca7d |
| Idempotency — action | One remote action per key | - | y | - | - | - | PASS - 10 workers to 1 CLAIMED, 9 refused | - | 09aca7d |
| Idempotency — content | No duplicate text to one target | - | y | - | - | - | PASS - signature per agent; dry run never claims it | - | - |
| High concurrency (50×1) | 50 admissions of one status | - | y | - | - | - | PASS - 50/50, zero rejections | - | 09aca7d |
| High concurrency (50 distinct) | No over-serialisation | - | y | - | - | - | PASS - 50 events, 50 jobs, 1.4s | - | 09aca7d |
| Job leases | Claim/heartbeat/expire/resume | - | y | - | y | y | PASS - claim/expiry/resume; busy lease untouched | - | 09aca7d |
| Kill at every pipeline stage | Resumes at prior settled state | - | y | - | y | y | PASS - all 5 commit points; 20 nodes map onto 5 | - | 09aca7d |
| Pipeline graph validity | Invalid graphs fail clearly | y | y | - | - | - | PASS (A+I) - `unit/graph.test.ts` rejects a cycle, an unreachable node and a dangling edge, naming the node; `integration/pipelineGraph.test.ts` walks the default graph, takes both branches of a filter, and pins a running job to its version | | |
| Version pinning | In-flight job keeps its versions | - | y | - | - | - | PASS (I) - a running job stays pinned to the graph version it started on, so a graph edit mid-flight does not change it | | |
| Provider CRUD | Add/edit/replace/delete | - | y | - | - | - | PASS (I) - `integration/modelLifecycle.test.ts` and `providers.test.ts`: a model travels with what its provider offers, is reported when the provider stops offering it, and removing a model from an agent leaves the provider alone | | |
| Provider failures | 401/403/404/429/500/timeout | y | y | - | y | - | PASS (A+I+F) - 401/403 the owner's key, 429 a rate limit and not a misconfiguration, 5xx the provider's outage; retried, escalated to review, or stopped permanently by class. xAI answers 400 for a bad key and is read from the body | providers disagree on the status for a rejected key | 41-47 |
| Model fallback | Order respected, trace accurate | - | y | - | - | - | PASS (I) - falls back to the next configured model and keeps every attempt on record | | |
| Easy Mode setup | Fresh user completes setup | - | - | y | y | - | PASS - 8 steps; Start refuses with readable blockers | route moved, e2e stale | a75da55 |
| Easy ↔ Advanced | One config system, no split brain | - | - | y | - | - | PASS - both directions read the same document | - | a75da55 |
| Easy Mode errors | Written for normal users | - | y | - | - | - | PASS (I) - `integration/validationMessages.test.ts`. Every refusal a person can reach names the setting and what to change; none is a status code | | |
| Advanced Mode regression | No capability lost | - | - | y | - | - | PASS - all sections present on an Easy-made agent | e2e assumed Advanced | dc631d9 |
| UI route walk | No dead controls | - | - | y | - | - | PARTIAL - 18 e2e cover the main routes | - | - |
| "Your agents" clipping | Regression-tested at 5 widths | - | y | y | - | - | PASS - 5 widths plus 100/125/150% zoom | - | 42bdb1e |
| Responsive matrix | 390/834/1280/1440/2200 | - | - | y | - | - | PASS - after fixing a 390px overflow | grid item min-width auto | 42bdb1e |
| Accessibility / input | Keyboard, focus, labels | y | - | y | - | - | PASS - audited in the running app: 26 inputs, 0 without an accessible name (was 10), every label click focuses its control, one h1, main/nav/header landmarks, focus never suppressed. No skip link, which is noted rather than claimed | Field rendered a label it never associated with anything | (this round) |
| Real Chrome identity | Two independent signals | - | - | y | - | - | PASS - chrome.exe; binary and CDP both Chrome 151.0.7922.175 | - | - |
| Chrome restart | Session survives | - | - | - | - | - | NOT TESTED - needs a real Chrome killed and restarted with a live session | | |
| Browser record loss | Recovers, does not duplicate | - | - | y | y | y | PASS - finds holder, replaces it, keeps the session | record loss stranded a live Chrome | 7a4eecb |
| Browser task races | No watcher misreads a launch | - | y | - | y | y | PASS (I+F+R) - `integration/browserTasks.test.ts`: an unstarted task is superseded rather than refused, a live lease blocks a second, an expired one is taken over, the sweep distinguishes abandoned from never-claimed, and the owner can always cancel | | |
| Four tab roles | All four exist and are used | - | - | y | - | - | PASS - all four tracked; ACTION/RESEARCH on demand | - | - |
| Tab adoption | 5 restarts → still 4 tabs | y | - | - | - | y | PASS (A) - 20 unclean restarts keep the count flat, and the real 15-tab profile recovers. Pure reconciler only; says nothing about a real Chrome | one abandoned tab per unclean restart, 15 found live | ca188ce, 67d562b |
| Tab closure recovery | Only the closed one returns | y | - | - | - | - | PASS (A) - a closed role is recreated alone; sign-in, challenge and composer tabs are never claimed or closed | | ca188ce |
| Tab interference | Roles do not navigate each other | y | - | - | - | - | PASS (A) - `unit/visionAndResearchRouting.test.ts` proves the web search runs on RESEARCH and never names ACTION; `unit/tabReconciliation.test.ts` proves a monitor never claims the sign-in or composer tab | | |
| Tab serialisation | Same role queues, others concurrent | y | - | - | - | - | PASS (A) - `unit/tabSerialisation.test.ts`: two operations on one tab queue rather than interleave, four queue in order, a thrower hands the tab on rather than wedging the role, and two roles run at the same time | | |
| Tab health staleness | Stale is never HEALTHY | - | - | y | y | - | PASS - soak flags a CONNECTED account going stale | - | 7d98241 |
| Real sign-in | End to end, stops at challenge | - | y | - | - | - | PARTIAL (I) - `integration/signInStates.test.ts` proves the watcher only looks at settled states and stops the moment a person is asked for something; `unit/authObservation.test.ts` fails if anything clicks, fills or dismisses. A real sign-in through to a real challenge is still untested | | |
| Sign-in timeout | No infinite spinner | - | y | - | - | - | PASS (I) - `integration/signInStates.test.ts`: a sign-in nobody finishes reaches TIMEOUT, a settled state the watcher leaves alone rather than a spinner | | |
| Radar — each monitor | Six kinds, enable/disable | - | y | - | - | - | PASS (I) - `integration/radar.test.ts` covers each source kind separately: health starts unknown, becomes healthy on a poll, degrades once and only fails on repetition, and one failing source does not stop the others | | |
| Radar — duplication | One event, many discoveries | - | y | - | - | - | PASS (I) - one event and one job however many sources found it, against real Postgres | watched posts were typed MENTION | 7f9242b |
| Radar — failure isolation | One source degrades alone | - | y | - | y | - | PASS (I+F) - a source starts unknown, becomes healthy on a poll, degrades once and only fails after repeated failure; one failing source does not stop the others, and health is per source rather than per account | | |
| Radar — cursor recovery | Catches up without flooding | - | y | - | - | - | PASS (I) - `integration/radar.test.ts` and `monitorScroll.test.ts`: a cursor is kept so the next poll resumes rather than restarting, scrolling stops at the newest post already reconciled, and it gives up when the feed stops growing rather than scrolling for ever | | |
| Context resolution | 13 nested cases | y | - | - | - | - | PASS (A) - `unit/xConversation.test.ts`, 26 cases over article snapshots rather than a live browser. Includes case 4, the AI4CZ regression: a mention four levels deep assembles the full ancestry oldest first | | |
| Action vs context target | Never replies to an ancestor | y | - | - | - | - | PASS (A) - `unit/xConversation.test.ts` anchors the target to the mention and carries the root only as context; `unit/targets.test.ts` collapses every spelling of a status to one canonical URL | | |
| Focal status resolution | No positional fallback | y | - | - | - | - | PASS (A) - `unit/xConversation.test.ts`: refuses rather than falling back to a position, and refuses when the page rendered nothing. There is no positional fallback to exercise | | |
| Author verification | Mismatch refuses | y | - | - | - | - | PASS (A) - `unit/verifiedOnly.test.ts`: a verified author passes, an unverified one is refused, and verification that could not be read is refused distinctly rather than failing open | | |
| Memory scopes | Six scopes, no leakage | - | y | - | - | - | PASS (I) - `integration/memory.test.ts` and `isolation.test.ts`: a fact from one conversation is recalled in another, one person's memories stay out of another's prompt, and a memory is never retrieved for the other agent | | |
| Memory noise | Trivia does not pollute | y | - | - | - | - | PASS (A) - `unit/memory.test.ts`: questions and small talk are ignored, the importance floor is honoured, duplicates never returned, and how much one message can contribute is capped | | |
| Memory contradiction | Supersession, not both | - | y | - | - | - | PASS (I) - `integration/stances.test.ts`: a changed position supersedes rather than sitting beside the old one, and the old row is what lets the agent say it changed its mind | | |
| Relationship memory | Reaches generation, no leak | - | y | - | - | - | PASS (I) - `integration/relationships.test.ts`: exchanges are counted so somebody never answered stays a stranger, a level the owner pinned is never overwritten, and a shared reference rests after use so it does not become a catchphrase | | |
| Stance ledger | Reversal caught, revision allowed | - | y | - | - | - | PASS (I) - `integration/stances.test.ts`: only a straight reversal is a conflict, a firm position may soften without being called a contradiction, and a revision is offered so a reply can acknowledge it | | |
| Voice fingerprint | Same agent across providers | y | - | - | - | - | PASS (A) - `unit/voice.test.ts`: the fingerprint is measurements rather than adjectives, carries its provenance, says nothing when there is nothing to measure, and admits when there are too few samples to judge | | |
| Voice rewrite failure | Job survives | y | - | - | - | - | PASS (A) - `unit/voice.test.ts`: a rewrite that scores worse is discarded and a failed rewrite never fails the job | | |
| Generic-AI detection | Catches register, not concision | y | - | - | - | - | PASS (A) - `unit/voice.test.ts`: catches the stock opening, the helpdesk sign-off and the shape rather than the words, leaves a plain answer alone, and respects a persona meant to sound corporate | | |
| Repetition | Near-duplicate caught | y | - | - | - | - | PASS (A) - `unit/voice.test.ts`: catches a sentence lifted from a recent reply and a reused opening, is harder on repeating to the same person, cares less about weeks ago, and lets a signature phrase recur once rested | | |
| Engagement decision | Engage/ignore/review | - | y | - | - | - | PASS (I) - `integration/engagement.test.ts`: all three wired outcomes, with a decision not to reply ending the job as CANCELLED carrying its reasons rather than as a failure | | |
| Approval UI | Edit, approve, reject | - | - | y | - | - | PASS - e2e edits, approves, asserts edited text sent | report called it untested | dc631d9 |
| Approval restart | Survives all four restarts | - | y | - | - | y | PASS (I+R) - `integration/approval.test.ts` and `recoveryChaos.test.ts`: a held job survives, executes the edited text once, and a lease that has not expired is left alone | | |
| Real action pipeline | Verified target, read back | - | - | - | - | - | NOT TESTED - the live path is exercised by `tools/scenarios/run.mts --live`, which was not run this round | | |
| Composer edge cases | Typeahead, re-render, slow | - | - | - | - | - | NOT TESTED - needs a real composer with the typeahead open | | |
| Ambiguous submission | Looks before retrying | - | y | - | y | - | PASS (I+F) - `integration/actionCloseout.test.ts`: a composer that does not close is looked at before anything is retried, because retrying an accepted reply posts twice | | |
| Read-back normalisation | Mentions, URLs, emoji, breaks | y | - | - | - | - | PASS (A) - `unit/ownReplyMatch.test.ts`: mentions, URLs, emoji and line breaks all normalise, so a reply X rendered differently is still recognised as the one that was sent | | |
| Original posting | Scheduler publishes once | - | y | - | - | - | PASS (I) - `integration/posting.test.ts`: one POST job from the best idea, silence recorded with its reason when the backlog is empty, and refusals when the agent is inactive, monitor-only or has no account | | |
| Scheduler duplication | One job per due timestamp | - | y | - | - | - | PASS (I) - `integration/posting.test.ts`: a due schedule is claimed once and moved on in the same statement, which is what stops two workers posting for one appointment | | |
| Scheduler restart | No duplicate, no missed | - | y | - | - | y | PASS (I+R) - `integration/postingWiring.test.ts`: it does not fire the moment it is switched on, keeps its appointment when an unrelated setting is saved, moves it when the rhythm changes, and clears it when posting is turned off | | |
| Vision | Real vision model | - | - | - | - | - | NOT TESTED - needs a real vision model and a real image | | |
| Vision routing | Separate vision role | y | - | - | - | - | PASS (A) - `unit/visionAndResearchRouting.test.ts`: the vision role is asked for by name, nothing near it falls back to primary, and the gateway honours a single requested role rather than walking the chain | | |
| Vision failure | Never hallucinates media | y | - | - | y | - | PASS (A+F) - `unit/multimodal.test.ts`: an unread image is an explicit gap the prompt states, and `unit/evidenceNote.test.ts` proves the model is told to admit it rather than describing what it did not see | | |
| Research node | Uses RESEARCH tab only | y | - | - | - | - | PASS (A) - `unit/visionAndResearchRouting.test.ts`: the search runs under the RESEARCH role and that path never names ACTION | | |
| Multi-account | Two accounts, no mixing | - | y | - | - | - | PASS (I) - `integration/isolation.test.ts`: an event reaches only its account and only its agent, in both directions, with two simultaneous events kept apart and each account given its own profile directory | | |
| Multi-account concurrency | Independent, serialised per account | - | y | - | - | - | PASS (I) - `integration/isolation.test.ts`: the lock is account-scoped, so a second worker on one account is refused while another account proceeds at the same time | | |
| Profile lock | Two launches, no corruption | - | y | - | - | - | PARTIAL (I) - `integration/isolation.test.ts` proves the account lease refuses a second holder and that two installations sharing a profile root stay apart. Two real Chromes racing for one profile directory is still untested | | |
| Account disabled mid-job | No remote side effect | - | y | - | y | - | PASS (I+F) - `integration/capabilities.test.ts`: revoking READ stops reading entirely, and a grant revoked after a job is queued fails that job permanently rather than retrying into a refusal | | |
| Agent paused mid-job | Documented, consistent | - | y | - | - | - | PASS (I) - `integration/autonomy.test.ts` and `killSwitch.test.ts`: a paused agent creates no job, an in-flight one waits rather than giving up, and the live status says the agent cannot work and why | | |
| Capability revocation | Permanent stop | - | y | - | y | - | PASS - burst of 8, 3 workers, none sent | - | 8941449 |
| Quiet hours | Real clock boundary | y | y | - | - | - | PASS (A+I) - `unit/cadence.test.ts` and `integration/cadence.test.ts`: quiet hours cover reading as well as acting, and an unusable timezone fails open rather than stopping the agent mysteriously | | |
| Rate ceilings | Tighter of two wins, names which | - | y | - | - | - | PASS (I) - `integration/cadence.test.ts`: the account ceiling and the agent policy both apply, the tighter wins, and the verdict names which one bound | | |
| Burst handling | 50 mentions, bounded | - | y | - | y | - | PASS (I+F) - `integration/safetyUnderLoad.test.ts` and `stress.test.ts`: a burst is bounded, an identical second action to one target is refused, and none of a burst is sent once permission is gone | | |
| Postgres restart | Recovers, no corruption | - | - | y | y | y | PASS - counts identical, both workers recovered | native worker died silently | 43bbe69 |
| API restart | Chrome survives | - | - | y | - | y | PASS (L+R) - restarted the API against the running installation. A new server process (24s old, pid 88400 under the same watcher) came up, and Chrome was untouched: the same browser instance, byte-identical webSocketDebuggerUrl, and the health check still reading x @ShiftAboveCtrl healthy. The API owns no browsers, and this is the evidence for it | | |
| Native worker restart | Reattaches, adopts tabs | y | - | - | - | y | PARTIAL (A+R) - `unit/tabReconciliation.test.ts` proves 20 unclean restarts keep the tab count flat and the real 15-tab profile recovers. A real worker restarting against a real Chrome is still untested | | |
| Container worker restart | Leases recover | - | y | - | y | y | PASS (I+F+R) - `integration/recoveryChaos.test.ts`: an expired lease returns the job to the settled state before its step and it resumes rather than restarting; a live lease is left alone | | |
| Full system restart | Scripts bring it all back | - | - | - | - | - | NOT TESTED - needs the scripts run against a live installation | | |
| Cold start | From no processes at all | - | - | - | - | - | NOT TESTED - needs a machine with no AI17Z processes | | |
| Startup failure UX | Explains what failed | y | y | - | y | - | PASS (A+I+F) - `unit/supervisor.test.ts` gives up when it plainly cannot start and says why; `integration/secretHandling.test.ts` proves a missing, short or wrong master key refuses loudly in a fresh process rather than starting broken | | |
| Soak harness | `npm run soak` exists and reports | - | - | y | - | - | PASS - npm run soak; flags trends, writes JSON | counted all machine Chrome | 7d98241 |
| Soak run | Longest practical duration | - | - | - | - | - | NOT TESTED - the harness exists and was not run for a long duration this round | | |
| Resource leaks | Trend, not absolute | - | - | - | - | - | NOT TESTED - see soak run. The Chrome leak found earlier this round (61 per suite run, now 0) was measured rather than soaked | | |
| Token/cost path | Fast path vs deep path | - | y | - | - | - | PASS (I) - `integration/spending.test.ts`: calls a day and a month are counted and enforced, the cost cap is checked after them, and a cost cap that cannot be enforced says so instead of reading 0.00 for ever | | |
| Secret scan | Nothing committed | y | - | - | - | - | PASS - nothing key-shaped in tracked files | - | 12f04a1 |
| Log audit | Sentinel never appears | y | y | - | - | - | PASS - sentinel absent from every column, trace, redactor | - | 12f04a1 |
| Browser security | Loopback only, no automation of challenges | y | - | - | - | - | PASS (A) - `unit/chromeFlags.test.ts` proves the debug port binds to loopback and every CDP path carries its own user-data-dir; `unit/authObservation.test.ts` fails if anything clicks, fills or dismisses on an auth page | | |
| Master key | Missing key fails loudly | - | y | - | y | - | PASS - missing/short/wrong all refuse, in fresh processes | - | 12f04a1 |
| Prompt injection | Content stays untrusted | - | y | - | y | - | PASS - scenario harness; content stays data | - | - |
| Malformed unicode | Sanitiser holds | y | y | - | y | - | PASS - 20 hostile shapes settle | NUL byte crashed ingest | 8941449 |
| DOM change resilience | Classified failure + screenshot | y | - | - | y | - | PASS (A+F) - `unit/browserErrors.test.ts`: a missing selector is classified rather than guessed, and the message says what was being looked for | | |
| Diagnostic screenshots | Exist, findable, associated | - | y | - | y | - | PASS (I+F) - `integration/failureDiagnostics.test.ts`: a real PNG on disk, an artifact row pointing at it, a diagnostic pointing at the artifact, and the job pointing at the diagnostic, so a failure screenshot is reachable from the run that produced it. Also that a failure with no screenshot is still recorded, because a failed capture must never mask the failure that triggered it | | |
| Trace accuracy | UI matches database | - | y | - | - | - | PARTIAL (I) - `integration/pipeline.test.ts` carries an event through to an executed action with a full trace and records one for every job it settles. That the UI renders the same rows is not asserted | | |
| "Why did it say this" | Grounded in recorded data | y | - | - | - | - | PASS (A) - `unit/conversationView.test.ts`: the order is root then ancestors then incoming then reply, what was used is shown, a failed lookup is shown as well as a successful one, and no chain-of-thought is rendered | | |
| "Why did it ignore this" | Useful explanation | - | y | - | - | - | PASS (I) - `integration/engagement.test.ts`: a decision not to reply is CANCELLED with its factors recorded, and the reasons travel to the UI rather than a bare score | | |
| Dry run guarantee | No remote mutation, any path | - | y | - | y | - | PASS - 5 triggers, 3 malformed flags, 0 real actions | - | 09aca7d |
| Operating modes | Manual/review/autonomous | - | y | - | - | - | PASS (I) - `integration/autonomy.test.ts` walks all five: OFF records nothing, MONITOR_ONLY records without generating but still yields to a manual trigger, MANUAL_ONLY creates nothing automatically, REVIEW stops at the gate, AUTONOMOUS runs through to an action | | |
| Agent delete/edit/duplicate | No accidental sharing | - | y | - | - | - | PASS (I) - `integration/portableAgent.test.ts` and `agentRename.test.ts`: a copy gets its own identity, renaming it leaves the original alone, memories never travel, and a duplicate goes out through the portable document so it cannot carry what an export could not | | |
| Data isolation | A and B share nothing | - | y | - | - | - | PASS (I) - `integration/isolation.test.ts` and `subResourceOwnership.test.ts`: memories, relationships and stances stay on their own side, and every sub-resource route is scoped by owner in SQL | | |
| Empty / large data | 0 and many | - | y | - | - | - | PARTIAL (I) - `integration/stress.test.ts` covers many (50 concurrent, 50 distinct). Empty states are covered per screen rather than as one pass | | |
| Persona sources | Honest status | - | y | - | - | - | PASS (I) - `integration/personaSource.test.ts`: raw corpus items never enter a prompt, every derived trait cites the items it came from, duplicates collapse before scoring, and excluded items are kept | | |
| twscrape optionality | Failure does not kill runtime | y | - | - | y | - | PASS (A+F) - `unit/twscrape.test.ts`: absence is reported as a capability this installation does not have, and a failure never takes the runtime with it | | |
| Research failure | Gap propagates, no invention | y | - | - | y | - | PASS (A+F) - `unit/research.test.ts` and `researchBudget.test.ts`: a lookup that fails is reported so the model says it does not know, a search challenge is a full stop, and whatever is left when the budget runs out is a stated gap rather than a wait | | |
| Optional provider offline | NOT CONFIGURED vs OFFLINE | y | - | - | - | - | PASS (A) - `unit/providerState.test.ts`: never configured and configured but unreachable are different words, because they need different actions | | |
| Health page | Every indicator is evidence | y | - | - | - | - | PASS (A) - `unit/healthScoreboard.test.ts`: every indicator comes from the diagnostics endpoint, the page invents no state, it shows when a part last succeeded rather than last ran, and no raw provider error is rendered | | |
| Failure classification | Every failure has a class | - | y | - | y | - | PASS - every surfaced failure carried a class | - | - |
| Cancellation | State stays coherent | - | y | - | - | - | PASS (I) - `integration/approval.test.ts` and `commitments.test.ts`: a rejected job is cancelled and sends nothing, a commitment that can never be kept is cancelled rather than retried, and `browserTasks.test.ts` cancels everything on an account and lets the next request through | | |
| Pool stress | No deadlock, no exhaustion | - | y | - | y | - | PASS - 50 concurrent, no deadlock | pooled read inside a transaction | ce85b49 |
| Clean shutdown | Leases and session safe | y | - | - | - | y | PASS (A+R) - `unit/cleanExit.test.ts`: Chrome is closed gracefully before it is killed and the profile lock is waited for, because force-killing loses the session that was the point | | |

## The existing-database upgrade, in full

Run 2026-09-04, on a copy and never on the original.

1. `pg_dump` of the running installation (read-only): 1 agent, 147 events,
   143 jobs, 89 actions, 174 memories, 29 content ideas, 1 sealed credential.
2. Restored into a scratch database on the development server. Counts identical.
3. Rolled back to `0047_reply_triggers.sql` -- the schema the previous release
   left behind -- by undoing exactly what 0048, 0049 and 0050 create, so the
   upgrade under test is a real one rather than a no-op.
4. `npm run migrate`: 3 applied, 47 skipped, no drift.
5. Every count identical afterwards, and `migrate:status` reports 50 applied
   with nothing pending or drifted.
6. The sealed provider credential still opens under the installation's own
   master key. This is the failure that would otherwise be silent: the schema
   migrates, every row is present, and the first thing the agent tries to do
   fails because the key it needs can no longer be decrypted.

The copy and the dump were deleted afterwards. Both held real conversation
content and a sealed key.

## Defects found this round

| # | Defect | How reproduced | Root cause | Fix | Commit |
|---|---|---|---|---|---|
| 1 | Two e2e tests red | `npx playwright test` | The suite predates the Easy/Advanced switch and asserted Advanced surfaces without selecting Advanced; `/agents/new` is Easy Mode now | `useInterface(page, mode)` through `addInitScript` | dc631d9 |
| 2 | `/activity` scrolled sideways at 390px | Every route loaded at five widths | Grid items default to `min-width: auto` and refuse to shrink below min-content: track 342px, item 405px | `[&>*]:min-w-0` on the grid | 42bdb1e |
| 3 | Native worker died on a Postgres restart | `docker compose restart postgres` under a live worker | `setInterval(() => void tick())` plus a `try/finally` with no `catch` is an unhandled rejection, which ends the process. The `tsx` supervisor stayed up, so nothing looked wrong | `startLoop` under every loop | 43bbe69 |
| 4 | Soak counted every Chrome on the machine | First soak run | 1,982 Chrome processes belonging to the owner's own browsing | Ask CDP for our own targets; machine-wide kept as unflagged context | 7d98241 |
| 5 | Soak flagged a disconnected account | First soak run | A disconnected account is supposed to publish nothing | Only a CONNECTED account can contradict itself | 7d98241 |
| 6 | Test drain stopped early | `recoveryChaos` | `drainAgentJobs` claimed globally then filtered, locking jobs it would not run | `agentId` filter inside the claim statement | 09aca7d |
| 7 | `closeChrome` reported closed while the profile was still locked | Full suite on a loaded machine: "the profile persists between launches" failed with the product's own message, `A Chrome (pid 91968) is holding this account's profile` | The graceful path returned as soon as the CDP port stopped answering. Chrome stops answering while its renderers are still exiting, and they hold the lock. The force-kill path comments on exactly this hazard; the graceful path did not check | Wait for nothing to be holding the profile before reporting closed, on both paths | (this round) |
| 8 | Every `Field` rendered a label associated with nothing | Accessibility audit of the running app: 10 inputs with no accessible name on Policies alone | `htmlFor` was optional and most callers did not pass it, so the label was text above a control rather than a label for it. Invisible unless you use a screen reader or click a label | `useId` in the component: a single control takes the id, anything else is a `role="group"` named by the label | (this round) |
| 9 | Watched posts were recorded as mentions | `outreachDiscovery` | Both tracked monitors call `harvest(ctx, 'POST', ...)` and 'POST' is not an EventType, so the fallback made it MENTION -- which is in the default trigger set | Map monitor words explicitly; an unknown one lands on KEYWORD_MATCH and is logged, never on the type that acts on its own | 7f9242b |
| 11 | A passing real-Chrome run leaked 61 browsers | Counted the Chrome processes under the run's own profile directory after a green run | `started` only knows browsers the file launches directly; the ones opened through `leaseSession` belong to the session manager and never reach that list | Sweep anything still running out of the run's temporary profile directory | (this round) |
| 12 | The suite got slower every run and then failed | Full suite went from 10 minutes to 40, then failed with "a Chrome is holding this account's profile" | Defect 11 compounding: leftovers from earlier runs hold profiles and load the machine, so the leak from one run is the flakiness of the next | Fixing 11 fixes this; 0 left after a passing run now | (this round) |
| 10 | A claimed content idea never came back | Reading the code against a real backlog of 27 | `markIdeaUsed` had no callers, so a published post never recorded which idea it came from and every failure spent one silently | A reconciler that asks the idea's job how it went | 417ae01 |

Carried in from the session immediately before, each with a regression test: a
pooled query inside a transaction deadlocking the pool (ce85b49), a NUL byte in
a mention crashing ingest (8941449), a Chrome outliving its record becoming
invisible (7a4eecb), and test databases leaking (f62c3e3).

## Not tested, and not claimed

Rewritten at the end of this round. Each entry says what is missing and what it
would take, because a list of gaps that quietly goes stale is worse than no list.

- **Real sign-in, end to end.** Needs a person to type a password, and by design
  AI17Z stops at the first challenge rather than answering one. What *is* tested:
  the watcher only looks at settled states, stops the moment a person is asked
  for something, and `authObservation.test.ts` fails if any code path clicks,
  fills or dismisses on an auth page.
- **Vision.** No vision model is configured anywhere, so nothing has read an
  image. The routing is tested -- the vision role is asked for by name and never
  falls back -- and an unread image is an explicit gap in the prompt. What is
  untested is a real model reading a real picture.
- **A real remote action.** `tools/scenarios/run.mts --live` is the path that
  publishes and it was not run this round. Everything up to the send is covered.
- **Chrome restart, full system restart, cold start.** Each needs the running
  browser stopped, and the session in it belongs to the owner. Killing it to
  prove it survives is a poor trade when a failed graceful close is exactly the
  case that loses the session.
- **Two signed-in accounts side by side.** One X account was available. Profile
  paths are per-account by construction and the account lease is tested; two
  real browsers racing for one profile directory is not.
- **The provider matrix.** Only the providers already configured were exercised.
  OpenAI, Anthropic, DeepSeek, Ollama and a generic OpenAI-compatible endpoint
  were not each connected and failure-tested against a live endpoint.
- **A 24-hour soak.** The harness is proved and the longest run completed in
  this session is recorded in the final report.

### Closed since this list was first written

Multi-account isolation, quiet hours and rate ceilings against the clock, and
the scheduler paths now have integration coverage rather than a note here. The
matrix rows cite the tests.
