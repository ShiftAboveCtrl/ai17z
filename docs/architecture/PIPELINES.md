# Pipelines

## Today

Every agent has a pipeline stored as a versioned graph: nodes, edges, and per-node
configuration, immutable per version.

```
Trigger -> Resolve context -> Retrieve memory -> Assemble persona
        -> Generate -> Validate -> Approval gate -> Execute -> Persist
```

The runtime in `packages/runtime/src/pipeline.ts` implements exactly this
sequence. The stored graph is therefore **descriptive**: it is a faithful record
of what runs, and what the UI draws, but the executor does not yet interpret it.

This is a deliberate limit, and it is stated plainly rather than implied. Building
a general workflow interpreter before the base system worked would have been the
wrong order. What exists is the domain model, the versioning, the storage, and a
UI that renders real rows — so making the executor graph-driven is an extension,
not a rewrite.

## Node kinds

| Kind | What the step does |
| --- | --- |
| `TRIGGER` | An inbound event becomes a durable job |
| `RESOLVE_CONTEXT` | The adapter identifies the exact remote target and reads the surrounding conversation |
| `RETRIEVE_MEMORY` | Each scope is queried under its own limit; every selection records why |
| `ASSEMBLE_PERSONA` | Persona, policy, memory and context render into ten prompt layers |
| `GENERATE` | The model gateway walks the fallback chain |
| `VALIDATE` | Output is checked against policy; repairs recorded, failures escalated |
| `APPROVAL_GATE` | Autonomous continues; review waits for a person |
| `EXECUTE_ACTION` | Target verified again, action claimed once, then performed |
| `PERSIST` | The turn is recorded and the memory write policy runs |

## The prompt engine

Ten ordered layers, stored as template data rather than string literals in a
worker:

1. `SYSTEM_RULES` — runtime rules
2. `IDENTITY` — who this agent is, and is not
3. `PERSONA_FACTS` — background, personality, topics
4. `STYLE` — tone, style, language, voice examples
5. `SAFETY_DISCLOSURE` — disclosure policy, prohibitions, blocked topics
6. `RETRIEVED_MEMORY` — what it remembers, and the instruction not to invent
7. `IMMEDIATE_CONTEXT` — thread, parent, author, incoming message
8. `TOOLS` — what it may call
9. `TASK` — what to produce
10. `OUTPUT_CONTRACT` — the rules the validator will enforce

A layer that renders empty is dropped entirely rather than shipped as a blank
heading. Every surviving layer is stored with the model call, labelled with where
it came from ("persona v3", "6 retrieved memories"), and shown in the trace.

The template language is deliberately tiny: substitution and presence-conditional
sections. Prompt templates are content, not code, and must not be able to do
something surprising.

## Extending

**A new step kind** means adding it to the node kind enum, writing the step
function, and adding it to the `STEPS` map in `pipeline.ts`.

**Branching** is the reason edges carry a `condition` column. Making the executor
follow edges rather than a fixed map is the natural next step, and the schema is
already shaped for it.

**A new prompt template** can be seeded in `packages/prompts/src/defaultTemplates.ts`.
Changing a layer definition cuts a new active version automatically; existing
jobs keep the version they started with.
