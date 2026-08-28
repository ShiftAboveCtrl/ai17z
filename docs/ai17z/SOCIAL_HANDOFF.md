# Social intelligence — handoff

**418 tests passing. 9 end-to-end. 39 migrations, no drift. Typecheck clean.**

All fifteen phases of §112 are built, in the order the specification gave. This
document says what each one actually does, what was proven by running it, and
what remains untested.

---

## Social Radar

| Monitor | Implemented | Tested |
| --- | --- | --- |
| `notifications` | yes | reconciliation, health, cursor |
| `mention_search` | yes | same |
| `reply_search` | yes | same |
| `own_threads` | yes | own-post ledger, rotation, age bound |
| `tracked_account` | yes | context-only enforcement |
| `tracked_keyword` | yes | same |

**Reconciliation is proven:** the same post through three monitors produces one
event and one job. Discovery evidence is recorded per source, so a monitor that
only ever repeats what another found is visible.

**Health is per source and three-valued.** A source that worked and found
nothing is healthy; one failure is degraded; three is failing. One failing
source does not stop the others being polled.

**Not tested against live X.** The monitors have not been run against the real
service — that needs a signed-in account.

---

## Multimodal

| Media | State |
| --- | --- |
| images | inventory, vision description, OCR text kept separately |
| GIFs | recognised and described as reactions, briefly |
| video | poster frame only — one honest still, not frame-by-frame |
| quoted posts | resolved as a distinct object with their own media |
| links | recorded with the policy decision; fetching is a tool call |
| polls | detected, not analysed |

A short post with an image is assumed to be about the image. Unread media that
mattered is an explicit gap and the prompt tells the model to say so.

**Vision has never been run against a real vision model.** No provider with
vision is configured here, so image description is exercised only through the
adapter contract.

---

## Relationships

Schema: handle plus platform id, first and last interaction, inbound and
outbound counts, familiarity, topics, summary, owner note, disposition,
callbacks with use counts.

Familiarity is derived from **exchanges** and elapsed time, never from inbound
volume. Retrieval prefers the platform id, so a rename does not reset a
relationship.

---

## Stances

Positions supersede rather than overwrite; the superseded row is retained and
surfaced, which is what lets the agent acknowledge changing its mind.

Conflict is only a straight reversal of a position held above the confidence
threshold. Four policies: rewrite, review, allow-and-revise, ignore.

Predictions and commitments are detected and stored. **Only a person resolves a
prediction** — nothing decides an outcome automatically.

---

## Voice

Dimensions measured: median and p90 characters, sentences, words per sentence,
and rates for questions, exclamations, emoji, hashtags, links, fragments,
contractions, first person, capitalisation, ellipses, dashes, multi-line —
plus characteristic vocabulary and typical openers.

Derived from published replies, falling back to persona examples below twenty
samples. Provenance and sample count are stored and shown.

The compiler: deterministic pass always; model rewrite only below threshold; a
rewrite that scores worse is discarded; a failed rewrite never fails the job.

**Provider independence is proven end to end.** Two mock providers with
deliberately opposite house styles carry identical substance through the real
pipeline and both come out inside the agent's measured voice, with each
provider's tells stripped. The test states explicitly that identical text is
*not* the requirement.

---

## Repetition and generic-AI

Repetition: trigram overlap, longest shared run, opener match. Weighted by
recency and by whether it was said to the same person. Signature phrases may
recur once rested.

Generic-AI: phrase patterns plus structural ones — the balanced caveat, the
essay conclusion, the listicle, the transition stack, the restated question.
Scoped to the registers a persona actually wants to avoid.

**It is a register metric.** It says how much something reads like a generic
assistant. It is never presented as evidence that text was machine-written, and
must not be.

---

## Engagement and intent

Fourteen intents. Four strategies. Reply value starts at 40 and is pushed down
by named factors, all of which reach the UI with their signs.

**Silence is a branch in the graph**, ending the job as `CANCELLED` with reasons
recorded — never a thrown error.

Hostility is met with `DEFLECT`, never `CHALLENGE`. Hostility mirroring defaults
to 0.05.

---

## Conversation arcs, entities, content

Thread state carries topic, settled points, the open question and a summary;
rebuilt every three turns using the classifier role, and failing soft.

The entity graph records co-occurrence in Postgres tables. **The only claim
stored is that a post named two things together.**

Content ideas come from questions answered well and positions worth restating.
An empty backlog means the agent posts nothing.

---

## Cost and latency

| Stage | Model call |
| --- | --- |
| engagement, intent, temperature | never |
| voice score, generic, repetition | never |
| media understanding | only with media *and* a `vision` model |
| thread summary | every ~3 turns, `classifier` |
| generation | always, one |
| voice rewrite | only below threshold, `voice_rewrite` |

Fast path for a simple mention: deterministic decisions, one generation,
deterministic checks, post. Deep path adds vision, a summary, and a rewrite.

---

## Live X validation

| Level | State |
| --- | --- |
| mock | **passing** — 418 tests including the full pipeline |
| read-only | **not run** — needs a signed-in account |
| dry run | **not run against live X** |
| manual live action | **not run** |
| autonomous live test | **not run** |

A real Chrome sign-in window was opened and driven successfully, and the account
reached `AWAITING_LOGIN`. Nobody has completed a sign-in, so nothing downstream
of that has touched live X.

---

## Remaining limitations, stated plainly

1. **No live X validation.** Everything above is proven against mocks and the
   real pipeline, not against X. The monitors' selectors are written from the
   current DOM and have not been run against it.

2. **No vision model configured**, so image understanding is untested against a
   real one.

3. **No real provider key.** The provider-independence proof uses two mock
   providers with opposite house styles. That tests the compiler correctly; it
   does not prove Claude and DeepSeek specifically converge.

4. **twscrape has no X account.** It is installed and the API now correctly
   reports that, attributed to the worker that has it. Adding an account
   requires credentials and is yours to run: `twscrape add_accounts`.

5. **Proactive posting has no scheduler.** The content brain produces ideas and
   `nextPost` picks one up, but nothing calls it on a timer yet. Cadence governs
   reading and rate-limits acting.

6. **Video is a poster frame.** No transcription, no frame sampling. The
   `transcription` role exists and nothing uses it.

7. **The social critic (§67) was not built.** The quality gate is entirely
   deterministic. That is a deliberate ordering choice — every check that can be
   arithmetic is — but a model critic for "does this actually answer the post"
   is not there.

8. **Simulation mode (§92) was not built.** Historical events cannot be replayed
   against a new persona.

---

## Git

Branch `ai17z-overhaul`, 37 commits. The social layer is the last twelve:

```
bb1ec1a  radar
d9cc14d  multimodal
deb1c40  relationships
9e0d2ad  stances
9e0ba59  engagement
4680b54  voice
db0feaf  arcs
58e287e  content
cfc0160  provider regression + behaviour
427244b  persona sync routing
```

---

## The distinction this was built for

The provider decides **what is intelligent to say**.

AI17Z decides who is saying it, who they are speaking to, what has happened
before, what they believe, whether that belief has changed, what parts of the
post actually matter, what is in the image, whether to respond at all, what kind
of response it should be, how this particular agent would phrase it, whether it
has said this already, whether it still sounds like itself, and whether it
should be posted.

That is the difference between a bot connected to an API and a persistent social
agent. The architecture is there and tested. What it has not yet done is any of
it against the real X.
