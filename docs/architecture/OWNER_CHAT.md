# Owner chat

The owner talking to their own agents, one at a time or several in a room. The
agent answering is the real one: its persona, identity policy, memories and
beliefs, through the prompt engine (`chat.owner`, built from the reply
layers), the model gateway and the capability loop. Nothing in chat keeps a
copy of agent state.

Code: `packages/runtime/src/ownerChat.ts`, `introspectionCapabilities.ts`,
`setupCheck.ts`; `packages/database/src/repositories/chat.ts`,
`introspection.ts`; `apps/api/src/routes/chat.ts`; `apps/web/src/routes/ChatPage.tsx`.
Migration 0100.

## Asking the agent about itself

Thirteen `agent.*` capabilities read the agent's own records: setup and state,
health, recent activity, growth over a stated window, learning, goals,
reflections, a belief and its evidence, relationships, owner decisions, setup
changes, and why it did or did not answer a post. Each returns structured
evidence and a sentence, and says so plainly when something was not recorded.

**Owner only.** They declare `audience: 'OWNER'`. The capability loop never
puts them on a public menu, and invocation refuses them outside owner chat. An
agent that would explain its silence to a stranger has told them how to get
past it.

**No reasoning, because none is stored.** "Why did you reply?" is answered
from the job's trace (how the post was found, the engagement decision and its
factors, memory, lookups, the validator, what was sent), the same reading the
Response Lab gives. "Why didn't you?" reads the reason ingest recorded in
`event_agent_skips`, or the trace of a job that decided against answering.

**Routed, not dumped.** The shortlist offers these only when the question is
about the agent, so an ordinary turn pays for no diagnostics.

## Looking things up

A question that depends on something current is looked up exactly as a reply's
would be: `whatToResearch` decides from the shape of the question, the web is
searched through the agent's own X account's browser, market data answers a
ticker or address, and Plugin research sources apply. A question about the
agent itself is never researched. Only a worker with a browser can search, so
a turn that needs the web waits for one; with none running, the turn is
answered without and the answer's evidence says what could not be checked.

## Changing things from chat

Chat does not change settings. Asked to change a belief, switch a Plugin off
or stop watching something, the agent says where in AI17Z that is done. A
write from casual conversation is exactly the kind of change an owner cannot
see happening, and financial actions are never reachable from here at all.

## Conversation is not memory

Nothing the owner types reaches durable memory unless they press "Remember
this" and choose which agents keep it, and as what: a fact, something about
the agent itself, or a knowledge source. Anything shaped like a secret is
refused. A save is its own row (`chat_saves`) and outlives the conversation:
deleting a conversation keeps what was saved, and deleting a memory does not
rewrite the message it came from.

## Rooms

Up to four agents. The owner asks all of them or names one. Each answers in
turn, with only its own memories, beliefs and capability permissions; the
transcript is the only thing they share. Answers are queued only from an owner
message and never from an answer, so two agents cannot talk to each other for
ever. A shared conclusion reaches other agents only when the owner saves it to
them.

## Where it runs

The worker claims one answer at a time under a lease (`claimNextAnswer`), only
the earliest unfinished answer in a conversation, so a later agent in a room
reads an earlier one. A worker that dies mid-answer leaves it to be taken
again. A failed answer says why and can be tried again.

## Setup and health

`agentSetupCheck` answers "is this agent set up well" with concrete checks and
a link to the exact setting for each, on the agent's Overview. Not set up is
its own quiet state and never a fault. Settings can also be found by typing
what they are called (Ctrl+K), including Social Radar, which lives inside an
account's session and is addressable as `/settings?account=<id>&focus=radar`.

## Changing an agent from chat

`packages/runtime/src/agentManagement.ts` and `managementCapabilities.ts`;
migration 0102.

An owner can say "be less formal", "stop posting for today" or "add Solana to
your topics" and have it happen. The agent never writes its own settings: it
names one change from the closed list in `CHANGES` through
`agent.change_setting`, and the engine applies it through the same versioned
persona, policy and posting repositories the settings screens use.

**Tiers are decided per move.** LOW applies at once and can be undone (tone,
topics, reply length, a standing instruction, emoji, avoiding a subject,
pausing, posting less, less automation). CONFIRM waits for the owner's
Confirm (a new name, allowing an avoided subject, more automation, resuming
posts, posting more often). NEVER is refused and recorded with where it is
done instead: money, tokens, wallets and keys, credentials, whether the agent
may deny being an AI, capability permissions, another agent, deleting itself,
safety rules. No change kind can reach any of those.

**One agent.** A capability acts on `ctx.agentId`, which the model cannot
choose, and only in owner chat with the owner message as its origin. In a
room, `changeTargets` decides before any model runs: a named agent only,
"both of you" or "everyone" for all, and a change that names nobody gets one
notice asking which agent, rather than changing everybody. A name before the
verb ("MEADGod stop posting") is an address, not a question.

**Checked and reversible.** Every write is read back, and one that disagrees
puts the old value back and records a failure. Undo restores the old value only
while the setting still holds what the change wrote; Confirm applies only while
the setting still holds what it held when asked. Both refuse with a sentence
otherwise, so neither overwrites a later decision.

**History.** `agent_changes` keeps who asked, their words, the conversation,
the part of the agent, before and after, the read-back, and whether it was
confirmed, declined, undone or refused. Chat shows each change under the
answer with Undo or Confirm; the agent page's Changes section lists thirty
days; `agent.my_changes` answers "what did you change today".
