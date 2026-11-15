# Token unlocks and vesting streams

What a token's Streamflow vesting streams say, read from the chain: how much
is still held in unfinished streams, what share of supply that is, the next
scheduled release and what a stream's own schedule releases in the next seven
days. Code: `packages/runtime/src/vestingReader.ts`, capability
`solana.read_vesting_streams`, lines in `packages/prompts/src/vestingLines.ts`,
contract in `packages/shared/src/contracts/tokenUnlocks.ts`.

This document is also the specification Studio builds against (Studio backlog
item 5, locked and vesting supply). Studio reads the chain itself and never
reads an installation's payload for this. The payload below is what an
installation will serve at `GET /api/v1/installation/token-unlocks?chain=solana&address=`
once that endpoint exists. **Nothing serves it today.**

## Scope, stated so a result cannot claim more

* Only **Streamflow** is decoded. Jupiter Lock, Team Finance, Sablier and the
  rest are not read, and a result says so (`otherLockersRead: false`, and the
  line "only Streamflow is read; other lockers are not").
* Only the **twenty largest token accounts** of the mint are looked at. A
  stream held outside them is not seen. `NONE_SEEN` means none among the
  accounts that were read, never that the token has none.
* A date is the end of an account's own schedule. Nothing here says what a
  release does to anything.

## How a stream is found without scanning

`getProgramAccounts` is not an allowed read in core. The search starts from the
mint's holders instead.

1. `getTokenSupply` and `getTokenLargestAccounts` (at most 20 accounts).
2. `getMultipleAccounts` for those token accounts. A Streamflow escrow is a
   token account whose SPL owner field (bytes 32 to 64) is **its own address**,
   and whose mint (bytes 0 to 32) is the mint. Only those are candidates.
3. For each candidate: `getSignaturesForAddress` (up to three pages of 1000),
   take the oldest successful signature, `getTransaction` with `jsonParsed`, and
   collect the accounts named by instructions of the Streamflow program (outer
   and inner), except the escrow itself.
4. `getMultipleAccounts` on those. The stream is the one account that is
   **owned by the Streamflow program**, decodes as a stream, and **names this
   mint at offset 177 and this escrow at offset 209**.

That back-reference is the proof. Deriving the escrow from the stream account
with the documented seeds (`"strm"`, metadata) was tried and is **not** a proof:
two of three live escrows were not derived that way. Do not use it.

A candidate that no stream names back is **unrecognized**: counted as
`unrecognizedLockAccounts`, never as locked. A history longer than the pages
read, or a creation transaction without a Streamflow instruction, is the same.

Ceilings: at most 20 accounts per read, a deadline that stops starting new
streams (the rest are `notRead`, and totals are then a lower bound), two failed
streams in a row stop the read. Cached for one hour; a failed read is not
repeated for 30 seconds. The escrow to creation-accounts mapping is immutable
and cached for the life of the process.

## The stream account

1104 bytes, owned by `strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m`. All integers
are little endian u64. Offsets checked against live accounts on 2026-11-15.

| Field | Offset |
| :- | :- |
| created_at | 9 |
| withdrawn_amount | 17 |
| canceled_at (0 when never cancelled) | 25 |
| end_time (unix seconds) | 33 |
| mint (32 bytes) | 177 |
| escrow_tokens (32 bytes) | 209 |
| start_time | 409 |
| net_amount_deposited | 417 |
| period (seconds) | 425 |
| amount_per_period | 433 |
| cliff (unix seconds, 0 when none) | 441 |
| cliff_amount | 449 |

Times outside 2001 to 2286 are refused. The sender and the recipient are not
decoded and are never carried anywhere.

## Schedule

`cliffAt = max(cliff > 0 ? cliff : start, start)`.

`vestedAt(t)`: unreadable (`null`) unless `period > 0`, `net > 0`,
`cliff_amount <= net` and `start <= end`. Otherwise `net` when `t >= end`,
`0` before `cliffAt`, else `min(net, cliff_amount + floor((t - cliffAt) / period) * amount_per_period)`.

`nextRelease(t)`: the first moment after `t` at which `vestedAt` rises, at most
`end`, with the amount it rises by. Before `cliffAt` that is `cliffAt` when
`cliff_amount > 0`, else `cliffAt + period`.

State: `CANCELED` when `canceled_at > 0`, else `ENDED` when `end <= now`, else
`LOCKED`. Only `LOCKED` streams count as held. A stream that ended is "ended",
not locked.

A stream past its cliff that releases more often than hourly (`period < 3600`
and `amount_per_period > 0`) is **continuous**: it has no single next date, so
`releasingNow` is true and `nextUnlockAt` ignores it.

* `totalLockedAmount`: sum of what the escrows of `LOCKED` streams hold, from the
  mint's own holder list. Null when no `LOCKED` stream was seen.
* `supplyPctLocked`: that over the mint's supply, two places, rounded down.
* `nextUnlockAt` and `nextUnlockAmount`: the soonest `nextRelease` among
  non-continuous `LOCKED` streams, amounts summed where streams share a time.
* `unlockingNext7DaysAmount`: for each `LOCKED` stream, `vestedAt(now + 7d) -
  vestedAt(now)` capped at what it holds, summed. **Null when any LOCKED
  stream's schedule is unreadable**, never a partial sum.
* `lastUnlockAt`: the latest `end_time` among `LOCKED` streams.
* `noScheduledRelease`: true when no `LOCKED` stream was seen. The line is
  "no scheduled release date on record".

## Payload

`TokenUnlocksPayload` in `@xbam/shared/contracts`, every object `.strict()`.
Amounts are exact integer strings in base units. Times are UTC ISO 8601.
`null` is "not read", never zero. A failed read is
`{ protocol, chain, address, status: 'UNAVAILABLE', reason }` and nothing else:
Studio shows "unavailable", never "0% locked".

```json
{
  "protocol": 1, "chain": "solana", "address": "<mint>",
  "status": "FOUND",
  "decimals": 6, "supply": "1000000000000000",
  "totalLockedAmount": "250000000000000", "supplyPctLocked": 25,
  "nextUnlockAt": "2026-11-18T12:00:00.000Z", "nextUnlockAmount": "49999999999999",
  "unlockingNext7DaysAmount": "50000000000000",
  "releasingNow": false, "lastUnlockAt": "2027-09-21T12:00:00.000Z",
  "noScheduledRelease": false,
  "endedStreams": 1, "unrecognizedLockAccounts": 0, "notRead": 0, "accountsRead": 5,
  "streams": [
    { "state": "LOCKED", "startAt": "...", "endAt": "...", "cliffAt": "...",
      "heldAmount": "...", "sharePct": 5, "scheduleReadable": true,
      "nextReleaseAt": "...", "nextReleaseAmount": "..." }
  ],
  "otherLockersRead": false, "source": "streamflow",
  "slot": 123456, "readAt": "...", "statement": "..."
}
```

No stream account, escrow, sender or recipient address is in the payload, and a
test fails if one appears. `endedStreams` counts `ENDED` and `CANCELED`; each
stream's `state` says which.

## Wording

Fixed template (`renderVestingLines`), no adjectives. Never "dump", "unlock
dump", "sell pressure", "bearish", "insider unlock", and none of the verdict
words (safe, rug, scam, buy, sell, bullish, avoid, smart money). A test scans
every rendered scenario and the source of the template.

## Fixtures for Studio parity

`tests/fixtures/tokenUnlocks/*.json`, each `{ snapshot, expected }`. The
snapshot is a fixed cluster (supply, largest accounts, account bytes in base64,
signatures, the creation transaction) with a fixed clock of 2026-11-15 12:00
UTC; `expected` is the payload. `tests/support/vestingFixtures.ts` builds them
and a test fails when a stored file differs from what the builder makes.
Every address is a hash of a label: no real holder, sender or recipient is in
them. Regenerate with `WRITE_VESTING_FIXTURES=1 npx vitest run tests/unit/vestingReader.test.ts`.

| Fixture | What it holds |
| :- | :- |
| `streamflowMixed` | a linear schedule with a cliff, a lock until one date, a stream that ended, a wallet and a pool account |
| `noneSeen` | no stream among the largest accounts: no zero, no percentage |
| `unrecognizedLock` | a self-owned token account whose creation names no stream: unrecognized, counted nowhere |

A fixture proves a reader agrees with the bytes and the rules above. It cannot
prove Streamflow still writes them: check a live stream before relying on it.

## Not covered

EVM vesting contracts (Sablier, OpenZeppelin), Jupiter Lock, Team Finance,
streams held outside the twenty largest accounts, and any claim about price.
The evidence card does not carry these lines yet: its renderer is being changed
by other open work, and the lines are a separate template ready to join it.
