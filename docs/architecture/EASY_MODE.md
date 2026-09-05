# Easy Mode

## The rule

Easy Mode is a **view over the same configuration**, not a second system.

```
EASY MODE                    ADVANCED MODE
eleven answers               every field
     |                            |
     +---------> the same versioned persona,
                 policy, cadence, radar sources,
                 and posting schedule
                            |
                      the same runtime
```

There is no `easy_setup` table. `packages/runtime/src/easyMode.ts` is pure:
`toPersona`, `toPolicy`, `toCadence`, `toRadarSourceKinds`, and
`postIntervalSeconds` project answers onto the real documents; `readEasyView`
reads them back. `apps/api/src/routes/easy.ts` is the only wire, and it saves
through `savePersonaVersion` and `savePolicyVersion` like anything else.

Two properties, both tested:

- **Round trip.** Configure in Easy, read it back, get the same answers.
  Saving twice changes nothing the second time.
- **Honesty.** Advanced can express things Easy has no word for. Those are
  reported in `beyondEasyMode`, never flattened, and an Easy save leaves them
  untouched.

## The mapping

### Character

| Easy | Persona |
| --- | --- |
| Name | `displayName` |
| Who is this? | `biography` |
| Personality | `personality` |
| Style preset | `tone`, `styleGuidelines`, `responseLength` |
| Tone (typed) | `tone`, overriding the preset |
| Cares about | `topics` |
| Things they would say | `styleExamples` |

A preset is a starting point. What the owner typed always wins, and editing the
tone away from a preset makes the preset read back as `CUSTOM` — which is the
truth, not a failure.

### Replies

| Easy | Policy |
| --- | --- |
| Everyone | `engagement.strategy = ALWAYS_REPLY`, `minimumReplyValue = 0`, `ignoreMassTags = false` |
| Everyone except spam | `engagement.strategy = SELECTIVE` |
| Verified accounts only | `content.requireVerifiedAuthor = true` |
| Only people I choose | `content.allowedRemoteHandles = [...]` |
| Reply to almost everything | `engagement.minimumReplyValue = 10` |
| Balanced | `= 35` (the platform default) |
| Only when useful | `= 60` |
| Ignore mass-tag spam | `engagement.ignoreMassTags` |
| Do not repeat yourself | `engagement.maxRepliesPerPersonPerHour` 3, or 50 when off |
| Watch its own posts | radar source `own_threads` |
| Only when it is named | drops radar source `reply_search` |

`notifications` and `mention_search` are always both on. They miss different
things, and one alone is the single point of failure the radar exists to remove.

### Posting

| Easy | Effect |
| --- | --- |
| Off | no `agent_posting` row is enabled |
| Occasionally | a chance to post every 6 hours |
| A few times a day | every 5 hours |
| About daily | every 22 hours |

An interval is a ceiling, not a timetable. Coming due means looking at the idea
backlog; an empty backlog means silence, and the reason is recorded on the row.

### Operation

| Easy | Policy |
| --- | --- |
| Automatic | `automation.mode = AUTONOMOUS` |
| Review first | `automation.mode = REVIEW_BEFORE_ACTION` |

`dryRunDefault` is always false. Review means a person approves a real action;
dry run means nothing is sent at all. Conflating them would leave somebody
approving replies that never go anywhere.

`OFF`, `MONITOR_ONLY`, and `MANUAL_ONLY` have no Easy Mode equivalent. An agent
in one of them still opens here, with a line saying what saving would change it
to.

## What Easy Mode never touches

Model role routing, fallback chains, model parameters, memory scopes and
budgets, relationship voice, the stance ledger, the voice fingerprint, quality
gates, the pipeline graph, cadence internals, browser settings, capabilities,
tools, block lists, working hours, banned phrases, language rules, custom
instructions, prohibited behaviours.

All of it keeps its defaults, which are the strong ones. **Easy Mode simplifies
configuration, not intelligence.** An agent set up here still gets relationship
memory, stance consistency, thread context, multimodal context, the voice
compiler, anti-repetition, multi-source discovery, and exact-target
verification — it just was not asked about any of them.

`tests/unit/easyMode.test.ts` asserts that directly: an Easy Mode policy has
memory retrieval on, quoted-post resolution on, target verification on, and
voice, stance and relationship configuration identical to the platform default.

## Starting an agent

`POST /api/agents/:id/start` runs a preflight first and refuses with a list of
blockers rather than activating something that will fail on its first job. Each
blocker is one sentence about what is wrong and one about what to do:

```
No AI model is connected.        Choose a provider and a model.
@atlas is not connected.         Sign in again.
Nothing can open a browser.      Start the worker on the machine with Chrome.
```

The connection check is channel-aware: only a channel that signs in through a
browser can be signed out of, so the mock channel is never told to sign in.

## Switching

The agent page opens in the simple view and remembers the choice across agents,
because a person is an Easy Mode person or an Advanced person and being dropped
into the other one is disorienting. Advanced is one button away and still has
all twelve sections.
