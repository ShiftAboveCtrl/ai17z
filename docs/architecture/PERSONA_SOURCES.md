# Persona sources

**Learning a voice from a corpus, with provenance.**

## Source material is evidence, not memory

AI4CZ dumped every scraped post into memory. The persona that came out was
noisy, and there was no way to ask why the agent sounded the way it did.

AI17Z keeps the raw archive forever and derives a compact profile from a
*filtered* subset. Raw posts never enter a prompt. Traits do, and every trait
cites the items it came from.

```
fetch → normalise → fingerprint → dedupe → score → classify → store → derive
```

## Fingerprinting comes before scoring

The fingerprint lowercases, and strips URLs, mentions, numbers and punctuation,
before hashing. A repost and its original collapse to one item, and a campaign
repeated forty times cannot dominate what is learned — because the collapse
happens *before* anything is scored, not after.

## Scoring is arithmetic, not a model call

Five scores per item: `style`, `persona`, `belief`, `knowledge`, `noise`. Every
item carries the reasons it scored that way, and those reasons are shown to the
owner.

This is deliberate. Re-scoring four thousand items costs nothing, the result is
reproducible, and the owner can be told exactly why something was dropped.

**Length alone never excludes anything.** A two-word reply can outscore a long
announcement, which is the entire point when the voice being learned is a terse
one.

### Classification

| Class | Meaning |
| --- | --- |
| `voice` | sounds like a particular person |
| `opinion` | states a durable position |
| `reference` | long, factual, impersonal |
| `promotional` `automated` `low_signal` | excluded, with the reason recorded |

Reference is distinguished from voice by first-person language plus length, not
by comparing scores: a well-formed factual paragraph also scores respectably on
style, so the comparison alone gets it wrong.

## Excluded items are still stored

Exclusion is a decision about what to *learn from*, not a reason to lose
evidence. Every fetched item is kept, and the owner can override the decision in
either direction — or clear the override and return it to the machine.

## Adapters

`PersonaSourceAdapter` keeps every source at arm's length.

- **`manual`** — pasted text. Always available; makes the whole pipeline usable
  with no scraping at all.
- **`x_public`** — shells out to the `twscrape` CLI, reports honestly when Python
  or twscrape is absent, and returns a `requirement` sentence the UI shows.

Nothing downstream knows twscrape exists. The live reply path stays
Playwright-driven and is entirely unaffected by whether this is installed.

## Traits and provenance

`deriveProfile` produces style, topic, belief and example traits. Each carries
`evidence`: the ids of the items it came from. **A trait without evidence is an
assertion**, so the UI shows the count and lets you open the items.

Applying a profile writes a *new persona version*. Nothing is overwritten, and
the version history says where the voice came from.

## Where it lives

| Path | What |
| --- | --- |
| `packages/persona/src/normalize.ts` | whitespace, links, fingerprints |
| `packages/persona/src/score.ts` | scoring and classification |
| `packages/persona/src/derive.ts` | traits from a filtered corpus |
| `packages/persona/src/sources/` | adapters |
| `packages/persona/src/sync.ts` | the orchestration above |
| `migrations/0017_persona_sources.sql` | sources, items, traits, evidence |

## Installing twscrape

It is not required. If you want it:

```bash
pip install twscrape
```

Set `AI17Z_TWSCRAPE_COMMAND` if it is not on the worker's `PATH`. The UI reports
availability rather than failing at fetch time.
