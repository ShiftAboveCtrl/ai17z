# Social paper trading

`paper.trade` simulates one requested BUY through `runPaperTrade`. It is a
model-callable READ with LOW risk, disabled until the owner enables it. The
public capability loop remains off by default. Nothing here reads a private
key, signs, submits or reaches a live trading path.

The owner creates a PAPER mandate on the social agent using the existing
`PUT /api/agents/:id/mandate` route. Choose `ANY_SOLANA_TOKEN` for Solana mints,
`protectiveExits: null`, and the desired size, liquidity, fee and slippage
ceilings. PAPER requires no wallet. Then pin that exact returned mandate ID
with authenticated `PUT /api/agents/:id/paper-trading`:

```json
{
  "mandateId": "00000000-0000-4000-8000-000000000001",
  "venue": "AMM_POOL_SOLANA",
  "quoteAsset": {
    "kind": "ONCHAIN",
    "network": "solana",
    "address": "So11111111111111111111111111111111111111112",
    "decimals": 9,
    "symbol": "SOL"
  },
  "maxInBase": "10000000",
  "maxPerDayBase": "100000000",
  "maxRequestsPerRequesterPerDay": 3
}
```

The ID above is an example; use the ID returned by the mandate route. Amounts
are base units of the quote asset: 10,000,000 wrapped SOL base units is 0.01
SOL. This ceiling must fit the mandate. Setup does not enable the capability.
Enable the Social paper trading Plugin, or set `paper.trade` to ALLOWED through
`PUT /api/agents/:id/toolspace/paper.trade`. Public replies also require the
owner's `policy.tools.capabilityLoop` opt-in and the ordinary channel grants.
`GET /api/agents/:id/paper-trading` reports the saved configuration and permission.
Both setup routes are owner-scoped. There is no model-callable setup route.

`maxPerDayBase` bounds paper BUY spend per UTC day in the configured quote
asset's base units. If omitted, it defaults to ten times `maxInBase`. The
mandate's `maxPerDay` also applies, so the smaller ceiling wins. Sales do not
refund the daily budget. Both daily limits use the committed fill timestamp,
including requests that started before midnight. `maxRequestsPerRequesterPerDay` defaults to three
committed fills per UTC day, with an owner-configurable range of 1 to 100.
It counts distinct messages from the same channel author ID, across the
agent's accounts, rather than a model-supplied identity or a changeable handle.
Missing author IDs share one conservative bucket per channel. Owner chat uses
the conversation owner's ID across their conversations. Replaying an existing
request does not spend either limit again.

These checks use the committed paper journal, not `exposureOf`, which accounts
for LIVE trades. They include fills whose subsequent receipt write failed.
Open paper cost in the configured quote asset must fit `maxOpenExposure`, and
opening another asset/quote position must fit `maxOpenPositions`. Existing
paper buys and sales determine current quantities and remaining cost through
`paperPositions`. Costs in different quote assets are never added together.
Admission checks fail early; the same limits are checked again inside the
engine's paper journal lock immediately before the committed fill. Concurrent
requests cannot consume the same remaining budget. No new migration is needed.

Accepted incoming requests are `paper long $WIF`, `paper buy $X`, or a single
mint or contract address. A leading account mention is allowed. An optional
`on solana` identifies the chain. `for 5000000 base units` asks for a smaller
size. Without a size the configured ceiling is used. Multiple assets, extra
instructions, shorts and malformed amounts are refused. Unknown chains are
refused. Tickers use `parseTokenReference` and `resolveToken`, with liquidity
dominance disabled: two candidate identities mean ambiguity, even when one is
far more liquid. Exact decimals for unlisted Solana tokens come from the paced
pool reader. A listed asset uses the owner's exact `AssetRef`. All upstream
reads use their existing quotas; this feature makes no X read.

The capability accepts only `{}` from the model. It loads the stored incoming
event, or the owner-chat message, rather than a paraphrase or parent post.
Scheduled origination cannot invoke it. A LIVE mandate, an autonomous mandate,
a protective-exit policy, a replaced mandate or a changed capability config
cannot be inherited. Permission is read at admission and again after fresh
market reads and route pricing, immediately before recording the fill. The
engine forces PAPER and only a committed `PAPER_FILLED` transition is a fill.
The journal retains its snapshots, simulated amounts and named risk reasons.

Migration `0117_social_paper_requests.sql` claims each `(agent, incoming message)`
once with a primary key. Retries replay the recorded result, including refusals
and NO_MARKET. Concurrent callers cannot create a second fill. A process that
dies after claiming leaves PENDING for inspection; it is never automatically
rerun. A thrown attempt settles a durable PENDING result in `finally`, since
an exception could follow a committed fill. PENDING, missing results on a
claimed request, and failed or timed-out invocations hold the reply for review.
Their internal errors and operator instructions are never published to a
stranger. Inspect the trade intent keyed `social-paper:<agent>:event:<event>` or
`social-paper:<agent>:chat:<message>` before deciding what to ask next. A new
incoming message is a new request, even when its text matches an earlier one.

Every receipt says "Simulated paper", gives the fill and fee in labelled base
units, and carries the risk verdict with its named reasons. The full reason
sentences remain in the structured result and journal; public risk refusals
use compact reason codes so a realistic multiple-cause refusal fits 280
characters. Every resolved asset label includes a shortened contract address.
Symbols must match `[A-Za-z0-9]{1,12}`; any other upstream symbol is replaced
by the shortened mint, so it cannot inject mentions, tickers or promotional
copy. REFUSED and NO_MARKET
have no fill. The model cannot turn this receipt into a claim of money moved:
generation selects the recorded receipt, voice scoring keeps the receipt intact,
and validation and execution hold any changed or truncated receipt for review.
The ordinary identity, content, channel, cadence and quality gates still apply.
Public addresses must satisfy the existing output policy. No result is a price
prediction or a promise of future returns, and this adds no portfolio or timer.

Verification uses a mock channel, real disposable Postgres databases, a fake
market reader and mocked upstream answers. Live X, real market quality and
deployment are separate from those checks.
