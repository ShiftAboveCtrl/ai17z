# The Response Lab

The question an owner asks before they will let an agent near their account is
not "does it work" but **"what would it say to this, and why that"**. Both
halves matter. A draft on its own is something to like or dislike; a draft with
the evidence beside it is something to correct.

`packages/runtime/src/rehearse.ts` is the implementation. Studio's **Lab** view
is where an owner reaches it, and `apps/api/src/routes/lab.ts` is the three
routes between them.

## It runs the real pipeline, as a rehearsal

A rehearsal manufactures an event and lets the ordinary ten steps run, exactly
the way a scheduled post is manufactured as a `SCHEDULED_TRIGGER` event rather
than given a pipeline of its own. What comes back is a real job with a real
trace, and the explanation is a *reading* of that trace.

That is the property the whole thing rests on. An explanation produced by a path
of its own would be an explanation of that path.

## Not the playground

`playground.ts` deliberately runs persona, prompt, model, voice and validator
with **no** memory, thread or research, because comparing two personas fairly
means holding everything else still. It is the right answer to a different
question, and it cannot answer this one: most of what decides a real reply,
meaning who this person is, what was said above, what the agent already
believes and what it had to look up, is exactly what the playground leaves out.

Both still exist. Neither is a simplification of the other.

## Nothing published, structurally

`dryRun: true` is not a parameter. It is set in one place, it cannot be passed
in by a caller or a route, and the job row is **read back** and cancelled if the
flag somehow did not land.

That last check exists because its mirror has already been paid for. A nested
`{ options: { dryRun: true } }` was silently ignored in the scenario harness
once, and an autonomous agent replied to a stranger. Everything that reaches the
remote side is behind `!job.dryRun` in the execute step, which is why passing
the agent's real account costs nothing and passing null would make the rehearsal
less like the thing it is rehearsing.

## A rehearsal is not a sighting

The manufactured event carries an id of its own rather than the post's, for two
reasons that point the same way:

- `events (channel, account, remote_event_id)` is unique, which is what stops
  four radar monitors answering one post four times. Borrowing the post's id
  would turn that guarantee against the owner: trying an agent against a post
  would silently **suppress** the real mention arriving an hour later.
- An owner editing a persona tries the same post repeatedly. A lab that answered
  only the first time would look broken.

The event is also marked `rehearsal: true` in its payload, so nothing downstream
can mistake it for something that happened.

## What the explanation says

Two lists, in the order somebody asks for them.

**What it could see.** The message, who wrote it, the post above it, what it
remembered, what it looked up, what it knows about that person. Each carries a
sentence saying why it matters to the answer, and **anything absent is named
rather than omitted**: "it could not read the picture" and "there was no
picture" are different things to be told, and a missing row cannot say the
first.

**How it got there.** The trace rows grouped into the stages a person would
recognise, in the order the answer was built up. The trace was already complete
and already conclusions rather than reasoning, since no raw chain-of-thought is
stored anywhere in this system. What it was not is *legible*: thirty rows of
`MEMORY_SELECTED`, `STANCE_SELECTED`, `RESEARCH_DONE` in arrival order is a log,
and an owner reading a log is doing the product's job for it.

A stage with no rows reports that it did not run, which is information. "It did
not look anything up" answers half the questions asked about a wrong reply.

**A decision not to answer is shown with its reasons.** Silence is a branch, not
a failure, and it is the outcome an owner least understands without the reasons
beside it: the agent looks broken and the job list shows a cancellation with
nothing attached to it.

## Reading a real post

`REHEARSE_X_POST` is a browser task, for the same reason `COLLECT_PERSONA` and
`READ_X_ACCOUNT` are: the API owns no browsers, and reading X goes through the
signed-in session the worker holds. A lab that read X from the API would need a
second way in, which is the requirement that killed the feature this one
descends from.

It calls the X intelligence layer, whose contract has no post, like, follow,
repost or message in it and must never grow one.

The read asks for `LIVE` freshness, unlike an account read. A profile card can
be an hour old without misleading anybody; a rehearsal is about what the agent
would say to a post *now*.

The post above it travels with the rehearsal when there is one, because a reply
on its own frequently means nothing. Where the ancestor could not be read, that
is recorded as a gap and carried through to the answer, so an agent answering
blind does not look like one answering with the whole thread in front of it.

## Where the reader does the reading

The account whose browser reads is preferred to be one the agent is actually
linked to. Reading a post as the agent's own signed-in session is what makes the
rehearsal faithful: whether the author blocked it, whether it follows them, and
what a protected account shows are all answers that depend on who is asking.

## A typed rehearsal has no X account, on purpose

`/api/agents/:id/lab/typed` runs on the mock channel and passes no account, so
nothing external is touched while somebody is still editing a persona. That is
the fast path and it is the right default.

The consequence is that every `x.` capability is unavailable in a typed
rehearsal, and it used to say so as *"this agent has no X account to read as"*,
which is false for every agent whose owner has linked one and leaves them
nothing to do about it. It now says what is actually true: nothing here is
attached to an X account, and rehearsing against a real post is how to read X.

The distinction matters more now that the capability loop exists, because the
answer an agent gives with a capability and the answer it gives without one are
different answers, and a lab that silently produced the second while an owner
was judging the first would be misleading about exactly the thing it exists for.

## The corpus

`tools/scenarios/corpus.mts` holds eighty-three situations, one per shape. A
shape rather than an example: "somebody disagrees with a claim" is a thing
timelines do constantly, and how an agent handles it is a property of the agent.

Eighty-three because the failures here are distributional. An agent can answer
any single message well and still open every third reply with the same
construction, end everything on a question, or turn banter into documentation,
and you only see that laid out side by side.

What the newest thirty-two cover is what was missing rather than more of the
same: instructions hidden inside a mention, being asked what to buy, being asked
to predict a price, being asked to pretend to be a person, being one of thirty
accounts tagged, a pronoun with two possible antecedents, a thread revived after
a month, a reply in another language, and being asked what it is unsure about.
Several of those exist to be **declined**, which is as much a property of the
agent as anything it says.
