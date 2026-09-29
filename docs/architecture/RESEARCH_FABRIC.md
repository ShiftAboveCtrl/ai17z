# Research Fabric

One place where AI17Z keeps what it found out about the world while setting up
or improving an agent, with where each piece came from and how much it may be
trusted. It is not a second X reader and not a second knowledge store: X is
read through `packages/channels/src/x/intelligence/`, and what an agent keeps
long term still goes through knowledge sources and memory.

Code: `packages/shared/src/contracts/research.ts` (vocabulary),
`packages/channels/src/x/researchSources.ts` (everything X-shaped),
`packages/database/src/repositories/research.ts`, `packages/runtime/src/researchFabric.ts`.
Migration 0096.

## Objects, sightings, runs

- A **research object** is one thing: a post, a profile, a page. It is keyed by
  an opaque key (`x:status:<id>`, a canonical URL), never by where it was seen.
- A **sighting** is one family seeing it (`X`, `SEARCH_ENGINE`, `TWSTALKER`,
  `SOTWE`, `WEB`, `GITHUB`, `DOCUMENTATION`, `OWNER`, `PLUGIN`, `ARCHIVE`).
  `research_sightings (object_id, family)` is unique, so a mirror that shows the
  same post as X adds a sighting to one object rather than a second post.
- A **run** is one piece of research with a lease and settled stages, claimed
  like every other loop here.

## Trust

Every sighting carries a tier: `PRIMARY_PLATFORM`, `OFFICIAL_PROJECT`,
`OFFICIAL_REPOSITORY`, `DIRECT_AUTHORITATIVE`, `OWNER_SUPPLIED`, `SEARCH_INDEX`,
`PUBLIC_MIRROR`, `ARCHIVE`, `UNKNOWN`. Ranking depends on purpose: for how a
person writes, the platform is the best witness; for a fact about a project,
its own documentation and repository outrank everything.

- The best reading of an object is chosen by `readingPrecedence`, so canonical
  X wins over a mirror of the same post.
- Copies that disagree are recorded (`copiesDisagree`), not averaged. A mirror
  that only shows a fragment is recognised as a fragment rather than a
  disagreement.
- `mayEstablishFact` and `mayTriggerAction` are the only answers to "can this
  be relied on" and "can this cause the agent to do something". A search
  snippet or a mirror can do neither on its own.

## Mirrors are optional and never evaded

TwStalker and Sotwe are secondary families an owner may enable. Both currently
serve a Cloudflare managed challenge to automated requests. The adapters
recognise it (`isChallengePage`) and report the family `UNAVAILABLE`; nothing
solves, waits out or disguises itself past a challenge. A challenged family is
held for 24 hours; a family that fails three times is held for an hour
(`research_source_health`).

## Untrusted by default

Everything read from a website, mirror, repository or search result is data.
`fenceUntrusted` wraps it with `UNTRUSTED_PREAMBLE` before it reaches a model,
and `suspectedInjection` flags text addressed to the model. Nothing a source
says can change what the agent is allowed to do.

## Budget

X reads go through `checkReadCapacity` and `noteXRead` as `BROAD` reads. An
account that is resting defers the run (`retryAfterMs`) rather than failing it.
