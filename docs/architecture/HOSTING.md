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

They subscribe, a private runtime is provisioned, and they open AI17Z in a
browser. No Docker, no terminal, no server of their own, no local install, no
host setup. They connect X if they want to, install Plugins if they want to,
and the hosted runtime is the canonical AI17Z rather than a cloud edition of
it.

So the properties a hosted runtime must have are the properties the local one
already has, plus the ones that only matter once somebody else is holding the
machine: isolation from other customers, a key only this runtime can use, an
expiry that is not a deletion, and a way out.

## V1 is paid confidential hosting, not community compute

The host/provider abstraction stays, so somebody else's hardware can become
eligible later. **It is not a V1 dependency and no third-party machine holds a
secret-bearing customer agent.** A product where a stranger installs a daemon
and receives other people's provider keys and X sessions is not something to
build, and building the abstraction is not the same as enabling it.

What would make third-party compute eligible is the whole of
[docs/architecture/CONFIDENTIAL_COMPUTE.md](CONFIDENTIAL_COMPUTE.md):
confidential isolation, remote attestation, a verified measurement,
attestation-gated key release, rollback protection, revocation and a host
network policy, each implemented and each proved. Until then production
secret-bearing workloads run on infrastructure that satisfies the trust policy,
and the public wording never says otherwise.

## The security property, stated so it can be checked

**A host operator must not be able to read or silently alter a customer's
durable AI17Z state, secrets, browser session, wallet material or agent
configuration.**

That is confidentiality and integrity. It is not availability, and the two are
separated everywhere in this document because conflating them is how a security
claim becomes untrue. A host operator can always power a machine off, pull its
network or delete a disk, and **nothing here promises immunity from denial of
service**.

What it has to prevent is that operator being able to read tenant plaintext
memory, read the tenant database in the clear, read provider keys or wallet
keys or X cookies, substitute a modified runtime and still receive the
decryption keys, enable debug and still receive them, replay a stale
attestation, forge an owner-authorised financial action, or roll durable state
back to an older version without the owner noticing.

**A microVM does not deliver that.** KVM protects a tenant from its
neighbours, which the Firecracker lab below proves against a real kernel and a
real guest. It does nothing about the administrator controlling the
hypervisor, who can read guest memory and attach a debugger. So production
hosted AI17Z requires hardware-backed confidential compute, the Firecracker
lab stays a development and isolation lab, and it is never described as
protection from the host.

## Isolation: what the boundary actually is

**A container is not the boundary between two customers**, and AI17Z does not
describe one as though it were. Firecracker's own design document is the reason
this is written as a rule rather than a preference: it states that the first
layer of isolation is KVM, and that it is built so a single host can run
workloads belonging to different customers. A guest with its own kernel is the
boundary. A shared kernel with namespaces is a resource arrangement.

`packages/runtime/src/microVm.ts` is the guest, described before anything
boots it. Nothing in this repository has booted one, so what is there is a
plan, the properties the plan must have, and `guestMatchesPlan`, which
compares what a host reports with what it was asked to run. A plan is not a
running guest, and a host that reports nothing has proved nothing.

`plansShareAnything` checks two plans on one host against the list below.
The read-only root image is deliberately absent from it: a measured image
two tenants both boot is the one thing they are meant to share, and the
single writable disk each gets is what they are not.

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
`packages/runtime/src/hostEgress.ts` turns that list into an ordered plan, a
soundness check on the plan, and `verifyLoadedRuleset`, which reads a ruleset
back off the host. That last one exists because a rule that was generated is
not a rule that is loaded, and a host whose ruleset failed to apply looks
exactly like one where it did until a guest reaches the metadata endpoint.
Denials are checked for both families, because an allowlist that forgets v6 is
not one, and an allow placed above a deny is refused outright: first match
wins, so that mistake is invisible in a diff. A ruleset is searched for each
denial as an address rather than as characters, because `10.0.0.0/8` contains
`0.0.0.0/8`: a substring test passed a host whose unspecified-range rule had
failed to load, on the strength of its private-range rule. `mayConnectTo` is the belt to
that braces, and it delegates to `addressVerdict` in `@xbam/upstream` rather
than judging an address a second way. The
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

**`CONFIDENTIAL_COMPUTE` is the production V1 target**, and it is the only tier
that addresses the security property above. It is not enabled because nothing
has been provisioned, attested or released against real hardware.
`CONFIDENTIAL_PROVIDERS_ENABLED` in
[`confidential.ts`](../../packages/shared/src/contracts/confidential.ts) is
empty for the same reason, and it is written out rather than derived so that
researching a provider cannot enable it.

`FIRST_PARTY_TRUSTED` being the one enabled tier is therefore a statement
about today rather than about the architecture: it is hardware the operator
controls, with the key sealed on the host, which means an operator with root
could in principle reach it. That is the sentence confidential compute exists
to delete, and until it is deleted it is said in full wherever a customer
could read a claim instead.

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

`packages/runtime/src/hostAttestation.ts` is what "not enabled" looks like in
code rather than in a comment. `attestationVerdict` has no path that trusts a
host without a verifier registered against a hardware vendor root, and no
verifier is registered in this repository. It refuses a report it cannot parse
rather than guessing at one, so being wrong about a field position costs a
refusal and never a false approval; it refuses a nonce it did not ask for,
because the nonce is the only thing making a report about now; and it refuses
firmware below the floor rather than warning, because accepting a version with
a known break in it is how a fixed problem comes back. `mayReleaseRuntimeKey`
is the one function that decides whether a customer's key is sent to a
machine, so a tier being enabled and a key being released cannot disagree.

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

## One tenant, one database

`packages/runtime/src/tenantDatabase.ts`. The boundary is Postgres' own: a
database per tenant, a role that can reach exactly that database, and `PUBLIC`
revoked before the tenant is granted anything, because the other order leaves a
window in which the database exists and every role on the server can reach it.

Names are derived from the runtime id rather than read back from a stored
value, for the same reason `resolveProfileDir` derives a browser profile path:
a name written by one machine and read by another is a second, empty thing that
looks exactly like the first. They carry a hash suffix rather than a plain
truncation, because Postgres cuts an identifier at 63 bytes and truncating is
exactly how two long ids become one database.

`observedIsolationProblems` is the half that matters. It compares what the
server reports with what was asked for, because a GRANT that was generated is
not a GRANT that ran, and a provisioning step that half failed leaves a
database whose permissions nobody checked.

A database per tenant is isolation between tenants and not from the server
operator. A superuser reads every database on the server, which is why a
tenant's own secrets are sealed under its own key rather than left in the clear
in its own database.

## Bringing one into existence

`packages/runtime/src/tenantProvisioning.ts`. The dangerous state is not
failure, it is half success: a guest booted before its egress rules loaded, a
database reachable by PUBLIC because the revoke did not run, a grant issued
against a runtime that never finished starting. Each of those is
indistinguishable from a working tenant from the control plane's side, because
every individual step returned.

So it is ordered steps with a rollback, and three orderings are checked rather
than remembered. The network is attached before the guest boots, or the guest
is unfiltered for however long the rules take. The key is minted before
anything is sealed under it. Isolation is verified before a grant exists,
because a grant is what makes a runtime reachable and verifying afterwards
means verifying something a customer can already use.

`mayMarkReady` asks the host and the server rather than inferring anything from
the steps having run. Rollback runs newest first, since an undo depends on what
came before it still being there. `stateAfterFailure` returns no state in which
a runtime may act. And `orphanReport` exists for the case nobody wants: a
rollback that itself failed has left something on a host that the control plane
has no record of, and nothing will find it by looking at the control plane.

## Connecting an account

`packages/runtime/src/hostedSignIn.ts`. Locally this is settled: a person signs
in to the real browser window and the session lives in the profile. Hosting
breaks the assumption that rested on, which is that the owner is at the
keyboard, and the obvious replacement is the one thing that must not be built.

Two routes exist. The default is the owner taking the runtime browser through
the takeover stream and typing into the real page themselves, where the
credential lands nowhere. The other is a password the owner stored on their own
runtime, sealed under that runtime's own key, never in the control plane and
never in a shared store. It is off by default, and the interface says what it
buys: an account with two factor authentication on reaches the code step on
every fresh sign-in and still needs a person.

`REFUSED_SIGNIN_ROUTES` is the longer list, and it is written down because
every entry on it is easier than the two above. A central form collecting a
username, a password and a code for every customer. A vault the control plane
can read. Relaying a texted code, which is answering a security challenge
whether it is typed or forwarded. A CAPTCHA solver, paid or otherwise.
Importing a customer's session cookies, which asks somebody to export a bearer
credential and send it somewhere and is the shape of a phishing instruction
whoever sends it. Holding recovery codes, which does not reduce the risk of
holding a password but concentrates it.

**AI17Z never answers a security challenge**, and hosting creates no exception.
`CHALLENGE_STOP` states it in full in that file rather than linking elsewhere,
because somebody reading it is looking for the exception and finding a link is
how a reader concludes there might be one.

## Capacity

`packages/runtime/src/hostedCapacity.ts`, which is the core's half and not a
shop. Nothing in it takes a payment, prices anything or talks to a payment
provider: paying is the owner's act, exactly as it is for a marketplace Plugin.

An entitlement bounds provisioning before a runtime exists rather than being
reconciled afterwards, because a reconciliation that finds an extra runtime has
already given somebody a machine, and taking it back means either a customer
loses an agent they were using or the business absorbs capacity it never sold.
Refusing to start the eleventh is a sentence on a screen.

A suspended runtime still occupies its entitlement, since it still holds a
database, a disk, a key and a backup. Widening takes effect at once; narrowing
only at renewal, because applying a reduction immediately would mean choosing
which of somebody's agents to stop. Being over capacity is reported rather than
enforced, for the same reason. And `lapseEffect` types `deletesAnything` as the
literal `false`, so a future change that wanted a lapse to delete something
would not typecheck.

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

When the preferred host is refused the runtime moves, and **the answer says it
moved and why that host was refused**. It used to read identically to a first
placement, and the move is the one event an operator has to see: a tenant
driving a browser that changes machine changes egress address, which is how an
account picks up a security challenge nobody asked for.

**A host that stops answering does not have its runtimes reassigned.**
`strandRuntimesOf` marks them `HOST_UNREACHABLE` and stops. Reassigning on its
own would mean starting a second copy of a runtime whose first copy may be
alive and holding a signed-in browser, and two copies of one agent is worse
than one that is unavailable.

When nothing can be placed, the refusal names every host and why each one
refused, because "no capacity" is the least useful thing an operator can be
told.

**What a host has reserved is a sum, not a count.** A runtime class is a row
(`runtime_classes`, migration 0106) and `host_reservations` adds up the CPU,
memory and disk of the classes of the runtimes on each host. Before that the
only record was a class name, so placement was built and deliberately not
exposed: multiplying a count by an assumed class produces refusals and
acceptances nobody can explain.

A class is **retired, never deleted**, because a runtime created under it still
names it and what an agent was given is a fair question afterwards. A host
holding a runtime whose class is no longer recorded is counted as
`unmeasured` and **refused**: that sum has a hole in it, which makes the host
look emptier than it is, and absent is not zero here either.

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

**An absent expiry is not an expired one.** `entitledUntil` has three readings
and not two: in the future is entitled, in the past has lapsed, and absent is
unrecorded. Reading the third as a lapse sent an operator-created runtime, or
one whose billing integration failed to write the column, to GRACE and from
there to a scheduled deletion inside about three months, with nobody having
decided that. Nothing is due, and the operator screen says the entitlement is
unrecorded so somebody can notice. The errors are not symmetric: a runtime
running longer than somebody paid for costs money an operator can see, and an
agent deleted because a column was never written is irreversible.

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

SHARE is configuration. MOVE adds memories and the picture, and memories are
the whole of what it adds: `readLearned` in `agentPackage.ts` selects from
`memories` and nothing else, deliberately.

**Relationships and stances travel in no mode, MOVE included.** Both rebuild
themselves from what the agent actually published, so carrying them would put
a list of everybody it has spoken to into a file that gets emailed around, in
order to reconstruct something that reconstructs itself. `HOSTED_EXPORT_CARRIES`
claimed they travelled and `HOSTED_EXPORT_OMITS` said they were absent only in
SHARE, which is the worst kind of wrong for a list whose whole job is telling
an owner what travels before they decide. It is now held against the exporter's
own source rather than against a memory of it.

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

`packages/runtime/src/backupStoreFs.ts` is the simplest real store, and it is
**not registered on import**: a store that registered itself would make
`backupReadiness` say a hosted runtime is recoverable on the strength of a
directory existing on the machine that is holding it. It is also **not
off-host**, and says so in the line an operator reads, because a backup on
the machine it is protecting reads as solved on a status screen and is not.
It writes under the storage directory rather than beside the program, since
the program directory is replaced on every upgrade.

`mayRecoverElsewhere` is the guarded one. Restoring a runtime onto a different
host while the original may be alive is the two-copies problem again, so it
refuses unless the original is known not to be running. **`HOST_UNREACHABLE`
does not establish that**, and allowing it was the same mistake as reading a
broadcast nobody saw as a broadcast that did not happen: the host stopped
answering, which is precisely the case where it may be alive and partitioned.
A restore from there needs the old host fenced, meaning its key revoked so
whatever is still running cannot reach anything, or somebody having looked at
the machine. `RESTORE_CAVEATS` says
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
and refuses anything key-shaped. **A field name on the allowlist is not a value
on it**: checking only the names let
`{ jobsQueued: { note: 'the mentions tab is wedged' } }` through, under an
allowed name, carrying exactly the content the allowlist exists to keep out. So
every value is a finite number, a boolean or absent, and `state` and `version`
are the only strings.

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

## Asking a host rather than trusting it

`tools/hosted-isolation-check.mts` is the observed half of every check above.
It reads the loaded nftables ruleset, the process tree, and the server's own
catalogue for each tenant database, and reports what it found. It writes
nothing and provisions nothing, so it is safe to run on a host holding live
tenants.

Its one deliberate behaviour is that a check which could not run reports
UNAVAILABLE rather than passing, and the summary says so in a sentence rather
than rounding it up. A check that cannot run is the shape of a boundary nobody
has verified, which is the same reason the release preflight is run in the
packaging stage rather than assumed.

`tools/tenant-preflight.mts` is the other half, and it runs **inside** a
tenant before the application starts. Every rule it enforces is written down
elsewhere, and a written-down rule is enforced where a process starts or it is
enforced nowhere: a runtime that boots against the shared database has already
read another tenant's rows before any later check could have an opinion. It
asks four questions, refuses on any of them, and exits 1 so a launcher can
branch on it.

It derives the database and role names from the runtime id rather than reading
configured ones, compares the master key as a digest so no key reaches a log,
reads the server's own catalogue rather than the intention, and refuses to
start a runtime the lifecycle says may not act. It has **no default runtime
id**: one that guessed would pass for the wrong runtime, which is worse than
not running.

## The Firecracker lab, and what it proved

`packaging/hosted-lab/bin/`, against a real kernel on this machine.
Firecracker v1.17.0 and the jailer installed from the official release with the
published checksum verified, the current CI kernel (6.18.51) and Ubuntu 24.04
rootfs, converted to ext4.

What a boot actually produced, read from the host rather than assumed:

- Firecracker running as `ai17zvm`, not root.
- `Seccomp: 2`, meaning filter mode, and `NoNewPrivs: 1`.
- Its own network, mount and pid namespaces, all different from the host's and
  from the other tenant's.
- Its own chroot, with neither tenant's containing the other.
- Two tenants booted at once, each passing the egress proof.

**The egress policy was tested by a guest trying, not by reading a rule
listing.** A probe guest whose init connects to each denied range and each
permitted one reported: metadata `169.254.169.254` blocked, link-local blocked,
all three private ranges blocked, carrier-grade NAT blocked, and
`1.1.1.1:443`, `8.8.8.8:53` and `9.9.9.9:443` reached. The permitted half
matters as much as the denied half: the first run of this blocked everything,
and the reason was not the rules.

Two defects came out of that, both of which only a kernel was going to find.

`verifyLoadedRuleset` reported three correctly loaded denials as missing,
because `nft list ruleset` renders a single-host prefix without it:
`169.254.169.254/32` comes back as `169.254.169.254`. A check that always fails
teaches an operator to stop reading it.

And **one tenant, one namespace, one tap** is now a guard rather than a
convention. nftables evaluates every chain at a hook, so two tenant tables each
ending in `policy drop` discard the other's traffic: both tenants lose all
egress while every rule reads as correct and every denial appears loaded.
`namespaceHoldsOneTenant` refuses that arrangement and says what would happen.

**None of this is protection from the host operator**, and the lab is never
cited as though it were.

## What it costs, and what a plan has to clear

Measured rather than estimated, by `tools/measure-runtime.mts` on this machine
with the api and worker actually running:

| | |
| --- | --- |
| AI17Z at idle | about 434 MB: api 132, worker 193, runtime 109 |
| Database | 29 MB for one agent with 313 memories and 312 actions |
| Excluded | two `tsx watch` supervisors at 70 MB each, development only |

**Inside a guest, which is the figure that counts**, the same measurement with
Postgres in the boundary: `total=3939MB available=3386MB used=553MB`, and a
14 MB database after 106 migrations. The developer-machine figure of 434 MB
excludes Postgres and includes a different operating system, so the guest's own
number is the one a plan derives from.

Against the eight gigabytes of the smallest confidential VM that leaves room,
and the real consumer is Chrome, which this project already bounds at 4 GB a
slot and has measured at 3,801 MB in a mentions renderer. So the floor holds
AI17Z, its database and a browser with room to spare, which is the measured
argument for several of one owner's agents sharing a runtime rather than each
getting a VM.

The compute floor itself is in
[CONFIDENTIAL_COMPUTE.md](CONFIDENTIAL_COMPUTE.md): **two vCPUs, because there
is no smaller confidential size, at $37.67 to $89.79 a month** depending on
region and commitment. `hostedCost.ts` is the ledger: twelve lines on a closed
list so a new cost cannot be added without appearing in it, a line a tenant has
none of recorded as zero so an omission means unknown, shared overhead kept
apart from direct runtime cost, and planning on p95 rather than a mean because
a plan priced from the mean loses money on the ordinary heavy customer.

The margin target arrives as an argument. 60% is an engineering planning
figure, not a business policy, and `judgePlanEconomics` refuses a structurally
unprofitable allocation before the runtime exists and names what would have to
change. **No plan has been priced and no public price exists.**

Model tokens are **BYOK**. A customer brings their own provider key, which is
the only initial policy a margin against a $38 to $90 floor survives, and
`MODEL_API` keeps a cost line so a later platform-funded option is metered
separately rather than absorbed.

## What has not been done

Written here rather than discovered later, and corrected as things got done.

**Done since this document was first written:**

- A real microVM has booted, twice over, under the jailer as an unprivileged
  user with seccomp filtering and its own namespaces.
- The egress ruleset has been loaded into a real kernel, read back out of it,
  and verified from the kernel's own output. A guest has tried to reach each
  denied range and failed, and each permitted one and succeeded.
- Backup and restore run against a real S3-compatible object store: signed
  requests, a byte-for-byte round trip, a tampered object reported CORRUPT, an
  absent one told apart from a failure, and a read refused for a key outside
  the store's own prefix.
- AI17Z's own resource use is measured rather than estimated.
- Confidential provider research is current, with every figure sourced and
  dated and the Azure prices read from the retail prices API.

**Still not done, and each of these is a real gap rather than a formality:**

- No confidential VM has been provisioned on either provider, so no attestation
  has been verified against real hardware and no key has been released to an
  attested runtime. This needs an authorised paid cloud environment and is the
  one item that cannot be advanced without one.
- No AI17Z runtime image has been built, so there is no measurement to pin and
  no signed measurement policy has been published.
- No generation witness has been deployed, so a rolled-back runtime would be
  reported as `UNWITNESSED` rather than caught.
- No tenant has been provisioned end to end. The statements in
  `tenantDatabase.ts` have never been run against a real server, and AI17Z has
  never started inside a guest.
- No capacity figure is claimed. A runtime class says what is set aside; how
  many agents a machine actually carries is a different number and nothing has
  produced it.
- No plan has been priced, no entitlement issued and no capacity sold.
- Google's all-in confidential instance cost is unmeasured, pending a billing
  catalog credential.
- Venue adapters are not in this repository.
- Nothing has been pushed except the documentation-only front page. Phase 1
  releases as a coherent whole or not at all.
