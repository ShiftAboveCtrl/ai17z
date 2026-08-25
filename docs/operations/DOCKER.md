# Running with Docker

## Start

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# paste into XBAM_MASTER_KEY in .env

docker compose up -d
```

Open http://localhost:8080.

## Services

| Service | Image | Purpose |
| --- | --- | --- |
| `postgres` | `postgres:16-alpine` | Everything is stored here |
| `api` | `docker/node.Dockerfile` | HTTP layer; applies migrations on start |
| `worker` | `docker/worker.Dockerfile` | Jobs, channel polling, browser control |
| `web` | `docker/web.Dockerfile` | Static bundle behind nginx, proxying `/api` |

| Port | Service |
| --- | --- |
| 8080 | Web |
| 8787 | API |
| 55432 | Postgres |

## Volumes

| Volume | Holds |
| --- | --- |
| `xbam_pgdata` | The database |
| `xbam_storage` | Screenshots, diagnostics, uploads |
| `xbam_browser` | Persistent Chromium profiles, one per account |

`docker compose down` keeps them. `docker compose down -v` deletes them, and with
them every agent, memory, and job.

## Migrations

The API runs them at startup because `XBAM_RUN_MIGRATIONS=1` is set for that
service, so a fresh stack comes up ready to use. To run them by hand:

```bash
docker compose run --rm api npm run migrate
docker compose run --rm api npm run migrate:status
```

## The worker image

It is built on `mcr.microsoft.com/playwright` and is large, because the worker is
the only process that drives a browser. If you do not need a browser channel:

```yaml
worker:
  environment:
    XBAM_BROWSER_ENABLED: "0"
```

The worker then declines browser tasks with a clear message rather than failing
mid-job, and the mock channel continues to work normally.

## Browser sign-in in Docker

The worker container is headless, has no display, and has its own fresh Chromium
with none of your cookies. It cannot use a browser on your machine either: Chrome
refuses debug connections whose Host header is not localhost.

So if an agent has to act with a session you signed into, run the worker on your
machine and leave the rest in Docker:

```bash
docker compose up -d --scale worker=0
npm run dev:worker
```

[Driving a real browser](BROWSER_SESSIONS.md) covers both arrangements.

## Restart behaviour

```bash
docker compose restart
```

Jobs survive. A worker that dies mid-step leaves a lease behind; the recovery
sweep at the next worker start returns the job to the settled state before that
step and it resumes. Nothing is lost and nothing is repeated: a job recovered
from execution finds its action already claimed and completes without acting.

## Logs and health

```bash
docker compose logs -f api worker
curl http://localhost:8787/api/health/live
```

The full component report (database, queue, each provider, each account, browser)
is at `/api/health`, and is what the System section of Settings displays.

## Rebuilding

```bash
docker compose build api worker web
docker compose up -d
```

Application code is TypeScript run by `tsx`, so there is no build artefact to
drift from its source, but the images still need rebuilding to pick up changes.
