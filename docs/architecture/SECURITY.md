# Security

AI17Z is a local-first application. It assumes one trusted operator on their own
machine, and it is built so that a mistake by that operator is recoverable and a
compromise of the database is not immediately a compromise of every account.

## Secrets

Provider API keys are the only secrets AI17Z stores.

- Read from `AI17Z_MASTER_KEY`, falling back to `XBAM_MASTER_KEY` so that
  secrets sealed before the rename stay readable without any migration.
- Sealed with AES-256-GCM under that key, a 32-byte value held in the
  environment and never persisted.
- Stored as `v1.<iv>.<tag>.<ciphertext>`; each seal uses a fresh IV, so two
  identical keys are not linkable in the database.
- Readable only through `providers.getDecryptedApiKey`. The repository's public
  column list omits `sealed_api_key`, so a key cannot reach an API response by
  accident.
- Surfaced in the UI only as an 8-character sha256 fingerprint.
- `redact()` blanks anything key-shaped before it reaches a log line or a trace.

Losing `AI17Z_MASTER_KEY` makes stored keys unrecoverable. That is the intended
failure mode: re-enter them.

## Passwords

The owner password is stored as scrypt (N=16384, r=8, p=1) with a per-user salt,
and verified in constant time. Sessions are opaque server-side rows keyed by a
sha256 of the token, so signing out revokes immediately and the raw token is
never stored.

Authentication failures return one message for both unknown addresses and wrong
passwords.

## Browser sessions

AI17Z never handles an account password. "Open sign-in" launches a real browser
window on the platform's own login page and the person signs in themselves; the
resulting session lives in a Chromium profile directory AI17Z owns.

Cookies, tokens, and storage state are never read into the application, never
displayed, and never written to the database. The session panel shows what AI17Z
knows *about* the session (mode, status, when it was last checked), not the
session itself.

"Clear session" deletes the profile directory outright.

## The action boundary

Everything before execution is reversible. The execute step is the only place
that touches the outside world, and it is guarded four times:

1. **Automation mode** — review mode holds every message for a person.
2. **Dry run** — runs the full pipeline including target verification, then stops.
3. **Rate policy** — hourly, daily, minimum spacing, and working hours. Exceeding
   a limit delays a job; it never discards one.
4. **Idempotency** — the action is claimed exactly once, and identical content to
   the same target is suppressed.

Target verification is a hard gate for browser channels. If the exact remote
object cannot be identified, the adapter refuses and the job goes to a person.

## Identity

The platform default is that an agent may not claim to be human. This is an
explicit, versioned policy field (`identity.mayDenyBeingAI`, default false), the
prompt engine states it, and the validator rejects output that violates it.

The legacy system hard-coded the opposite into its prompt. The importer drops that
instruction, reports the drop, and configures the imported agent as `INSPIRED_BY`
with the platform default intact.

Changing it is possible, deliberate, recorded as a new policy version, and
attributed in the audit log.

## Input handling

Everything arriving from a channel is data, never instruction. Incoming text is
placed in a clearly delimited context layer, and the system rules layer tells the
model to produce one message and nothing else. Adapter payloads are stored for
forensics but are never interpreted as configuration.

Tools that can reach the network are disabled by default and inert until an
explicit host allowlist is configured. An agent that can fetch arbitrary URLs is
an agent that can be steered by whatever it fetches.

## Storage

Artifacts are addressed by database id, never by client-supplied path, and the
resolved path is re-checked against the storage root before the file is served.

## What is not implemented

- No multi-user access control. The ownership boundary exists in every query
  (`ownerId` is checked on every agent, account, and provider route), so adding
  roles later does not mean revisiting them, but there is one owner today.
- No transport encryption. AI17Z binds to localhost and expects to stay there.
  Exposing it to a network means putting it behind TLS.
- No rate limiting on the API itself.
- No CSRF protection, because authentication is a bearer token in `localStorage`
  rather than a cookie, so the class does not apply.

## Importing from an older installation

The importer opens a legacy database read-only and touches nothing else. Where
it finds anything credential-shaped it reports the path and moves on: it never
opens, prints, copies or imports a secret, on the principle that anything the
importer could read is something a bug in the importer could leak.

Anything it names should be treated as compromised and rotated. A credential
that has sat in an old project directory has been backed up, synced and copied
more times than anybody remembers.
