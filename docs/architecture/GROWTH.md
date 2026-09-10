# Growth

**What an agent has seen, what came of it, and what none of it can tell you.**

Everything in this document is a claim about the past. Nothing here decides what
an agent says, and nothing here can publish. It exists because an owner running
an autonomous account on their own machine has no other way to find out whether
it is working, and the alternative to answering that badly is answering it not
at all.

## The shape of every answer

Three parts, in the same three components on every screen:

```
the claim      one number, and the sentence that says what it is
the reasons    what moved it, each with its own sentence and its own weight
the gaps       what could not be measured, given the same weight as the claim
```

`docs/ENGINEERING.md` puts it plainly: the reasons matter more than the scores,
and a score without its reasons is not shippable. That rule is load-bearing here
more than anywhere else in the product, because these are the numbers most
likely to change what somebody does — an owner rewriting their agent's voice on
the strength of eleven posts is the failure this whole area is arranged to
prevent.

The gaps are not a footnote. Two accounts on the same bridge score are not
equally well understood, and only the gaps tell them apart.

## Nothing is stored

There is no growth table. Every answer is derived, at the moment it is asked,
from rows the pipeline already writes:

| Question | Read from |
| --- | --- |
| What is being said | `events` — what the radar discovered |
| What is being launched | `events` |
| Who leads somewhere new | `relationships`, plus co-appearance in `events` |
| Worth speaking into | `events`, `actions`, and the bridge scores |
| What has worked | `actions` joined to `post_analytics` |
| How the account itself has moved | `account_analytics` |

`repositories/mentions.ts` makes the same argument about the inbox being a read
model rather than a table. A second record of what happened drifts from the
first, and the first is the one the pipeline maintains.

The two exceptions are `experiments` -- a question somebody asked is not
derivable from anything -- and `account_analytics`, because a follower count
that was true last week is not recoverable from anything true today.

## Absent is not zero

The rule the whole area turns on. A post whose impressions were never read is
left out of every comparison rather than counted as nought — counting it drags
whichever group it lands in and makes "we have not looked" indistinguishable
from "it got nothing".

`post_analytics` makes every metric nullable for the same reason, and
`publishedWithReadings` is anchored on what was published rather than on what
was measured, so an unmeasured post is present with blanks instead of absent
altogether.

## How measurement happens

Reading a post *is* measuring it. Every `x.read_post` records an observation,
and the radar's own-threads monitor records one each time it visits one of the
agent's own posts to look for replies — it is already standing on the page where
the counts are. Nothing polls X to ask how a post is doing.

Observations are snapshots, never a running total. The unique index is per post,
per source, per minute, so a poller that runs twice records one observation. An
older reading is evidence; replacing it would throw away the only thing that
makes a series a series.

Two sources, kept apart: `TIMELINE` is what anyone can see, `POST_ANALYTICS` is
what X shows only the author. They were measured by different things and one
must never suppress the other.

The account's own numbers work the same way and are collected the same way:
reading the agent's own profile records a follower count, and nothing else does.
Only its own -- a follower count for somebody else is read live for a bridge
score and not kept, because a series about accounts the agent merely looked at
would be a history of people who never asked for one.

**Nothing here is scheduled, and that is deliberate.** `docs/architecture/CADENCE.md`
allows one timing engine and no second timer. So the series is as dense as the
looking, and the screen that shows it says so instead of implying a daily
measurement nobody is taking.

## Bridges are about attention, not worth

`contracts/relationship.ts` says familiarity exists so a conversation can
continue naturally, "not as a score for deciding whose message is worth more,
and not as a measure of anybody's value". The bridge score sits on the far side
of that line and stays there:

- **Nothing in the reply path may read it.** Whether to answer somebody is
  decided by what they said.
- It ranks conversations the agent might *start*, which is a question about the
  agent's own attention.
- An owner instruction ends the question rather than being outweighed by a
  follower count.

The name is the definition. A bridge connects two groups that are otherwise
separate, so an account whose whole neighbourhood the agent already talks to
scores low however well liked it is. Reach is log-scaled and relative, because
linear reach makes one enormous account outrank every other consideration
combined — which is how automated outreach ends up talking exclusively at people
who will never answer.

## Opportunities are mostly declines

The easy version of this feature is to score every post on a timeline and reply
to the top ten. That is an agent answering strangers about subjects it knows
nothing about, under somebody's own name.

So a post about nothing the agent has anything to say about is **declined
outright** rather than scored low, and the declines are returned alongside the
opportunities with a sentence each. "We looked at forty posts and found nothing"
is the useful answer; an empty list on its own is not.

The subjects come from `PersonaDraft.topics` — the same list the reply path
reads. A second copy would drift the moment somebody edited one.

## Narratives need more than one voice

Any bag of text produces a ranked list of words, and a ranked list of words
looks exactly like an insight. Three refusals:

- One account repeating itself is not a narrative. A term needs several distinct
  authors.
- Share, not count. Reading twice as many posts produces twice as many mentions
  of everything, which reads as everything rising.
- A rise needs a before. With nothing older read, these are subjects that are
  *present* rather than *rising*, and the difference is stated rather than
  implied.

## Launches state no fact

The part of the product where a confident sentence does real damage. Nothing
here produces a fact; it records where one was seen, with the posts and the
accounts that posted it. No price, no liquidity, no volume, no pair — those come
from the market lookup, which quotes its source, and they are a different
subsystem on purpose.

The one judgement is arithmetic: several different addresses for one ticker
means at most one of them is right, and this cannot say which. Addresses are
shown in full and selectable, because a truncated address somebody copies from a
screenshot is worse than no address at all.

There is no path from here to a wallet.

## Experiments refuse to answer

An agent posts a couple of times a day, so every honest verdict for the first
fortnight is "not yet". A tool that instead announces a winner on Thursday is
worse than no tool. The floor is in `readExperiment` and cannot be lowered from
a screen.

- **One running experiment per agent**, enforced by a partial unique index. Two
  at once are one experiment with four arms: a post written short *and* with a
  picture belongs to both, and whichever finishes first takes credit for the
  other's effect.
- **Assignment is stored, not recomputed.** The hash is stable so a restart
  between writing a post and publishing it cannot move it between arms, but the
  experiment id is part of that hash and recomputing later against an edited
  experiment would silently reshuffle counted results.
- **Posts only, never replies.** Quietly varying how the agent answers somebody
  is an experiment run on a person who did not agree to be in one.
- **The variant joins the output rules and nothing else.** An arm that rewrote
  the persona would be a second agent rather than the same agent writing
  differently. The control arm must leave the prompt byte for byte as it was, or
  both arms differ from the baseline and the experiment measures the harness.
- **Median, not mean**, for the same reason content signals use one: a post
  carried by a large account is ten times every other post combined.
- Stopped, never deleted. "We tried that and it made no difference" is most of
  what this teaches.

## Where it is shown

X Studio, at `/agents/:id/studio` — its own page rather than a tab on the agent
screen. That page is where somebody decides what their agent *is*; this is where
they look at what came of it, and its five tabs are sized to fit a 375px phone
without a sideways scroller.

Nothing on the Studio page publishes. The one thing it writes is an idea into
the backlog the posting engine already reads, and an agent coming due still
decides for itself whether there is anything worth saying.
