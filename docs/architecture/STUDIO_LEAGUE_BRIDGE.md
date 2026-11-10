# Studio paper league bridge

How an AI17Z agent that runs on its owner's own installation can be an entrant in
a weekly paper league season published by AI17Z Studio. This document is the
contract between the two repositories. The client is `packages/runtime/src/studioLeague.ts`,
the allowlist for everything that crosses the boundary is
`packages/shared/src/contracts/studioLeague.ts`, and the client is proved against
`tests/support/leagueStudioServer.ts`, which implements this document strictly.

The Studio schema is pinned from `forge` commit
`e42c31f93697890d3652103d6d2d9de3c1570c72`, specifically
`tests/support/core-league-contract.ts`. Core's schema agrees from the Zod import
down. The fake server uses the independent copy in
`tests/support/pinnedStudioLeagueContract.ts`; targeted tests compare both copies
and Studio's published hash vector.

This is slice 1: the contract, the core half, and the owner-only question "how am I
doing in the league". Posting a standing in public is a later slice.

Studio owns the season: its rules, its dates, the rank. This installation owns the
agent: what it trades, under which mandate, and what it says. Nothing here lets
either side decide the other's half.

## Everything is simulated

The league is paper only. Every document carries `simulated: true` as a literal,
and a document that says otherwise is refused, not relayed. Every figure the agent
says names Studio as its source and says simulated and paper. A rank is never put
as an edge, and nothing here is advice.

Local entrants are scored from fills they report. Studio did not watch them
happen, and the standing says so (`basis: "REPORTED_BY_ENTRANT"`), as does the
sentence the agent says.

## Switches

Core requires `AI17Z_LEAGUE_JOURNAL=1` explicitly, including in production.
Unset, empty, `0` and every other value disable the bridge. While disabled, season,
entry and standing calls return an unavailable result with status `503`; reporting
and the sweep return zero work before reading the database or contacting Studio.
Existing entries and fill keys remain available when the switch is enabled again.
This gate grants no holder or account access: Studio still asserts those facts
for the owner of the authenticated installation and answers `403` on refusal.

| Surface | Switch | Default |
| --- | --- | --- |
| Entering a season | the owner's act (`enterLeagueSeason`), naming the agent, the season and an alias | nothing is sent until then |
| Reporting fills | being entered; the worker sweep reports the entered agent's paper fills | nothing is reported without an entry |
| Asking "how am I doing in the league" | the `league.standing` capability, in the Paper league pack | DISABLED, owner only |

Linking to Studio still sends nothing about any agent. The first thing that leaves
for an agent is the owner entering it, which is a row in "Sent to Studio" in
`STUDIO_LINK.md`. The capability is shaped like `wallet.*`: effect READ, risk LOW,
`audience: 'OWNER'`, `unsetPermission: 'DISABLED'`. It is never offered in a public
conversation and is refused if one names it.

## Requests

All requests go to the linked Studio origin only, never to an address that appeared
in an answer, as `studioInstallationRequest`: `Authorization: DPoP <access token>`
and a DPoP proof (RFC 9449) for that exact method and address without the query,
signed by the installation key. Studio must refuse `Authorization: Bearer`. There
is no stored bearer secret.

All paths are under `/api/v1/installation/league/seasons/{slug}`. `slug` is
`^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`; the client validates it before any request.

| | Method and path | Purpose |
| --- | --- | --- |
| 1 | `GET .../{slug}` | read one published season |
| 2 | `POST .../{slug}/entry` | enter it, idempotent by `entry_key` |
| 3 | `POST .../{slug}/entry/fills` | report paper fills, idempotent by `fill_key` |
| 4 | `GET .../{slug}/entry` | read own entry and standing |

Every object in every direction is strict. An unknown field makes the whole
document a refusal, because a field nobody agreed to is evidence the other side
changed, not noise to drop.

### 1. Read a season

`200` with:

```json
{
  "protocol": 1,
  "simulated": true,
  "source": "ai17z-studio",
  "generated_at": "2026-11-09T10:00:00.000Z",
  "season": {
    "slug": "week-45",
    "title": "Weekly holder paper league",
    "status": "OPEN",
    "entry_closes_at": "...",
    "starts_at": "...",
    "ends_at": "...",
    "fills_accepted_until": "...",
    "max_entrants": 50,
    "rules_hash": "<sha256 hex of the canonical JSON of rules>",
    "rules": { }
  },
  "local_agents": { "allowed": true, "note": null }
}
```

`rules` is Studio's season rules (`SeasonRulesSchema`, version 1) narrowed to what
this installation can honour:

| Field | What core accepts |
| --- | --- |
| `paperOnly` | the literal `true` |
| `quote` | exactly USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) or USDT (`Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`) on Solana, with that symbol and 6 decimals. Mint, symbol and decimals together are the identity, so a lookalike mint called USDC is refused |
| `capital` | positive, at most 1,000,000, and exactly writable in the quote's decimals |
| `universe` | `SOLANA_MEMECOINS` with 1 to 4 lists. `MARKETS` is refused: it names nothing a mandate could be confined to |
| `bounds` | `maxOpenPositions` 1 to 10, `maxTradePct` 1 to 100, `minLiquidityUsd` 0 to 100,000,000 |
| `costs.feeBps` | 0 to 1000 |
| the rest | as in Studio's schema, every object strict |

Date rules, enforced by the schema: entry closes at or before the start; a season
runs 1 hour to 14 days; `fills_accepted_until` is at or after `ends_at` and at
most 168 hours after it.

#### The canonical form of `rules`, exactly

`rules_hash` is the lowercase hex SHA-256 of the UTF-8 bytes of the canonical JSON
text of `rules` (not of the whole season document). Canonical JSON text is:

* No whitespace anywhere.
* Objects: members sorted by key in ascending order of **UTF-16 code units** (the
  default string sort of JavaScript). This is not code point order: the key
  `"😀"` (U+1F600, units `D83D DE00`) sorts **before** `"～"` (U+FF5E). Members are
  written as `"key":value`, each key serialized as a string below.
* Arrays: elements in their given order, `[a,b,c]`.
* Strings: ECMAScript `JSON.stringify`. Only `"` `\`, the control characters
  U+0000 to U+001F and lone surrogates are escaped; the short forms `\b \t \n \f \r`
  are used where they exist and `\u00xx` (lowercase hex) otherwise. Every other
  character, including all non-ASCII text, is written as itself and hashed as UTF-8.
  `/` is not escaped.
* Numbers: the ECMAScript `Number::toString` form that `JSON.stringify` produces:
  shortest digits that round-trip, no trailing zeros (`12.50` is `12.5`), no `+` on
  the mantissa, exponent forms such as `1e+21` and `1.5e-7`, and `-0` is `0`.
  Non-finite numbers do not occur.
* `true`, `false`, `null` as written.

`tests/fixtures/league-hash-vectors.json` holds fixed vectors (input JSON text,
canonical text, expected hash), generated by a script independent of the product
code and checked by `tests/unit/leagueBridge.test.ts`. They cover key order,
non-integer and exponent numbers, `-0`, non-ASCII keys and values, the UTF-16
ordering above, arrays, null, booleans and string escapes. Studio proves its
implementation against the same file.

The client recomputes `rules_hash` and refuses a season whose hash is not the hash of the rules beside it,
a season for another slug than the one asked for, and one whose `generated_at` is
older than 15 minutes or more than 5 in the future. `local_agents.allowed: false`
is a refusal with Studio's `note`.

Statuses: `404` means no such season. Anything else but `200` is reported as
"Studio answered N" with Studio's `error_description`.

### 2. Enter

```json
{ "protocol": 1, "entry_key": "<uuid>", "rules_hash": "<64 hex>", "alias": "Night Owl", "entrant": "LOCAL_AGENT" }
```

* `entry_key` is random and derived from nothing about the agent. The same key is
  the same entry however many times it is sent; Studio answers `200` with the
  existing entry on a replay and `201` on a new one.
* `rules_hash` is the hash the entrant read. Studio refuses `409` if it is not the
  season's.
* `alias` follows Studio's alias rules (3 to 24 characters, no link, no address).
  Studio remains the authority.
* The request carries no agent id, handle, wallet, persona or model.

Answer `200` or `201`:

```json
{ "protocol": 1, "entry_id": "ent_...", "season_slug": "week-45", "status": "ACTIVE", "entered_at": "..." }
```

Definitive refusals, after which the client records the entry as REFUSED and does
not retry: `400`, `403`, `404`, `409`, `410`, `422`, each with
`{ "error": "...", "error_description": "..." }`. Studio uses `409` for
`season_closed` (entry is not taken after the lock, and cannot be backfilled),
`rules_changed` and `already_entered` (one entry per installation per season).
Anything else (a network failure, `429`, `5xx`, an unreadable answer) keeps the
entry PENDING and it is tried again under the same key, with a wait of a tenth of
the time already waited, between one minute and fifteen minutes. Elapsed time
never ends an entry: a Studio outage of any length leaves it pending. It ends
only when Studio says no, or when the season's `entry_closes_at` passes without
Studio having taken it (REFUSED, "Entry closed before Studio took this one"). The
lock governs when Studio takes an entry, not when the local mandate is written:
an entry Studio accepted before the lock may still have its mandate written after
it, until the season ends. Nothing is backfilled, because only trades filled under
the mandate are reported, so a late mandate means fewer fills and never earlier
ones. An entry Studio holds whose mandate could never be written is ENDED once
the season is over.

### 3. Report fills

```json
{
  "protocol": 1,
  "entry_id": "ent_...",
  "fills": [
    {
      "fill_key": "f<31 hex>",
      "filled_at": "...",
      "side": "BUY",
      "asset": { "network": "solana", "address": "<mint>", "decimals": 9 },
      "quote_address": "<the season's quote mint>",
      "in_base": "100000000",
      "out_base": "49875000",
      "fee_base": "250000",
      "price_base_units": "2000000",
      "priced_at": "...",
      "price_source": "...",
      "slippage_bps": 4,
      "price_impact_bps": 12,
      "simulated": true
    }
  ]
}
```

One to 50 fills per report, each key once. Amounts are digit strings in base units,
never floats. `fill_key` is derived from the entry key and the local trade, so it
names nothing local. Nothing else about a fill leaves: no intent id, no model, no
reasoning, no impact model text.

Answer `200`:

```json
{
  "protocol": 1,
  "simulated": true,
  "accepted": ["f..."],
  "duplicates": ["f..."],
  "rejected": [{ "fill_key": "f...", "reason": "OUTSIDE_SEASON" }]
}
```

Every key sent appears exactly once. `duplicates` is a key already held with
identical content, counted once. The same key with **different** content is
`CONTENT_CHANGED`: a fill is never edited, here or there. Reasons are
`ENTRY_NOT_ACTIVE`, `SEASON_NOT_RUNNING`, `OUTSIDE_SEASON` (the fill is dated
outside `starts_at`..`ends_at`), `AFTER_REPORT_DEADLINE` (after
`fills_accepted_until`), `CONTENT_CHANGED` and `INVALID`. Studio does not backfill:
a fill is dated by the entrant and Studio rejects one outside the window.

The client takes the answer only if every key in it was sent and none is counted
twice. A key Studio did not account for stays pending and is sent again with the
same bytes. `accepted` and `duplicates` settle a fill as accepted; `rejected`
settles it as rejected for good. A definitive `4xx` for the whole report rejects
that batch; a network failure, `429`, `5xx` or an unreadable `200` defers it with
a backoff from one minute to one hour.

### 4. Own entry and standing

`GET .../{slug}/entry`, `200`:

```json
{
  "protocol": 1,
  "simulated": true,
  "source": "ai17z-studio",
  "generated_at": "...",
  "season_slug": "week-45",
  "entry_id": "ent_...",
  "season_status": "RUNNING",
  "entry_status": "ACTIVE",
  "basis": "REPORTED_BY_ENTRANT",
  "standing": {
    "state": "RANKED",
    "rank": 3,
    "of": 12,
    "return_bps": -125,
    "max_drawdown_bps": 480,
    "fills_counted": 4,
    "last_mark_at": "...",
    "reason": null
  }
}
```

`state` is `NOT_STARTED`, `PENDING` (no usable valuation yet), `RANKED` or
`UNRANKED` (withdrawn or stopped). Only `RANKED` has a rank, and the rank is within
the field. `return_bps` is signed, net of costs, on starting capital; a loss is
negative. `NOT_STARTED` carries no figures. `404` means Studio has no such entry.
The client refuses a document for another slug or entry id, one older than 15
minutes, or one with any unknown field.

## What core does with a season

1. **Reads and refuses whole.** Strict parse, hash recomputed, freshness checked,
   and the mandate computed, all before anything is written. A hostile payload
   (unknown asset, oversized limit, unknown field, universe it cannot confine)
   leaves no entry row, no mandate and nothing sent to Studio.
2. **Checks the mandate slot** before Studio hears anything. An agent has one
   mandate. A LIVE mandate is never replaced, whatever is asked. The owner's own
   paper mandate is replaced only if the owner said so explicitly
   (`replacePaperMandate`); replacing breaks a pinned social paper request, which
   fails closed.
3. **Records the intent to enter**, keyed, then tells Studio. A crash between
   "Studio said yes" and "the mandate was written" leaves a row to resume under the
   same key, never an entry Studio holds that nothing here knows about.
4. **Writes the mandate only after Studio accepted**, in one transaction with the
   entry becoming ACTIVE. An entry Studio refused therefore never replaced anything
   of the owner's.

### The season mandate

A PAPER mandate, owner-approves-each, with no protective exits. The mode is not
read from the season (the rules have no such field) or from the caller: the
repository writes `mode: 'PAPER'` over whatever it is handed, and
`tests/unit/leagueBridge.test.ts` fails if any league source imports a signer, a
wallet, `studioLiveTrades`, the trade executor or the kill switch, or writes
`LIVE`. `tests/unit/noWalletCapabilities.test.ts` pins the single capability.

| Mandate field | From the season |
| --- | --- |
| `maxPerDay`, `maxOpenExposure` | `capital` in the quote's base units |
| `maxPerTrade` | `capital` times `maxTradePct`, floored |
| `maxOpenPositions` | `bounds.maxOpenPositions` |
| `minLiquidityBase` | `minLiquidityUsd` in the quote's base units (a dollar stablecoin, so this is exact), at least 1 |
| `maxFeeBase` | the larger of the season's fee rate and 1% of `maxPerTrade` |
| `maxSlippageBps`, `maxPriceImpactBps` | 300 each; the season names none, and a simulation errs towards the worse fill |
| `expiresAt` | `ends_at` |
| venue, network, scope | `AMM_POOL_SOLANA`, `solana`, `ANY_SOLANA_TOKEN` |

Who decides the trades is unchanged: the existing paper machinery, under this
mandate, with the owner approving each one. The bridge does not trade.

### Reporting

The worker sweep copies the entry's `PAPER_FILLED` trades under the season mandate
and the entered agent's own id
into `league_fill_reports`, once each (primary key `(entry, trade)`), then sends
what is due. The stored payload is frozen by a database trigger: a reported fill is
not edited, and a settled report does not change state. The season's own fields on
`league_entries` are frozen the same way. A fill outside the season window, or not
priced in the season's quote, is kept as `LOCAL_ONLY` with the sentence for why and
is never sent. After `fills_accepted_until` whatever is unsent becomes `LOCAL_ONLY`
and the entry ends. Reporting continues while PAUSE ALL is set, on purpose: it
records paper fills already made and is not a new action.

Every fill batch and pending entry retry confirms the season again before a POST
or mandate activation. The sweep also checks idle entries every thirty minutes,
using its existing loop with no new timer. Unreachable or stale: the existing
paper mandate remains, the problem is recorded, and no fills are reported until a
fresh season can be confirmed. A different rules hash, entry lock, start, end or
report deadline fails closed: an active entry ends and its paper mandate pauses;
a pending entry is refused without writing a mandate. The frozen local row is
also checked against its stored season document before any fills are copied.
Cancelled: the entry ends and its mandate is paused. A contradictory fill answer
or a key that was not sent defers the whole batch without settling any fill.

## What the agent says

`league.standing` reads Studio now and says what Studio said. Nothing is computed
here and nothing is kept between calls.

| Studio said | The agent says |
| --- | --- |
| `RANKED` | its rank of the field and its simulated return after costs, a loss as plainly as a gain, from Studio, simulated and paper, not real trades, nothing about future results |
| `PENDING`, `UNRANKED`, `NOT_STARTED` | that it has no rank, with Studio's reason, and that it will not guess |
| not entered | that there is no league standing to give |
| unreachable, refused, stale, malformed | that it cannot check, what is still true locally (the paper mandate is in place until the season ends), and that it will not guess at a rank |

## Studio implementation

Studio's side is implemented on the pinned `forge` commit in
`lib/http/league-bridge.ts`, `lib/services/league-bridge-service.ts`,
`lib/trading/league-ledger.ts` and `lib/validation/league-bridge.ts`. It provides:

1. `GET /api/v1/installation/league/seasons/{slug}` as in section 1, published from
   the season row, with `rules_hash`,
   `fills_accepted_until` (frozen with the rules' dates) and the
   `local_agents` block.
2. `POST .../entry` as in section 2: an entry kind `LOCAL_AGENT` with no Studio
   journal agent behind it, the idempotency key, one entry per installation per
   season, the lock at `entry_closes_at`, and `409`s as above. The existing
   `provisionSeasonJournals` skips these entries.
3. `POST .../entry/fills` as in section 3: a fill ledger keyed by `fill_key`, content
   hashed so a replay is a duplicate and a changed fill is `CONTENT_CHANGED`, and
   the window and deadline rejections.
4. `GET .../entry` as in section 4: standing computed by the existing scoring, with
   open positions marked to a usable price, the mark age rule and
   `UNRANKED_UNTIL_VALUED` applied to reported fills the same way as to journal
   readings. Cost accounting for reported fills is Studio's: the reported
   `fee_base` is what the paper venue charged, and Studio may apply the season's
   `costs.feeBps` as a floor.
5. Local entries labelled Self-reported on public surfaces. The core bridge
   reports paper facts; Studio owns scoring and these labels.

The bridge preserves Studio's `503` unavailable, `403` access refusal and `409`
conflict responses. A `503` leaves an entry pending under the same key, while a
definitive entry refusal leaves the existing mandate untouched. No schema change
is needed for the local gate and frozen-fact checks; migration `0120` already
provides the entry and immutable fill ledgers.

## Not in slice 1

* Posting a standing in public (reticence, cadence, capacity, identity policy, an
  owner opt-in). The answer shapes here carry what it needs.
* An owner screen or API route to enter, and withdrawing from a season (Studio
  keeps results of a withdrawn entry, unranked).
* Making the agent trade the season on its own. It trades as it already does,
  under the season mandate.
