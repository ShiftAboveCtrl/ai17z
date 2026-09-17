# How something gets from the world to X and back

Every other architecture document here describes one subsystem. This describes
the path between them, so that a question like *where does X reading happen* has
one answer you can find without reading five files.

It is deliberately a map of **where responsibilities live**, not a list of
features. If you are adding something, the useful question is which of these
boxes it belongs in, and the answer is almost always "an existing one".

## The path

```
  X          GitHub       the open web       the owner        the clock
   │            │               │                │                │
   └────────────┴───────────────┴────────────────┴────────────────┘
                                │
                         OBSERVATIONS
         events · discoveries · repo_events · x_account_observations
                                │
                   ┌────────────┴────────────┐
                   │                         │
              INGEST                    DELIBERATION
       is this work for an agent?    is this worth attending to?
                   │                         │
                   │                    agent_attention
                   │                    agent_goals
                   │                    agent_reflections
                   │                         │
                   │                    INTENTIONS
                   │              content_ideas · agent_engagements
                   │                         │
                   └────────────┬────────────┘
                                │
                              JOBS
                  one durable unit of work, with a lease
                                │
                        THE TEN STEPS
     context → media → relationship → stance → engagement decision →
     research → memory → prompt → model → voice → validator
                                │
                    ┌───────────┴───────────┐
                    │                       │
              APPROVAL                   ACTIONS
        owner gate, when policy      one remote side effect,
        or the validator asks        behind an idempotency key
                    │                       │
                    └───────────┬───────────┘
                                │
                     BROWSER / TOOLSPACE
              the one signed-in Chrome, four role tabs
                                │
                          VERIFICATION
                  the target is what we think it is
                                │
                            OUTCOME
        actions · voice samples · relationships · stances · traces
                                │
                        back to OBSERVATIONS
```

## Where each responsibility lives, exactly once

| Question | Answer |
| --- | --- |
| Where does X reading happen? | `packages/channels/src/x/intelligence/`. Nothing else may read X. |
| Where are actions executed? | `performCapabilityAction` in `packages/runtime/src/capabilityActions.ts`, then the channel adapter. There is no second executor. |
| Where is agent context built? | The ten steps in `packages/runtime/src/steps/`, assembled by `@xbam/prompts`. |
| Where are approvals decided? | `packages/runtime/src/approvals.ts`. The web and Telegram both call it. |
| Where is social voice finalised? | `compileForJob` in `packages/runtime/src/voice.ts`, then `validateOutput`. |
| Where is health classified? | `collectHealth` in `packages/runtime/src/health.ts`. The Health screen and Telegram render the same report. |
| Where does deliberation happen? | `packages/runtime/src/deliberate.ts`, with `salience.ts` deciding what is worth attending to. |
| Where does memory become durable? | `packages/memory`, written by the pipeline and by `consolidate` in `deliberate.ts`. |
| Where are GitHub events observed? | `packages/runtime/src/repoWatcher.ts`. Read-only, four GET endpoints. |
| Where are engagement decisions made? | `engagementWorth.ts` judges, `engage.ts` acts. `engagement.ts` decides replies. |
| Is this message about the agent's subjects? | `touchesTopics` in `engagement.ts`. One matcher, used by both heuristics. |
| Is this the same post written two ways? | `canonicalTarget` in `capabilityActions.ts`. |
| What may this machine afford? | `budgetFor` in `packages/shared/src/resources.ts`. Everything it returns is enforced. |
| Which capabilities may the model choose from? | `shortlistCapabilities` in `capabilityRelevance.ts`, then `runCapabilityLoop`. |
| What does an agent give up under memory pressure? | `throttleFor` and `loopAllowed` in `resources.ts`. Loops declare a priority. |
| Why did a reply say that? | `explainRehearsal`, drawn by `ReplyInspector` on any job, rehearsed or published. |

## Four words that mean four different things

These are abused easily and the abuse is expensive, so they are worth stating.

**An event is an observation.** Something happened, somewhere, and this
installation recorded it. An event is not work and does not imply any. Its
uniqueness is `(channel, account, remote_event_id)`, which is what makes several
radar monitors seeing one post into one post.

**A job is durable work for one agent.** It has a lease, a state machine, and
exactly one reason to exist. A job that nothing will run is not a job; it is a
record, and a record belongs in the table for the thing it records. That
distinction was learned the expensive way: the engagement runner left its record
job claimable, so the pipeline ran the whole thing a second time.

**An action is one remote side effect.** It is the only thing in the system that
reaches another service, it carries an idempotency key, and the key is built
from a *canonical* target, because one post written two ways was two actions
until it was not.

**An approval is an owner gate.** One state, whatever asked for it and whatever
answers. A transport does not get its own approval semantics: Telegram calls
`approveJob` exactly as the web does, and gets the same policy check on the text.

## Rules that hold the shape

**The model is shown the few capabilities that bear on the question, never all
of them.** Seventy-three render 20,535 characters of menu against a
3,010-character prompt, and an agent handed that called nothing at all: asked
the time it ran a web search and answered "I don't know" while `time.now` was
in the list. The narrowing is deterministic and reads only what a capability
already declares about itself, so a new one is shortlisted without editing
anything. A task that matches nothing is offered nothing, which is correct for
banter and costs no tokens.

**`CAPABILITY_OFFERED` records what was on the menu beside what was used.**
"The agent did not look it up" has two causes with one symptom, never
shortlisted or shortlisted and declined, and they need opposite fixes.

**A failed lookup before the prompt is not the end of the search.** The
research step runs before assembly and the capability loop runs after it, so
the evidence verdict must not close a door the model is about to be offered.
The requirement to admit uncertainty is unchanged either way.

**An agent gives up speculation before it gives up answering people.** Loops
declare ESSENTIAL, STANDARD or OPTIONAL. Mentions arriving, the owner's
commands and recovery never stop at any pressure; watching repositories goes
first. The pressure verdict is smoothed asymmetrically, twenty seconds to
believe it got worse and two minutes to believe it got better, because
`freemem` moves every second and an unsmoothed verdict starts and abandons the
same work repeatedly.

**A speed setting turns model calls on and off, or it is a label.** The three
response speeds are one record in `contracts/policy.ts` that the runtime reads
for its numbers and the interface reads for its words, so a setting cannot come
to describe something it no longer does, and `responseSpeed.test.ts` fails if
any two of them do the same thing. What varies is the voice rewrite (24.9s at
the median, the largest optional cost in a reply), whether a cheap model chooses
what to look up and how long it is given, and how many times the model may stop
to ask for a capability. What never varies is reading the thread, memory, the
lookups themselves, the validator or the deterministic voice pass, because a
faster reply that is checked less is not a speed setting, it is a different
promise.

**A claim moves a due time and nothing else.** `claimDueWakes`, the account
poller and the feed watcher all move the next-due column in the statement that
selects the row. A claim that also stamps "last looked at" closes the window the
work it is claiming is about to read, because `UPDATE ... RETURNING` returns the
row as written. That cost deliberation every scheduled observation it ever had.
See `DELIBERATION.md`.



**Nothing downstream of a channel adapter knows what X looks like.** No selector,
no cookie, no vendor payload leaves `packages/channels`.

**The API owns no browsers.** Anything needing the signed-in session records a
`browser_tasks` row and the worker executes it. That is why looking somebody up,
collecting a persona, and rehearsing against a real post are all browser tasks
rather than API calls.

**A rehearsal is not a sighting and not a message.** The Response Lab runs the
real pipeline so its answer is worth something, which means it manufactures a
real event. That event carries its own id and a `rehearsal` marker, and the
inbox and mentions read models skip it.

**Absent is never zero.** A count nobody could read is not a count of zero,
anywhere in the reading layer or downstream of it.

**Silence is a branch.** A decision not to reply ends a job as `CANCELLED` with
its reasons, never as a failure.

## Where to add things

- A new thing an agent can *read*: extend `x/intelligence` or add a watcher
  beside `repoWatcher.ts`. It produces observations and stops there.
- A new thing an agent can *do*: a capability in `packages/runtime`, registered
  in Toolspace, executed through `performCapabilityAction`. Not a new executor.
- A new reason to *not* do something: a factor in the relevant heuristic, with a
  named reason. A score without its reasons is not shippable.
- A new thing to *tell the owner*: `notify.ts` decides whether it is worth
  saying. No subsystem calls a transport directly.
- A new *health* signal: a component in `collectHealth`. Both surfaces get it.
