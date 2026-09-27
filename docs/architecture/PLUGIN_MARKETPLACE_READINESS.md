# Connecting a website to AI17Z Plugins

What an AI17Z installation already expects from a Plugin registry, read from
the source in this repository, so the website that becomes the registry can be
connected to it without guessing. The full design is in
[`PLUGIN_REGISTRY.md`](PLUGIN_REGISTRY.md); this page is the boundary.

**Nothing here describes the website.** Its accounts, storage, framework and
payments are whatever its own source says they are, and the connection should
extend those rather than add a second set.

## The shape of the connection

```
AI17Z installation  --(registry protocol v1, HTTPS GET, JSON)-->  registry (the website's backend)
       |                                                                  |
       owner decides what to install                        publishers publish manifests
```

An installation only ever **reads** from the registry. It never uploads, never
reports usage, and never sends anything about the agents that use a Plugin.

## What the installation already does

| Concern | Where | Current behaviour |
| --- | --- | --- |
| Registry address | `packages/runtime/src/pluginRegistry.ts` (`registryAddress`) | Owner configuration, no default, HTTPS only. Unset means "not configured", said in words. |
| Protocol version | `REGISTRY_PROTOCOL = 1` | Sent as `x-ai17z-protocol: 1`; every answer must carry `protocol: 1`. |
| Browse and search | `registryCatalog` | `GET {address}/api/v1/plugins` with an optional `q` search term. |
| One Plugin | `registryDetail` | `GET {address}/api/v1/plugins/{id}`. |
| Install | `installFromRegistry`, then `installPlugin` in `plugins.ts` | Fetches the detail, checks the hash, parses the manifest strictly, checks compatibility, registers the capabilities. Atomic both ways: a failure puts the previous version back. |
| Integrity | `installFromRegistry` | The detail answer carries the manifest **as text** and its `manifestSha256`; the installation hashes the text it received and refuses a mismatch. The stored row keeps the hash (`InstalledPlugin.manifestSha256`). |
| Credentials | `keyHeader` | Optional. When an owner stored a registry key it is sent as `authorization: Bearer ...`, sealed at rest under the master key. Browsing works without one. |
| Refusal | `get` | 401 or 403 is reported as "the registry refused this key"; any other non-2xx as its status. Nothing is retried in a loop. |
| Size and time | `get` | 2 MB per answer, 15 seconds per request, through `safeFetch`, which refuses private addresses and re-checks redirects. |
| Updates | `registryUpdates` | Compares installed versions with the catalogue using `comparePluginVersions`. An update that asks for more (`footprintExpansion`) is asked about again; a downgrade is refused unless requested. |
| Uninstall | `uninstallPlugin` | Atomic: a failure re-registers what it removed. Secrets and per-agent rows go with the Plugin (migration 0087 foreign keys). |

## What one answer must look like

These are the shapes the client validates today, strictly: an unknown field is
a refusal.

**Catalogue:** `{ protocol: 1, plugins: Listing[] }`, at most 500 entries.

**Detail:** `{ protocol: 1, plugin: Listing, manifest: string, manifestSha256: string }`.

**Listing:** `id` (3 to 64), `name`, `summary` (up to 300), `publisher`,
`version`, `entitled` (boolean, default false: whether it needs an
entitlement), optional `homepage`.

## The manifest

`PluginManifest` in `packages/shared/src/contracts/plugins.ts`,
`PLUGIN_MANIFEST_SCHEMA = 1`, parsed `.strict()`.

| Field | Rule |
| --- | --- |
| `id` | 3 to 64, lower case, `^[a-z][a-z0-9-]*[a-z0-9]$`. The Plugin's identity everywhere. |
| `name`, `summary`, `publisher` | Text; `publisher` is 2 to 120 characters and is shown as given. |
| `version` | Strict semver `x.y.z`. |
| `compatibility` | `minimum` (semver) and optional `below`, checked against the running AI17Z by `pluginRuns` at install, update and startup registration. |
| `kind` | `CAPABILITY_PACK`, `HTTP_CAPABILITY` or `FEATURE`. |
| `homepage` | Optional URL. |
| `config` | Up to 8 fields, lower-case keys, labelled; secret fields are sealed. |
| `capabilities` | Up to 12 declarations: name, title, description, category, risk, input schema, and one HTTP operation. |
| `features` | Up to 4 of `RESEARCH_SOURCE` and `OWNER_PANEL`, each requiring its block (`research`, `panel`) and each block requiring its feature. |

**One HTTP operation per capability, and no code.** Method `GET` or `POST`, a
URL whose `{placeholders}` are filled from validated input and encoded, an
allowlist of 1 to 8 bare hostnames, an optional credential slot (`BEARER`,
`HEADER` or `QUERY`, filled from a config key), a timeout of 1 to 30 seconds
(default 10), and an hourly quota of 1 to 600 (default 60). **Schema v1 refuses
writes**: a manifest cannot show a call is idempotent, reversible or safe to
retry.

## What the installation enforces around a Plugin

| Concern | Where | Rule |
| --- | --- | --- |
| Identity of capabilities | `packages/tools` | Capability ids are `plugin_<id>.<name>`. The `plugin_` prefix is reserved, so an installed Plugin can never claim `x.`, `time.` or any other built-in family. |
| Permissions | `agent_capability_permissions` | Per agent, per capability: `DISABLED`, `OWNER_APPROVAL` or `ALLOWED`. A Plugin's enabled state is computed from these rows; there is no second store. |
| Quotas | `pluginCapabilities.ts` | The declared `quotaPerHour`, charged per agent per Plugin (`chargePluginCall`), refused with a sentence when spent. |
| Readiness | `pluginsAndCore`, `invoke.ts` | Computed on every call, never cached: each capability's own `readiness` check (for an installed Plugin, whether every required config field and secret is set for this agent) alongside its permission. Registered is not available, and the screen says which. |
| Audit | `capability_invocations` (migration 0063) | Every call, whether offered, refused or run, with its reason. |
| Network | `safeFetch` plus the allowlist | The allowlist is checked twice: on the address built from input, and on the address that actually answered. Private addresses are refused. |
| Secrets | `agent_plugin_secrets` (migration 0086) | Per agent per Plugin, sealed under the master key; never in an API response, a log, an audit row, a browser task, `localStorage` or an exported agent. |
| Agent-specific configuration | Plugin config per agent | Non-secret values are configuration; secret values are the sealed rows above. |

## Extension points a Plugin may use

- **`RESEARCH_SOURCE`**: one of the Plugin's own capabilities becomes a source
  the research step may call, through `invokeCapability`, so permission,
  readiness, quota, allowlist, timeout and audit all apply. The block names the
  capability, the input field the query goes into, which result fields are the
  title, summary and link, and the source name shown with each finding.
- **`OWNER_PANEL`**: a title, up to 12 sentences, up to 8 of the Plugin's own
  capabilities whose recent runs are shown, and up to 6 links to hosts the
  Plugin already declared. A Plugin never returns markup.

## Moving agents between installations

`PORTABLE_AGENT_VERSION = 3`. An `.ai17z-agent` package **names** a Plugin and
never carries its manifest, because a document carrying one would be an
installer. SHARE carries configuration; MOVE adds memories and the picture. An
importer that has the Plugin applies the non-secret configuration; one that
does not is told which Plugin, publisher and version it would need. Secrets
never travel.

## What the website will need to supply

Derived from the interface above, and only from it:

1. **Somewhere manifests live**, returned as the exact text whose SHA-256 is
   published beside it.
2. **Two read endpoints** at the paths the client already calls, answering in
   the shapes above.
3. **A way to mark a Plugin as needing an entitlement** (`entitled`), and to
   decide from a bearer key whether the caller has it. How keys are issued, and
   to whom, is the website's own account system.
4. **Publisher identity**, shown as the `publisher` string. Nothing in the
   client verifies a publisher beyond that string today.
5. **Versions**, as semver, with the compatibility range the installation
   checks before installing.

## What does not exist yet, and should not be invented

- No official registry address. The client is proved against
  `tests/support/registryServer.ts`, which implements the contract strictly.
- No publisher signature. The checksum catches a corrupted or altered download
  against what the registry published; it is not proof of who published it.
- No update channels. The catalogue lists one current version per Plugin, and
  the client compares against it.
- No categories, ratings, moderation state, purchase flow or usage reporting in
  the protocol. Each would be a protocol change, versioned, with the client and
  the test server moving together.

When the website source is available, the first job is to read how it already
handles accounts, storage and payments, and map these five needs onto them.
