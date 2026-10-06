# Agentic trading

**Status: in development. Not released, not enabled, and no funded transaction
or brokerage order has ever been made from this repository.** The default mode
is PAPER and the default approval is OWNER_APPROVES_EACH. Nothing here is
required to run AI17Z, and an agent with no mandate can do none of it.

This document is mostly about what a model is not allowed to touch, because
that is the part that matters and the part that would be quietly eroded first.

## The division of labour

A model may produce a **`TradeIntent`**: a request, in exact base units, naming
an asset by chain and contract, against a **`TradeMandate`** the owner wrote.

That is the entire surface. It may not produce transaction bytes, choose a
destination, widen a limit, or reach anything that signs. Everything between
the intent and the chain is deterministic and sits below the model: the
mandate, the risk checks, a quote that has to still be true, a simulation, and
an approval.

**No generic transaction capability is ever exposed to a model.**
`NEVER_MODEL_CALLABLE` in `packages/runtime/src/tradeExecution.ts` is the list:
`send`, `transfer`, `approve`, `sign`, `signMessage`, `signTypedData`,
`contractCall`, raw calldata, an arbitrary destination, and the rest. Every one
of them would let a model choose the destination, the amount or the calldata,
which is the whole of what a mandate exists to decide instead.

`tests/unit/noWalletCapabilities.test.ts` already holds the capability registry
against that line and fails if a wallet capability appears. The agent's four
wallet capabilities are reads, OWNER audience, and DISABLED until the owner
turns them on.

## Money is never a float

Every amount is a decimal string of the smallest unit, reusing `BaseUnits` from
the wallet vocabulary so there is one rule rather than two. Every comparison in
`tradingRisk.ts` is BigInt arithmetic. A rounding error here is somebody's
money, and a float that is correct in a test is correct until the number gets
large.

## Venues are named after what executes, not after a label

```
PONS_V1              EVM     Pons V1, a locked one-sided Uniswap V3 position
PONS_V2_CURVE        EVM     Pons V2 minting into a constant-product curve
PONS_V2_GRADUATED    EVM     Pons V2 after graduating into a locked Uniswap V4 pool
PUMP_CURVE           SOLANA  Pump bonding curve
PUMP_SWAP            SOLANA  PumpSwap
ROBINHOOD            BROKER  the brokerage
```

Pons V1, V2 on its curve and V2 after graduation are **three venues, not three
states of one**. The arithmetic, the failure modes and the transaction shape
differ, so merging them is how an agent sells into a pool that is not there.
The same reasoning separates Pump's bonding curve from PumpSwap.

**Which venue an asset is on is read from chain state**, never inferred from a
ticker, a name or a user interface label.

## The mandate is the owner's, and it is versioned

A mandate is superseded rather than edited, like every other versioned thing
here, so what an agent was permitted at the moment it acted stays answerable.

It carries the venues and networks allowed, the assets allowed (empty means
nothing, which denies everything), a maximum per trade, per day and of open
exposure, a maximum open position count, slippage and price impact ceilings in
basis points, a minimum liquidity and maximum fee, how old a quote may be when
execution is attempted, an expiry, and a pause.

`mode` defaults to **PAPER** and `approval` defaults to
**OWNER_APPROVES_EACH**. Those two defaults are the product's position, not a
starting configuration to grow out of.

## The risk engine is arithmetic, not judgement

`packages/runtime/src/tradingRisk.ts`. Pure: it calls no model, reads no
network and signs nothing. Given an intent, a mandate and the current state it
says yes or no and why.

**Every refusal carries its reasons, and the reasons are the output.** "Risk
score 18" tells nobody anything, and the question an owner asks afterwards is
always "why did it not do that". Reasons accumulate rather than
short-circuiting on the first, because somebody declining a trade wants all of
why and a second run to find the second problem is a second chance to approve
it by accident.

The stops no arithmetic can argue with come first: a pause at any scope, a
paused or expired mandate, an intent judged against a mandate it does not
belong to, an intent and mandate belonging to different agents, an expired
intent, and an intent already in flight.

## The one place a transaction could become two

`TRADE_INTENT_STATUSES` has `SIGNED` and `SUBMITTED` as separate states on
purpose. Between them is the only window where AI17Z has created something
irreversible and does not yet know what happened to it.

**`TRADE_NO_RESIGN_STATUSES` is `SIGNED`, `SUBMITTED`, `UNKNOWN` and
`CONFIRMED`.** `maySign` in `tradeExecution.ts` is the only thing that reads
it, so there is one answer rather than one per call site.

`UNKNOWN` is in that list on purpose, and it is not a synonym for failure. A
broadcast whose outcome nobody saw is the exact case where trying again creates
a second real transaction, so:

- `afterBroadcast` keeps **REFUSED** and **UNSEEN** apart, exactly as the
  market reader keeps `NOT_LISTED` and `UNAVAILABLE` apart. A network that
  refused a transaction has told us nothing was sent, and that is safe to act
  on. A connection that dropped has told us nothing at all, and treating the
  second as the first is a duplicate-transaction machine.
- `resolveUnknown` is the only way out, and it asks the network rather than
  assuming. The same reasoning as `wasAlreadyDone` asking X whether a reply
  landed: a worker that died between sending and recording is
  indistinguishable from one that died before sending, and the system cannot
  mark its own homework.
- After `UNKNOWN_ATTEMPTS_BEFORE_PERSON` it asks for a person. A sweep that
  never gives up looks like progress, and is the state in which somebody
  eventually resends by hand to make it stop.

`maySign` also re-reads the mode rather than trusting an earlier read, because
a mandate can be read at one moment and acted on at another, and an execution
path that trusts the earlier read signs on a mandate somebody has since
changed.

## Paper mode is the whole path minus the signature

`paperTrading.ts` runs real market data, the real risk engine and the real
arithmetic, and deliberately does not sign. The result is `PAPER_FILLED`, and
it is **ignored by exposure**, because an exposure number that counted
imaginary positions would refuse real trades for imaginary reasons.

`mode: 'PAPER'` is forced at creation and checked again at signing. Two checks
for one rule, in the same spirit as the capability permission checked at ingest
and again before execution.

## Market data: median, not deepest

`marketData.ts`. The deepest UNI pair on DexScreener is UNI/SASHIMI reporting
$5,178,076 a token against a real $5.18. One broken pair tops a liquidity table
and cannot move a median.

A ticker is not an identity: pairs are grouped by contract, the deepest group
wins, the address is quoted, and the others are acknowledged.

**`NOT_LISTED` and `UNAVAILABLE` are kept apart.** A token that does not exist
and a feed that did not answer are different things to tell somebody, and
treating the second as the first is how a bad price becomes a trade.

## What is explicitly not authorised

- **No funded blockchain transaction.** None has been built, signed or
  broadcast.
- **No funded brokerage order.**
- **No unattended live-mainnet autonomous trading.**
- No venue adapter is in this repository, and three of them exist outside it.
  The parts that can move value are first-party adapters the owner installs,
  for the same reason `wallet.ts` holds no key. See below.
- No private venue source has been published here.

## The venue adapters, which are private

Three first-party adapters exist outside this repository, with no remote, and
none of their source is here. What is public is the contract they implement:
`MarketReader` for reading a venue, and a proposal shaped like the fields of a
`TradeIntent`. The public pipeline owns the intent, the mandate, the risk
arithmetic, the approval and the signing boundary; an adapter owns the venue
and nothing else.

Each one implements the same four rules, and each refuses rather than improvises:

- **No address or program id is a constant.** Every deployment is configuration
  verified against chain state before use: the chain id, that code or an
  executable account is actually there, and a recorded hash so a redeployment
  is a disagreement rather than a silent substitution. A ticker never
  identifies an asset; exact chain plus exact address does.
- **Four typed operations each: two questions and two proposals.** An allowlist
  rather than a denylist, with the forbidden verbs checked as well, so an
  operation whose name crosses the line is refused twice. No adapter holds a
  key and none can sign.
- **A built transaction is inspected before it could reach a signing
  boundary.** The venue that returns one gets its transaction deserialised, and
  the fee payer, every program, the instruction count, the asset and the
  required signer count are all checked against what was asked for. Signing
  because an API said so is blind signing.
- **The generations and phases are read, never assumed.** Pricing a bonding
  curve as a pool, or the reverse, produces a plausible number that is wrong,
  and the window between graduation and migration is a refusal rather than a
  guess.

What is blocked, and only this:

| Adapter | Blocked on |
| --- | --- |
| Pons | a Robinhood Chain RPC endpoint, without which the deployment check refuses |
| Pump | a Solana RPC endpoint; the funded half is not authorised at all |
| Robinhood | an agentic-account authorisation, which only the account holder can grant |

The Robinhood adapter does one thing worth naming here. Its Trading MCP tool
names are not published anywhere, so it **discovers** them through `tools/list`
and maps what comes back onto AI17Z's own operations, rather than asserting
names that would fail the first time somebody connected. A tool the mapping
does not recognise is reported rather than ignored, and a tool that places,
submits, cancels or executes is refused whatever it is called. Robinhood's own
trade-approval setting is treated as a second gate and never as a substitute
for the owner's mandate.

## Chain facts, and where they came from

`wallet.ts` carries the network ids, each read from a live node rather than
copied from a list: Ethereum 1, BNB 56, Robinhood Chain 4663 (`eip155:4663`,
whose `eth_chainId` answered `0x1237`), and Solana's genesis hash.

Pons' factory addresses were read from source and are marked as such. **They
have never been verified onchain from this repository**, and a source-inspected
address is not a verified one.

## What has not been done

- No adapter has executed anything, in paper or otherwise, against a real
  venue. Each is source-complete and test-proven against fixtures and
  arithmetic, and each refuses without the credential it names.
- No mandate has been created on a live installation.
- The Robinhood MCP surface is discovered rather than asserted, and has never
  been discovered against the real server.
- `tradeExecution.ts` has never been handed a real broadcast result.
