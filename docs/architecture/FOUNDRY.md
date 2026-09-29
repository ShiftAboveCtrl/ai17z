# Agent Foundry

From a short brief ("make an agent in the voice of @someone, who works on
these projects") to a reviewed, applied setup, or, for an existing agent, a
proposal of what to improve. The Foundry proposes; the owner decides; the
canonical repositories apply. There is no Foundry copy of a persona, a policy
or a belief.

Code: `packages/shared/src/contracts/foundry.ts`, `packages/runtime/src/foundry.ts`
(compiler), `foundryRun.ts` (stages), `foundryApply.ts`, `foundryReport.ts`,
`testSuite.ts`; `apps/worker/src/foundryWorker.ts`; `apps/api/src/routes/foundry.ts`;
the screens at `/agents/new/research` and `/agents/:id/foundry`.
Migrations 0098 and 0099.

## A run

A run is a research run (see `RESEARCH_FABRIC.md`) that moves through settled
stages: understanding the brief, finding sources, reading X, secondary sources,
deduplicating, voice, topics, beliefs, knowledge, safety, tests, ready. It is
claimed by a browser-capable worker, because reading X needs the agent's own
browser, and a restart resumes at the last settled stage.

## Proposals

`compileFoundry` is deterministic. Each item has a section, the current value,
the proposed value, a rationale, a confidence, the evidence it rests on, and an
assessment of what is there now (already correct, missing, weak, stale,
contradictory, unsupported, or new). Topics are semantic (`semanticTopics`), never word frequency.
A belief is proposed only with at least three supporting posts over two days,
one of them confirmed.

## Review and apply

Items are accepted, edited or rejected one at a time, by section, or all at
once. A decided item is never overwritten by a later pass. `applyFoundry`
writes through the existing repositories: one new persona version, one policy
version, stances with their evidence, knowledge sources (queued for the
worker), persona sources, Radar sources, toolpacks, and an audit row.

**Improving an existing agent never applies anything by itself.** It assesses
and proposes, and the owner's own choices (a pinned belief, their wording) are
kept where the evidence agrees with them.

## Test this agent

The Foundry writes behavioural cases for the setup (a greeting, a confident
wrong claim, a fake announcement, a live price, a long technical question, a
friend having a hard week, hostility, an identity question, a mass-tag pitch, a
scam contract, and version confusion or a foreign language where they apply).
Each runs as a Response Lab rehearsal, a dry-run job through the real
pipeline, and is judged when read: pass, stayed silent, read it, failed. A
pattern can say a draft repeated a scam link or claimed to be human; it cannot
say a technical answer is right, so those come back for a person to read.
