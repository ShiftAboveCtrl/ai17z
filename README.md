# AI17Z

A local-first platform for building and running autonomous agents.

An agent in AI17Z is an identity, a memory, a model, a policy, and the channels it
is allowed to act on. None of that is code: you create an agent, give it a voice,
point it at a model, connect an account, and turn it on. The runtime underneath
is deliberately boring — Postgres, a job table, typed contracts — so that the
interesting part is the agent, not the plumbing.

AI17Z is the successor to a working system called AI4CZ. It keeps that system's
best ideas, replaces its architecture, and imports its history as one agent.

---

## What it does

- **Durable pipeline.** Every inbound event becomes an immutable record and a
  job. Jobs survive restarts and resume from the last completed step.
- **Answerable behaviour.** Every generation stores its prompt layers, the
  memories it retrieved and *why*, every model attempt, and the verification
  that preceded the action.
- **Idempotent execution.** The same event cannot produce two remote actions.
  Not by convention — by unique index.
- **Memory that spans conversations.** Six scopes, with an explicit write policy
  and deterministic retrieval you can inspect.
- **Replaceable models.** OpenAI, Anthropic, OpenRouter, Ollama, any
  OpenAI-compatible endpoint, and a deterministic mock, behind one gateway with
  a fallback chain.
- **A safe default.** Dry run runs the whole pipeline, verifies the target, and
  stops before touching anything real.

---

## Quick start with Docker

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# paste that into AI17Z_MASTER_KEY in .env
docker compose up -d
```

Then open **http://localhost:8080** and create your owner account.

| Service  | URL                   |
| -------- | --------------------- |
| Web      | http://localhost:8080 |
| API      | http://localhost:8787 |
| Postgres | localhost:55432       |

The API applies migrations on start, so a fresh stack comes up ready to use.

> The worker image is built on the Playwright base image and is large. If you do
> not need a browser channel, set `AI17Z_BROWSER_ENABLED=0` and the worker will
> decline browser work cleanly rather than failing mid-job.

---

## Quick start without Docker

You need Node 22+ and a Postgres you can reach.

```bash
cp .env.example .env          # then fill in AI17Z_MASTER_KEY
npm install
npm run db:up                 # or point DATABASE_URL at your own Postgres
npm run migrate
npm run dev                   # api + worker + web
```

Open **http://localhost:5173**.

---

## First run

1. **Create your owner account.** Local, one person, stored as a scrypt hash.
2. **Add a model provider.** Settings → Add provider. Ollama needs no key.
   Everything else takes an API key, encrypted at rest with your master key and
   never returned by the API afterwards.
3. **Create an agent.** Eight short steps. Keep the mock channel.
4. **Inject a test event.** On the agent page, Activity → *Inject a test event*.
   The whole pipeline runs locally: context, memory, prompt, model, validation,
   target verification. Only the final action is simulated.
5. **Open the job.** Every decision it made is on one page.

Nothing here requires X, or any external account at all.

---

## Importing AI4CZ

```bash
npm run import:ai4cz -- --dry-run    # read and report, write nothing
npm run import:ai4cz                 # import for real
```

Set `AI4CZ_LEGACY_DIR` in `.env` first. The legacy project is opened read-only
and is never modified. The importer is idempotent: running it twice imports
nothing the second time.

It brings across the persona, the voice corpus, the conversation history, and
the ledgers that stop the agent replying to a year-old backlog. It does **not**
bring across API keys, cookies, browser sessions, or the instruction telling the
model never to admit what it is. See
[`docs/legacy-ai4cz/MIGRATION.md`](docs/legacy-ai4cz/MIGRATION.md).

---

## Layout

```
apps/api        HTTP layer
apps/worker     jobs, channel polling, browser control
apps/web        the interface
packages/       shared contracts, database, runtime, memory, prompts,
                models, channels, browser, jobs, tools
migrations/     numbered SQL, applied in order
tools/          the AI4CZ importer, visual validation
docs/           architecture, operations, migration
```

## Testing

```bash
npm test          # unit + integration, against real Postgres
npm run typecheck
```

## Documentation

- [Architecture overview](docs/architecture/OVERVIEW.md)
- [Data model](docs/architecture/DATA_MODEL.md)
- [Jobs and the runtime](docs/architecture/JOBS.md)
- [Memory](docs/architecture/MEMORY.md)
- [Channels](docs/architecture/CHANNELS.md)
- [Models](docs/architecture/MODELS.md)
- [Pipelines](docs/architecture/PIPELINES.md)
- [Security](docs/architecture/SECURITY.md)
- [Local setup](docs/operations/LOCAL_SETUP.md)
- [Docker](docs/operations/DOCKER.md)
- [Driving a real browser](docs/operations/BROWSER_SESSIONS.md)
- [AI4CZ migration](docs/legacy-ai4cz/MIGRATION.md)

## License

Private project. Not licensed for redistribution.
