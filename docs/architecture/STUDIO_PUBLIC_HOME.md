# Public home: local consent and Studio contract

Core owns preview, owner consent and the last acknowledged state. Studio owns the public page. Publication and link posting are off by default. Three `studio_home.*` capabilities are OWNER-audience and disabled until granted. The API additionally checks the signed-in owner. The model cannot supply confirmation: the publish capability requires the owner's complete `publish home <digest>` message from the harness.

Migration 0127 stores local state in `agent_public_home`, keyed to the local agent with cascading deletion. No state, pending preview, posting flag, origin or URL is part of either portable format or SHARE/MOVE packages. No CHECK-backed enum is introduced.

Preview stores an immutable snapshot, its canonical JSON SHA-256, a UUID idempotency key, the current Studio origin and installation id, and a fifteen-minute expiry. Publication sends exactly that snapshot. A new preview replaces the old pending confirmation. Editing choices in the UI clears the displayed preview. An expired preview or changed link needs a new preview. Every network write uses installation DPoP, never a bearer secret. No transport failure or response body is logged or copied into an error message.

The manifest has exactly `protocol`, `identity`, `simulated`, `alias`, `showActivity`, `leagueEntryId`, `voice`, `paper`, `league`, and `receipts`. Identity is always `AI_AGENT`; simulated is always true. Voice uses the existing strict VoiceDocument projection, titled with the public alias. Paper includes only complete-window totals, source time, cost assumptions and open-position treatment from the existing Studio paper record, without decisions. League includes only simulated aggregate standing and its entrant-reported basis. Receipts contain only id, kind, publication time and dry-run status. Receipt actions must satisfy the same capability consent floor, mock/rehearsal exclusion and scrub list as the tape. No memory, private prompt, relationship, account identity, credential, wallet or local agent name has a manifest field. Owner-authored voice text is visible in full before consent and needs the same review as a voice listing.

An asked-for record link follows the ordinary reply pipeline, deterministically, without a model rewrite. A separate owner switch permits one home-link idea per digest. It enters the existing posting engine, which applies reticence, quality, quiet hours, cadence, dry run and execution gates. The send boundary rechecks publication and posting consent. Last-confirmed state is retained on failure. The initial confirmation expires with its preview; acknowledged renewals can extend it. A snapshot is unavailable while control is off, after a failed publish or removal, or after relinking. The UI labels the last confirmation and withholds a stale link. The worker renews an unchanged current snapshot under the lease below. A new preview and owner confirmation is required after expiry or a terminal refusal.

## Installation receiver and lease renewal

Studio branch `feat/public-home-receiver` accepts installation DPoP writes at
`POST /api/v1/installation/agents/<local agent id>/home`. The receiver checks the
installation, owner, holder standing, agent state and alias. Core pins each write
to the preview's `origin`, `installationId` and `linkedAt`.

* `PUBLISH`: `{ protocol: 1, operation: 'PUBLISH', idempotency_key: <UUID>, manifest, manifest_sha256 }`.
  The manifest is the immutable owner-confirmed preview. Reused keys cannot
  change its bytes or resurrect a removed revision.
* `UNPUBLISH`: `{ protocol: 1, operation: 'UNPUBLISH', idempotency_key: 'remove:<publish UUID>', publication_keys: [<UUID>, ...], manifest_sha256 }`.
  Core lists at most the uncertain pending revision and last confirmed revision.
  Removal remains possible with control off and cannot remove a later revision.
* `RENEW`: `{ protocol: 1, operation: 'RENEW', idempotency_key: <UUID>, publication_key: confirmed.revision, manifest_sha256: confirmed.digest }`.
  No manifest or content is sent. The existing worker sweep calls
  `sweepPublicHomeRenewals`, serialized by the same per-agent advisory lock used
  by preview, publish and removal. It attempts at most once every five minutes,
  only for a published, current home on the same link with control enabled and
  no unknown outcome. A persisted attempt key survives transport failures and
  process restarts; retries reuse it. Each successful renewal clears that key.

Publish and removal acknowledgements carry `protocol: 1`, `published`, `slug`
and `manifest_sha256`. Renewal additionally requires `valid_until`. Only a 200
renewal acknowledging the same slug and digest advances `confirmedAt`, and
`validUntil` is capped at the earlier of Studio's expiry and now plus fifteen
minutes. The revision, digest and slug stay unchanged. Consent and link are
checked again after transport. Core constructs the public URL from its pinned
origin and validated slug, never a supplied URL.

Transport failures, malformed or mismatched acknowledgements, 429 and 5xx keep
the last confirmation and retry on a later sweep. A 403 or 409 stops renewal for
that revision. `publication_expired` and `renewal_limit` raise one owner info
notice to preview and publish again, then let the existing confirmation lapse.
Other refusals mark it unavailable immediately. Publishing again or unpublishing
clears the notice. Studio caps renewals at twenty-four hours from publication;
only a fresh owner-confirmed publication can start another span. A stale home
is never renewed or resurrected by the worker.

The local contract server exercises DPoP signatures, token binding, publication,
removal and renewal, including consent, timing, lost responses, terminal refusals
and expiry capping. This is not verification against a deployed Studio or its
public renderer. No Studio files are changed.
