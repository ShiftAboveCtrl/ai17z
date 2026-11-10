# Peer review

An agent can have a draft read by a second agent of the same owner before the
reply goes out. It is off by default (`policy.quality.peerReview.enabled`), and
turning it on adds one model call per reply that reaches the voice step.

## Shape

`runPeerReview` in `packages/runtime/src/peerReview.ts` makes one `generate`
call, as the peer, on the peer's own `primary` model. The call is recorded like
any other model call with purpose `peer.critique`. The critique comes back as
`{ verdict, summary, changes[] }` and is folded into the **existing** voice
rewrite brief as a `SECOND OPINION` section. There is no extra rewrite and no
extra stage.

## What keeps the peer a critic

- It is shown the incoming message, the draft and its own name and biography.
  `buildCritiqueMessages` takes exactly those fields.
- The call has no tools, no capability loop and no channel.
- The answer is parsed against a fixed schema. Any other key, such as an
  `action` or a `capability`, is dropped, and an answer that is not that shape
  is recorded as `unreadable` and ignored.
- The peer must belong to the same owner as the agent and cannot be the agent.
- A rewrite that carried peer notes goes through `validateOutput` again, so
  dashes, emoji, banned phrases, unverified addresses, human claims and model
  disclosure are enforced on the last text written. A rewrite that breaks a
  rule is dropped and the reply stays as it was. `stepVoice` still applies
  `removeEmDashes` afterwards.

## Failure

A missing, slow, failing or unreadable peer is a recorded outcome
(`skipped`, `unavailable`, `unreadable`) and never fails the job.

## What is stored

One `VOICE_COMPILED` trace row carrying `peerReview`: whether it ran, the
outcome (`kept`, `undone`, `no_changes`, ...), the peer's one-sentence summary
and the suggestions that were kept or undone. The peer's prompt and raw answer
are not repeated there, and no reasoning is stored.

## Behaviour in a dry run

The ordinary rewrite is withheld from a dry run to save money. Peer review is
not, so an owner can watch two agents argue a reply in the Lab. Nothing a dry
run produces is published.

## No migration

The policy is a versioned JSON document. A version saved before the field
existed parses with peer review off.
