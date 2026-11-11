# Media decisions for original posts

`AI17Z_POST_MEDIA_ENABLED` defaults to `false`. Turning it on lets an original
POST use a screenshot when its brief links to a live HTTPS page. A linked
release page is a reason to show the release; a brief without a URL normally
stays text only. Ordinary replies never enter this decision.

Every original post records its decision and reason as `POST_MEDIA_DECIDED`, with
`data.phase = post_media`. Disabled posts add this observation without changing
the prompt, output, context, event or supplied attachments.

The worker captures through the channel's `capturePostMedia` hook. X uses the
existing browser's RESEARCH tab, whose creation uses the background tab path.
This optional operation cannot launch or restart a browser. Captures refuse X
URLs, their short links, redirects to X and X subresources. X content must
continue through the reading layer and its read budget. Local and private
addresses are refused too. No page is clicked, and the tab is cleared afterwards.
An unavailable browser or screenshot leaves a text-only post with a trace reason.

The screenshot is validated and stored as POST_MEDIA. Its reference is pinned in
the job's resolved context before generation and reused on retries. Execution
uses the same hash verification, adapter attachment and recovery checks as
owner-supplied media. Supplied attachments take precedence over automatic media.

## Optional creative Plugin

`AI17Z_CREATIVE_MEDIA_ENABLED` also defaults to `false`. With both flags on, a
brief without a page URL may ask an installed Plugin for an image. A manifest
declares the `CREATIVE_PROVIDER` feature and a `creative` block:

```json
{
  "capability": "make_image",
  "promptField": "brief",
  "imageField": "image_base64"
}
```

The named capability must belong to that Plugin, accept a required string
prompt and return a string containing base64 image bytes. The manifest must
declare both the feature and block. No creative provider ships enabled.

The owner must explicitly grant the capability Allowed. An unset permission is
insufficient, even for a low-risk read. Invocation uses the existing capability
permission, pause, readiness, host allowlist, timeout, quota and audit path.
Returned bytes pass through POST_MEDIA validation before attachment. Invocation
history records that an image was returned, without keeping its base64 payload.
