# The X runtime: three tabs in one real Chrome

## Why three

One page did everything, and that was the problem. A monitor navigating to the
notifications timeline discarded a reply composer that was open. An action
navigating to a status page threw away a monitor's place in the timeline.
Neither failure appears in a log: the work simply comes back empty.

So an account keeps three persistent tabs in the one browser:

```
REAL GOOGLE CHROME
profile: storage/browser-profiles/<account-id>

  TAB 1  ACTION         replies, posts, and the verification before them
  TAB 2  MENTIONS       mention search, reply search, own threads
  TAB 3  NOTIFICATIONS  X's own notifications, as an independent source
```

Reading no longer disrupts posting, posting no longer disrupts reading, and
notifications and mention search stop taking turns.

## How a tab knows what it is

`window.name`, not an in-process map. `packages/browser/src/tabs.ts` writes
`ai17z-tab:MENTIONS` into the page and reads it back.

That matters across a restart. A worker that reconnects to a Chrome still
running finds its three tabs already there and adopts them; an in-process map
would have lost them and opened three more, every restart, forever. It is also
why the ACTION tab adopts the blank tab a fresh Chrome opens with instead of
leaving it orphaned beside a new one.

`window.name` is cleared by a cross-origin navigation, so every lease re-asserts
the tag once it holds the tab.

## Concurrency

```
leaseSession(config, role)
   -> one browser per account          (the launch lock)
   -> one tab per role                 (adopted or created)
   -> one operation per tab at a time  (the tab lock)
```

Different roles run at the same time. Two operations on the same role queue,
because interleaving two navigations on one page produces results neither
caller asked for. A caller waiting more than two minutes gets a retryable
`tab_busy` rather than hanging.

Nothing here replaces the account lease that serialises browser *tasks* — that
still exists and still guards sign-in.

## Recovery

Each role recovers alone. A closed tab is removed from the map by its own
`close` event and recreated on the next lease; the other two are untouched, and
the browser is not restarted. This is what stops a failing monitor from ending a
sign-in somebody is halfway through.

A closed Playwright page does not throw from every method, which is exactly how
a dead tab used to look healthy. `page.isClosed()` is checked on every
acquisition.

## Health

The worker publishes a snapshot of all three tabs every ten seconds, and once
more when an account's browser goes away. The API owns no browsers and cannot
ask, so this is the only way the account page can tell a dead monitor from a
quiet one.

`browser_sessions.tabs` holds the array; `tabs_updated_at` is what makes a stale
snapshot detectable. The UI treats anything older than 90 seconds as "no browser
running" whatever the snapshot says.

## Which role does what

| Operation | Tab | Why |
| --- | --- | --- |
| `connect`, `healthCheck`, `observeAuth` | ACTION | Session-level, and sign-in happens in the first tab |
| `ingestEvents` | MENTIONS | Reading |
| `pollRadarSource('notifications')` | NOTIFICATIONS | Its own surface, on its own cadence |
| every other radar source | MENTIONS | Search and thread reads |
| `resolveContext` | ACTION | Reads the target's own page; belongs with the action |
| `verifyAction`, `executeAction` | ACTION | Must be the same tab as each other |

After a reply or a post the action tab returns to `x.com/home`. A tab parked on
a stranger's status page is one keystroke from doing something nobody asked for,
and the next action navigates from wherever it finds itself anyway.

## When a post cannot be read back

A post is EXECUTED only with read-back: an id or address read off the account's
own timeline. A submit that returned and a composer that closed are not
evidence, and X's timeline lags, so an empty scan proves nothing. Without
read-back the action is held `AMBIGUOUS` (`REVIEW_REQUIRED`), the job goes to its
owner, and `postUnconfirmed` notifies them. It is never retried automatically: a later attempt,
including one recovered from a worker that died mid-submit, asks the remote
first and sends again only on a conclusive absence. If the post is then found,
it becomes EXECUTED and the notification is resolved. Replies and likes keep the
looser recovery rule, because a duplicate of either costs less than a held post.

## A post with a picture or a video

A post may carry up to four images, or one GIF, or one video. The files are held
by AI17Z as `POST_MEDIA` artifacts, identified from their own bytes when they are
stored (PNG, JPEG, WebP, GIF, MP4, QuickTime; never SVG; a movie without its
index or samples is refused), capped per kind (5MB, 15MB, 50MB), and referred to
everywhere else by id and sha256. The executor resolves them just before the
action is claimed and checks the bytes against the hash that was approved, so a
file swapped on disk is a permanent failure with nothing sent. A channel that
does not set `supportsMedia` is refused the same way rather than being allowed
to post the text alone.

On the ACTION tab, `attachMedia` (`packages/channels/src/x/composer.ts`) gives
the files to the composer's own file input with `setInputFiles`. The "add photos"
button is never clicked: it opens a native picker, and the covered-UI rule above
applies to it as much as to the editor. Focus returns to the editor afterwards,
because the keyboard submit fallback needs it there. It is finished when every
file has its tile, nothing shows progress and the post button is enabled, within
a bound per kind (60 seconds, 90, 300). A failed or stalled upload, a missing
file input and a toast from X are all **retryable**: this runs before the submit,
so nothing was sent. Every selector is in `selectors.ts`.

Read-back covers the media too. The post is found on the profile as before, and
its article is then checked for what was sent: images are counted, a video needs
a player, a GIF may be drawn as either. The adapter states the result as
`mediaConfirmed`; the executor treats anything but `true` on a post that was
sent with files as unconfirmed, so the post is held `AMBIGUOUS` exactly like one
that could not be found. A post that is public but without its picture is not
recorded as done, and its address is in the evidence for the owner.

## What this does not change

The browser architecture underneath is exactly the one proved in
`docs/legacy-real-chrome-analysis.md`: real Google Chrome, started by AI17Z with
a dedicated profile, attached over CDP with `chromium.connectOverCDP`. Tabs are
a layer on top of that and touched none of it.

## Acceptance

`tests/integration/realChrome.test.ts`, against Google Chrome 151:

- three roles leased at once share one browser and get three distinct pages
- leasing a role twice returns the same tab, not a fourth one
- closing the mentions tab leaves the action tab untouched, and the next lease
  recreates only the mentions tab
- two operations on one tab serialise, in order

These skip loudly where Chrome is not installed. A skip is not a pass.
