# Public radar sources

The public activity tape may include an exact ticker pin and the stored source
post URL. It reads existing event discoveries and radar sources, never X.

In Social radar, save a Keyword watch with an exact uppercase ticker target such
as `$SOL` and select Share this ticker and source post on Studio. Publication
also needs the installation activity tape enabled and the agent's
`studio.activity_tape` permission ALLOWED. Existing watches default to private.
Saving that same watch unchecked keeps future source details private. Remove
previously published rows through Studio's owner tape controls or the local
`/api/studio/activity-tape/scrub` route.

Only enabled, explicitly opted-in X ticker watches qualify. A search phrase,
missing or invalid URL, removed source, lowercase ticker, or unshared watch
retains the existing bare radar row. No asset is inferred from post prose.
No text, target handle, wallet, recommendation or outcome leaves the install.

Release Studio's optional `radar` receiver and migration before enabling source
sharing. Older senders remain valid. Older strict receivers reject the new
detail, so keep sharing off until the receiver supports it.
