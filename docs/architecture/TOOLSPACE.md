# The Toolspace

What an agent can find out, and the one road every question travels down.

## The chain

```
model / runtime
      -> capability            contract.abi, market.snapshot, defi.stablecoins
            -> upstream family contract_ethereum, market_gecko, defi_stablecoins
                  -> adapter   sourcify, geckoterminal, defillama
                        -> normalised evidence, with provenance
```

A model asks `contract.abi`. It never asks `sourcify.lookup`. That one rule
is what the rest of this document is about, and every property below follows
from it:

- **A source can be replaced without touching a prompt.** Sourcify going away is
  a registry edit, not a change to what an agent knows how to ask.
- **Two sources can answer one question.** A family is a rank-ordered list, and
  falling back is ordinary rather than exceptional.
- **Nothing an adapter does is invented twice.** Rate limiting, retry, caching,
  request coalescing, the circuit breaker, provenance, secrets, health and size
  limits all live in `packages/upstream` and an adapter inherits them by being
  one.

An adapter that reimplements any of those is a bug, however well it works.

## Where things live

```
packages/upstream/src
  contract.ts      what an Upstream is; Answer<T> and Provenance
  registry.ts      families, ranks, and what is registered
  ask.ts           the one route: ask(family, query) -> Answer<T>
  http.ts          safeFetch -- the only way out to the network
  limiter.ts       concurrency and windows, per scope
  quota.ts         windows, scopes, and how a key is shaped
  machineQuota.ts  the file ledger behind MACHINE scope
  memoryQuota.ts   the in-process one, for unit tests
  breaker.ts       cooling off a source that is failing
  cache.ts         freshness and in-flight coalescing
  failures.ts      every way a call can fail, classified
  exactNumbers.ts  integers that must not go through a double
  addresses.ts     EVM identity; bitcoinAddress.ts, cid.ts for the others
  families/        one file per upstream family
```

Capabilities live in `packages/runtime/src/*Capabilities.ts` and are registered
in `bootstrap.ts`, alongside the upstreams, for the reason stated there: a
registry filled at import time contains whatever happened to be imported.

## ask()

```ts
const answer = await ask<DefiQuery, DefiAnswer>('defi_stablecoins', { kind: 'stablecoins' });
answer.value        // the normalised shape
answer.provenance   // who answered, from what host, when, and who was asked first
```

Everything happens inside that call, in this order:

1. **Cache.** A fresh value is returned without a request. Two callers asking the
   same question at the same moment share one request rather than making two.
2. **Breaker.** A source that has been failing is skipped, with a reason.
3. **Quota.** A slot is taken, or waited for, or the next source is tried.
4. **Fetch**, through `safeFetch` only, bounded by bytes and by a timeout,
   carrying the caller's `AbortSignal`.
5. **Classify.** Every non-2xx and every thrown error becomes an
   `UpstreamFailure` with a named class. Nothing escapes unclassified.
6. **Fall back**, in rank order, recording who was asked and could not answer.

### Falling back is not a second opinion

`fellBackFrom` exists so an answer cannot look healthier than the system is.
"Ankr was down so this came from Llama" is worth knowing. But a fallback is
**one** source answering after another could not -- it is not two sources
agreeing, and nothing may present it as confirmation. Where a cross-check is
actually wanted it is written as one: `market.price_check` asks two independent
families and reports whether they agree, and reports the disagreement rather
than resolving it.

## Limits

Every family declares what it may spend. The shape is deliberately general,
because "requests per minute" is not the only thing a service meters.

```ts
limit: {
  concurrentPerProcess: 2,
  windows: [
    perSecond(3, { scope: 'MACHINE' }),
    perTenSeconds(20, { scope: 'MACHINE' }),
    perMinute(100, { scope: 'MACHINE' }),
    // A limit the service applies per method, not per connection.
    { ...perTenSeconds(15, { scope: 'MACHINE' }),
      per: (query) => (query as SolanaQuery)?.method ?? null },
  ],
},
timeoutMs: 10_000,
maxBytes: 256_000,
```

### The two scopes

| Scope | Counts across | Held by |
| --- | --- | --- |
| `INSTALLATION` | every process sharing one database | `pg_advisory_xact_lock` |
| `MACHINE` | every process on one machine, database or not | a file ledger |

The distinction is not decoration. An installation's container worker and a
developer's native worker are two processes; if each counted alone, each would
believe it had the whole allowance and the endpoint would see twice what AI17Z
thought it was sending. `MACHINE` scope is keyed on the **origin**, because what
a public endpoint meters is the address talking to it, not which of our families
happens to be asking.

That is why a family's `origin` must be the host it actually fetches. A family
that declares one host and calls another shares an allowance it never spends and
credits a service that never answered.

### Published, or ours

`LimitSource` distinguishes a number the service publishes from one AI17Z chose
for itself. Both are respected identically; the distinction is so that a person
reading the configuration can tell a contractual limit from a courtesy.

Where a service publishes nothing, the number is ours and is deliberately
modest. These are public goods and nothing here may be pointed at one hard.

### A trailing window is not a bucket

A window of capacity C over interval I does **not** mean C requests in any span
of length I. Over a span S it allows `C x ceil(S / I)`, because the window
trails. 100 requests per 10 seconds is 300 requests in 30 seconds, not 100, and a byte
budget argued from the smaller figure is wrong by a factor of three.

The same arithmetic is what bounds *concurrency* without inventing a number.
Connections open at once are the grants inside a trailing span of one timeout,
so a 10-second timeout at 20 grants per 10 seconds holds at most 20 connections
open against a published 40 -- for any number of installations, because the
window is machine-scoped and keyed on the origin. `timeoutMs` is therefore
load-bearing rather than a comfort figure, and `upstreamLimits.test.ts`
recomputes the bound rather than trusting the comment.

### 429 is an instruction, not a failure

A rate limit that has not cleared is not an outage. `Retry-After` is read and
obeyed; the block is recorded against the **address**, so a per-method window's
discriminator does not hide a refusal that applies to everything.

## safeFetch

The only way out of this package to the network, and the reason is the shape of
the attack rather than any one check:

- **The address is judged, then pinned.** The name is resolved, the address is
  checked against private, loopback, link-local and reserved ranges, and then an
  undici `Agent` with a `connect.lookup` hook pins the socket to *that* address.
  Resolving twice is how a DNS rebinding gets in between the check and the
  connection.
- **One Agent per call, closed in `finally`.** There is no connection pool and
  no keep-alive. That costs a handshake per request and buys two things: the
  pinning above cannot be reused for a later, different address, and a service's
  *connection* rate is exactly its request rate, so a limit expressed in new
  connections can be reasoned about at all.
- **TLS stays strict.** No `rejectUnauthorized: false`, ever, under any flag.
- **Redirects are re-judged**, not followed on trust.
- **Bytes are counted as they arrive** and the read stops at `maxBytes`. A
  response is refused by size before it is parsed, never after.
- **A response compressed more than once is refused**, before its body is
  pulled. `maxBytes` bounds what the reader takes, and that is not a bound on
  this: `Content-Encoding: gzip, gzip, gzip, ...` makes the client build a chain
  of decompressors, and the work happens inside the transport where the size cap
  cannot see it. One coding is normal and stays allowed -- refusing compression
  outright would cost a public endpoint several times the bandwidth on every
  call, which is the wrong answer to a problem two layers already solve.

## Size is a first-class limit

Rate limits get the attention; size is more often the thing that actually
governs. From the DefiLlama survey, all measured rather than assumed:

| asked | returns |
| --- | --- |
| `stablecoinchains` | 19 KB |
| `v2/historicalChainTvl/Ethereum` | 118 KB |
| `stablecoins` -- every one there is | 540 KB |
| `overview/fees` | 4.2 MB |
| `protocols` | 8.6 MB |
| `protocol/aave` | 10.2 MB |
| `yields` pools -- 17,210 of them | 11.5 MB |
| `stablecoin/1` -- **one** asset | 20.6 MB |

Two lessons, both of which cost something to learn:

**An API offering one shape for a chart and another for a number is offering a
choice.** `api.llama.fi/protocol/aave` is 10.2 MB; `api.llama.fi/tvl/aave` is
eighteen bytes and answers the same question.

**The specific question can cost far more than the general one.** Asking about
one stablecoin is thirty-eight times more expensive than asking about all 425,
because the single-asset endpoint carries full history. Nobody assumes that
direction, which is exactly why it is written down.

A capability that returns 17,210 rows has not answered anything; it has moved
the problem into the prompt. Trimming happens in code, and what was trimmed is
reported (`totalReported`, `totalDaysAvailable`) rather than quietly dropped.

## Numbers that must not be doubles

A `uint256` balance does not survive `JSON.parse`. `exactNumbers.ts` parses with
a reviver that keeps the original text, so a balance, a supply or a hex quantity
stays exact from the wire to the answer. Anything that could be larger than
2^53 goes through it. Prices and percentages, which are approximate by nature,
do not need to.

## Provenance

Every answer carries where it came from, on the value rather than in a log:

```ts
{ upstreamId, family, origin, fetchedAt, source, ageMs, fellBackFrom }
```

The prompt layer has to be able to say "GeckoTerminal, a minute ago" in the same
breath as the number. A finding whose provenance is in a log file is a finding
the model cannot attribute, and an unattributable finding is one it will state
as its own knowledge.

## What is registered

Thirty-three families, September 2026. Several are one family per chain, because
a chain is what an adapter is configured for and asking "the EVM" is not a
question anything can answer.

A family is what is *asked*, not what is returned. `contract_ethereum` answers
compilation, ABI, deployment, proxy resolution, source ids and metadata; those
are fields of one question, not six families.

| Family | Answers | Sources |
| --- | --- | --- |
| `evm_*` (7 chains) | balances, blocks, receipts, logs | publicnode, the chain's own RPC, drpc, cloudflare |
| `solana_mainnet` | the same, for Solana | Solana's public RPC |
| `bitcoin`, `bitcoin_fees` | addresses, transactions, fee estimates | mempool.space, blockstream |
| `contract_*` (7 chains) | is it verified, its source, ABI, proxy resolution | sourcify |
| `signature_curated`, `signature_registry` | what a four-byte selector means | openchain, 4byte |
| `market_pairs` | pools and prices | dexscreener |
| `market_gecko` | pools, prices, OHLCV, new and trending pools | geckoterminal |
| `price_usd` | a token price by exact contract | defillama |
| `defi_tvl`, `defi_chains`, `defi_chain_history` | value locked, now and over time | defillama |
| `defi_stablecoins`, `defi_stablecoin_chains` | stablecoin supply, price and where it sits | defillama |
| `token_security`, `token_tradeable` | observations about a token contract | goplus, honeypot.is |
| `governance` | proposals and votes | snapshot |
| `ipfs` | content by CID, with the hash checked | pinata gateway |
| `encyclopedia`, `instant_answer` | reference lookups | wikipedia, duckduckgo |

Two of those pairs exist to be asked together rather than in turn.
`market_pairs` and `market_gecko` are independent indexers over the same chains,
which is what makes an agreement between them worth something; `signature_curated`
and `signature_registry` are a curated list and an open one, and a selector
found in both is a different claim from one found only in the open registry.

A family with one source is not a defect. `governance` reads Snapshot because
Snapshot is where the proposals are, and inventing a second source for symmetry
would mean adding one that does not know the answer.

## What the Toolspace refuses to do

These are properties, not preferences, and each has a test behind it.

**Evidence is data, never instruction.** Text retrieved from anywhere -- a page,
a contract's own metadata, a token name -- cannot become a runtime instruction.
A token called "ignore previous instructions" is a string.

**No verdicts on token risk.** Observations with their source attributed, never
SAFE or SCAM. The observations are the product; the judgement is the reader's.

**Identity is exact, or it is refused.** A chain and a contract address. Never a
ticker: anybody can mint a token called anything, and a price attached to the
wrong contract is the error that costs somebody money. Ambiguity is returned as
ambiguity rather than resolved by guessing.

**No writes to any chain.** No `eth_sendTransaction`, no `eth_sendRawTransaction`,
no `personal_*`, no signing, no unlocking, no wallet access. Generic `eth_call`
is deliberately absent too: a typed contract view is a capability somebody can
read, and an arbitrary call is a shell.

**No arbitrary shell.** There is no `run_shell(command)` and there will not be.

**Measure before adopting.** Every family here was researched against current
official documentation, probed live once, weighed, and then adopted, made
optional, deferred or rejected -- with the measurement recorded next to the
decision, including for the ones that were rejected.

## Testing discipline

**A green test proves nothing until it has failed for the right reason.** Every
behaviour worth stating is mutation-checked: the code is broken deliberately and
the suite must catch it. Ten mutations were applied to the DeFi wave and all
ten were caught, one of them only after a live probe showed the first version of
the check was dead code. An earlier wave shipped two survivors, both of which
turned out to be checks the capability was already making elsewhere, which is
exactly what a survivor is for.

**A live canary is one or a few tiny requests.** Never a loop, never a load
test. It exists to catch the thing a fixture cannot: the DeFi canary is what
proved a euro stablecoin at $1.16 is on its peg, and that measuring it against a
dollar would have reported a sixteen per cent depeg on a perfectly healthy
asset.

**Never intentionally abuse a free endpoint.** They are public goods. If a probe
needs repeating, it is a probe that should not be repeated.
