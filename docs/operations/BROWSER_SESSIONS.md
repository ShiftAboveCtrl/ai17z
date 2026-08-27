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
