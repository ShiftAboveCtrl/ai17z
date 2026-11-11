# Public radar sources

The public activity tape may include an exact ticker pin and the stored source
post URL. It reads existing event discoveries and radar sources, never X.

In Social radar, save a Keyword watch with an exact uppercase ticker target such
as `$SOL` and select Share this ticker and source post on Studio. Publication
also needs the installation activity tape enabled and the agent's
`studio.activity_tape` permission ALLOWED. Existing watches default to private.
Saving that same watch unchecked keeps future source details private. Switching
source sharing off, disabling or deleting the source, or disabling installation
tape sharing automatically queues removal of previously shared radar rows.
The worker sends those tombstones through the existing activity tape transport,
even while sharing is off. Failed removals remain queued until acknowledged.
The worker must be running and linked to Studio for removal to finish. Manual
removal remains available through `/api/studio/activity-tape/scrub`.

Only enabled, explicitly opted-in X ticker watches whose ticker starts with a
letter qualify. `$100` is not an asset pin. Consent is checked again before
sending. A search phrase, missing or invalid URL, lowercase ticker, or unshared
watch carries no source details. New private discoveries retain the bare radar
row. Previously shared rows are removed after withdrawal. No asset is inferred
from post prose. No text, target handle, wallet, recommendation or outcome leaves the install.

Older senders remain valid. When an older strict receiver rejects a batch with
HTTP 400 or 422, the sender retries once with all radar detail removed. Event ids,
other tape events and removals stay intact, and acknowledgement advances the
cursor. Transport failures retain the cursor and queued removals for retry.

The local delivery ledger records radar ids before transport, including attempts
whose acknowledgements are lost. Only acknowledged removals clear that metadata.
On upgrade, existing discovery ids seed the ledger conservatively so historical
rows can also be removed. Owner setting changes queue removals immediately; the
worker also checks for withdrawals on each sweep.
