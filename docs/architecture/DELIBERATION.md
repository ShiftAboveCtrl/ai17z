# Persistent autonomous deliberation

An agent that thinks between the things it is asked.

> **This is not a mind, a consciousness, or a stream of thought, and nothing in
> AI17Z may describe it as one.** It is a bounded working set of structured
> conclusions, each carrying the evidence it rests on. The honest claim is
> narrow and still worth a great deal: an agent that keeps context, researches
> its own uncertainty, holds goals and learns from outcomes participates with
> continuity — and one that does none of those things can only react.

## Why it exists

An AI17Z agent already had identity, persona, voice, six memory scopes,
relationships, stances and commitments. What it had never had is a **present
tense**: what it is interested in now, what it is unsure about, what it is
trying to find out, what it recently learned.

Without that an agent is reactive. It answers what it is asked, and when nobody
asks it has nothing to say — so a posting schedule either goes quiet or produces
filler, and every reply starts from the same standing start however long the
agent has been running.

## The shape

```
observe    read what the pipeline already wrote
attend     score it deterministically, and mostly decline it
reflect    connect what survived — bounded, model-assisted, optional
update     decay, retire, supersede
intend     turn the strongest of it into candidates the existing gates judge
```

| Table | What it holds |
| --- | --- |
| `agent_attention` | The working set. What is on its mind, with the factors that put it there. |
| `agent_goals` | What it is trying to do, and who decided. |
| `agent_reflections` | Every time it looked, including the times it found nothing. |
| `agent_wake` | When it next thinks, and how much it may do on its own. |

## Five properties, and what each prevents

**No second scheduler.** `agent_wake` carries the due time and the claim moves
it forward in the statement that selects it — the same shape as the account
poller, the feed watcher and the repository watcher.
`docs/architecture/CADENCE.md` allows one timing engine.

**No raw chain-of-thought, anywhere.** Every artifact is a conclusion, its
evidence, its confidence and what to do next. Model reasoning tokens are not
stored, not shown to an owner, and not sent anywhere. A "reflection" is a
durable summarised artifact; it is never a transcript.

**Doing nothing is a result.** Most wakes produce nothing. That is recorded as
what happened and shown on the screen, because a view that listed only the
productive runs would make a correctly quiet agent look broken. A quiet agent
also backs off — doubling to a ceiling of eight times its interval — so it stops
asking a paid model the same question every half hour for ever.

**Nothing here decides to act.** At most deliberation puts a well-sourced idea
in `content_ideas`, which the posting engine already reads and already refuses
to post from when there is nothing worth posting. The engagement heuristic, the
policy gates, cadence, rate limits, idempotency and exact-target verification
all still run.

**Identity evolves; security policy does not.** An agent may develop interests,
goals, hypotheses and lessons. It may not change what it is permitted to do. The
autonomy ladder is owner-set only.

## Attention is deterministic, and that is not a cost decision

Nothing in `salience.ts` calls a model. `docs/ENGINEERING.md` says a score
without its reasons is not shippable, and *"the model thought it was
interesting"* is not a reason anybody can inspect, correct or tune — which is
exactly the judgement an owner most needs to be able to look at.

So every point is attributable to a named factor carrying a sentence: what
subject it is about, whether it bears on a goal, who said it, how fresh it is,
whether anybody else was discussing it, and whether it is new relative to what
is already on its mind.

**The default answer is no.** Most observations are *declined outright* rather
than scored low — something with nothing to do with this agent is a reason not
to think about it, not a weak reason to think about it. An agent whose working
set fills with everything it saw has no interests; it has a queue.

## A working set is about subjects, not posts

Items are fingerprinted on what they are about, and the unique index on
`(agent, kind, fingerprint)` turns repeat sightings into **reinforcement**
rather than duplication.

This was wrong once and the failure is worth recording: fingerprinting every
discovery on its permalink made three people saying the same thing into three
entries that read as an agent fixating, and nothing was ever reinforced — so
nothing could be told apart from a passing remark, which is the signal the whole
set is ranked by. The anchor is now kept only where the object genuinely *is*
the thing: the agent's own published action, a promise it made, a release.

## Fading, rather than a deletion timer

Salience decays exponentially on a per-kind half-life, and an item below the
floor is **retired rather than deleted** — "what did it used to be interested
in" is a reasonable thing for an owner to ask. Decay is reversible: a subject
that comes back is the same subject.

A `LESSON` outlives a `NARRATIVE` by a long way, because a narrative is about
what is happening and a lesson is about what turned out to be true.

## Reflection: the one place a model does the thinking

Fenced four ways — a `classifier` role only, one call, a timeout, and a schema
that **drops any item citing no evidence**. Everything that goes wrong keeps
what attention already produced, and the wake records that reflection did not
run. The working set is never worse for having tried.

Never the primary model. An expensive reasoning call to decide whether anything
interesting happened is the opposite of the point — the same argument
`plan.ts` makes about planning lookups.

A conclusion that merely restates one of its own sources is dropped, which is
the guard against a loop that turns every observation into an "insight" about
that observation.

## What reaches a reply

**Relevance-driven, always.** An agent may be uneasy about something all week
without every answer mentioning it. Internal state that leaks into unrelated
conversations is worse than internal state nobody has, because it reads as an
agent that cannot tell what it is talking about.

An original post is the deliberate exception: there is no incoming message for
anything to be relevant *to*, and "what has this agent been thinking about" is
exactly what a post answers.

Confidence travels with each line and is not decoration. A hypothesis held at
0.4 is introduced as a thing it suspects, because an agent that states one as a
finding is worse than an agent that never had it.

## The autonomy ladder

| Rung | What it adds |
| --- | --- |
| `OBSERVE` | Notices and scores. Changes nothing, says nothing. |
| `THINK` | Also reflects, decays, and keeps its own working set. |
| `SUGGEST` | Also puts candidates in the backlog an owner can see. |
| `ACT` | Also lets candidates reach the gates that were always going to decide. |

Four rungs rather than a switch, because "autonomous" is four separate decisions
somebody makes at different times and one control forces the most cautious of
them onto all four. **`ACT` is not a bypass** — it decides whether a candidate
is offered to the existing gates, never whether those gates run.

Off by default. An agent does not start thinking because it was created.
**PAUSE ALL stops deliberation entirely**, including the thinking: it costs
model calls and changes the agent's own state, and an owner who pressed pause
did not mean "keep developing opinions".

## Watching a project

`docs/architecture/DELIBERATION.md` is also where repository awareness lands,
because knowing what a project did is one of the few things an agent can be
genuinely current about.

`repo_sources` watches a repository and `repo_events` records what it did, with
a URL anybody can check. Read only and structurally so: four GET endpoints, no
push, merge, comment or release, and no column a write could be built on.

Polling rather than webhooks, because a local installation usually has nowhere
for GitHub to deliver to. Conditional requests make that cheap — a stored ETag
gets a 304 with no body, which GitHub does not charge against the rate limit —
and the unique index on `(source, kind, remote_id)` is what makes overlapping
polls safe. Polls overlap as a matter of course.

**`worthNoticing` is the half that matters.** Most of what a repository does in
a day is mechanical and interests nobody outside it, and the entire difference
between a project-aware agent and a changelog bot is what it declines:
conventional `chore`/`ci`/`docs` prefixes, lockfile bumps, a subject too terse to
be about anything, a pull request that is only proposed, a build doing what
builds do. A release always counts; a red build counts because somebody may ask.

## Tests

| Property | Where |
| --- | --- |
| Attention, declines, decay, fingerprints | `tests/unit/salience.test.ts` |
| Observe, attend, reflect, goals, pause, backoff, restart-safety | `tests/integration/deliberation.test.ts` |
| What reaches a reply, and what stays out of one | same file |
| What a project did, and what is never worth mentioning | `tests/unit/repoWatcher.test.ts` |
| Reading a project, and the boundary around it | `tests/integration/githubCapabilities.test.ts` |
