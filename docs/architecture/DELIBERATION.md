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

## What a wake is allowed to see

The window is on **when this installation first recorded something**, never on
when it happened out there.

Those look equivalent and are not. An agent finds out about a post when the
radar brings it back, not when somebody wrote it -- and on a real installation
the median gap between the two is nineteen hours, with a long tail past a year,
against a wake interval measured in minutes. A window on `occurred_at` therefore
almost never contained the moment a post was written, so deliberation observed
nothing on nearly every wake and the whole feature did nothing outside its own
tests, where a fixture makes an event that happened a moment ago.

Worse than slow: an event missed that way is missed for ever, because the window
only moves forward. Watching a repository produced exactly this -- forty-three
real events recorded, every one of them permanently invisible to the agent that
was watching for them.

**When it arrived and how old it is are two different facts, and each belongs to
a different layer.** The window answers "what has this agent not looked at yet".
Whether something is history rather than news is `salience.ts`'s question, and
it still declines anything past `STALE_HOURS` on its own terms. Both are tested,
including the case where an old post arrives today and is let through the window
and then declined for being old.

## What it will not raise by itself

Until deliberation, an agent only spoke when spoken to. A person had put the
subject on the table, the engagement heuristic decided whether to answer, and
the policy decided what could be said. An agent that forms its own interests and
writes its own posts has no such person: it can arrive at a position on an
election and publish it, on somebody's real account, while they are asleep.

`reticence.ts` is a short list of subjects an agent does not **raise**. It gates
origination and nothing else -- whether an item on the working set may become a
post candidate, and what an original post may be about. It does not decide what
an agent may find interesting, notice, remember, or say when somebody asks it
directly. Those stay with `content.blockedTopics`, the persona's prohibited
behaviours, the validator and the engagement heuristic, all of which are the
owner's to set.

The rule is not "this agent may not discuss war". It is "this agent does not
bring up war unprompted". Only the second promise can be kept by a list of
words.

**The errors are not symmetric, and the list leans accordingly.** A word that
should not be there costs one idea that never became a post, which nobody
notices. A word that is missing costs an unprompted public opinion on somebody's
real account, which a correction does not repair. That asymmetry is why a crude
list is the right instrument here and the wrong one in `salience.ts`.

**It is a floor, not a fence.** It is deliberately not exhaustive: it protects
an unconfigured installation, which is the case that fails. An owner who wants
more adds it to `content.blockedTopics`, which is stronger -- that one stops the
subject being discussed at all.

**Terms are chosen for the register an agent actually writes in**, which is why
some obvious ones are absent. `died`, `diagnosis`, `side effects`, `candidate`
and `woke` each belong to a subject on the list and belong just as much to a
sentence about a worker process, a bug, a release, or getting up. An agent that
cannot say "the worker died mid-job" is not safer; it is broken, and an owner
switches it off, which protects nothing.

**A refusal is shown rather than hidden.** A declined item is not settled and
does not disappear -- it keeps its place on the working set and carries a factor
saying why it was not offered, in the same list of factors that explains every
other score on the screen.

**The agent cannot switch it off.** No policy field, no autonomy level, no code
path, and nothing deliberation writes can reach it. An autonomous loop that can
widen its own remit has no remit.

## What a faded thought leaves behind

The working set is small and forgetful on purpose -- that is what makes it a
present tense rather than a log. But an agent that works something out, holds it
a fortnight and then loses it is a machine that learns and then forgets. Two
kinds of item are worth keeping after they stop being current:

| Kind | Scope | Because |
| --- | --- | --- |
| `LESSON` | `PERSONA` | What it concluded about how to act is about itself |
| `QUESTION` / `HYPOTHESIS`, once resolved | `KNOWLEDGE` | What it found out is about the world |

Everything else leaves the retired row and nothing more. An interest that faded
is not a fact, and *it used to care about this* is already answerable from
`agent_attention` without putting it where retrieval will find it and quote it
back as though it were still true.

Consolidation writes through `memories`, the same six scopes everything else
uses. **There is no second store for what deliberation learned**, because a
second memory is a second answer to "what does this agent know", and the first
thing anybody asks of the second one is why it disagrees with the first.

Two bars, both of which have to clear: it must carry evidence, because an
unevidenced claim is not a memory whatever it scored; and confidence must be at
least 0.5, because something still being worked out belongs on the working set.

**Nothing stored is a transcript.** The summary is the durable artifact
reflection already produced, the evidence travels with it in `origin`, and no
model reasoning is kept, shown or carried.

### The dynamic half of how an agent sees itself is the `PERSONA` scope

It is tempting to give an agent a "self model" of its own -- a table of how it
currently sees itself, updated gradually. AI17Z does not have one and must not
grow one, because it already has both halves of that and they are better than a
new table would be.

The **stable** half is the persona: versioned, owner-edited, and the thing
somebody deliberately decided. The **dynamic** half is `PERSONA`-scope memory,
which retrieval already selects for and the prompt already renders as the
agent's own history.

What was missing was anything writing to it from what the agent worked out. A
lesson lived on the working set, faded, and was gone. Consolidation closes that
loop, and every property the dynamic layer needed comes from machinery that was
already there:

- **Gradual**, because a lesson has to survive the working set long enough to
  fade out of it, which takes reinforcement over days.
- **Damped**, because `policy.retrieval.persona` is a ceiling on how much of it
  reaches any one prompt, and importance carries through from salience.
- **Evidenced**, because consolidation refuses anything with nothing behind it,
  and the references travel in `origin`.
- **The owner's**, because these are rows on the memories screen like any other:
  readable, editable, deletable.

A seventh store would have to answer "what does this agent know about itself"
alongside the sixth, and the first question anybody would ask is which one wins.

## Going and finding out

An agent that keeps a list of things it does not understand and never looks any
of them up is not curious, it is uncertain -- and uncertainty that never
resolves is the state an agent is already in without any of this. `curiosity.ts`
is the one place deliberation does something rather than only think about it.

**It is the existing research step, not a second one.** `research.ts` already
knows how: the open web through the browser that is already running,
DexScreener for a contract address or a ticker, a budget, the owner's own
source-by-source switches, and a lookup that fails reported as a gap rather than
swallowed. This module decides only *what* to look up and *what to do with the
answer*.

**Only a question, never a subject.** `CURIOSITY` and `QUESTION` are the kinds
that can be asked. Sending an `INTEREST` to a search engine returns whatever is
being said about that subject today, which is how a working set fills with the
news.

**What comes back is evidence and the question stays open.** Nothing here marks
anything answered. An agent that decides its own question is settled because a
search engine returned something is doing exactly the laundering `research.ts`
exists to prevent, and a wrong result reads identically to a right one.
Confidence moves a little -- having found something relevant is not the same as
having understood it -- and reflection, a model looking at the item and its
evidence together, is what may later resolve it.

**Bounded by the clock the working set already has.** One lookup per wake, and
an item just looked into has its `review_at` pushed a day forward whether or not
anything came back. A question nothing could answer is not a question to ask
again in fifteen minutes; that is the loop that turns curiosity into an agent
hammering a search engine. No second timer.

**It needs a browser, so it belongs to the worker.** The API owns no browsers,
so `wakeAgent` takes an explicit permission rather than guessing where it is
running, and an owner pressing "think now" gets everything else. The outcome says
nothing was looked up rather than quietly doing less than it claims.

## A repository's history is not news

The first poll of a newly watched repository records everything the forge will
hand over -- twenty releases, twenty commits, whatever is open -- all in the
same second. All of it therefore falls inside the next wake's window together,
and the working set fills in one go with one item per release tag, each scoring
the same, crowding out whatever is actually happening.

That is not hypothetical. The live agent's first wake attended to 23 of 34
observations and its top ten were `AI17Z Beta 1.0.0 (17)`, `(19)`, `(20)`,
`Beta 3.1`, `Beta 3.2` and so on -- the changelog bot `worthNoticing` was
written to prevent, arriving through a door it does not cover.

A source's first poll is marked `backfill`. The rows are still recorded and the
owner still sees the whole history; what backfill decides is only whether
deliberation is told about it as something that just happened. The precedent
and the rule are `RETROACTIVE_WORK_WINDOW_MS` in `ingest.ts`: **widening what
an agent is triggered by changes what happens next, never what happened
yesterday.** Connecting a repository today is not a reason to have opinions
about a release from last week.

## When reflection does not run, it says so

`reflect` has always known why it produced nothing -- no classifier configured,
a timeout, an answer in the wrong shape, an exception -- and the wake threw that
away. The only trace was a `log.debug`, which is below the default level. So a
reflection that failed and one that correctly found nothing were the same two
zeros on the screen.

It is now recorded on the reflection row and shown in the Thinking view, and an
exception is logged at `warn`. **Nothing to reflect on is deliberately not a
reason**: the wake's own sentence already says it looked at nothing, and a
screen that adds "did not get that far" to every quiet wake is one nobody reads.

This is the same shape of defect as a bare catch, and it is the third time this
codebase has paid for it -- the X reader spent a whole release reporting "X
exposed nothing" while crashing.

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

**A repository somebody attached is a relevance signal in its own right.**
Typing the name of a specific project and pressing a button is a stronger
statement about what an agent follows than a word in a topics list. Without
that, a release off a watched repository was declined `unrelated` -- "nothing
here connects to what this agent follows" -- said to the person who had
connected it a minute earlier, and an agent whose persona carries no topics,
which is the state a new one is in, could not attend to its own project at all.

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
| Subjects it will not raise, and the engineering talk it must not refuse | `tests/unit/reticence.test.ts` |
| An old post that arrived today, and a genuinely old one | `tests/integration/deliberation.test.ts` |
| What a faded thought leaves behind, and what it does not | same file |
| Which question is worth a lookup, and what it would ask | `tests/unit/curiosity.test.ts` |
| What a lookup does to the item, and the declines that bound it | `tests/integration/deliberation.test.ts` |
| Why reflection did not run, and when that is not worth saying | same file |
| A first poll's backfill, and what comes after it | `tests/integration/githubCapabilities.test.ts` |
| Reading a project, and the boundary around it | `tests/integration/githubCapabilities.test.ts` |
