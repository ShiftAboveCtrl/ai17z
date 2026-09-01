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

## What you need

- **Docker Desktop** (Windows) or **Docker Engine** (Ubuntu)
- **Node 22 or newer**, for the worker that drives the browser
- **Google Chrome**, if you want to connect an X account

Chrome is the real thing, not Chromium and not Edge. AI17Z spawns it and
attaches over the debugging protocol, and refuses to substitute another browser
for it. Everything else works without one.

## Install on Windows

Three commands, from a PowerShell window in a folder you can write to:

```powershell
git clone REPLACE_WITH_AI17Z_GITHUB_URL ai17z
cd ai17z
.\install-ai17z.ps1
```

Then start it:

```powershell
.\start-ai17z.ps1
```

and open **http://localhost:8080**. The first screen asks you to create an
account; that account is yours and lives only on this machine.

`install-ai17z.ps1` checks Docker, Node and Chrome, tells you what is missing
and where to get it, and writes a `.env` with a master key generated for your
installation. It installs nothing behind your back. It never overwrites an
existing `.env`, because that file holds the key your stored provider
credentials are encrypted with.

If any of it does not work, run `.\doctor-ai17z.ps1`. It reports every part
separately and distinguishes working, not set up yet, and broken.

## Install on Ubuntu

```bash
git clone REPLACE_WITH_AI17Z_GITHUB_URL ai17z
cd ai17z
./install-ai17z.sh
./start-ai17z.sh
```

Same three steps and the same result. Connecting an X account opens a real
Chrome window for you to sign in to, so a desktop session is needed for that
part; the rest runs anywhere Docker does. See **Support** below for exactly what
has and has not been verified.

## Checking it over

```powershell
.\doctor-ai17z.ps1
```

```bash
./doctor-ai17z.sh
```

Reports on every part, and distinguishes three things a new user cannot tell
apart otherwise: working, not set up yet, and broken. A fresh installation with
no X account is not an error, and the doctor says so.

## Stopping

```powershell
.\stop-ai17z.ps1
```

```bash
./stop-ai17z.sh
```

Data survives. `-Volumes` / `--volumes` deletes the database, every stored
provider key and every browser session, and asks for the word DELETE first.

---

## Quick start with Docker

> You do not need this section if you used the installer above. It is here for
> people who would rather drive Docker themselves.

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# paste that into AI17Z_MASTER_KEY in .env
docker compose up -d
```

A containerised worker has no browser and no display, so it takes jobs and
leaves browser-backed accounts alone. Run a native worker alongside it for
those — the Windows script above does this for you, and
[Driving a real browser](docs/operations/BROWSER_SESSIONS.md) covers the rest.

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

You need Node 22 or newer and a Postgres you can reach.

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

## Easy Mode and Advanced Mode

Easy Mode is eight questions and is the default. It is not a cut-down second
system: it writes the same versioned persona, policy, cadence and radar
configuration the Advanced screens edit, and reads them back. Change something
in Advanced and Easy shows it; change it in Easy and Advanced shows it.

Advanced keeps everything -- prompt layers, pipeline nodes, memory scopes, model
roles and fallbacks, the stance ledger, cadence, capabilities, browser
diagnostics. Nothing was removed to make Easy Mode simple.

The switch is in the header, and it is one setting for the whole application.

---

## Where your data lives

Everything AI17Z stores is on your machine:

| What | Where |
| --- | --- |
| Database (agents, events, jobs, memories, relationships) | Docker volume |
| Provider API keys | The same database, encrypted with your master key |
| X browser profiles and sessions | `storage/browser-profiles/` |
| Failure screenshots | `storage/diagnostics/` |
| The master key itself | `.env`, and nowhere else |

**Back up `.env`.** Losing the master key makes every stored provider credential
unreadable, and there is no recovery.

### What leaves your machine

The runtime is local. The model is not, unless you choose a local one.

- **Ollama** runs on your machine. Nothing leaves it.
- **OpenAI, Anthropic, OpenRouter, DeepSeek** and any other remote provider
  receive the context AI17Z sends them: the incoming post, the conversation
  around it, the retrieved memories and the persona. That is how they answer.

If that matters to you, use Ollama.

---

## Support

Honest about what has actually been verified:

| Platform | Status |
| --- | --- |
| Windows 11 + Docker Desktop + Google Chrome | Verified end to end, including real X |
| Ubuntu Desktop | Scripts written and syntax-checked; **not verified on Ubuntu** |
| Ubuntu Server (headless) | Not a supported flow. Signing in to X needs a real browser window |

Ubuntu is not claimed as tested. The install, start, stop and doctor scripts
exist and their logic runs, but nobody has yet taken a clean Ubuntu machine
through the whole flow. If you do, the doctor tells you what it finds.

---

## Troubleshooting

**"Docker is installed but not running."** Start Docker Desktop and wait for it
to settle, then run the start script again.

**Ports already in use.** Something else has 8080, 8787 or 55432. Set
`AI17Z_WEB_PORT`, `AI17Z_API_PORT` or `POSTGRES_PORT` in `.env`.

**"Google Chrome not found."** Install it from google.com/chrome. Chromium and
Edge are different browsers and are not used as substitutes.

**An X account will not connect.** Connecting opens a real Chrome window and
waits for you to sign in by hand. If X asks for a code, a CAPTCHA or confirms an
unusual login, AI17Z stops and leaves the window alone -- it never types a
password and never answers a security challenge. Finish it yourself and it
carries on.

**The agent is running but never replies.** Open the agent's Activity. Every
decision is recorded, including the decision not to answer and the reasons
behind it. "Not worth answering: nothing to do with what this agent follows" is
the system working.

**Something is wrong and you cannot tell what.** Run the doctor.

---

## Running a second installation

Two AI17Z installations on one machine need different names and ports, because
the Docker project name is what container and volume names are derived from. In
the second checkout's `.env`:

```
AI17Z_INSTANCE=trading
AI17Z_API_PORT=8797
AI17Z_WEB_PORT=8090
POSTGRES_PORT=55433
```

They then share nothing: separate database, storage, browser profiles and
containers. A normal single installation needs none of this.

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

## Publishing this

If you are forking or releasing your own copy, [Publishing](docs/PUBLISHING.md)
lists the handful of things that cannot be done in code: the repository URL, the
description, and what to be honest about in an announcement.

---

## Documentation

- [Architecture overview](docs/architecture/OVERVIEW.md)
- [Data model](docs/architecture/DATA_MODEL.md)
- [Jobs and the runtime](docs/architecture/JOBS.md)
- [Memory](docs/architecture/MEMORY.md)
- [Channels](docs/architecture/CHANNELS.md)
- [Models](docs/architecture/MODELS.md)
- [Pipelines](docs/architecture/PIPELINES.md)
- [The social layer: identity, relationships, voice](docs/architecture/SOCIAL.md)
- [Cadence: when an account is read and may act](docs/architecture/CADENCE.md)
- [Capabilities: what an agent may do](docs/architecture/CAPABILITIES.md)
- [Connecting an account and security challenges](docs/architecture/SIGN_IN.md)
- [Persona sources: learning a voice](docs/architecture/PERSONA_SOURCES.md)
- [Security](docs/architecture/SECURITY.md)
- [Local setup](docs/operations/LOCAL_SETUP.md)
- [Docker](docs/operations/DOCKER.md)
- [Driving a real browser](docs/operations/BROWSER_SESSIONS.md)
- [AI4CZ migration](docs/legacy-ai4cz/MIGRATION.md)

## License

[MIT](LICENSE). Use it, change it, ship it; keep the copyright notice.

Nothing in the tree argues with that. Of 372 installed packages: 305 MIT,
23 ISC, 13 Apache-2.0, 7 BlueOak-1.0.0, 6 BSD-3-Clause, 1 CC-BY-4.0, 1 0BSD,
and 16 that declare nothing. No GPL, AGPL, SSPL or BUSL anywhere.

The licence covers this code. It does not cover what you do with it: the terms
of any service an agent acts on are between you and that service.
