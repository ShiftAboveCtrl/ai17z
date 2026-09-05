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
