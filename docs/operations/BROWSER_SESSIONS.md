# Driving a real browser

Channels like X act on an account you own, using a session you signed into
yourself. AI17Z never handles your password: it drives a browser that is already
signed in.

There are two ways to arrange that, and the right one depends on where the
worker runs.

## The constraint that decides it

**Only the worker opens browsers.** A Chromium profile can be held by one
process at a time, so the API records intent in `browser_tasks` and the worker
carries it out.

**A containerised worker cannot use a browser on your machine.** Chrome binds its
debug port to loopback and refuses connections whose `Host` header is not
localhost, so attaching from a container is rejected even when the port is
reachable. The container also has its own fresh Chromium with none of your
cookies.

So: if the agent must act with your real session, **run the worker on your
machine**, not in Docker.

## Option A — Managed profile (recommended when AI17Z owns the browser)

AI17Z launches the browser and owns a persistent profile directory. You sign in
once through the UI and the session lives in that profile across restarts.

1. Open the account in AI17Z, set **Browser → Managed profile**.
2. Pick the build: **Real Chrome**, **Real Edge**, or **Bundled Chromium**.
   Real Chrome uses the browser already installed on the machine running the
   worker; bundled Chromium is what the container has.
3. Click **Open sign-in**. A real window opens on the platform's login page.
4. Sign in there yourself.
5. Click **Test session**. It should report connected.

Real Chrome requires the worker to run where Chrome is installed. In Docker,
only `chromium` is available.

## Option B — Attach over CDP (when you want to keep the browser yourself)

AI17Z attaches to a browser you started, and never closes it.

```powershell
npm run browser:cdp                       # port 9222, dedicated profile
npm run browser:cdp -- -Port 9223         # a second account
npm run browser:cdp -- -Browser edge
```

Then:

1. Sign in to the platform in the window that opens. The profile persists, so
   this is a one-time step per account.
2. In AI17Z, set **Browser → Attach over CDP** and the URL to
   `http://127.0.0.1:9222`.
3. Run the worker on that same machine:
   ```bash
   npm run dev:worker
   ```
4. Click **Test session**.

The launcher uses a dedicated profile under `storage/browser-profiles/cdp-<port>`
rather than your everyday Chrome profile. That matters: Chrome refuses
`--remote-debugging-port` on a profile another Chrome instance already has open,
so using your day-to-day profile would mean closing your browser every time.

AI17Z detaches from a CDP browser when it is done. It does not close it.

## Running the worker on the host with the rest in Docker

The worker only needs the database, which Docker publishes on 55432.

```bash
docker compose up -d --scale worker=0     # api, web, postgres only
npm run dev:worker                        # worker on your machine
```

Or stop an already-running one with `docker compose stop worker`.

Both workers can safely run at once — job claiming uses `FOR UPDATE SKIP LOCKED`
— but the containerised one will fail browser tasks it cannot serve, so it is
cleaner to run one.

## Playwright version pinning

The worker image ships browser binaries for exactly one Playwright release. The
npm version and the image tag must match exactly:

| Where | Value |
| --- | --- |
| `packages/browser/package.json` | `"playwright": "1.62.1"` |
| `docker/worker.Dockerfile` | `mcr.microsoft.com/playwright:v1.62.1-jammy` |
| root `package.json` | `"@playwright/test": "1.62.1"` |

A caret range here is a latent break: npm floats to a newer Playwright, the image
still carries the old binaries, and the first browser launch fails with a missing
executable rather than anything that mentions versions.
`tests/unit/playwrightVersion.test.ts` fails if they drift.

To move to a new version, change all three together and rebuild:

```bash
docker compose build worker && docker compose up -d worker
```

## What AI17Z deliberately does not do

It does not spoof fingerprints, patch `navigator.webdriver`, rotate user agents,
or simulate human input timing. The legacy AI4CZ project carried roughly 900
lines of that; none of it was carried across.

What AI17Z does instead is use a real browser with a real session you signed into,
and pace itself through the rate policy. Short randomised settle delays exist
because the X timeline is virtualised and acting on a stale frame is the largest
source of flaky automation, not to disguise anything.


## Three ways to give AI17Z a browser

### 1. AI17Z Chrome profile — recommended

AI17Z launches **your installed Chrome** with a profile directory kept for that
account:

```
storage/browser-profiles/<account-id>
```

You sign in once, by hand, in the window it opens. The profile persists, so
every later run reuses that session and no credential is ever needed again.
AI17Z never sees your password: you type it into a real Chrome window.

This is the default and the one to reach for.

**On a first sign-in a platform may say it has temporarily limited the login.**
A profile AI17Z has just created has no cookies, no history and no extensions,
which is unusual for an account with years behind it. Repeated attempts make it
worse and are usually what triggered it in the first place. Wait, then sign in
once and let the profile keep the session.

### 2. Attach to a Chrome you already have open — not available yet

Chrome 144 added a way for an agent to ask a *running* Chrome for a debugging
session, which you approve at `chrome://inspect/#remote-debugging`. That is the
right shape for this: your real browser, your real session, and an explicit
permission each time.

AI17Z does **not** implement it. The mechanism behind it is not documented in
enough detail to build against without guessing, and public reports disagree
about whether it uses the old `DevToolsActivePort` discovery or a new request
API. It will be added when the mechanism is documented, not before.

Note also what Chrome says about this mode: while a debugging session is active
your agent inherits everything the browser is signed in to. That is a reason to
be deliberate about it, not a reason to avoid it.

### 3. Custom CDP endpoint — advanced

Start a browser yourself and point AI17Z at it:

```powershell
.\scripts\launch-chrome-cdp.ps1
```

It uses a dedicated directory because **Chrome has refused
`--remote-debugging-port` on the default profile directory since version 136**.
Sign in once in that window; the profile persists there too.

Set the account to **Custom CDP endpoint** with the URL the script prints, and
leave the window open while AI17Z is working.

## Profile seeding is experimental, and usually does not work on Windows

`launch-chrome-cdp.ps1 -SeedFromProfile Default` copies an existing Chrome
profile into the debugging directory. It is kept as a fallback, and it is **not**
part of normal onboarding.

Since Chrome 127, App-Bound Encryption ties cookies to Chrome's own identity
rather than to the Windows user, and Chrome discards cookies it finds in a
directory they were not encrypted for. Copying `Local State` does not change
that. History, bookmarks and preferences do come across; the login usually does
not.

Use it only if you have a reason to, expect the window to open signed out, and
sign in by hand when it does.

## Signing in is yours, always

Whichever mode you use, AI17Z never types a password and never answers a
security challenge. When X asks for a code, a CAPTCHA, a key, or confirmation
that a sign-in was really you, the account moves to `CHALLENGE_REQUIRES_USER`,
the window is left open and untouched, and the watcher **stops reading the
page** so it is not looking while you type. See
[docs/architecture/SIGN_IN.md](../architecture/SIGN_IN.md).
