# Running a Studio playbook on the local agent

A playbook published on AI17Z Studio can be imported into an agent on this
installation. It becomes that agent's **paper mandate** and the exact assets
that mandate may touch, pinned to the playbook's id and version, and the agent
can say which one it runs. It is configuration. It is not a copy of a trader.

Studio's half (publishing, and the route this installation reads) is built in
the Studio repository. This document is the core contract, and
`tests/integration/playbookImport.test.ts` proves it against a Studio that is a
local server on loopback, never a real host.

## What a playbook may say

`PlaybookDocument` in `packages/shared/src/contracts/playbook.ts`. Every object
is `.strict()`: a field not named is a refusal, and the sentence names the
field only if it is harmless to print.

| Field | Meaning |
| --- | --- |
| `schema` | Always `1`. |
| `id`, `version` | Studio's id and an integer version. A later version is matched on the id. |
| `title`, `publisher` | Plain words only (`[A-Za-z0-9 ._'-]`, 60 characters, no line break, markup or link). |
| `capitalSol` | The paper capital it was written for. No limit may exceed it. |
| `universe` | `chain: "solana"` and 1 to 50 `{ mint, decimals }`. No symbol, no name, no "any token". |
| `limits` | Per trade, per day, open exposure, open positions, slippage, price impact, liquidity floor, fee. The same bounds an owner may write by hand. |
| `expiresAt` | Optional. |

There is nowhere to put a mode, an approval mode, a capability, a permission, a
Plugin, a script, a path, a URL, a prompt, a persona, a stance, a relationship,
a wallet, or a claimed result. Not because the importer refuses them: the schema
has no such field. A document over 64 KB is refused before it is parsed.

## Two steps, bound by a digest

1. **Preview** (`POST /api/agents/:id/playbook/preview`). Body is
   `{ document }` or `{ studioId }`, plus an optional `allowDowngrade`. It reads,
   parses and plans, and writes nothing. The answer lists every limit as
   published, as it would be written, and as the agent holds it now, flags the
   rows the owner's own mandate narrowed, flags any row that would let the agent
   do more than it does now, and carries `sha256` of the parsed document plus
   the fixed promises below.
2. **Confirm** (`POST /api/agents/:id/playbook/confirm`). Same body plus the
   `sha256` that was shown. The playbook is read again, and a different digest
   is refused, so a Studio that changed its mind between the preview and the
   click cannot get something nobody looked at applied.

Both are owner control plane routes. No capability reaches them and no model can
call them.

The fixed promises, shown with every preview:

- It is written as a paper mandate. Nothing here can make it live, autonomous or able to sign.
- Paper entries are simulated automatically without per-entry approval, within your paper limits. Nothing is signed or sent.
- No capability, permission or wallet is changed.
- Only the assets listed are in its universe, by exact mint.

## What is written

`planPlaybook` in `packages/runtime/src/playbookImport.ts` is one pure function
used by both the preview and the write, so they cannot disagree. It writes:

- `mode: 'PAPER'` and `approval: 'OWNER_APPROVES_EACH'` as literals. No document
  field is read for either, and a unit test hands it a document that smuggles
  both and shows they are ignored. The approval field gates live trades only;
  paper simulations do not enter the transaction approval workflow.
- `venues: ['AMM_POOL_SOLANA']`, `networks: ['solana']`, `assetScope: 'LISTED'`
  with `allowedAssets` the exact mints, and no protective exits.
- Each limit as the tightest of the published value, the playbook's capital, and
  the latest owner-written mandate, including retired owner mandates across
  later imports (a higher liquidity floor
  is the stricter one; the earlier expiry wins; a tighter quote age is kept).
  A mandate a previous playbook wrote is not a ceiling the owner chose, so a
  new version is shown as a change against it instead (`widensCurrent`), while
  the retained owner ceiling still binds.
- The pause: a paused mandate stays paused.

It refuses, with a sentence and the agent unchanged: a **LIVE** current mandate
(replacing it with paper would quietly end somebody's live configuration, so the
owner switches it themselves first); an expired playbook; a duplicate or
malformed mint; a limit set the owner's ceiling leaves with nothing to spend.

Importing reads no wallet and writes no `agent_capability_permissions`.
Radar observations use the existing channel path and grant no permission to act.

## Versions are pins

Migration `0122_agent_playbooks.sql`. Each import writes a new mandate row and a
new pin row and retires the old ones, in **one transaction under a lock on the
agent row** (`applyPin`), deciding against the mandate and pin read inside it. Two
imports at once queue; a plan made against a mandate the owner has since edited
is never written over their edit.

- The same id and version with different content is refused against every digest
  recorded in this installation, including retired pins and other agents. A
  transaction lock serialises concurrent imports of the same version.
- A lower version than the one running is refused unless `allowDowngrade` is
  sent, as with Plugin updates.
- The same version and content when the agent still runs it is a no-op.
- The pin keeps the document as published and what was effectively applied.
- Editing the mandate by hand afterwards writes a new mandate (the editor already
  supersedes). Whether the pin is still what runs is **computed**, not stored:
  `playbookStatus` compares `mandate_id` with the current mandate and says
  `EDITED` when the owner has moved on. There is no status column, so no enum
  CHECK to keep in step.

## What the agent says

`agent.self_state` (owner audience, already registered, no new capability) gains
a `playbook` sentence: which playbook, its id, its version and the import date,
or that the mandate has been changed since. The title is published text, shown
to the owner in the preview before they confirm and quoted in that sentence; it
is held to the plain-name grammar but is the one string from the document that
reaches owner chat, which is why it never reaches a public prompt.

## The signal radar

`playbookUniverse(agentId)` returns the exact assets of a running playbook, and
null when none runs or the owner has since edited the mandate. Confirm creates
an ordinary Social Radar keyword source per linked account. The existing radar
tick also creates sources for accounts linked later, and disables sources after
an owner edit or unlink. Each poll rotates to one exact mint from the current
universe. X reads pass through `checkReadCapacity`, `noteXRead` and the existing
keyword pacing rules. These sources inform context only and cannot create jobs.
No second scheduler or market-signal implementation is introduced.

Paper fills enforce per-trade and daily limits at execution. Daily spend and
open exposure come from the paper journal in the trade's quote units, separate
from live exposure. The gate and fill share the existing paper-journal lock, so
concurrent buys cannot each spend the same remaining daily allowance.

## Studio's side of the contract

`studioPlaybook(id)` in `studioLink.ts`: a `GET /api/v1/installation/playbooks/{id}`
with the installation's access token and a DPoP proof for that exact request,
through the same `authed` path as purchases. The id is checked against the id
grammar before it reaches a path. A 200 is `{ "protocol": 1, "playbook": { ... } }`;
the value is passed on **unparsed**, because the importer is the only thing that
decides what a playbook may say. A 404, any other status, an unlinked
installation or a network failure each become a sentence and leave the agent
unchanged. Studio's import route does not need to exist for core to be correct:
a file import takes the same path.

## What it does not do

It carries no relationships, stances, memories or claimed performance, and has
no field that could. It does not copy a trader: it sets limits and a universe,
and every entry is still the agent's own decision, judged by the existing gate
(`tradingRisk.ts`) and approved by the owner. It does not enable live trading,
approval or autonomous modes, or any capability, and nothing in a playbook can.
