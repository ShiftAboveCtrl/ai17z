# Real trades from Studio

`packages/runtime/src/studioLiveTrades.ts`, with `liveTrading.ts` underneath it.
Studio's counterpart is `docs/LIVE-EXECUTION.md` in the Studio repository.

## The rule

**The key lives where the owner lives.** A Studio trading agent decides; it
never signs, and Studio holds no key. A real trade is prepared on the owner's
own AI17Z, by the wallet adapter they installed and pinned, under the mandate
of the local agent they chose, and is signed only after the owner approves the
digest of that exact transaction here. An approval relayed through a website is
an approval the website could forge, so there is no such relay.

## The path

1. A Studio agent in APPROVAL mode records a decision and asks for a trade: one
   request per decision, unique there, naming the exact mint and amount.
2. The worker's sweep (`sweepStudioLiveTrades`), every minute while the owner
   has `studio.liveTrades` on, collects requests over the installation's DPoP
   link. Studio never connects here.
3. Each request is carried out by the local agent the owner bound to that Studio
   agent (`studio.liveTrades.bindings`). Unbound is refused with a sentence.
4. `proposeLiveSwap` runs exactly as for a local trade: LIVE mandate with
   OWNER_APPROVES_EACH, pause, fresh market read, Jupiter quote for this amount,
   the stricter of the route's and the owner's floors, the adapter's simulation
   of the exact transaction, and the risk verdict. Its idempotency key is
   `studio-live:<request id>`, so a request delivered twice is one trade.
5. Studio is told PREPARED with the digest, the wallet and the simulated amounts,
   and the owner is notified (`LIVE_TRADE_WAITING`, delivered to Telegram if
   paired).
6. The owner presses **Review**: the transaction is built and simulated again,
   because a Solana transaction names a blockhash the network forgets in about a
   minute. **Approve and send** approves that digest and sends it at once;
   `maySign` reads the mandate, the pause and the quote's age again then.
7. A sent trade is asked about by hash on the next sweep (`reconcileLiveSwap`),
   which reads the chain and never sends again. Every step is told to Studio,
   which takes reports only forward, so telling it twice is harmless.

## What is not done, and why

- **Amounts are the simulation's.** The adapter reports a receipt's status, not
  its token balance changes, so Studio is told what the exact signed
  transaction delivered in simulation and the request says so
  (`amounts_from: SIMULATION`). A sale never asks for more than the wallet
  holds, whatever Studio's book says.
- **No venue-native stop.** Jupiter's Trigger API offers a stop-loss and
  take-profit pair, but it moves the tokens into a custodial vault, needs a
  JWT from signing a challenge message (the wallet signs two typed transaction
  kinds and never a message), and fills a stop at up to 20% slippage by
  default. That is a custody decision for the owner, not a default.
- **No autonomous buying.** A mandate asking for autonomy is refused, as it is
  for a local trade. Every buy waits for the owner, because a digest cannot be
  approved in advance. The one exception is a protective sale, below, and it
  is an authority the owner wrote, never one the agent asked for.

## Protective exits the owner authorised in advance

A stop that waits for somebody to wake up is not a stop. So a mandate may carry
a `protectiveExits` policy, written by the owner on the agent's Wallet section
and by nobody else: a stop loss below average cost, a trailing stop from the
highest price seen since entry (only once the position is in profit), and a
liquidity floor under which it sells whatever the price. It also sets the worst
slippage, price impact and fee such a sale may accept. Null, the default, means
none.

`guardLivePositions` in `packages/runtime/src/protectiveExits.ts` runs in the
worker every fifteen seconds, as ESSENTIAL work, so memory pressure never
delays it. It calls no model. For each position the chain confirmed it reads
the wallet's balance and the pool, and when a trigger crosses it proposes the
sale through the ordinary path (`proposeLiveSwap`), checks the prepared
transaction against the policy's own bounds, and only then approves that exact
digest under the policy and sends it. The approval is recorded as
`live.protective_exit.approved_by_policy`, naming the trigger.

What holds it:

- **A sale only.** The policy can sell what the agent holds and nothing else.
  It cannot buy, cannot raise a limit, and cannot be written or widened by a
  model: the mandate editor is an owner route, and nothing an agent decides
  reaches it.
- **Sale-side checks are about the sale.** The size, daily, exposure, position
  count and liquidity limits exist to stop buying too much; applied to a sale
  they would refuse the exit a falling price needs. A sale is still held to its
  slippage, impact and fee bounds, the wider of the mandate's and the policy's.
- **One sale per position at a time.** An advisory lock per agent
  (`withLiveExitLock`) and an in-flight check, which reconciles a SUBMITTED or
  UNKNOWN sale by its hash before anything else is tried. The idempotency key is
  the position and the minute, so a trigger seen on two passes is one trade.
- **Paused means paused.** A paused mandate or PAUSE ALL stops it.
- **Studio may ask, never decide.** A protective request from Studio is honoured
  this way only when the policy says `honorStudioProtective`; otherwise it waits
  for the owner like any other.

## Which tokens

`assetScope` on the mandate is `LISTED`, the default (only assets named in it),
or `ANY_SOLANA_TOKEN`, which a memecoin agent needs: a token launched an hour ago
cannot be listed in advance. It applies to on-chain Solana assets only, and
every other limit still binds each trade.

## Two ways to send a trade would be one too many

A wallet intent whose key starts `trade-intent:` carries a live trade and can be
approved and sent only through the trade (`approveIntent` and `submitIntent`
refuse it otherwise). The plain wallet routes would sign the same digest without
the trade's checks at sending and without carrying the result onto the trade.
