# Agent packages

An agent as a file somebody can send: `.ai17z-agent`.

## Two things, kept apart

`packages/shared/src/contracts/portable.ts` is the **document** — what travels.
`portablePackage.ts` is the **envelope** — what it is, where it came from, what
it will bring, and a checksum. `packages/runtime/src/agentPackage.ts` writes and
reads them.

The document existed already, for duplicating an agent and for the JSON export.
The envelope is what makes it a file people can hand each other, which changes
the threat model completely: exporting is our own data going out, importing is a
file that arrived from somewhere.

## Why JSON and not a zip

A `.ai17z-agent` file is JSON. Base64 attachments cost a third more than they
should, and that is the price of the property that matters:

A zip has **paths**, and paths have `..`. It has entries that get written to disk
before anything inspects them. It needs a library to read, and archive libraries
are where path-traversal bugs live. An agent is a persona, a policy, some
settings and possibly a picture. None of that needs a filesystem inside a file.

The result is a format with **nowhere to put anything executable**:

- No script field, no command, no entry point. "Do not execute anything in a
  package" is not a rule the importer has to remember — there is nothing in the
  shape that could be executed.
- No path that becomes a file. The one attachment is an image, carried inline
  and written under an id AI17Z generates. A package cannot name where anything
  lands.
- No identity. No agent id, no owner id, no credential id. An import is always a
  **new** agent owned by whoever imported it, so a shared file cannot overwrite
  somebody's work.
- Every schema is `.strict()`, at every level. An unknown field is a refusal,
  not something that rides along into an installation nobody inspected.

## Two modes

**SHARE** is configuration: what somebody decided. Persona, policy, which model
role does what, where documentation comes from. Safe to hand to a stranger,
because there is nothing in it that belongs to anybody.

**MOVE** is that plus what the agent has learned. Not shareable and not meant to
be — it exists so somebody can carry their own agent to their own new machine.

Neither carries a credential, a session or a browser profile, in the strongest
sense available: the shapes have nowhere to put one. The model roles name a
*provider* so an importer can say "this wants an Anthropic model and you have
none configured", and never a credential, because a credential belongs to an
installation rather than to an agent.

### What MOVE carries, and what it deliberately does not

Memories, and the picture. That is all.

Jobs, actions, events and traces are the record of an installation doing work
rather than anything the agent knows; carrying them would import somebody else's
history as though this machine had done it.

**Relationships and stances are absent on purpose.** Both are learned from what
the agent actually published, and rebuild themselves on a new installation from
the first conversation onwards. Carrying them would put a list of everyone the
agent has ever spoken to into a file that gets emailed around, in order to
reconstruct something that reconstructs itself. That trade is not worth making.

## Inspect, then import

Always two steps. The whole point of a portable agent is that somebody can be
handed one, and being handed a file is exactly when you want to look inside
before opening it.

`inspectPackage` never throws for a bad package — an unreadable file is
something to be told about, not an error to handle. It reports what is wrong in
a sentence, and for a valid package it reports counts, the mode, which AI17Z
version wrote it, and notes worth reading before pressing the button:

- that a MOVE package carries learned material and should only be imported if it
  is your own agent
- that model roles bring no credential
- that a `PATH` knowledge source will not exist on this machine
- that capabilities describe an intended permission profile and grant nothing
  until an account is connected

**Every count is taken from the parsed document, never from a field the file
supplied.** A package that described itself as harmless is exactly the one worth
checking.

## The checksum

sha256 over the canonical JSON of `agent`, `avatar` and `learned` — keys sorted,
so the same agent produces the same digest whichever order a serialiser emitted
fields in.

It catches a **truncated download**, which is the failure that actually happens.
Half an agent imported silently is far worse than a file that refuses to open,
so a mismatch is a refusal on import rather than a warning.

It is **not a signature** and is not presented as one. Anybody who can alter the
document can alter the checksum, which is precisely why the importer validates
the content rather than resting on this. What protects against a hostile package
is the shape of the format, not the digest.

## The picture

Carried inline as base64, sniffed on the way out and again on the way in. A
declared mime type in a file somebody sent is a claim, and this one arrives from
further away than most — so the bytes go through the ordinary avatar path, which
identifies the format from the bytes, enforces the size and dimension limits, and
writes under an id AI17Z generates.

A package whose picture is not really an image does not stop the import. The
agent is created, the picture is skipped, and the skip is reported. A hostile
package should be unable to land its payload, not able to block an import.

## Sender identity

A package names the AI17Z **version** that wrote it and nothing else. Not the
machine, not the user, not an installation id. A package is something people send
each other, and a stable sender identifier would turn every shared agent into a
way of learning who made it.

## Routes

| | |
| --- | --- |
| `GET /api/agents/:id/package?mode=SHARE\|MOVE` | downloads it, `no-store` |
| `POST /api/agents/package/inspect` | reports what is inside, creates nothing |
| `POST /api/agents/package/import` | creates a new agent |

All three require a signed-in owner. Export and import are both audited — what
was in it, never the contents.
