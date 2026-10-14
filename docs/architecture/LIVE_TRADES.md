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
- **No autonomous path.** A mandate asking for autonomy is refused, as it is for
  a local trade. Under OWNER_APPROVES_EACH every exit, a protective sale
  included, waits for the owner: a digest cannot be approved in advance.

## Two ways to send a trade would be one too many

A wallet intent whose key starts `trade-intent:` carries a live trade and can be
approved and sent only through the trade (`approveIntent` and `submitIntent`
refuse it otherwise). The plain wallet routes would sign the same digest without
the trade's checks at sending and without carrying the result onto the trade.
