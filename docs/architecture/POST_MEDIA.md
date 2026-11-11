# Original-post media

Both post-media runtime flags default off. A decision is persisted once per job,
including disabled and negative decisions. Disabled decisions emit no trace and
leave prompt, event, output and resolved-context bytes unchanged.

Screenshots require an owner-authored idea (`manual` or `you`) and exact hosts in
`policy.media.allowedCaptureHosts`. The default empty list denies all capture.
Redirects and embedded requests must also use declared public HTTPS hosts.
Capture uses a fresh cookie-less CDP browser context and a background target;
the context is disposed after capture, including on failure. The actual connected
server IP must be public before any screenshot bytes are retained.

An explicitly enabled creative Plugin receives the post brief (up to 2,000
characters) through its declared prompt field. Its normal capability permission,
network, quota and audit checks apply. Adding or changing this declaration is an
approval footprint expansion. Rehearsals and dry runs may decide and capture,
but their execution gate must never publish.
