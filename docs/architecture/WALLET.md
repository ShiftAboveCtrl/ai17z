# An agent's own wallet

Code: `packages/shared/src/contracts/wallet.ts` (vocabulary),
`packages/runtime/src/walletCore.ts` (rules), `walletCapabilities.ts` (the four
reads), `apps/api/src/routes/wallets.ts` (the owner's routes). Migration 0103.

## The split

AI17Z holds the rules and none of the chain code. Generating a key, deriving an
address, reading a node, simulating, signing and broadcasting are a
`WalletAdapter`, supplied by a first-party wallet Plugin the owner installs on
their own machine and pins by hash:

```
AI17Z_WALLET_ADAPTER_DIR=<absolute path to the directory the adapter was installed in>
AI17Z_WALLET_ADAPTER_SHA256=<the sha256 of index.mjs in it>
```

In an installed copy the API and the jobs worker run in containers, so
`docker-compose.yml` mounts that directory read-only at
`/opt/ai17z-wallet-adapter` and points them at `index.mjs` there; a native
worker reads the same directory directly. Unset, the mount is an empty named
volume, so nothing is created beside the program. `AI17Z_WALLET_ADAPTER`, the
module's own path, still works for a process outside Docker.

The file is hashed before it is imported and refused on any mismatch, on a
missing hash, or if it does not export an adapter. Without one, every wallet
capability reports itself unavailable and nothing else changes. This is not the
Plugin marketplace, where a Plugin declares and never ships code.

## Networks

Ethereum (`eip155:1`), BNB Smart Chain (`eip155:56`), Robinhood Chain
(`eip155:4663`) and Solana mainnet (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`).
Each was taken from the network's own documentation and read back from a live
node on 2026-09-30. All four are mainnets.

## What an agent can do: read

`wallet.address`, `wallet.balances`, `wallet.network_status`,
`wallet.recent_activity`. Reads only, DISABLED until the owner enables the
Wallet pack, and owner-only in this version. There is no `wallet.send`,
`transfer`, `approve`, `sign`, `sign_message`, `call_contract` or
`send_calldata`, and `tests/unit/noWalletCapabilities.test.ts` fails if one
appears or if the capability layer reaches the submit path.

## How value moves: only this way

1. **Draft.** The owner writes a transaction: `NATIVE_TRANSFER` or
   `TOKEN_TRANSFER`, typed, strict, base units as digits. No calldata, no
   approval of a spender, no message signing. An idempotency key makes a
   second click find the first draft.
2. **Simulate.** The adapter asks the chain what would happen and pins what it
   would sign: nonce and fee caps for EVM, the blockhash window for Solana.
3. **Approve.** The owner approves the SHA-256 digest of exactly that:
   sender, network, recipient, amount, token, maximum fee and pinned values.
   A different digest approves nothing. An approval lasts ten minutes.
4. **Submit.** `APPROVED -> SUBMITTING` is a single-row claim, so two presses
   sign once. The secret is opened, used and zeroed; the hash is recorded
   before the network sees anything. Then `SUBMITTED`, or `UNKNOWN` if the
   broadcast failed in a way that may still have landed.
5. **Reconcile.** A submitted or unknown transaction is checked by its hash.
   Nothing moves an intent back into a state it could be signed from, so there
   is no retry, blind or otherwise.

No mainnet transaction happens without the owner approving that exact
transaction. There is no autonomous path, and no setting creates one.

## A Solana swap

`SOLANA_SWAP` is the third kind, and the only one that is not a transfer:
from the wallet to itself, two exact mints, an exact amount in, and the least
the owner accepts out. The rules are `packages/runtime/src/solanaSwap.ts`; the
chain code stays in the adapter.

- **Jupiter's own router only.** The adapter takes the swap's instructions from
  Swap API V2's router path (`/swap/v2/build`, Metis) and composes the
  transaction. The meta-aggregator (`/order`) was measured and is not used:
  excluding the other routers there leaves no quote, and their programs are
  not ones this code can vouch for.
- **The adapter pins the transaction it simulated**: its bytes, the SHA-256 of
  its message, the route's promised floor, what the simulation delivered, and
  how much SOL left the wallet. Core adds the time it was simulated. All of it
  is in the digest, so the owner approves one exact message.
- **Refused before the owner is asked**: a fee payer other than the wallet,
  a second signer, any top-level program outside `SWAP_PROGRAMS` (Jupiter's
  program, the token programs, the associated token account program, System
  and Compute Budget, read from a live `/build` answer), a router other than
  Metis, a promised or simulated amount below the owner's minimum, and SOL
  leaving the wallet beyond the swap, its fee and 0.01 SOL of account rent.
- **A minute, not ten.** A Solana transaction names a recent blockhash and the
  network refuses it after about a minute and a half. A swap simulated more
  than `SWAP_VALID_MS` ago is neither approved nor sent; it is simulated again.
- **Checked after signing, before sending.** `signedMatchesApproved` reads the
  signed bytes back. Anything but the approved message under exactly one real
  signature ends the intent `FAILED` with nothing broadcast.

What a swap would get is also a read anyone may make: `market.swap_quote`
asks the same API with no wallet named, so its answer carries no transaction
and cannot be signed.

## Keys, backup and recovery

- The secret is generated by the adapter and sealed with AES-256-GCM under
  `AI17Z_MASTER_KEY` before `createWallet` returns, exactly like a provider API
  key. It is never in an API response, a log, an audit row, a trace, a browser
  task, an agent package or a model prompt, and no route reveals it.
- **Recovery is the database plus the master key.** A database backup holds
  the sealed secret; the master key opens it. Losing the master key loses
  every wallet, which is why the owner is asked to confirm they hold a backup
  of both (`POST /api/wallets/:id/backed-up`), and why the screen says so
  before anything is sent to a wallet.
- **A Solana wallet can be restored from a recovery phrase** the owner holds
  (`POST /api/agents/:id/wallets/restore`): BIP-39, twelve or twenty-four
  words, derived at `m/44'/501'/0'/0'` with SLIP-0010, which is what Phantom and
  Solflare use. The owner states the address they expect, and a phrase that
  derives a different one is refused rather than creating a wallet nobody
  recognises. The phrase is used once, to derive the key, and is sealed nowhere,
  logged nowhere and shown to no model; the wallet records `origin: PHRASE`. The
  derivation is pinned against published vectors in
  `tests/unit/walletRecovery.test.ts`, and the integration test scans the whole
  database and the process output for the phrase afterwards.
- No plaintext export in this version. Moving an agent to another machine
  moves the installation; `.ai17z-agent` packages never carry a wallet.
- A wallet is retired, never deleted, because it may still hold something.
