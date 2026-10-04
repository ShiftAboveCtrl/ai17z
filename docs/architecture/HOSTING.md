# Hosted runtimes

**Status: in development. Not released, not enabled, and no customer runtime
has ever been placed.** This document describes what is built, what is designed
and refused, and what has not been measured. It is written down now because the
decisions are the hard part and a decision nobody can read is a decision
somebody will undo.

There is one AI17Z. Hosted mode is a vocabulary, a scheduler, a gateway and a
bounded runtime; it is not a cloud fork, a second memory system or a different
product. Local mode is the default and nothing here is required to run AI17Z on
your own machine.

## What a customer actually buys

Capacity for a runtime: a persistent, isolated AI17Z that keeps running when
their laptop is shut. Not a chat session, not a model subscription, and not an
X bot. The agent inside it is the same agent the local product builds, with the
same persona, memory, relationships, beliefs, deliberation and policy, because
it is the same code.

So the properties a hosted runtime must have are the properties the local one
already has, plus the ones that only matter once somebody else is holding the
machine: isolation from other customers, a key only this runtime can use, an
expiry that is not a deletion, and a way out.

## Isolation: what the boundary actually is

**A container is not the boundary between two customers**, and AI17Z does not
describe one as though it were. Firecracker's own design document is the reason
this is written as a rule rather than a preference: it states that the first
layer of isolation is KVM, and that it is built so a single host can run
workloads belonging to different customers. A guest with its own kernel is the
boundary. A shared kernel with namespaces is a resource arrangement.

Two things follow, and the second is the one that gets forgotten.

`jailer` is mandatory, not recommended. The same document treats the jailer as
part of the production configuration rather than as hardening somebody may add
later.

**Firecracker filters no guest network traffic at all.** It says so plainly and
says the filtering belongs at the host level. So egress control is work AI17Z
owes rather than something it inherits by choosing a hypervisor.
`EGRESS_DENIED_CIDRS` in `packages/shared/src/contracts/hosting.ts` is that
list, and the first entry is `169.254.169.254/32`, the cloud metadata address,
which is the single most valuable thing a compromised guest can reach. The
denials are infrastructure rather than content: a hosted agent researching the
open web is the product working. Nothing in that list is about geography and
nothing in it exists to get past anybody else's security controls.

### What customers must never share

Stated as a list because the failure is always the same shape, which is one
column standing in for a boundary:

- a Postgres database
- a runtime master key
- a wallet secret store
- a Chrome profile or browser process
- a filesystem namespace
- a runtime API credential
- a memory store

"Separated by an `account_id` column" is not isolation between customers. It is
the thing a single SQL mistake defeats, and it is how multi-tenant systems leak.

## Provider tiers, and why only one is enabled

`PROVIDER_TIERS` has three entries and `PROVIDER_TIERS_ENABLED` has one.

| Tier | What it means | Enabled |
| --- | --- | --- |
| `FIRST_PARTY_TRUSTED` | Hardware the operator controls | Yes |
| `VERIFIED_PROVIDER` | A named operator under agreement, no attested key release | No |
| `CONFIDENTIAL_COMPUTE` | A measured guest, key released only against attestation | No |

`PROVIDER_TIERS_ENABLED` is written out rather than derived, so adding a tier
to the vocabulary cannot quietly make it schedulable. `TIER_REQUIREMENTS` keeps
what each one would have to prove as data rather than prose, so the readiness
screen and the scheduler answer from the same place and "why can I not use my
own machine yet" has a specific answer.

For the confidential tier those requirements are deliberately exact, because
confidential compute is easy to claim and the claim is worth nothing without
them. An SEV-SNP attestation report carries a launch measurement and a 64-bit
guest policy that includes a DEBUG bit; a report whose policy permits debug
describes a guest somebody can attach to, and accepting one would mean the
measurement proved nothing. TDX reaches the equivalent through
`TDG.MR.REPORT`. Either way the requirement is the same: verify against the
vendor root of trust, match a measurement for an image AI17Z published and can
reproduce, refuse a policy permitting debug, and release the runtime key only
against a report that passed all three.

Until that exists and has been exercised, **hosting is first-party hardware and
is never described as host-blind.** `custodyFor` returns `HOST_SEALED` for the
only enabled tier, and `CUSTODY_GUARANTEES` records in one place that a host
operator with root could in principle reach a host-sealed key. Saying so is the
point: a guarantee nobody has proved is a marketing sentence, and a customer
deciding what to put in a hosted runtime needs the real answer.

## Keys

**Every tenant runtime gets its own master key.** One global encryption key
across hosted customers would mean one compromise is every compromise, and it
is the sort of shortcut that is invisible until it is catastrophic.
`newRuntimeMasterKey` mints 32 bytes per runtime and `SECRET_PLACEMENT_RULES`
names every place a key may not appear.

`carriesSecret` walks a payload looking for key-shaped values, because the
rules above are only as good as something that checks them. It is used on
anything crossing a boundary: a control-plane response, a host assignment, an
export, an audit row.

A key is never printed, never logged, never returned by an API, never put in a
browser task's params, and never carried in an agent package. The existing
local discipline is the same and for the same reason: `redact()` in
`packages/shared/src/logger.ts` blanks anything key-shaped, and provider
credentials are readable only through the one accessor that decrypts them.

## Placement

`packages/runtime/src/hostScheduler.ts`. A runtime class is a reservation
subtracted from a host before anything starts, so a machine cannot be promised
twice.

`HOST_HEADROOM` keeps 20% of memory and CPU and 10% of disk unallocated,
because a host at 100% of its own measurement is a host with no room to recover
anything. `HEARTBEAT_STALE_AFTER_SEC` is 90, the same bound the local browser
heartbeat already uses, and for the same reason: anything older than that is
treated as "not running" whatever the last snapshot said.

Placement is **sticky**. A runtime that has a host keeps it, because migrating
is a restore and a restore is the risky operation.

**A host that stops answering does not have its runtimes reassigned.**
`strandRuntimesOf` marks them `HOST_UNREACHABLE` and stops. Reassigning on its
own would mean starting a second copy of a runtime whose first copy may be
alive and holding a signed-in browser, and two copies of one agent is worse
than one that is unavailable.

When nothing can be placed, the refusal names every host and why each one
refused, because "no capacity" is the least useful thing an operator can be
told.

**No slot count is asserted anywhere in this repository without being measured
on the hardware it is claimed for.** There is no "supports N agents" number,
and `tools/hosted-lab.mts` exists to produce one honestly rather than to
confirm one somebody wrote first.

## The gateway: a client never names its own runtime

`packages/runtime/src/tenantGateway.ts`.

A hosted client authenticates with a grant and gets back an assignment. It does
not send a runtime id, and there is no parameter it could send one in. This is
the whole of the authorisation design, because every multi-tenant escape begins
with a client naming a resource and a server checking afterwards whether it
should have.

`authoriseGatewayRequest` answers `NO_SUCH_GRANT` identically for a grant that
is unknown, expired, revoked or spent. Four distinguishable answers is an
oracle for probing which grants exist.

Grants are stored as a hash. `issueGrant` returns the token exactly once, at
creation, and nothing can read it back.

`ASSIGNMENT_FORBIDDEN_FIELDS` pins what an assignment may not carry: no host
address, no key material, no other tenant's anything.

## Expiry is not deletion

`packages/runtime/src/hostedLifecycle.ts`. A hosted agent is somebody's durable
thing, and the worst available answer to a lapsed subscription is to destroy it.

```
ACTIVE -> GRACE (7 days, still acting)
      -> SUSPENDED (30 days, acting stopped, state kept)
      -> RETAINED (60 days, not running, state kept)
      -> DELETION_SCHEDULED (notice given, 14 days)
```

**`lifecycleAction` never returns a deletion.** The furthest it goes is
scheduling one, with notice, and deleting is a separate act somebody takes. A
function that could return "delete this customer's agent" is a function one bug
away from doing it.

`spendPermissionFor` is the one answer to whether a runtime may do anything
that costs money or touches the world. Autonomy, browsing, trading and model
spend are the same question, asked once, so a suspension cannot be enforced in
four places and forgotten in a fifth. `runtimeMayAct` in the contract is its
counterpart for callers that only need the boolean.

`ownerOptionsFor` says what the owner can still do from each state, because a
suspended runtime they cannot export is a hostage.

## The way out

`packages/runtime/src/hostedExport.ts`. The same portable agent document the
local product already writes: `.ai17z-agent`, JSON, every schema `.strict()`,
nowhere to put anything executable.

SHARE is configuration. MOVE adds memories and the picture.
`HOSTED_EXPORT_OMITS` names what is deliberately absent and why, and
relationships and stances remain absent for the reason they always were: both
rebuild themselves from what gets published, so carrying them would put a list
of everybody the agent has spoken to into a file that gets emailed around.

A runtime's master key is not in an export. Neither are provider credentials,
sealed plugin secrets or a browser profile. `mayExport` refuses with a named
reason rather than producing a partial document, and `moveWarnings` says what
will not come with it, before the file is written rather than after.

Export works from `SUSPENDED` and `RETAINED`. It has to: those are exactly the
states an owner is in when they want to leave.

## Backups

`packages/runtime/src/runtimeBackup.ts`. A backup is sealed under the runtime's
own key, which means two things at once: a host operator holding the ciphertext
holds nothing useful, and a backup is worthless without the key, so the key's
custody is the backup's custody.

`verifyBackup` exists because an unverified backup is a belief. It re-reads
what was stored and compares a hash. `backupReadiness` reports honestly that no
store is registered rather than claiming a backup happened, because the local
product already learned that "ready" did not prove a worker was running.

`mayRecoverElsewhere` is the guarded one. Restoring a runtime onto a different
host while the original may be alive is the two-copies problem again, so it
refuses unless the original is known not to be running. `RESTORE_CAVEATS` says
what does not survive a restore, in particular that a browser profile's
signed-in session may not, because Chrome on Windows ties cookies to its own
identity and a restored profile can arrive logged out.

## Watching the infrastructure without reading the customers

`packages/runtime/src/hostObservability.ts`.

A health record carries counts and states and nothing else.
`HEALTH_ALLOWED_FIELDS` is an **allowlist**, checked as one, because the
failure mode is somebody adding a field rather than somebody adding one whose
name was predicted. The pressure to include "just the last error message" or
"just the current page title" is constant and each one is a small window into
somebody's work. `isCleanHealth` refuses prose even inside an allowed field,
and refuses anything key-shaped.

`judgeHealth` answers what an operator should look at first. The distinction it
exists for is **busy against wedged**: a long queue on a runtime that is still
reporting is work, and the same queue on one that has gone quiet is a failure,
and getting that backwards costs an operator an hour. Silence is judged before
anything else, because every other number is from the past. Repeated restarts
are reported as a crash loop rather than as recovery, since restarting
repeatedly recovers nothing and looks like it might. Absent is not zero: a
count nobody could read does not degrade a runtime.

`OPERATOR_DENIED_BY_DEFAULT` names what an operator may not reach: memory
contents, owner chat, prompts, browser frames, wallet keys, backup plaintext.
The test asserts that list shares no vocabulary with the health allowlist,
because two lists that overlap mean observability is quietly a window.

Reaching into a tenant at all is break-glass: a written reason, an expiry, and
a record of whether the owner approved. Four hours is the ceiling, because a
week-long break-glass is not break-glass, it is a key.

## Browser takeover

`packages/runtime/src/browserTakeover.ts` and
`packages/browser/src/screencast.ts`.

A hosted runtime drives a real browser the owner cannot see, which is a problem
the local product does not have: locally the owner can simply look at the
window. So frames are streamed, over CDP's own `Page.startScreencast`, bounded
by `STREAM_BOUNDS`.

The state machine's one interesting property is that `agentMayWrite` is true in
`OWNER_REQUESTED` while `agentMayBegin` is false. Finishing the keystroke it is
part way through is safe; starting a new operation while the owner is reaching
for the keyboard is not.

`WAITING_FOR_HUMAN` has no agent-raisable transition out of it. This is the
hosted form of a rule AI17Z already holds absolutely: **AI17Z never answers a
security challenge.** A CAPTCHA, a second factor, an emailed or texted code, a
hardware key, a confirmation of an unusual login or a locked account stops the
agent, leaves the window alone, and stops reading the page. There is no setting
for it, no code path around it, and hosting does not create one. There is no
solver and no bypass.

**Nor is there a hosted form asking a customer for their X username, password
and 2FA code.** `SENSITIVE_INPUT_RULES` says what the stream must not be
described as, and deliberately excludes "end-to-end" and "zero-knowledge",
because a frame rendered on a host and sent through a control plane is neither.

## Trading

`packages/shared/src/contracts/trading.ts`,
`packages/runtime/src/tradingRisk.ts`, `tradingGate.ts`, `marketData.ts`,
`paperTrading.ts`, migration `0104_agent_trading.sql`.

Also in development, also not enabled, and the boundary matters more than the
feature.

**No generic transaction capability is ever exposed to a model.** Not `send`,
`transfer`, `approve`, `sign`, `signMessage`, `signTypedData`, `contractCall`,
raw calldata, an arbitrary destination or an arbitrary transaction. A model can
propose a `TradeIntent` against a `TradeMandate` the owner wrote, and that is
the entire surface. The existing local wallet already holds this line, and
`tests/unit/noWalletCapabilities.test.ts` fails if a wallet capability appears.

Defaults are `PAPER` mode and `OWNER_APPROVES_EACH`. `judgeTrade` is pure,
calls no model, and accumulates every reason rather than short-circuiting on
the first, because an owner declining a trade wants all of why.

`TRADE_NO_RESIGN_STATUSES` is the duplicate-spend guard: once an intent is
`SIGNED`, `SUBMITTED`, `UNKNOWN` or `CONFIRMED` it can never be signed again,
and `UNKNOWN` is in that list on purpose. A broadcast whose outcome is unknown
is the exact case where retrying creates a second real transaction.

Amounts are integer base units, never floats, in the one place the local wallet
already defines them.

**No funded transaction, no funded brokerage order and no unattended
live-mainnet autonomous trading is authorised, and none has been performed.**
Market reads keep `NOT_LISTED` and `UNAVAILABLE` apart, because a token that
does not exist and a feed that did not answer are different things to tell
somebody, and treating the second as the first is how a bad price becomes a
trade.

## What has not been done

Written here rather than discovered later:

- No microVM has been built or booted. `/dev/kvm` exists on the development
  machine; nothing has run in a guest.
- No capacity has been measured, so no capacity is claimed.
- Backup and restore are implemented and tested against a fake store. Neither
  has been executed against a real one.
- No load or chaos measurement has been run.
- Venue adapters are not in this repository.
- Nothing has been pushed. Phase 1 releases as a coherent whole or not at all.
