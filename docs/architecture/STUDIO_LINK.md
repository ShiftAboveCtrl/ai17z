# AI17Z Studio, from inside AI17Z

How an installation links to AI17Z Studio, what that lets it do, and what it
never does. `packages/runtime/src/studioLink.ts` is the implementation,
`apps/api/src/routes/studio.ts` is how an owner reaches it, and the Studio tab
on the Plugins screen is where they do.

Linking is optional. Nothing else in AI17Z depends on it, and an installation
that never links works exactly as it did.

## Direction and content

Only the installation starts a conversation, always outbound. Studio has no
address for an installation and never connects to one.

| Sent to Studio | Never sent |
| --- | --- |
| A public key (P-256 JWK) | Agents, memories, prompts, conversations |
| A name the owner can change: "AI17Z on Windows" | Provider keys, the master key |
| Platform, AI17Z version, instance label | X sessions, cookies, Chrome profiles |
| DPoP proofs and tokens Studio issued | Telegram credentials, files, anything an agent thought |

There is no code path in the connector that reads any of the right-hand
column, which is the property that matters: nothing has to remember not to
send it.

## Identity

The installation's identity is a key pair made when it links. The private
half is sealed under the master key (`studio.installation.key`) and never
leaves the machine; Studio stores the public half and its RFC 7638
thumbprint. Every request carries a DPoP proof (RFC 9449) from that key, and
every token Studio issues is bound to it, so a token copied off the machine is
useless and there is no bearer secret to steal.

A fresh key is made for every link. Studio refuses a key it has seen, so a key
never outlives the link it was made for.

## Linking

RFC 8628 device authorization, with the public key registered in the first
step:

1. `beginStudioLink` asks Studio for a code. The owner sees an eight-letter
   code and a link.
2. The owner signs in on Studio, types the code on `/connect`, sees what is
   asking, and approves or denies. If this replaces an installation they had
   before, **they** choose which one there. The installation's own suggestion
   is only a suggestion, and one naming somebody else's installation is never
   repeated to anybody.
3. `pollStudioLink` redeems the code with a proof from the registered key,
   pins Studio's lease keys and syncs. The worker polls a pending link too, so
   approving on a phone and closing the laptop still finishes.

The code is a pairing secret for one link and nothing afterwards.

## Entitlements are a signed lease

`GET /api/v1/installation/entitlements` answers with a list and a lease: the
same answer as an ES256 JWS signed with a key only Studio holds, bound to this
installation's key (`cnf.jkt`), naming this installation (`sub`), and expiring
when the sync does (`exp`, 72 hours).

The keys that verify it are fetched from `/api/v1/lease-keys` when the link
is made and pinned, sealed under the master key. A later answer can add a key
for a rotation and can never replace the material of a kid already pinned.
`verifyEs256` accepts ES256 only and refuses a JWS that names its own key.

A marketplace Plugin runs only while a lease that verifies says this
installation may use **exactly** the installed version, manifest hash and
capability. It is checked in readiness and again at the start of every run,
so an entitlement revoked while a job waited stops that job.

Which Plugins are marketplace Plugins:

- any the registry listed as `entitled` when it was installed
  (`installed_plugins.requires_entitlement`), which Studio says of all of them;
- any whose capabilities reach Studio's host, however it was installed.

A Plugin from a registry that never said so is untouched.

### What this does and does not stop

It stops editing a database row: a forged or edited lease does not verify, a
swapped pinned key does not verify Studio's signature, and an expired lease is
expired. It does **not** stop somebody who changes AI17Z's code, which is open
source and runs on their machine. That is why Studio sells a paid Plugin only
through its hosted gateway, where Studio itself decides every call, and
refuses to sell any other kind.

### Offline

Studio being unreachable never stops AI17Z. The last lease keeps working until
it expires; after that marketplace Plugins pause, say so, and nothing else is
affected.

## The hosted gateway

A capability whose URL is on the linked Studio is called with a short-lived
tool token for that one capability (`POST /api/v1/tool-authorizations`) and a
DPoP proof for that one request. `studioGatewayHeaders` refuses to build them
for any address that is not the linked Studio's `/api/gateway/v1/`, so those
credentials cannot travel anywhere else.

## Reset, relink and revocation

- **Disconnect** tells Studio first (`POST /api/v1/installation/revoke`, with
  the installation's own proof), which releases its seats for the next link to
  carry. If Studio cannot be reached the local link is still removed and the
  screen says Studio was not told.
- **Relink** suggests the previous installation. On approval Studio carries
  the seats that were held, or released only because the installation was
  revoked, never past a seat limit and never one the owner took away on
  purpose. Purchases and entitlements belong to the account and never move.
- **Revoked on the website**: the next conversation gets `invalid_grant` or a
  second 401, the link is marked revoked, the lease is dropped at once, and
  marketplace Plugins stop.

## Purchases, completed here

A checkout on Studio names the installation that will finish it. That
installation lists the exact terms over DPoP, and the owner pays from the
Studio tab with their own wallet, found through EIP-6963.

`MARKETPLACE_PLUGIN_PURCHASE` (`packages/shared/src/contracts/marketplacePurchase.ts`)
is the whole of what can be signed: an ERC-20 `transfer(recipient, amount)` of
$AI17Z on Robinhood Chain, to the pinned token, for a whole number of base
units. It refuses another chain, token or decimals whatever Studio says, and
there is no approve, transferFrom, arbitrary calldata or native value. The
page checks the prepared transaction again with `isExactPurchaseTransaction`
before the wallet sees it.

It is owner control plane only. It is not a capability, no model can reach
it, and `tests/unit/noWalletCapabilities.test.ts` fails if a payment-shaped
capability is registered or the builder is imported by the capability layer.
No private key of any wallet is ever held.

`studio_purchase_ledger` (migration 0093) records what the wallet was asked to
sign. A purchase is prepared once, under a row lock; a second press is told
the wallet was already asked. Only a transaction hash or the owner saying
nothing was sent moves it on, and a purchase with a known transaction is never
prepared again. The wallet declining (EIP-1193 code 4001) is the owner saying
so. The terms are frozen by a trigger.

Reporting a hash grants nothing. Studio reads the chain itself and confirms
only a transfer matching every term, at finality.

## Development Studio

`AI17Z_STUDIO_UNSAFE_DEV_ORIGIN` points an installation at a Studio over http
or on a private network, for development and for proving an installation end
to end before Studio is deployed. It is read only from the environment, and the
Studio tab says so in a warning whenever it is set. Without it, the Studio
address is the registry address, which must be https.

## Proof

- `tests/unit/studioLease.test.ts`: proofs, lease verification branches, the
  entitlement decision.
- `tests/unit/marketplacePurchase.test.ts`: the transfer builder and its
  refusals.
- `tests/integration/studioLink.test.ts`: the gate inside a registered
  capability, a lease edited in the database, a swapped key, the offline
  horizon, gateway credentials, and the ledger's races.
- `tests/integration/studioContract.test.ts`, run by
  `node tools/studio-contract.mts <studio dir>`: this connector against the
  real website, running, with nothing mocked on either side.
