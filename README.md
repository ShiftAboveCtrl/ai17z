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

Three things, and the installer checks all of them before it does anything:

| | Why | Where |
| --- | --- | --- |
| **Docker Desktop** | Postgres, the API and the web app run in containers | [docker.com](https://www.docker.com/products/docker-desktop/) |
| **Node 22 or newer** | The worker that drives a real browser runs on your machine, not in a container | [nodejs.org](https://nodejs.org) |
| **Google Chrome** | Only for connecting an X account. Everything else works without it | [google.com/chrome](https://www.google.com/chrome/) |

Chrome means Google Chrome. Not Chromium, not Edge. AI17Z spawns it and attaches
over the debugging protocol, and refuses to substitute another browser rather
than pretend one is the other.

About 6 GB of disk once the images are built, most of it the worker image, which
carries a browser. The first build takes a few minutes; after that, seconds.

You do **not** need: an OpenAI account, an X account, a server, a domain, or a
paid anything. A local model through Ollama costs nothing and the mock provider
costs less.

---

## Install

### Windows

> **Not inside OneDrive, Dropbox or Google Drive.** npm links every package into
> `node_modules` with a symlink, and a syncing folder refuses those while it is
> reconciling, so the install dies several minutes in with `EBUSY: resource busy
> or locked, symlink`. On Windows your Desktop is inside OneDrive by default,
> which makes this the most likely way a first install fails. `C:\devi17z` or
> `%USERPROFILE%i17z` are both fine. The installer checks and stops rather than
> letting you find out the slow way.

One line, in PowerShell, in a folder you can write to:

```powershell
irm https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/bootstrap.ps1 | iex
```

That clones the repository into `.\ai17z`, checks the machine, and starts it.

Piping a script from the internet into a shell asks you to trust whatever the
server sends, and you are allowed to want to look first:

```powershell
irm https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/bootstrap.ps1 -OutFile bootstrap.ps1
notepad bootstrap.ps1
.\bootstrap.ps1
```

Or do it by hand, which is the same three steps the bootstrap runs:

```powershell
git clone https://github.com/ShiftAboveCtrl/ai17z.git ai17z
cd ai17z
.\install-ai17z.ps1 -Start
```

### Ubuntu

```bash
curl -fsSL https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/bootstrap.sh | bash
```

or by hand:

```bash
git clone https://github.com/ShiftAboveCtrl/ai17z.git ai17z
cd ai17z
./install-ai17z.sh --start
```

Connecting an X account opens a real Chrome window for you to sign in to, so
that part needs a desktop session. The rest runs anywhere Docker does. See
**Support** below for what has and has not actually been verified.

### No git?

Download the zip from the repository's **Code â†’ Download ZIP**, extract it, and
run the installer from inside the folder. Nothing in AI17Z needs git after the
files are on disk:

```powershell
cd ai17z-main
.\install-ai17z.ps1 -Start
```

The bootstrap scripts do this for you if git is missing.

### Then

Open **http://localhost:8080**. The first screen asks you to create an account.
That account is yours, it lives on this machine, and there is no sign-up.

`install-ai17z.ps1` installs nothing behind your back: it checks what is there,
says where to get whatever is missing, runs `npm install`, and writes a `.env`
with a master key generated for your installation. It never overwrites an
existing `.env`, because that file holds the key your stored provider
credentials are encrypted with.

## Opening it

```powershell
.\launch-ai17z.ps1
```

```bash
./launch-ai17z.sh
```

Starts everything and opens the app. The Windows installer adds this to the
Start Menu, so there is something to click; `-NoShortcut` skips that. It reads
the port from your own `.env`, so a machine running two installations opens the
right one.

## If something is wrong

```powershell
.\doctor-ai17z.ps1
```

```bash
./doctor-ai17z.sh
```

It reports every part separately and tells three things apart that otherwise
look the same: working, not set up yet, and broken. A fresh installation with no
model provider and no X account is not broken, and it says so, with the step
that fixes each one.

## Stopping

```powershell
.\stop-ai17z.ps1
```

```bash
./stop-ai17z.sh
```

Data survives. `-Volumes` / `--volumes` deletes the database, every stored
provider key and every browser session, and asks for the word DELETE first.

## Restarting

```powershell
.\restart-ai17z.ps1
```

```bash
./restart-ai17z.sh
```

Your signed-in Chrome survives a restart: AI17Z spawns the browser rather than
letting the automation library launch it, so stopping AI17Z does not close a
window you are signed in to, and starting again reattaches to the tabs already
open instead of opening more. `-KeepStack` / `--keep-stack` restarts only the
worker and leaves the containers alone, which is faster and enough for anything
that is not a container change.

## Updating

```powershell
.\update-ai17z.ps1 -Check
.\update-ai17z.ps1
```

```bash
./update-ai17z.sh --check
./update-ai17z.sh
```

`-Check` / `--check` says what an update would bring and changes nothing: the
commits, and any database migrations, which are the part that cannot be undone.

Your data and your `.env` are never touched. It refuses to run over uncommitted
changes rather than discarding them, and it works out whether the update can be
applied *before* stopping anything, so a checkout it cannot update is left
running rather than left down.

---

## Quick start with Docker

> You do not need this section if you used the installer above. It is here for
> people who would rather drive Docker themselves.

```bash
npm run setup          # writes .env with a master key, if there is not one
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
npm install
npm run dev                   # api + worker + web
```

`dev`, `migrate` and `db:up` each make sure `.env` exists with a master key
before they run, so there is nothing to generate or paste. Point `DATABASE_URL`
at your own Postgres if you would rather not use the container.

Open **http://localhost:5173**.

---

## First run

1. **Create your owner account.** Local, one person, stored as a scrypt hash.
2. **Add a model provider.** Settings â†’ Add provider. Ollama needs no key.
   Everything else takes an API key, encrypted at rest with your master key and
   never returned by the API afterwards.
3. **Create an agent.** Eight short steps. Keep the mock channel.
4. **Inject a test event.** On the agent page, Activity â†’ *Inject a test event*.
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

**`EBUSY: resource busy or locked, symlink` during install.** The folder is
inside OneDrive, Dropbox or another syncing folder. Move the project somewhere
that is not synced and install again. Nothing is wrong with npm or the machine:
the sync driver holds the directory while it reconciles a freshly created tree,
and npm workspaces need real symlinks. It is intermittent, which makes it worse
rather than better, since one install can succeed and the next fail on a
different package.

## Running a second installation

Every installation names itself after the folder it was installed into, and that
name decides which Docker volumes it uses. A clone into `ai17z-test` is
`ai17z-test`: its own database, its own browser profiles, its own containers.
Nothing is shared with any other checkout on the machine.

That name is written into `.env` once, when the installer creates it, and never
touched again -- so updating in place with `git pull` keeps the data it already
had.

Two of them can run side by side if you give the second one its own ports:

```
AI17Z_API_PORT=8797
AI17Z_WEB_PORT=8090
POSTGRES_PORT=55450
DATABASE_URL=postgres://xbam:xbam@localhost:55450/xbam
```

`DATABASE_URL` carries its own port and is what migrations and the native worker
dial, so it has to move with `POSTGRES_PORT`. The start script refuses if the two
disagree rather than letting one installation migrate another's database.

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

- [Engineering notes](docs/ENGINEERING.md) — the invariants, and what broke to produce each one
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
