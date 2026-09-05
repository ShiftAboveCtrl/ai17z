# Post-v0.1.0 expansion — audit and research

Written before any implementation code, as instructed. Two parts: what v0.1.0
actually has against the five objectives, and what the current official
documentation says, which changes the plan in two places.

---

## Part 1 — What already exists

### 1. Windows distribution

| | State |
|---|---|
| Setup scripts | `install-ai17z.ps1`, `start`, `stop`, `restart`, `update`, `doctor`, `launch`, `bootstrap` — all present, clone-based |
| Start Menu shortcut | Created by the installer |
| Uninstall | **Missing.** No `uninstall-ai17z.ps1` |
| Release artifact | **Missing.** Nothing produces an `.exe`, `.msi` or `.msix` |
| Release workflow | **Missing.** `.github/workflows/ci.yml` is the only workflow: typecheck, tests, build, secret scan. No release job, no signing hook |
| Licence | MIT, declared in `LICENSE` and `package.json` |

The v0.1.0 handoff said "installation is a clone, so there is no artefact to
checksum". That is accurate and it is exactly the gap this phase closes.

### 2. xAI

`registry.ts` maps `xai` to a generic OpenAI-compatible adapter pointed at
`https://api.x.ai/v1`. That is the whole integration: **Grok as a chat model and
nothing else.** No Responses API, no server-side tools, no `x_search`, no
`web_search`, no citations. Objective 2 is entirely new work.

What it can build on: the research step already routes questions by *shape*
(`whatToResearch`, `planLookups`), already has a bounded budget, already keeps
findings as evidence with provenance, and already reports a lookup that failed.
The xAI work extends that rather than replacing it.

### 3. Agent avatar

`avatarUrl` and `avatarMode` exist on the contract and the table, are settable
at creation, and are rendered on the agent page and the home grid. There is **no
upload endpoint and no post-creation edit control**. The artifacts route serves
stored files but nothing writes an uploaded image. The defect the brief
describes is real.

### 4. Portable agents

`exportAgent` / `importAgent` / `duplicateAgent` produce one strict JSON
document with a `NEVER_EXPORTED` denylist and a test that walks every key and
string looking for a planted secret. That foundation is sound.

What is missing against the brief: it is **JSON only** — no archive, no
manifest, no avatar or knowledge assets, no `.ai17z-agent` file. There is one
export mode, not two. There is no import inspection step. There is no untrusted
input hardening, because a JSON body cannot carry a zip bomb or a path
traversal, and an archive can.

### 5. Telegram and owner notifications

The owner notification system exists and is good: structured notifications,
severity, dedupe by partial unique index, acknowledgement, mute, a sweep that
derives conditions from state, and a UI panel.

It has **no transport layer at all.** Notifications are rows that the web UI
polls. `telegram` appears in the codebase only as a value in the *channel* enum
— an agent social channel that was never implemented — which is a different
concept from an owner notification transport and should not be confused with it.

So objective 5 is: add a transport abstraction beneath the existing notification
system, exactly as the brief specifies, and Telegram as the first transport.
Nothing about the raising, dedupe or severity logic needs to change.

### Also found

**There is no password reset path.** `/api/bootstrap/owner` refuses once an
owner exists and nothing else can set a password. On a local-first single-owner
application, a forgotten password currently means editing the database. That is
tolerable for a cloned developer setup and not tolerable once there is an
installer, so it belongs in this phase.

---

## Part 2 — What the current documentation says

### SignPath Foundation: we qualify, with work to do

Microsoft's own code-signing page now lists SignPath Foundation as the free
option for open-source projects, providing OV-level signing.

SignPath's conditions, checked against AI17Z:

| Requirement | AI17Z |
|---|---|
| No malware or potentially unwanted programs | Clean |
| OSI-approved licence, no commercial dual-licensing | MIT, single-licensed |
| No proprietary or non-open-source components | Dependency audit: MIT/ISC/Apache-2.0/BSD only, no copyleft, nothing vendored |
| Actively maintained | Yes |
| **Already released in the form to be signed** | **No. This is the blocker** — there is no artifact yet |
| Functionality described on the download page | README describes it; a release page does not exist yet |
| Signing team owns development and the repository | Yes |
| Only own binaries signed | Yes |
| No vulnerability identification or exploitation features | AI17Z drives a browser as its owner; it is not a security tool |
| Privacy policy shown at install, or a statement of no external transfer | **To write.** AI17Z is local-first and sends nothing anywhere by itself |
| Uninstall method provided | **To build** |
| MFA on SignPath *and* the source repository, all team members | **User action.** GitHub 2FA must be on |
| Authors, Reviewers, Approvers documented with names or GitHub teams | **To write** |
| Code signing policy on the project homepage linking to SignPath.io and SignPath Foundation | **To write** — `docs/CODE_SIGNING_POLICY.md`, linked from README |
| Signed binaries carry product name and version attributes | **To set** in the artifact |

Nothing here disqualifies AI17Z. The work is real but ordinary, and the ordering
matters: **the artifact has to exist and be released before the application can
be made**, because "already released in the form that should be signed" is a
condition rather than a formality.

The GitHub integration is `signpath/github-action-submit-signing-request@v2`,
taking `api-token`, `organization-id`, `project-slug`, `signing-policy-slug`,
`github-artifact-id`, `wait-for-completion` and `output-artifact-directory`. The
organisation id, slugs and token only exist after approval, so the workflow is
written now with those as repository secrets and variables, and fails safely
when signing was expected and did not happen.

### SmartScreen: the previous guidance was wrong

Microsoft is explicit, and our documentation contradicted it:

> EV certificates no longer bypass SmartScreen. Years ago, signing files with an
> Extended Validation (EV) code signing certificate would result in positive
> SmartScreen reputation by default, but this behavior no longer exists.

The change was made in 2024. `docs/CONTINUATION_STATE.md` and
`docs/RELEASE_HANDOFF.md` both still say EV carries SmartScreen reputation
immediately. Both are corrected in this phase.

Also authoritative, and worth writing down because it is widely misunderstood:

> There is no need (or mechanism) to manually submit a file for SmartScreen
> reputation review for consumer endpoints. Reputation builds organically
> through download volume.

Reputation is earned by downloads over time — "several weeks and hundreds of
clean installs from a wide audience". The only submission portal is the
Microsoft Security Intelligence file submission, which is for **malware and
false-positive analysis**, a different system with a different purpose. Enterprise
administrators may use it to accelerate trust for managed deployments; it is not
a consumer reputation mechanism. Conflating the two is the mistake the brief
warns about, and the documentation this phase writes keeps them apart.

One further fact worth carrying, stated more carefully than it was in the first
draft of this document. On Windows 11, **Smart App Control** can supersede
SmartScreen application reputation. Microsoft's wording is that it uses app
intelligence to decide whether software is trusted, and that a trusted signature
is one of the paths to that; software it cannot establish as trusted can be
blocked, and its checks apply to all executables rather than only downloaded
ones.

The earlier draft said it "blocks unsigned executables outright regardless of
reputation". That is broader than Microsoft claims, and overstating a security
control is the same error as understating one. The conclusion is unchanged and
does not need the overstatement: a trusted signature matters for more than
avoiding a warning.

### Microsoft Store: free, and probably not for us

Registration is free and Store-distributed MSIX packages are re-signed by
Microsoft, so users never see a SmartScreen warning. That is genuinely the
strongest trust outcome available and it costs nothing.

The problem is not policy, it is architecture. AI17Z requires three things the
Store cannot deliver with it:

- **Google Chrome**, a specific third-party browser AI17Z spawns and attaches to
  over CDP. Playwright's Chromium is explicitly not a substitute — the whole
  browser-engine design says a Chrome-shaped path that is not Chrome is a
  failure with instructions, never a substitution.
- **PostgreSQL**, whether through Docker Desktop or an existing server.
- **A Node runtime** running a long-lived local service that binds loopback
  ports, spawns processes, and writes browser profiles outside the package.

A packaged Win32 MSIX with full trust could technically spawn processes and bind
loopback. What it cannot do is bring Chrome, Postgres and Docker with it, and an
app whose first-run experience is "now go and install three other things" is not
what Store certification is for.

**Assessment: not practical in this phase, and not worth distorting the
architecture for.** The brief's own instruction applies. The realistic Store
path would be a different product shape — embedded Postgres, no Docker, and a
resolved answer to the Chrome dependency — and that is a decision about what
AI17Z is, not a packaging task. Recorded as a documented blocker with the exact
reasons, which is what the brief asks for when it is not practical.

The consequence: **SignPath is the trust path, and signing is what buys us Smart
App Control compatibility and reputation accumulation over releases.**

### xAI: two subsystems, confirmed

The official tools are exactly as the brief describes, and they are
**server-side** — xAI executes them, which is why they do not contradict the
finding that AI17Z has no local tool-call loop. That distinction stays explicit.

`x_search`, available through the xAI SDK, the OpenAI-compatible Responses API,
and the Vercel AI SDK:

| Parameter | Notes |
|---|---|
| `allowed_x_handles` | max 20, mutually exclusive with excluded |
| `excluded_x_handles` | max 20 |
| `from_date` / `to_date` | ISO 8601 `YYYY-MM-DD` |
| `enable_image_understanding` | boolean, costs money |
| `enable_video_understanding` | boolean, costs money |

It covers keyword search, semantic search, user search and thread fetch. Notably
there is **no mode parameter and no query parameter** — the model derives both
from the conversation. That shapes the design: AI17Z's job is to build a
well-formed information need and set the filters, not to pick a mode.

`web_search` takes `allowed_domains` / `excluded_domains` (max 5, mutually
exclusive), `enable_image_understanding` and `enable_image_search`.

Citations come back as `url_citation` annotations with `url`, `title` and
character offsets, plus `server_side_tool_usage` recording which tools ran. That
last field is what lets AI17Z say *"it searched X"* only when it actually did,
which the brief requires.

### Telegram: no inbound port needed, confirmed

`https://api.telegram.org/bot<token>/METHOD`. `getMe` validates a token and
returns the bot's identity. `sendMessage` takes `chat_id`, `text`, `parse_mode`.
`getUpdates` long-polls with `offset`, `timeout` and `allowed_updates`.

Everything AI17Z needs is outbound HTTPS. Pairing works by long-polling
`getUpdates` until the owner's `/start` arrives, which carries the `chat_id`.
No webhook, no public address, no inbound firewall rule.

The published API reference does not state per-bot send rate limits, so the
implementation treats limits as unknown and defensive: dedupe first, back off on
`429`, and never let a delivery failure touch the job that raised the
notification.

---

## Order of work

1. **Documentation and truth corrections.** The SmartScreen correction, the code
   signing policy, roles, privacy statement, Store assessment. Cheap, and it is
   what a SignPath application will be read against.
2. **Release artifact and workflow.** Installer, uninstaller, checksums, release
   job, SignPath hooks with placeholders that fail safely. This unblocks the
   "already released" condition.
3. **Telegram.** Self-contained, sits under the notification system that already
   exists, highest day-to-day value.
4. **Avatar editing.** Small and self-contained.
5. **Portable agent package.** Extends a sound foundation.
6. **xAI Enhanced.** Largest, and depends on nothing above.

Nothing in this list requires touching the golden runtime, and none of it starts
until this document is committed.
