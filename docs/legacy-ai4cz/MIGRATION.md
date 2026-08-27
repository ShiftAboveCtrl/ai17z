# Migrating AI4CZ into AI17Z

## The rule

`C:\Users\ta0as\OneDrive\Desktop\ai4cz` is immutable evidence. The importer opens
its SQLite database read-only and reads a handful of JSON and TypeScript files.
It writes nothing, installs nothing, and copies no secret out.

After a full import run, a file listing of the legacy directory (paths, sizes,
mtimes) is byte-identical to the listing taken before it. That is the check to
repeat if the importer changes.

## Running it

```bash
npm run import:ai4cz -- --dry-run   # read and report, write nothing
npm run import:ai4cz                # import
npm run import:ai4cz -- --legacy-dir=/some/other/path --owner-email=you@example.com
```

`AI4CZ_LEGACY_DIR` in `.env` supplies the default path. An owner account must
exist first.

## What a run reports

```
AI4CZ IMPORT

128 style memories imported
272 conversation turns imported
130 conversations linked
127 archived inbound records imported
128 historical events normalised
149 already-seen mentions recorded
182 historical action signatures recognised

0 malformed records skipped

0 secrets imported
```

Those numbers are from the real directory and match the forensic audit of it.

## What is imported

| Legacy source | Becomes | Count |
| --- | --- | --- |
| `src/cz_speaking.json` | `KNOWLEDGE` style memories, pinned | 48 |
| `cz_binance_tweets_scraped.json` | `KNOWLEDGE` style memories | 80 |
| `src/character.ts` bio | Persona biography | ~5,500 chars |
| `src/character.ts` system | Persona personality and language policy | minus one dropped line |
| `.eliza/elizadb.sqlite` `x_thread:*` | Conversations, messages, `THREAD` memories | 272 turns / 130 threads |
| `.eliza/elizadb.sqlite` `x` | `ACCOUNT` scope `EVENT_ARCHIVE` memories | 127 |
| `mentions_inbox.json` | Historical `events` | 128 |
| `seen_mentions.json` | Historical `events` (ledger only) | 149 |
| `posted_index.json` | `legacy_action_ledger` | 182 |

## What is deliberately not imported

API keys, `.env` files, OAuth tokens, cookies, `twitter-session.json`, the
Chromium profile in `x-session-data`, ElizaOS runtime configuration, the
abandoned PGlite experiment, dead code, and compiled `dist` output.

The importer names the nine credential locations it found so they can be rotated.
It does not open them.

## The identity decision

The legacy prompt instructed the model, in Chinese, to never deny its identity —
to behave as the real person and not admit otherwise. That instruction is
**dropped**, the drop is reported, and the imported agent is configured as:

- `identityKind: INSPIRED_BY` — the voice is inspired by a public figure, and the
  prompt says explicitly that the agent is not that person
- `identity.mayDenyBeingAI: false` — the validator rejects any output claiming
  humanity
- `identity.disclosure: ON_REQUEST` — if asked, it answers honestly
- A prohibition on claiming to be, or speak for, Changpeng Zhao

The Chinese *language* instruction is kept, because that is style, not deception.
It becomes an editable `languagePolicy` field rather than a buried literal.

## Safety posture of the imported agent

The legacy system posted autonomously. The imported one cannot:

- Agent state `DRAFT`
- Automation `MANUAL_ONLY`, dry run on by default
- X account created but **disabled**, status `NEEDS_AUTH`, no session imported
- The agent-account link created but disabled
- Rate policy: 10 actions/hour, 60/day, 45 seconds apart

Turning it on is four deliberate acts by a person.

## Not replying to a year-old backlog

The 128 inbox items and 149 seen mentions are imported as `events` rows keyed on
their status id. Because `events` is unique on
`(channel, account, remote_event_id)`, re-ingesting any of them is a no-op, so no
job is created and no reply is sent. This is exact, not heuristic.

## Not re-posting 182 replies

`posted_index.json` holds `targetKey|sha1(text)` signatures. AI17Z signs content
with sha256, so those entries cannot be matched by the modern signature.

Rather than pretend otherwise, migration `0010` stores them verbatim in
`legacy_action_ledger`, and the execute step computes the legacy sha1 form and
checks it before claiming an action. If a previous system already sent that exact
text to that exact target, the job completes without sending anything and the
trace says so.

## Repeatability

The importer is idempotent by construction:

- the agent is matched by slug
- memories dedupe on their content hash
- events dedupe on their remote id
- ledger entries dedupe on the signature

A second run reports zeros. A re-run does refresh the persona and policy to the
current import definition, which is the intended behaviour if the importer itself
has been improved.

## What is not migrated

Old AI role naming beyond the `user`/`ai` split, the `.bak` SQLite snapshots, and
the orphaned memory databases (`data/memory.sqlite`, `ai4cz.memory.sqlite`,
`.eliza/.elizadb_backup/memory.sqlite`). Those are overlapping subsets of the
main database; the audit recommends archiving rather than merging them, and this
importer follows that.
