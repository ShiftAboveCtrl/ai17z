# Mint check: the evidence-card reply

Someone mentions the agent with "check" and one token address. The agent replies
with a fixed card of sourced readings and no verdict. Off by default; Easy Mode
has one switch for it (`replies.mintCheck`, which writes `tools.mintCheck.enabled`)
and Advanced holds the two limits.

## Where it sits in the pipeline

- **Engagement step** (`planMintCheck`): detection, then the early stops. Only a
  message that addresses the agent can ask, so it never speaks first. A strong
  pitch is declined, hostility is left to the ordinary deflection, an evidence
  capability the owner disabled is respected, and an asker past their hourly cap
  is not answered. The request still goes through `exchangeLimit`, which no
  request buys its way past.
- **Research step** (`stepMintCheck`): claims a place in the limits, reads the
  evidence through `invokeCapability` (`token.solana_profile` for a Solana mint,
  `token.inspect_risk` for an EVM contract on a named chain), and fixes the reply
  text on the job. No web search runs for it.
- **Generate / validate / voice / execute**: the card is carried as fixed text.
  No model call writes it, the voice step leaves it alone, and validation and
  execution both refuse to send anything but the card as built, or a card that
  contains verdict wording, even after an owner approved it.

## What the card may say

Readings, each with its source and the time it was read; a reading that was not
reported is "unavailable", never zero. A missing, old or failed read is written
as such. Every card ends "Not a verdict. Reads can be wrong or late." The banned
register (safe, rug, scam, buy, sell, price, bullish, multipliers, tickers and
so on) is checked on the finished text, and a test enumerates the card across
every combination of known and unknown readings.

An EVM card names the service that said each line (GoPlus for the contract
analysis, Honeypot.is for the trade simulation) and the time **that service was
asked**, not the time the card was built. The upstream layer caches analysis for
an hour and a simulation for half of one, so stamping the card's own clock on a
cached answer would present it as current. A service whose reading is older than
`MINT_READ_MAX_AGE_MS`, or cannot be dated, is "unavailable". "Supply: cannot be
increased" is written only when the service stated that attribute and did not
flag it (`analysis.known`); a contract it has never analysed, or an attribute it
did not report, is "unavailable", because the capability lists a flag only when
one is raised and silence is not a reading.

## Limits

- Per asker per hour (`maxPerAskerPerHour`, default 3), refusals included.
- Per mint cooldown (`mintCooldownSeconds`, default 300): inside it, a second
  asker gets a one-line pointer at the first card, not a second read. "The same
  mint" is agent + chain + canonical address (`mint_key`, generated in migration
  0125): an EVM address is lowercased, a Solana address is left as written, and
  the same string on two chains is two contracts.
- **Only a published card is pointed at**: its job has an executed, non-rehearsal
  action. A card still on its way out reserves the contract, and the next request
  waits (`mint_card_pending`, a retryable stop that charges no attempt and takes
  no place in the limits) so five askers still make one read. A card parked for
  the owner's approval, or never sent, reserves nothing and the next request
  reads for itself.
- Both live in `mint_check_requests`, claimed under a per-agent advisory lock and
  unique on the job, so a retried job returns its first answer. A rehearsal takes
  no place in the limits.
- Reads spend from the upstream quotas in `packages/upstream`, not the X budget.

## Watching a mint

Nothing a stranger writes can create a watch. Once a card is confirmed published
(the execute step, not the research step) the owner gets a notification through
`notify.ts` with an id. It is INFO, so it travels in its own Telegram category,
`evidence`, which the severity floor does not apply to; the category switch is
the owner's control. Only published cards are offered to `/watch`. `/watch <id>` in their paired Telegram chat is the one
caller of `confirmMintWatch`, which pins a context-only (`mayTrigger: false`)
new-pool watch for Solana mints. A unit test pins that single caller.

## What it will never do

No wallet, trade, follow or verdict. A ticker, two addresses, a 0x address with no
chain and a pair link are each refused in one sentence.
