# Local setup

For working on XBAM without Docker for the application itself.

## Requirements

- Node 22 or newer
- Postgres 16 (the compose file provides one on port 55432)
- Docker, only for that Postgres

## First time

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# paste into XBAM_MASTER_KEY in .env

npm install
npm run db:up
npm run migrate
npm run dev
```

`npm run dev` runs the API, the worker, and the web dev server together with
prefixed output. Open http://localhost:5173.

| Process | Port | Command |
| --- | --- | --- |
| API | 8787 | `npm run dev:api` |
| Web | 5173 | `npm run dev:web` |
| Worker | — | `npm run dev:worker` |
| Postgres | 55432 | `npm run db:up` |

The web dev server proxies `/api` to 8787, so the browser sees one origin exactly
as it does in Docker.

## Browsers

Playwright is only needed for browser channels and the visual validation harness:

```bash
npx playwright install chromium
```

Set `XBAM_BROWSER_ENABLED=0` to switch browser work off entirely. The worker then
declines browser tasks with a clear message instead of failing part-way through
a job.

`XBAM_BROWSER_HEADLESS=0` (the default in development) is what makes "Open
sign-in" able to show you a real window.

## Everyday commands

```bash
npm run typecheck          # tsc across every package and app
npm test                   # unit + integration
npm run migrate:status     # applied / pending / drifted
npm run import:ai4cz -- --dry-run
```

## Tests and the database

Integration tests target a sibling `xbam_test` database, derived from
`DATABASE_URL` and created on first run. They truncate every table between cases,
so never point `DATABASE_URL` at data you care about.

## Visual validation

```bash
SHOT_TOKEN=<a session token> node tools/shots/capture.mjs
```

Screenshots land in `var/shots` at five viewports, and any console error is
reported. `SHOT_REDUCED=1` captures with `prefers-reduced-motion` forced on.

## Windows notes

This was developed on Windows, and two things are worth knowing.

**OneDrive and npm workspaces.** OneDrive's sync filter intermittently locks
directories while npm is creating workspace junctions, producing `EBUSY` on
`npm install`. Re-running usually completes it. If one link is left missing:

```powershell
New-Item -ItemType Junction -Path node_modules\@xbam\<name> -Target <path>
```

**Line endings.** `.gitattributes` normalises everything to LF.

## Resetting

```bash
docker compose down -v     # deletes the Postgres volume and all data
npm run db:up
npm run migrate
```
