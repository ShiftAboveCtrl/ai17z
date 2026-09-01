# Real Google Chrome: what AI4CZ and AI4YI actually did

Static analysis only. Neither legacy project was modified, executed, installed
into, or formatted. `ai4cz` last changed 2026-08-23 18:44, before this work
began; `ai4yi` was read from the AI4YI checkout.

---

## 1. AI4CZ browser architecture

### The browser binary

**Real Google Chrome, installed at the system location.** Never Playwright's
bundled Chromium.

```
C:\Program Files\Google\Chrome\Application\chrome.exe
```

Evidence: `HOW TO START EVERYTHING.js` §1 steps 3 and 4, and §9; and
`start-chrome-playwright.ts`.

### Who started it

**A person, externally, before the scripts ran.** Playwright never launched the
browser. The scraper says so in its own header comment:

> `scripts/scrape-notifications-to-inbox.js:11-13`
> ```
> // - Uses CDP attach (chromium.connectOverCDP) to an *already running* Chrome profile
> // - This script will NOT launch Chrome (you do that separately per profile/port)
> ```

### How Playwright connected

`chromium.connectOverCDP()` — the Chromium *API namespace* driving a *Google
Chrome* binary. These are different things and the distinction is the whole
point.

| | Scraper | Poster |
| --- | --- | --- |
| File | `scripts/scrape-notifications-to-inbox.js` | `scripts/post-replies-cdp.js` |
| Connect | `connectCDPBrowser()` → `chromium.connectOverCDP(cdpHttp)` (line 400) | `ensureCDPSession()` → `chromium.connectOverCDP(CDP_URL)` (line 1082) |
| Endpoint | `process.env.CDP_URL` → `http://127.0.0.1:9223` | `process.env.CDP_URL` → `http://127.0.0.1:9222` |
| Pre-flight | `cdpPreflight()` — `GET {CDP_URL}/json/version`, fatal on failure | none; the connect itself throws |
| Connect timeout | 30s via `Promise.race` | none |

### Ports and why there were two

Two Chrome instances were **required**, not incidental. From the runbook §4:

> Two separate Chromes are REQUIRED
> Poster uses: profile `C:\chrome-profiles\ai4cz`, port 9222
> Scraper uses: profile `C:\chrome-profiles\ai4cz_scraper`, port 9223, opens
> `https://x.com/notifications`
> **If you reuse the same profile or port, you'll get flakiness, auth friction,
> and weird state bleed.**

| Port | Role | Profile |
| --- | --- | --- |
| 9222 | posting replies | `C:\chrome-profiles\ai4cz` |
| 9223 | reading notifications | `C:\chrome-profiles\ai4cz_scraper` |

Both profiles were **separately and manually logged into the same X account**.

### Profiles

- **Dedicated**, at `C:\chrome-profiles\<name>` — outside the repository and
  outside Chrome's own `User Data` directory.
- **Never the everyday Chrome profile.**
- **Persistent**: the session survived restarts because the user-data directory
  survived restarts. There is no cookie import, no `storageState` load, and no
  profile copying anywhere in the live path.
- Switching accounts meant **new profile directories**, explicitly: "do NOT
  reuse existing ones" (runbook §7A).

### The startup command

```powershell
Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  -ArgumentList '--user-data-dir="C:\chrome-profiles\ai4cz" --remote-debugging-port=9222 --start-maximized'
```

### Headed or headless

**Headed.** `--start-maximized`, and the poster calls `page.bringToFront()`.
There is no `headless` flag anywhere in the live CDP path.

### How the login survived restarts

Entirely through the **persistent user-data directory**. A person signed in once
per profile, by hand, and Chrome kept it. The runbook's recovery advice for a
failing scraper is "check you're logged in on that profile" — a human check, not
a credential mechanism.

`twitter-session.json` and `x-session-data/` exist but belong to
`playwrightPoster.js` and `scrape_cz_tweets.js`, which are **superseded
standalone scripts**, not the live CDP path.

---

## 2. AI4YI browser architecture

### The finding that matters

**AI4YI's browser automation is byte-identical to AI4CZ's.**

```
scripts/scrape-notifications-to-inbox.js   1155 lines both, 1 line differs
scripts/post-replies-cdp.js                1420 lines both, 1 line differs
```

Both differences are the same thing:

```diff
- const SELF_HANDLES = (process.env.SELF_HANDLES || "ai4cz,ai4cz_binance")
+ const SELF_HANDLES = (process.env.SELF_HANDLES || "ai4yi,ai4yibinance")
```

The script inventories are identical — no file exists in one and not the other.

AI4YI is the **same system rebranded for a different X account**, not a rewrite.
The premise that it contains an optimised browser implementation is not
supported by the code.

### What AI4YI genuinely improved

One thing, and it is in the launch path. `HOW TO START EVERYTHING.js`, AI4CZ
2026-01-15 → AI4YI 2026-01-22:

```diff
- Start-Process "...chrome.exe" `
-   -ArgumentList '--user-data-dir="C:\chrome-profiles\ai4cz" --remote-debugging-port=9222 --start-maximized'
+ Start-Process "...chrome.exe" -ArgumentList @(
+   "--user-data-dir=C:\chrome-profiles\ai4cz",
+   "--remote-debugging-port=9222",
+   "--remote-debugging-address=127.0.0.1",
+   "--no-first-run",
+   "--no-default-browser-check",
+   "--start-maximized"
+ )
```

Three added flags and one structural change:

| Change | Why it is better |
| --- | --- |
| `--remote-debugging-address=127.0.0.1` | Binds the debug port to loopback. Without it the port can be reachable from the network, and anything that reaches it drives the signed-in browser. |
| `--no-first-run` | A fresh profile otherwise opens Chrome's first-run flow over the page being automated. |
| `--no-default-browser-check` | Same, for the "make Chrome default" prompt. |
| Argument **array** instead of one quoted string | PowerShell quoting around a path with backslashes is a known way to end up with a mangled `--user-data-dir` and a silently different profile. |

---

## 3. AI4CZ vs AI4YI

| Category | AI4CZ | AI4YI | Stronger | Why |
| --- | --- | --- | --- | --- |
| Chrome startup | `Start-Process`, single quoted arg string | `Start-Process`, argument array, 3 extra flags | **AI4YI** | Loopback binding and no first-run interference |
| Browser executable | System Chrome | Identical | — | Same |
| Profile handling | Dedicated persistent dirs | Identical | — | Same |
| CDP | `connectOverCDP` + preflight | Identical | — | Same |
| Ports | 9222 / 9223 | Identical | — | Same |
| Reconnection | `ensureCDPSession` with real health check | Identical | — | Same |
| Session persistence | user-data-dir | Identical | — | Same |
| Notification monitoring | 20s poll, adaptive hibernation | Identical | — | Same |
| Posting | 5–10s spacing, 45s strolls | Identical | — | Same |
| Timeouts | 30s CDP, 15min stale | Identical | — | Same |
| Poll cadence | 20s idle, hibernate 3–6/6–12 min | Identical | — | Same |
| Navigation, typing, submission | Identical | Identical | — | Same |
| Failure recovery | Identical | Identical | — | Same |
| Target verification | Identical | Identical | — | Same |

**AI4YI wins on exactly one axis: how Chrome is launched.** Everything else is
the same code.

---

## 4. The real working model

```
  A PERSON
     |  runs once, by hand
     v
  Google Chrome  C:\Program Files\Google\Chrome\Application\chrome.exe
     |
     |  --user-data-dir=C:\chrome-profiles\ai4cz        (dedicated, persistent)
     |  --remote-debugging-port=9222
     |  --remote-debugging-address=127.0.0.1            (AI4YI)
     |  --no-first-run --no-default-browser-check       (AI4YI)
     |  --start-maximized                               (headed)
     v
  Chrome keeps running, independently of any script
     |
     |  the person signs in to X once, in this window
     v
  persistent authenticated X session, on disk in the profile
     |
     v
  Node script                       CDP preflight: GET /json/version
     |                              chromium.connectOverCDP("http://127.0.0.1:9222")
     v
  poster (9222)  /  scraper (9223)
```

Two of these, on two ports, with two profiles.

---

## 5. Techniques worth adopting

### The CDP health check that actually works

`ensureCDPSession()` (`post-replies-cdp.js:1053`) does not trust
`browser.isConnected()` alone. It calls **`await page.title()`**, because that
round-trips the CDP pipe and throws when the pipe is stale:

```js
// 🔍 REAL health check: this throws if CDP is stale
await CDP_PAGE.title();
```

This is the same lesson AI17Z learned the hard way earlier in this project: a
closed persistent context returns an empty array from `pages()` rather than
throwing, so a cache looks healthy until the next operation fails.

### Finding the right page rather than opening one

```js
const xContext = contexts.find((ctx) => ctx.pages().some((p) => p.url().includes("x.com")))
  || contexts[0] || (await browser.newContext());
let page = xContext.pages().find((p) => p.url().includes("x.com"));
if (!page) { page = await xContext.newPage(); await page.goto("https://x.com/home", ...); }
```

Reuses the tab a person already has open instead of piling up new ones.

### Login detection by any of several markers

`detectLoggedIn()` tries ten selectors — home link, profile link, compose
button, navigation, and several `href` anchors — because X changes one at a
time. AI17Z's `SEL.loggedIn` currently checks two.

### Timing

| Setting | Value | Purpose |
| --- | --- | --- |
| `POLL_EVERY_MS` | 20s | idle notification scan |
| `MAX_PER_POLL` | 2 | burst protection |
| `POST_INGEST_COOLDOWN` | 4–9s random | between ingests |
| `HIBERNATE` | 3–6 min | after 8 idle polls |
| `HIBERNATE_RECOVERY` | 6–12 min | after a sustained busy period |
| `CDP connect timeout` | 30s | `Promise.race` |
| `CDP_STALE_MS` | 15 min | poster session recycle |
| `MIN_DELAY` / `MAX_DELAY` | 5–10s | between posts |
| `MAX_CONSECUTIVE_ERRORS` | 3 | poster stop condition |

The scraper **never reloads and never scrolls down** — notifications are treated
as a live stream, pinned to the top.

---

## 6. The decision for AI17Z: spawn, then attach

Two candidate designs:

**A. Playwright launches Chrome** — `launchPersistentContext(dir, { channel: 'chrome' })`.
This is what AI17Z does today and it *is* real Chrome.

**B. AI17Z spawns `chrome.exe`, then `connectOverCDP`** — what the legacy system did.

**B is adopted**, for reasons that survive scrutiny:

| Property | A: Playwright launches | B: spawn + attach |
| --- | --- | --- |
| Real Chrome | yes | yes |
| Persistent profile | yes | yes |
| **Survives a worker restart** | **no** — Playwright closes the browser when its client disconnects, so restarting the worker kills a window somebody may be signing in to | **yes** — Chrome is its own process and the worker reattaches |
| Explicit executable | no — Playwright resolves `channel: 'chrome'` internally | **yes** — AI17Z picks the path and can report it |
| PID for diagnostics | not exposed | **yes** |
| Automation flags | Playwright adds `--enable-automation`, sets `navigator.webdriver` | not added |
| Matches what worked here for months | no | **yes** |

The last two rows deserve care. AI17Z is **not** adding evasion: it adds no
flags to hide anything, and it still stops at every security challenge. The
difference is that a browser started as an ordinary browser is an ordinary
browser, and one started by an automation harness announces itself. Choosing not
to announce is not the same as disguising, and this is the configuration this
account ran under for months.

The legacy system needed a **person** to run `Start-Process` because the scripts
were standalone. AI17Z's Browser Host can own that lifecycle instead — which is
the modern-architecture half of the requirement.

---

## 7. What is adopted, and what is not

**Adopted**

- Real `chrome.exe`, discovered on disk, path recorded and displayed
- Spawned by the Browser Host with the AI4YI flag set
- Dedicated persistent profile per account, already at
  `storage/browser-profiles/<account-id>`
- `connectOverCDP` after a `/json/version` preflight
- `page.title()` as the liveness check
- Reuse an existing x.com tab rather than opening another
- Wider login detection
- Legacy timings folded into AI17Z's cadence engine, not scattered as sleeps

**Not adopted**

- **Two Chrome instances per account.** Legacy needed them because two
  standalone scripts fought over one browser. AI17Z serialises per-account work
  behind an account lease, which is the same problem solved once, properly. One
  Chrome per account, one port.
- **Fixed ports 9222/9223.** Ports are allocated per account.
- **A person running `Start-Process`.** The Browser Host does it.
- **`storageState` / cookie files.** Superseded in the legacy repo too.
- **Idle "strolling"** — scrolling and dwelling to look human. That is
  behavioural camouflage, and AI17Z does not do camouflage.
