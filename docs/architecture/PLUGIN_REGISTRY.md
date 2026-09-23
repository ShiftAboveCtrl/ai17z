# Plugins and the Plugin Registry

What an owner installs, what it is allowed to do, and how a Plugin gets here.

This document describes what exists. Where something is deliberately not
implemented, it says so and says why, because a document that describes an
aspirational system is worse than none: it is the thing people read instead of
the code.

## What a Plugin is

A Plugin is the unit an owner installs, enables, configures and trusts. It owns
no execution of its own.

Everything an agent can actually do is a **capability**: a typed input, a typed
output, a permission, a readiness answer and an audit row, invoked through
`invokeCapability` and nothing else. That is unchanged by Plugins and must stay
that way. A Plugin is a product layer over the capability system, so:

- there is no second capability registry
- there is no second invocation path
- there is no second permission store
- there is no second readiness layer, quota engine or audit trail

A Plugin's enabled state is **computed** from the permissions of the
capabilities it contributes, and enabling one writes those permissions into
`agent_capability_permissions`. That is why the Plugins screen cannot disagree
with what the runtime does: there is nothing else for it to read.

## Three sources

| Source | What it is | Rows in `installed_plugins` |
| --- | --- | --- |
| `BUILT_IN` | One of the six toolpacks, presented as a Plugin | None. It ships with AI17Z and is versioned with it |
| `LOCAL` | A manifest an owner pasted or supplied as a file | One |
| `AI17Z_REGISTRY` | A manifest fetched from a configured registry | One |

A built-in Plugin **is** the toolpack, not a copy of it. `TOOLPACKS` supplies
the grouping, the capabilities are registered exactly once, and
`setPluginEnabled` calls `setToolpack` for a built-in rather than carrying a
second implementation of the same rule.

## The capability relationship

`packages/runtime/src/plugins.ts` labels every registered capability with the
Plugin it belongs to: by the `plugin_<id>.` prefix for an installed Plugin, and
by toolpack prefix for a built-in. A card's state, readiness, permission and
recent use all come from `capabilityViews`, the same function the agent's own
page reads, so the two surfaces answer with one computation.

The state word is measured with `atLeastDefault` on both surfaces. Compared by
equality instead, the X pack reads MIXED on one screen and ON on the other,
because its reads default to ALLOWED while its writes default to asking or off.

**Plugins is the canonical place an owner decides.** The agent's own
Capabilities section shows the same facts read-only and links here. Two screens
that both look authoritative about one setting is how something ends up allowed
on one and refused on the other.

## Manifest, schema v1

`packages/shared/src/contracts/plugins.ts`. `.strict()` throughout, so an
unknown field is a refusal rather than something silently ignored: a field this
build does not understand may be the one that mattered.

```
schemaVersion  1, literally. Anything else is refused unread.
id             lower-case, hyphens, no underscore. Primary key.
name/summary/publisher/version   semver for the version.
compatibility  { minimum, below? } against AI17Z's release core.
kind           CAPABILITY_PACK | HTTP_CAPABILITY | FEATURE
config         up to 8 fields, each with `secret` and `required`.
capabilities   up to 12 declarations.
features       RESEARCH_SOURCE | OWNER_PANEL
research/panel the block each feature needs, required with it and refused without it.
```

### An installed Plugin declares; it does not ship code

There is no `eval`, no dynamic import of downloaded text, no `vm` pretending to
be a sandbox, no postinstall script, no shell, no filesystem access and no
downloaded JavaScript. What an installed Plugin declares is one bounded
operation:

- **one method**, `GET` or `POST`
- **a URL** with `{field}` placeholders filled from validated input, encoded on
  the way in so a value cannot add a query parameter, a path segment or a host
- **an allowlist of hosts**, bare hostnames, no wildcard, no port, no path
- **an optional credential slot**, naming a config field the manifest requires
  to be marked `secret`
- **a timeout**, 1 to 30 seconds
- **an hourly quota**, per agent

`packages/runtime/src/pluginCapabilities.ts` builds a real capability from that
and executes it through `safeFetch`. So a Plugin cannot reach the filesystem, a
shell, the Chrome profile, the X cookies, the master key, a provider
credential, another agent's memories, the database beyond its own
configuration, or a host it did not declare.

That is a deliberately small extension model. It is small because the
alternative is a marketplace for remote code execution on somebody's own
machine, holding their signed-in browser and their provider keys.

### WRITE is refused in schema v1

`effect` is `z.literal('READ')`. A declarative HTTP call cannot be shown by
reading its manifest to be idempotent, reversible or safe to retry, and those
are exactly the properties the write path depends on. So an installed Plugin
reads. Adding WRITE means adding a way for a manifest to prove those
properties, not relaxing this.

### Capability ids

`pluginCapabilityId` produces `plugin_<id>.<name>`: two segments, because the
registry's ids are `family.verb_noun` and the family is what the shortlister
groups by. Giving each Plugin its own family is the point, so a Plugin's
capabilities are offered or not offered together.

`plugin_` is reserved, so an installed Plugin can never claim `x.`, `time.`,
`agent.`, `memory.` or any other built-in family. Hyphens become underscores
because the id shape has no hyphen in it and a Plugin id cannot contain an
underscore, so the mapping is reversible.

## Being found

A Plugin that nothing offers is a Plugin nobody can use, and this is the one
place where being new rather than built in used to cost something real.

`capabilityRelevance.ts` lifts a whole family when the task names it, using
`FAMILY_HINTS` -- a map of the families that ship with AI17Z. An installed
Plugin's family is in no such map, so it scored nothing however well its own
words matched, and the only way to reach one was to say its id out loud. Found
on a real installation: a Plugin whose title and description both said
`temperature` scored 1 against a floor of 2 for "what is the temperature
there", and was offered for "the next berth slot" only because `berth` is in
its id.

So a family this build has no hints for derives them from what its own
capabilities declare: the words of their titles. The capability's title counts
in its own score there too, which nothing read before. Both read only what a
Plugin already had to write down, both are deterministic with no model call,
and both are scoped to unhinted families, so the twenty built-in families score
exactly as they did.

A task that matches nothing is still offered nothing. This makes a Plugin
reachable by the words somebody would use about it, which is what the
capability system already promised; it does not put one on every menu.

## The network boundary

**A Plugin cannot reach a private address or plain http, whatever it declares.**
`safeFetch` judges every hop, refuses anything that is not https, and refuses
addresses that are not on the public internet. A manifest naming `127.0.0.1`
validates and then fails at the moment it tries to fetch, with a sentence
saying so. That is the canonical layer doing its job rather than a Plugin rule.


The allowlist is checked **twice**:

1. On the address built from validated input, because a placeholder in the host
   position is how an allowlist is defeated by an input value.
2. On the address that actually answered. `safeFetch` re-judges redirects for
   private addresses and has no opinion about which *public* host a Plugin was
   allowed to talk to, so a public-to-public redirect is exactly the hop that
   would otherwise escape the declaration. It is refused and nothing is read.

The credential is opened from the sealed store at the moment the request is
built and goes straight into a header or a query parameter. It is never
returned, logged, audited or carried anywhere else.

The response is capped at 512 KB. A declared Plugin answers a question;
anything that needs megabytes is not this extension point.

## Features

Two, and the list is closed. An entitlement cannot invent a feature.

### RESEARCH_SOURCE

`packages/runtime/src/pluginFeatures.ts`. This does not give a Plugin a place in
the research step. It gives one of the Plugin's *own declared capabilities* a
second way of being called, through `invokeCapability`, exactly as the model
would call it. So the owner's permission applies, readiness applies, the quota
applies, the allowlist applies, the timeout applies, and an audit row is
written. A Plugin that is switched off is a source that is switched off, and
nobody had to remember to check that anywhere.

The manifest names which capability answers, which required string input takes
the question, and which output fields carry the title, the summary and
optionally a URL. All of that is checked when the manifest is read, so a
research source that could never produce a finding is refused at install.

What comes back is a `Finding`, the same shape a web search and DexScreener
return, attributed in the prompt as something a named source said a moment ago.
A source that answers nothing is a recorded gap, like every other lookup that
fails. `OWNER_APPROVAL` is skipped rather than held, because a lookup happens
inside a reply being written now and there is nobody to ask.

### OWNER_PANEL

Declarative data, drawn by AI17Z's own components: a title, sentences, which of
its own capabilities to show recent runs for, and links. There is no HTML, no
markdown, no template and nothing to execute. Link hosts must be ones the
Plugin already declared, or its own homepage, so a panel cannot become a way of
putting an arbitrary address in front of somebody under a publisher's name.

## Install, update, uninstall

**Install** is atomic and fails closed. The manifest is parsed, validated
against this build's schema, checked for compatibility, checked for a
capability id that already exists, and only then registered. If recording it
fails, everything registered is unregistered again and a previous version is put
back, so there is no state where a capability is callable and unrecorded or
recorded and uncallable.

**Publisher substitution is refused.** A later version arriving under a
different publisher is not an update. The publisher is stored beside the
manifest for exactly this, and the registry's catalogue entry is held against
the manifest as well.

**The manifest hash is checked before the manifest is read.** A document that
has been changed in transit is not one to reason about the contents of.
`manifestSha256` is over the bytes as received, and what was approved is kept,
so what was approved and what is running can be compared later.

**A downgrade is refused** unless asked for explicitly. A downgrade arriving on
its own is usually a catalogue that has been rolled back or tampered with, and
quietly replacing a Plugin with an older one is how a fixed problem comes back.

**Permission expansion on update needs a fresh answer.** `pluginFootprint` reads
what a manifest asks for -- hosts, capabilities, features, effects, risks,
whether it wants a credential, its ceiling -- and `footprintExpansion` says in
sentences what a new version asks for that the approved one did not. If
anything grew, the install is refused with those sentences until the owner
acknowledges them. Narrowing passes silently: a Plugin needs no permission to
do less.

**Uninstall** unregisters the capabilities before the record goes, so there is
no window where the model can choose something whose configuration has been
deleted. If the delete fails, the capabilities are registered again rather than
left unreachable. The permissions go with the Plugin, because a decision about
a capability that no longer exists is not a decision anybody can act on, and
leaving one behind means reinstalling silently restores a permission the owner
last saw a year ago. The invocation history stays: what an agent did is not
undone by removing the thing it did it with.

A call already in flight is not interrupted and cannot be. It holds the
capability object it was handed and has already read whatever configuration it
needed, so it finishes and is audited like any other. That is the right
outcome: a Plugin that cannot be removed while it is busy is a Plugin that
cannot be removed when it is misbehaving, which is when somebody wants to.

**A Plugin this build has outgrown stays installed and is not registered.**
`registerInstalledPlugins` skips it and the Plugins screen says so on the card,
rather than its capabilities silently vanishing.

## Storage

| Table | Holds |
| --- | --- |
| `installed_plugins` | id, source, version, publisher, manifest sha256, manifest verbatim |
| `agent_plugin_config` | non-secret configuration, per agent per Plugin |
| `agent_plugin_secrets` | sealed credentials, per agent per Plugin per key |
| `plugin_call_budget` | calls per agent per Plugin per hour |

Nothing here records what an agent may do. That is
`agent_capability_permissions` and only that.

The manifest is kept verbatim rather than exploded into columns. What was
approved is the thing worth being able to show later, and a normalised copy is
a second version of it that can disagree.

Migration 0087 puts foreign keys from the three per-agent tables onto
`installed_plugins` with `ON DELETE CASCADE`. Deleting those rows by hand worked
and is the arrangement this repository keeps deciding it does not want: a
guarantee living in application code is one a second caller can forget, and a
sealed credential outliving the Plugin it belonged to is the worst version of
that.

## Secrets

A Plugin secret is sealed with AES-256-GCM under `AI17Z_MASTER_KEY`, exactly
like a provider API key, and is readable only through
`plugins.getDecryptedPluginSecret`. It never appears in an API response, a log
line, an audit row, a trace, a browser task's params, `localStorage`, or an
exported agent package. The configuration route reports which secret keys are
filled and never what is in them.

The registry key is the same: sealed, write-only, and reported as
`{ present, hint }` where the hint is the last four characters, so somebody can
recognise which key is stored without the value being readable from a screen.

## Portability

`PORTABLE_AGENT_VERSION` is 3. `plugins` carries each Plugin's **identity** --
id, name, publisher, version, source -- and the agent's **non-secret
configuration** for it.

**The manifest does not travel.** A document that carried one would be a
document that installs a third-party HTTP capability on whatever machine opens
it, and these get emailed around: a preset somebody downloaded would silently
give their agent a remote endpoint they never approved. So an importer is told
which Plugin the agent used and has to install it itself, which is the same
decision the original owner made.

**No credential travels**, on SHARE or on MOVE. A sealed value belongs to the
installation that sealed it. The importer says so in a note rather than letting
somebody discover it when the first lookup fails.

On import: a Plugin already installed here from the same publisher gets its
configuration applied. One that is not is named with its publisher and version,
so the capability decisions in `toolspace` stop being a handful of ids this
installation refused with no explanation. Same id, different publisher is
reported and not applied: that is a different Plugin with the same name.

`inspectPackage` counts the Plugins a file names and says out loud that naming
is not carrying.

## New-agent defaults

`applyCoreRecommended` is called once, from the one route that creates an agent.
It writes explicit permissions rather than relying on each capability's default,
so what the Plugins screen shows on day one is what the runtime will do, and so
a later change to the recommended set cannot quietly re-open something for an
agent that already exists.

Recommended: the `reference` and `web` packs, plus the `time.`, `agent.` and
`memory.` families. Chosen against a rule rather than a preference: read-only,
useful without a credential, bounded in time and cost, nothing irreversible.

Deliberately not recommended: `x` (needs a connected account and reads somebody
else's timeline), `crypto` (financial), `projects` (needs a watch the owner sets
up), `filings` (needs a declared contact address).

**It never touches an agent that already has permissions**, and the import path
does not call it: an imported agent's decisions came with it, and writing
defaults first would leave every capability the package did not mention sitting
at this installation's recommendation rather than at what its owner chose.

It cannot fail agent creation. An agent with no permission rows works, because
every capability falls back to its own default; an agent that failed to be
created because a default could not be written does not.

## Registry protocol v1

The address is owner configuration with **no default**, and must be `https`.
An address that is not is refused when it is saved, with a sentence, rather
than stored and silently treated as absent.

```
GET /api/v1/plugins[?q=<search>]
    → { protocol: 1, plugins: [ { id, name, summary, publisher, version, entitled, homepage? } ] }

GET /api/v1/plugins/<id>
    → { protocol: 1, plugin: <listing>, manifest: <exact text>, manifestSha256: <hex> }
```

Requests carry `accept: application/json` and `x-ai17z-protocol: 1`. A stored
key is sent as `Authorization: Bearer <key>` when one exists.

**A key is optional.** A public catalogue is public, and requiring a key to
browse would make an API key a thing every installation needs, which is how a
narrowly scoped credential turns into a general machine identity. A key is for
private Plugins and entitlements: an entitled Plugin is absent from the
catalogue without one, and answers `403` on detail rather than pretending not
to exist.

The client refuses, in this order: a protocol it does not speak, a shape it does
not understand, a hash that does not match the bytes received, a manifest whose
id is not the one asked for, a manifest whose publisher disagrees with the
catalogue, a manifest this build cannot run, a publisher substitution, a
downgrade, and an unacknowledged expansion. `401`/`403` is reported as "the
registry refused this key" with a flag the interface uses to say a key may
help. A timeout is 15 seconds. Response bodies are capped at 2 MB.

`registryUpdates` compares versions numerically, because a string comparison
calls `1.10.0` older than `1.9.0` and an update check that gets that backwards
offers a downgrade as an upgrade for ever. Updates are fetched only when the
interface explicitly asks, so drawing the Plugins screen never waits on
somebody else's server.

### The transport seam

`RegistryOptions.transport` exists because the server the client has to be
proved against runs on loopback, which `safeFetch` refuses on purpose and which
the https rule refuses again. Both of those are worth keeping, so the seam is
here rather than as an exception in either. Nothing in the product passes it;
only `tests/support/registryServer.ts` does.

## The official registry server is not in this repository

There is no AI17Z website or backend source in this workspace, and the registry
has not been deployed. **No hostname has been invented.** Inventing one would
produce a client that looks finished and points at nothing, and the first
symptom would be an owner being told their internet was broken.

So: the address is configuration with no default, the shipped Plugins screen
says the registry is not configured until an owner sets one, and installing from
a file works without any registry at all.

What *is* finished is the contract, the client, and the security model around
both. `tests/support/registryServer.ts` implements this protocol strictly, so
the client is proved against a real server speaking it rather than against mocks
of itself.

## What schema v1 does not support

Said plainly, because the absence of each of these is a decision:

- **No remote code.** No downloaded JavaScript, no `eval`, no dynamic import,
  no `vm`, no postinstall, no shell, no filesystem.
- **No WRITE.** A manifest cannot show a call is idempotent or safe to retry.
- **No request body from input.** A `POST` carries no body built from input;
  parameters go in the URL. Adding one means deciding how a declared body is
  validated and logged, which is not done here.
- **No wildcard hosts.** A wildcard is how an allowlist stops being one.
- **No custom headers.** A Plugin cannot add one; the canonical layer builds
  the request.
- **No rendering.** An owner panel is data. A Plugin never returns markup.
- **No signature or provenance chain.** The hash catches a corrupt or altered
  download; it is not a signature, and it does not prove who published
  something. What protects against a hostile package is the shape of the
  format: there is nowhere in it to put anything executable. This is stated
  rather than implied, the same way `docs/SETUP_AUDIT.md` states what its hash
  does and does not pin.
- **No cross-agent state.** Configuration, secrets and quota are per agent.
- **No installing from an agent package.** Packages name Plugins; they do not
  carry them.

## Where things are

```
packages/shared/src/contracts/plugins.ts   manifest, views, footprint, id helpers
packages/database/src/repositories/plugins.ts  install, config, sealed secrets, quota
packages/runtime/src/pluginCapabilities.ts declaration -> capability, via safeFetch
packages/runtime/src/plugins.ts            views, enable, install, uninstall, defaults
packages/runtime/src/pluginFeatures.ts     RESEARCH_SOURCE and OWNER_PANEL
packages/runtime/src/pluginRegistry.ts     registry client and protocol
apps/api/src/routes/plugins.ts             the owner's routes
apps/web/src/routes/PluginsPage.tsx        Installed / Discover / Settings
migrations/0086_installed_plugins.sql      the tables
migrations/0087_plugin_rows_follow_the_plugin.sql  the foreign keys
tests/support/registryServer.ts            a real server speaking protocol v1
```

See also `docs/architecture/TOOLSPACE.md` for the capability system Plugins are
a layer over, and `docs/architecture/CAPABILITIES.md` for the permission model.
