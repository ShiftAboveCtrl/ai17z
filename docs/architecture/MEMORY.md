# Memory

## The problem this solves

The legacy system stored conversation memory keyed on the tweet thread. A new
mention on a different post produced a different key, and therefore zero memory.
Someone could tell the agent a fact and it would not know it an hour later in a
different thread. The operator knew, and had written a test that proved it, but
the fix was never deployed.

XBAM has six scopes, and the one that matters most is `USER`.

## Scopes

| Scope | Keyed by | Holds |
| --- | --- | --- |
| `THREAD` | conversation | The turns of one conversation |
| `USER` | remote handle | Durable facts about a person, across every conversation |
| `PERSONA` | agent | What the agent itself has said or committed to |
| `ACCOUNT` | account | Shared context for one connected account |
| `KNOWLEDGE` | agent | Curated reference material and style corpus |
| `EPISODIC` | agent | Compressed long-term summaries |

## Retrieval

Deterministic and inspectable. Each enabled scope is queried separately under its
own configured limit:

- `THREAD` — most recent turns in this conversation, restored to chronological
  order so the prompt reads like a conversation
- `USER` — pinned first, then importance, then recency
- `ACCOUNT` — same ordering, scoped to the account
- `PERSONA` / `KNOWLEDGE` / `EPISODIC` — pinned first, then Postgres full-text
  rank against keywords from the incoming message

Every selected memory carries a `reason`, written verbatim into
`memory_retrievals` and shown in the trace:

```
1. [USER]      "my favorite number is 41"       why: same remote user @alice
2. [THREAD]    "alice: what do you build with?" why: active conversation
3. [KNOWLEDGE] "People vote with their money."  why: knowledge base: matches "markets"
```

There is no hidden ranking model. "Why did the agent remember this?" is always
answerable, because the answer was written down when the choice was made.

## Writing

Not every sentence deserves to be remembered. `policy.memory.write` decides:

- **thread** — both sides of every exchange, if enabled
- **user** — durable facts, via the extractor
- **persona** — the agent's own outbound statements, off by default

The extractor is deliberately conservative. It fires on explicit requests to
remember, stated favourites and preferences, self-descriptions, names, and
locations, and refuses questions and hypotheticals. A heuristic that fires too
often poisons every future prompt for that person, which is worse than missing
something.

A model-based extractor is a configured option (`extractor: 'model'`) but is not
implemented yet. Selecting it falls back to the heuristic and says so in the log
rather than silently writing nothing.

## Deduplication

`memories` is unique on `(agent_id, scope, scope_key, content_hash)`, where
`scope_key` is the dedupe bucket: conversation for `THREAD`, lowercased handle
for `USER`, account for `ACCOUNT`, the scope name otherwise. A repeated fact
raises importance rather than creating a second row.

`content_hash` is sha256 of the content normalised for whitespace and case, so
"My favorite number is 41" and "my favorite number is 41." are one memory.

## Retention

`expires_at` supports a TTL per scope, configured as
`policy.memory.write.user.ttlDays`. Expired memories drop out of retrieval
immediately and are removed by `purgeExpiredMemories`. Pinned memories rank
first and are never written automatically: pinning is a human act.

## Budget

`policy.memory.retrieval.totalCharBudget` caps the rendered memory layer. When it
overflows, the tail is kept, because recent and highest-ranked memory matters
most. This is the one part of the legacy memory handling worth preserving.

## Semantic retrieval

Not implemented. The schema and the retrieval interface leave room for it: add an
embedding column and a vector index, then extend `selectRelevantMemories`. Basic
operation must never require it.
