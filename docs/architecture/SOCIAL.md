# The social layer

**The provider supplies intelligence. AI17Z supplies identity.**

The failure this replaces is the shape almost every agent has:

```
mention → send text to LLM → post whatever comes back
```

That produces something that reads differently every time the model changes,
treats a regular like a stranger, contradicts itself across days, answers a joke
with an explanation, and replies to everything because replying is all it knows
how to do.

## The pipeline that actually runs

Every one of these is a node in the stored graph, and the graph is what
executes. Nothing here is a hidden step.

```
X event
  ↓
RESOLVE_CONTEXT        thread, parent, target verification
  ↓
MEDIA_RESOLVE          images, quoted post, links
  ↓
RELATIONSHIP           who this is, what you have discussed
  ↓
STANCE                 what you already think about it
  ↓
ENGAGEMENT_DECISION ───ignore──→ END (a decision, not a failure)
  │                └──review──→ END (asked a person)
  ↓ engage
INTENT                 answer / disagree / joke / clarify / deflect
  ↓
RETRIEVE_MEMORY
  ↓
ASSEMBLE_PERSONA
  ↓
GENERATE               ← the only place the provider decides anything
  ↓
VALIDATE               output policy
  ↓
VOICE                  make it sound like this agent
  ↓
QUALITY_GATE           voice / generic / repetition
  ↓
STANCE_CHECK           does this contradict what you said before
  ↓
APPROVAL_GATE
  ↓
EXECUTE_ACTION
  ↓
MEMORY_WRITE
```

## Social Radar

Six independent monitors, one reconciler.

| Monitor | What it catches |
| --- | --- |
| `notifications` | the platform's own surface — one source, never the truth |
| `mention_search` | mentions notifications dropped |
| `reply_search` | replies indexed separately from mentions |
| `own_threads` | replies under the agent's posts that produce no notification |
| `tracked_account` | context from an account worth watching |
| `tracked_keyword` | a topic, ticker, or custom query |

**Identity is the post, not where it was found.** The same mention arriving
through three monitors within a minute is one event and one job — otherwise the
agent answers the same person three times. Discovery evidence is a child of the
event, so the existing unique index is what makes concurrent sightings safe.

**Health is per source and three-valued.** Worked-and-found-nothing is healthy;
one failure is degraded; only repetition is failing. Collapsing those is exactly
how the old single surface hid its own outage.

**Watching is not permission to reply.** A tracked account informs context and
creates nothing unless `mayTrigger` is turned on deliberately.

## Multimodal context

A post is not its text. Images, GIFs, video, the quoted post, and links are
stored as distinct objects, because "the question is in the second image" has to
be resolvable.

- A short post with an image is assumed to be **about** the image. Conservative
  in one direction only: answering the wrong question confidently is the outcome
  worth avoiding.
- Media that could not be read is an **explicit gap**, and the prompt tells the
  model to say it cannot see it. Pretending is worse than admitting.
- Vision uses the `vision` role only, never a fallback. Sending an image to a
  model that cannot read one gets a confident description of nothing.
- A quoted post's images belong to the quote — the difference between "Alice
  posted a chart" and "Alice quoted a chart".
- Link fetching is a real act against a third party and happens only where
  policy allows. A refused link is recorded with its reason.

## Relationships

Familiarity is earned by **exchanges**, not volume. Somebody who mentions the
agent thirty times and is never answered stays `NEW`, because that is not a
conversation. Time counts too: twenty exchanges in an afternoon is a thread.

The exchange is recorded **after the reply goes out**. Counting unanswered
mentions is how somebody persistent comes to look like a regular.

Callbacks rest between uses and retire after enough of them. A shared reference
used every time is a tic, not continuity.

The prompt gets sentences, not fields. A model handed a table of interaction
counts writes replies that sound like a CRM.

## Stances

A changed position **supersedes** rather than overwrites. The old row is what
lets the agent say "I was sceptical about this earlier, but".

Only a straight reversal counts as a conflict, and only against a firmly held
position. An agent that cannot move from certain to hedged is not consistent, it
is stuck.

Positions are learned from what was **published** — never a draft, never a dry
run. A dry run is explicitly not a public position.

## Engagement and intent

**Silence is a branch, not an error.** `ENGAGEMENT_DECISION` has three wired
outcomes and a job that ends in `ignore` is `CANCELLED` with reasons recorded.

Reply value starts at 40, not zero: the default posture toward somebody who took
the trouble to say something is to answer, and the score has to be pushed down
by a reason. The reasons are the point — "reply value 18" tells nobody anything;
"tags 6 accounts at once" tells them whether the call was right.

Four strategies, because one policy does not suit every agent.
`NEVER_AUTO_IGNORE` exists for owners who want silence to always be a person's
decision.

Hostility is met with `DEFLECT`, never `CHALLENGE`, and the tone-mirroring
default for hostility is `0.05`. Escalating is how an agent ends up in a fight on
its owner's behalf.

## Voice — the part that makes this provider-independent

The fingerprint is **measurements, not adjectives**:

```
median 54 characters, p90 147
1.4 sentences typical
questions 8%   exclamations 2%   emoji 0%   hashtags 0%
fragments 41%  contractions 12%  first person 18%
```

"Tone: dry" is a label each provider reads differently and differently again
next month. These are targets that do not move when the model behind them
changes.

Three levels of intervention, ordered by cost:

| Voice score | What happens |
| --- | --- |
| ≥ 85 | accepted — but the free cleanup still runs |
| 70–84 | deterministic tidy-up: filler openings, sign-offs, habits it does not have |
| < 70 | model rewrite, briefed with numbers rather than adjectives |

The free pass runs **whatever the score**. A helpdesk sign-off on a
correctly-sized reply still reads as a helpdesk sign-off, and the score cannot
see it — length, structure and punctuation are all fine.

The compiler only removes and substitutes. One that writes new sentences is a
second model with none of the safeguards.

A rewrite that scores worse than the draft is **discarded**. A failed rewrite
never fails the job.

### Generic-AI detection

Phrases *and* structure, because a blacklist alone does not work: the balanced
caveat, the essay conclusion, the customer-service register all survive any
amount of word substitution.

This is a **register metric**. It says how much something reads like a generic
assistant, which is a question about style rather than about origin, and it must
never be presented as evidence that text was machine-written.

### Anti-repetition

Several kinds of similarity, because reusing an opening and lifting a whole
sentence are different problems: trigram overlap, longest shared run, and opener
match. Saying the same thing to the same person scores worse; something from
three weeks ago scores less.

Signature phrases may recur, but only once rested — otherwise the thing that
makes an agent recognisable becomes a tic.

## Conversation arcs

Thread state carries what is settled, what is open, and a two-sentence summary.
The prompt is told not to reargue settled points, which is the whole purpose:
an agent that concedes a point and argues it again two turns later is the
failure.

Rebuilt every few turns, not every turn. A conversation does not change shape
between one reply and the next.

## Content

Ideas come from things that happened — a question the agent answered well, a
position worth stating on its own. **An empty backlog means the agent posts
nothing**, which is the correct outcome rather than a gap to be filled by
inventing a thought at 9am.

## Cost and latency

Every model stage is optional and most replies use one call.

| Stage | Model? |
| --- | --- |
| media understanding | only when there is media and a `vision` model is set |
| thread summary | every ~3 turns, `classifier` role |
| engagement, intent, temperature | never — arithmetic |
| voice score, generic, repetition | never — arithmetic |
| generation | always, one call |
| voice rewrite | only below threshold, `voice_rewrite` role |

The fast path for a simple mention is: deterministic decisions, one generation,
deterministic checks, post.

## What is deliberately *not* here

- No engagement optimisation. An agent tuned for replies per hour is worse.
- No sensitive inference. Relationships hold what happened between two people
  and nothing about who anybody is.
- No AI-detection claims. The generic score is about register.
- No hidden steps. Every stage is a node in the graph the owner can see.
