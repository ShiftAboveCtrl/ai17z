# Publishing an agent's voice to AI17Z Studio

Status: core side built; Studio side not built. This document is the contract
Studio implements. `tests/support/voiceStudioServer.ts` implements the Studio
side of it strictly, and `tests/integration/studioVoicePublish.test.ts` drives
the real client against that server.

## What this is

An owner can publish how an agent sounds, as an installable item on Studio, and
anybody who is linked can install it as a new agent of their own. It is the
voice and nothing else. Not the strategy, not the memory, not the keys.

Three properties hold the design together.

1. **A voice is an allowlist.** The published document is built from named
   fields and has nowhere to put anything else.
2. **Publishing is the owner's act, in their own words.** A model can propose it
   and cannot confirm it.
3. **An installed voice is a new, powerless agent.** It is the installer's, it is
   switched off, and it holds no permission, approval, account, model or memory.

Everything is optional, outbound only, and depends on the Studio link
(`STUDIO_LINK.md`). Nothing else depends on it.

## The document

`VoiceDocument` in `packages/shared/src/contracts/studioVoice.ts`. Every object
is `.strict()`: an unknown key is a refusal. Nothing has a default, so the
document parses to exactly what was sent and its digest can be reproduced.

| Section | Fields | Notes |
| --- | --- | --- |
| root | `format` (`ai17z-voice`), `version` (1), `title`, `summary` | `title` is a label (see below). |
| `character` | `biography`, `personality`, `tone`, `styleGuidelines`, `styleExamples[]`, `topics[]`, `languagePolicy`, `responseLength`, `prohibitedBehaviors[]` | Persona field names, so the mapping is auditable. |
| `settings` | `emoji{use,maxPerMessage,allowed[],messagesPercent}`, `maxCharacters`, `forbidHashtags`, `forbidLinks`, `forbidMentionsOfOthers`, `stripSurroundingQuotes` | Register only. |

**Deliberately absent**, each for a reason that should survive review:

| Absent | Why |
| --- | --- |
| memories, relationships, stances, anything learned | Rebuilt from what an agent publishes; carrying them leaks who it has spoken to. |
| credentials, wallet, addresses, `verifiedAddresses` | Secrets and money. |
| policy, permissions, approvals, autonomy, schedule, cadence | Decide what an agent may do. A voice must not widen that. |
| models, tools, knowledge, plugins | Installation specific, and plugins would make the file an installer. |
| picture | Not needed for a voice, and a media parser is attack surface. |
| `displayName`, `identityKind`, `representedEntity`, `mayDenyBeingAI`, any id or owner | A voice must not name the agent that installs it or claim to be somebody. The installer chooses the name. |
| `customInstructions`, `changeNote` | Operator text. It is the field most likely to hold something private and the one with most authority over the model. |
| `bannedPhrases` | Left out to keep the list short; it is output filtering, not voice. Adding it is a version bump. |

`voiceFromAgent` copies the named fields. It does not clone a persona and delete
from it, so a field added to `PersonaDraft` or `PolicyConfig` later does not
publish itself. A test hands it an object with extra fields and checks none
arrive.

### Text is data

Free text is length limited and may not contain control characters, the Unicode
direction overrides or isolates, line or paragraph separators, or a byte order
mark. `title` and `topics` are labels: a single line that must not look like a
path or an address (`../`, `/x`, `C:\`, `\\host`, `~/`, `scheme://`, a
backslash). Prose may mention a path, because nothing ever opens one.

Beyond that the text is the voice, and a hostile author can write anything in
it. What makes that harmless is where it goes: persona fields only, on a new
agent whose policy is the platform default, so the identity rules, the output
validator and every gate sit between the words and the world. `scanVoice` adds a
flag for a person: passages that read like an instruction to the model (`ignore
all previous instructions`, a leading `system:`, chat-template markers), a
request to reveal the prompt, a denial of being an AI, a request for a key or
seed phrase, an instruction to move funds, or markup. It is a regular
expression and is not presented as a defence. A clause that negates the request
("never share your seed phrase") is not flagged.

### Digest

`document_sha256` is the lowercase hex sha256 of the canonical JSON of the
document: UTF-8, object keys sorted by code unit, no whitespace, arrays in
order, no `undefined`. It is the identity of a version. Studio recomputes it on
publish and the client recomputes it on install.

## Protocol

Base: the linked Studio origin. Version 1 (`protocol: 1` in every body).

Authenticated calls (`/api/v1/installation/voices*`) use the installation's
token and a DPoP proof bound to the method, address and token, exactly like the
rest of the link. There is no bearer secret and Studio must refuse one.
Public calls (`/api/v1/voices*`) carry no credential at all; the client sends
none, so Studio cannot learn which installation is reading.

### `POST /api/v1/installation/voices`: publish

```json
{
  "protocol": 1,
  "idempotency_key": "<uuid, fresh for each preview>",
  "listing_id": null,
  "document": { "...VoiceDocument..." },
  "document_sha256": "<64 hex>"
}
```

`listing_id` is `null` to start a listing, or the id of one of this
installation's listings to add a version.

Studio MUST:

- parse the body strictly (unknown keys refused) and answer `422` on a body that
  is not a `VoiceDocument`, with `error_description` naming the first problem;
- recompute the digest and answer `422 digest_mismatch` on disagreement;
- if the digest equals a version the listing already has, answer `200` with that
  version and create nothing;
- otherwise create version `n + 1` and answer `201`;
- store each version once and serve those bytes unchanged for ever;
- on a replayed `idempotency_key` with an identical body, answer as the first
  time did (`200` or `201`, same receipt); with a different body, `409
  idempotency_conflict`;
- answer `404` for a `listing_id` it does not have under this installation, and
  `409 listing_unpublished` for a closed listing;
- bind a listing to the installation that created it. Another installation's
  publish naming it is `404`.

Receipt (`VoicePublishAnswer`, strict):

```json
{
  "protocol": 1,
  "listing_id": "voice_ab12cd34ef",
  "version": 1,
  "document_sha256": "<64 hex>",
  "status": "PUBLISHED",
  "published_at": "2026-11-09T11:00:00.000Z",
  "url": "https://<studio>/voices/voice_ab12cd34ef"
}
```

The client refuses to treat a publish as done unless the receipt parses, echoes
the digest it sent, names the listing it asked for, and links to a page on the
Studio origin. It also refuses a version number that contradicts what it was
already told (a number reused for different content, or a second number for
content it already has).

`listing_id` is `^[a-z0-9][a-z0-9_-]{5,63}$`, so it is safe in a path.

### `GET /api/v1/installation/voices`: list the owner's listings

`{ "protocol": 1, "listings": [ { "listing_id", "status": "PUBLISHED" |
"UNPUBLISHED", "title", "url", "versions": [ { "version", "document_sha256",
"published_at" } ] } ] }`. Every `url` must be on the Studio origin or the whole
answer is discarded.

### `POST /api/v1/installation/voices/{listing_id}/unpublish`

Body `{ "protocol": 1, "idempotency_key": "<uuid>" }`. Answer `200` `{
"protocol": 1, "listing_id", "status": "UNPUBLISHED", "unpublished_at" }`.
Idempotent: unpublishing a closed listing is `200`. `404` for a listing that is
not this installation's.

After it, both public pages answer `410`, no new install can start, and the
listing cannot take a new version (`409 listing_unpublished`). **It cannot reach
a copy somebody already installed**, and the preview says so before the owner
publishes. A new publish after an unpublish starts a new listing.

### `GET /api/v1/voices/{listing_id}`: public listing

`VoicePublicListing`: `protocol`, `listing_id`, `status: "PUBLISHED"`, `title`,
`summary`, `latest_version`, `versions[]` (`version`, `document_sha256`,
`published_at`), `url`. A signed-out visitor can read this. `404`/`410` once
unpublished.

### `GET /api/v1/voices/{listing_id}/versions/{n}`: public version

`VoiceVersionAnswer`: `protocol`, `listing_id`, `version`, `status:
"PUBLISHED"`, `published_at`, `document_sha256`, `document`. The document is the
stored bytes. The client rejects the answer unless it parses strictly, names the
listing and version asked for, and `document_sha256` equals the digest the
client computes from `document`.

Studio's pages for signed-out visitors render only fields of this document, as
text. A voice is never rendered as markup.

## Versions are immutable

A version is a digest. Editing a voice and publishing again is the next
version; the earlier one is untouched in storage, on the page and in any copy.
Publishing the same content twice is one version. An installed agent never
changes when its source gains a version: there is no update channel in this
protocol, deliberately, because an update that rewrote an agent's persona would
be the same hole as a package that could.

## Publishing, on the installation

Code: `packages/runtime/src/studioVoice.ts` and `studioVoiceCapabilities.ts`.

1. **Preview.** `previewVoice` builds the document, computes the digest, counts,
   findings and the confirmation phrase `publish voice <first 8 of digest>`, and
   stores one pending record (digest, a fresh `idempotency_key`, listing id, the
   phrase, an expiry of 30 minutes) in `app_settings`. Nothing leaves the
   installation.
2. **Confirm.** `publishVoice` proceeds only if a pending record exists for that
   exact digest, has not expired, and the confirmation holds. It then rebuilds
   the document from the agent *now* and refuses
   (`CHANGED_SINCE_PREVIEW`) if the digest differs, so what is sent is what was
   shown.
3. **Send** over DPoP. The pending record is kept on any failure, so a retry
   after a lost reply reuses the key and is one version. It is deleted on
   success.
4. **Record.** The listing id and the versions Studio reported are kept per
   agent (`app_settings`, no migration), and an audit row is written.

### The confirmation

A confirmation is one of two things, and only one is available to a model.

- `OWNER_MESSAGE`: the text of the owner's own message in owner chat must
  contain the phrase. A capability passes `ctx.origin.text`, which the harness
  sets. It is not an input, so a model cannot supply it, including a model that
  has just read a hostile voice or any other injected text. The phrase carries
  the digest prefix, so it confirms that document.
- `OWNER_ACTION`: for a route the owner reached while signed in by pressing a
  button. No capability constructs it, and a unit test fails if
  `studioVoiceCapabilities.ts` mentions it.

Unpublishing needs `unpublish voice <listing id>` in the owner's message.

### Capabilities

All `audience: 'OWNER'`, `unsetPermission: 'DISABLED'`, model callable (so they
appear in owner chat only once the owner enables them). Pinned by
`tests/unit/studioVoice.test.ts`.

| Id | Effect / risk | Does |
| --- | --- | --- |
| `studio_voice.preview` | READ / LOW | Builds and shows the document, nothing sent. |
| `studio_voice.publish` | WRITE / HIGH | Publishes the previewed digest on the owner's phrase. |
| `studio_voice.unpublish` | WRITE / HIGH | Takes a listing down on the owner's phrase. |
| `studio_voice.listings` | READ / MEDIUM | The owner's listings and versions as Studio reports them. |

The family is `studio_voice`, not `studio`: the `studio.` family belongs to the
paper record (`STUDIO_PAPER_RECORD.md`) and a test there pins it to exactly one
id. The toolpack is `studio_voice` ("Share my voice"). Turning it on lets these
run; it does not sweep the two writes to ALLOWED, and it does not remove the
owner's phrase.

There is **no install capability**. Creating an agent is not something a model
may do, and a test fails if the capability file reaches the install code.

## Installing

Code: `packages/runtime/src/studioVoiceInstall.ts`. `inspectVoice` never throws
and creates nothing; every number it reports is counted from the parsed
document. `installVoice` / `installPublishedVoice` create the agent.

The new agent:

- belongs to the installer, is named by the installer (defaulting to the
  listing's title), and is in state `DRAFT`;
- has the voice's persona fields, `identityKind` `FICTIONAL`, empty
  `customInstructions`;
- has the platform's `DEFAULT_POLICY` with only the six output settings from the
  voice, so `identity.mayDenyBeingAI` is false, `tools.capabilityLoop` is false
  and every gate is the default;
- has `agent_wake` with `autonomy: 'OBSERVE'` and `enabled: false`;
- has **no** capability permission rows, approvals, account, model role, tool,
  knowledge source, schedule, plugin, memory, relationship or picture.

`tests/integration/studioVoicePublish.test.ts` asserts this by counting rows in
every table that has an `agent_id` column and failing on any outside the four a
new agent always has (`agent_wake`, `personas`, `pipelines`, `policies`).

A voice whose text was flagged installs only when the caller passes
`acknowledgeFindings`, so the flags cannot be something only a screen showed.
Provenance (source, listing id, version, digest) is stored beside the agent and
audited. Installing again makes another agent; nothing is ever overwritten.

## What can go wrong, and what happens

| Case | Result |
| --- | --- |
| Not linked, or Studio unreachable | UNAVAILABLE with a sentence. Nothing cached, nothing guessed. |
| Studio returns an unknown field, wrong digest, other listing or version, or an off-origin link | Refused as a whole; nothing recorded or installed. |
| Persona edited between preview and confirm | `CHANGED_SINCE_PREVIEW`; preview again. |
| Preview older than 30 minutes | `EXPIRED`. |
| Reply lost after Studio stored the version | Retry reuses the key; still one version. |
| Package names an id, owner, identity, path, permission or policy | Refused by the strict schema; nothing created. |

## What Studio owes

- the five endpoints above, behaving as specified, including immutability,
  digest recomputation, idempotency and `410` after unpublish;
- DPoP verification on the authenticated pair, as the link already does;
- moderation of listings (this protocol carries a flag for owners, not a verdict
  for Studio), and a way to take down a listing Studio itself must remove;
- rendering of voices as text only;
- a rate limit on publish per installation.

Not part of this protocol and not built: install counts, ratings, paid voices
(they would go through the marketplace gateway and its leases, not this),
updates to installed copies.

## Not done on the core side

- API routes and screens for preview, publish, list, inspect and install. The
  service functions (`previewVoice`, `publishVoice`, `unpublishVoice`,
  `inspectVoice`, `installVoice`, `installPublishedVoice`) are exported and the
  routes are a thin layer on them, using `OWNER_ACTION` for the button.
- A `.ai17z-voice` file download and import dialog. `installVoice` already reads
  one.
- No migration: the pending record, listing record and install provenance live
  in `app_settings`, keyed by agent id. They are not removed when an agent is
  deleted, which leaves a few orphan rows.

## Tests

- `tests/unit/studioVoice.test.ts`: the allowlist, the digest, the hostile
  fixtures (unknown field, identity and permission claims, path shapes, control
  and direction characters, instruction text kept verbatim and flagged), what an
  installed voice becomes, and the pinned capability list.
- `tests/integration/studioVoicePublish.test.ts`: the flows above against
  `tests/support/voiceStudioServer.ts` and a real Postgres.
- `tests/integration/packsOff.test.ts` registers the new capabilities with the
  rest.
