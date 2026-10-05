<div align="center">

<img src="packaging/brand/ai17z-logo.png" alt="AI17Z" width="120" />

# AI17Z

**A local-first platform for persistent autonomous AI agents.**

The model is replaceable. The agent is durable.

[![CI](https://github.com/ShiftAboveCtrl/ai17z/actions/workflows/ci.yml/badge.svg)](https://github.com/ShiftAboveCtrl/ai17z/actions/workflows/ci.yml)
[![Platform packaging](https://github.com/ShiftAboveCtrl/ai17z/actions/workflows/platform-packaging.yml/badge.svg)](https://github.com/ShiftAboveCtrl/ai17z/actions/workflows/platform-packaging.yml)
[![Release](https://img.shields.io/github/v/release/ShiftAboveCtrl/ai17z?include_prereleases&sort=semver)](https://github.com/ShiftAboveCtrl/ai17z/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Install](#install) · [What makes it different](#what-makes-it-different) · [Architecture](#architecture) · [Status](#status) · [Documentation](#documentation)

</div>

---

## The idea

Most agent frameworks are a wrapper around a model call. Change the model and
you have changed the agent, because the model was the agent.

AI17Z splits those apart. The provider supplies replaceable intelligence;
AI17Z supplies the part that persists:

> identity · persona · memory · relationships · beliefs and stances ·
> commitments · knowledge and its provenance · goals · policy · learning

An agent keeps that across restarts, across model changes, and across
providers. Swap the model and the same agent answers in the same voice from the
same memory, because none of that lived in the model.

It runs on your own machine. The database, the browser profile, the keys and
every memory stay there.

---

## What makes it different

**Durable by construction, not by convention.** Every inbound event becomes an
immutable record and a job. Jobs survive restarts and resume from the last
completed step, because each step commits before the next begins.

**The same event cannot act twice.** Not by careful coding: by unique index.
Three layers of idempotency, enforced by the database, plus exact-target
verification immediately before anything irreversible.

**Answerable behaviour.** Every generation stores its prompt layers, which
memories it retrieved and *why*, every model attempt, and the verification that
preceded the action. "Why did it do that?" and "why did it stay silent?" both
have recorded answers.

**Silence is a result.** An agent that decides not to act records the decision
and its reasons. A correctly quiet agent does not look broken.

**A real browser, honestly.** Browser-backed channels drive actual installed
Google Chrome over CDP with a persistent profile, with both the chosen
executable and what the browser reported about itself stored and shown. A
CAPTCHA, a second factor or a device challenge stops the agent and waits for a
person: there is no solver and no bypass, and no setting that changes it.

**Replaceable models.** OpenAI, Anthropic, OpenRouter, Ollama, any
OpenAI-compatible endpoint, and a deterministic mock, behind one gateway with a
fallback chain. Local models work; nothing requires a cloud provider.

**A safe default.** Dry run executes the whole pipeline, verifies the target,
and stops before touching anything real.

---

## Install

AI17Z installs on **Windows**, **macOS 13+** and **Ubuntu 22.04+**. None of
them needs Git, and the macOS and Ubuntu packages carry their own verified Node
runtime. All three use Docker for the database. Google Chrome is optional and
enables browser-backed channels.

### Windows

Open Windows Terminal and paste:

```powershell
irm https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/install.ps1 | iex
```

That is the whole installation: it checks the machine, installs what is
missing, installs AI17Z, starts it, verifies it works, and opens it.

### macOS and Ubuntu

Download the short installer from the
[latest release](https://github.com/ShiftAboveCtrl/ai17z/releases), read it,
and run it. Both are plain shell scripts, deliberately short enough to audit.

> **Install AI17Z only with the command published here.** Nowhere else
> distributes it. The command fetches
> `raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/install.ps1`, checks the
> setup script against the release's own `SHA256SUMS.txt` before writing
> anything, and re-checks it immediately before running it.
>
> AI17Z is not code-signed, so where it came from is the whole of the answer to
> who wrote it. Nothing in the install path disables SmartScreen, Defender, UAC
> or the PowerShell execution policy, and
> [docs/SETUP_AUDIT.md](docs/SETUP_AUDIT.md) lists every host it may contact and
> every change it may make, including what the checksum does **not** protect
> against.

### Code signing

AI17Z is **not signed**, and is not about to be. Free certificates for
open-source projects are granted on the strength of an existing user base; we
applied and were turned down for not having one yet. Saying signing is coming
would be a nicer sentence and not a true one.

That is why the ordinary way in is a command rather than a download. **We will
never ask you to disable SmartScreen, Smart App Control or your antivirus, or
to click past a warning.** [Windows trust and SmartScreen](docs/WINDOWS_TRUST.md)
explains what those warnings actually mean, and
[docs/CODE_SIGNING_POLICY.md](docs/CODE_SIGNING_POLICY.md) is where this stands.

**Full instructions, from-source builds, updating, running several copies and
troubleshooting: [docs/INSTALL.md](docs/INSTALL.md).**

---

## Architecture

```
apps/api         Fastify HTTP layer. Owns no browsers.
apps/worker      Job worker, channel poller, browser runner. Owns all browsers.
apps/web         React single-page app.

packages/shared     Isomorphic zod contracts, crypto, logging, environment.
packages/database   Postgres pool, migrator, one repository per domain.
packages/jobs       Postgres-backed queue: claim, lease, recover, back off.
packages/models     Model gateway and provider adapters.
packages/memory     Six memory scopes, retrieval, write policy.
packages/prompts    Layered prompt engine.
packages/channels   Channel contract, mock channel, X adapter.
packages/browser    Playwright session manager, real Chrome over CDP.
packages/persona    Corpus normalising, scoring, trait derivation.
packages/tools      Capability contract and built-in capabilities.
packages/runtime    Validator, policy gates, ingest, pipeline state machine.
```

The pipeline every action goes through:

```
inbound event → immutable event → durable job → context and memory
  → prompt, model, capability decisions → validation and policy
  → exact-target verification → remote action or deliberate silence
  → verified outcome → learning
```

Nothing downstream of a channel adapter knows what any particular platform
looks like. No selector, no cookie and no vendor payload leaves
`packages/channels`; everything else operates on normalised contracts.

---

## Status

AI17Z is in **beta** and under active development. It is used daily against
real accounts by its authors.

| Area | State |
| --- | --- |
| Durable pipeline, jobs, idempotency | Shipped |
| Memory, relationships, beliefs, knowledge | Shipped |
| Model gateway and provider fallback | Shipped |
| Browser-backed channels with real Chrome | Shipped |
| Owner chat, Agent Foundry, Response Lab | Shipped |
| Plugins and capability permissions | Shipped |
| Agent packages: share, move, export | Shipped |
| Windows, macOS and Ubuntu packaging | Shipped |
| Agent wallet: owner-approved, read-only to models | Shipped, disabled by default |
| Hosted runtimes and agentic trading | **In development, not released** |

Releases are versioned with strict semver and every one is gated on the full
test suite, a cold typecheck, lint, a production web build, a production
dependency audit, ShellCheck, fresh and existing database migrations, a privacy
and secret scan, and a clean-room install verification that installs twice,
upgrades over itself, and asserts no data was lost.

---

## Your data

Everything an agent knows stays on the machine running it: the Postgres
database, the browser profile, the signed-in sessions, the keys and every
memory.

- **No telemetry.** AI17Z phones no home. There is no analytics endpoint.
- **Provider keys are sealed** with AES-256-GCM under a master key that never
  leaves the installation, and are readable only by the code that calls a
  provider. They never appear in an API response, a log line, an audit row or a
  trace.
- **What does leave** is what you point an agent at: the model provider you
  chose, and the services you connected it to. [docs/PRIVACY.md](docs/PRIVACY.md)
  itemises it.
- **It is yours to leave with.** Any agent exports to a single portable
  document that any other AI17Z installation can import.

---

## Documentation

**Getting it running**

- [Installing and running AI17Z](docs/INSTALL.md) — all three platforms, from source, updating, troubleshooting
- [Auditing AI17Z Setup](docs/SETUP_AUDIT.md) — every host it may contact and change it may make
- [Windows trust and SmartScreen](docs/WINDOWS_TRUST.md) · [Code signing policy](docs/CODE_SIGNING_POLICY.md)
- [Uninstalling and removing your data](docs/WINDOWS_UNINSTALL.md) · [Privacy](docs/PRIVACY.md)
- [Local setup](docs/operations/LOCAL_SETUP.md) · [Docker](docs/operations/DOCKER.md) · [Driving a real browser](docs/operations/BROWSER_SESSIONS.md)

**How it works**

- [Engineering notes](docs/ENGINEERING.md) — the invariants, and what broke to produce each one
- [Architecture overview](docs/architecture/OVERVIEW.md) · [Data model](docs/architecture/DATA_MODEL.md) · [Jobs and the runtime](docs/architecture/JOBS.md)
- [End-to-end data flow](docs/architecture/DATA_FLOW.md) — where each responsibility lives
- [Memory](docs/architecture/MEMORY.md) · [Channels](docs/architecture/CHANNELS.md) · [Models](docs/architecture/MODELS.md) · [Pipelines](docs/architecture/PIPELINES.md)
- [The social layer](docs/architecture/SOCIAL.md) — identity, relationships, voice
- [Persistent autonomous deliberation](docs/architecture/DELIBERATION.md) — what an agent thinks about between the things it is asked
- [The Response Lab](docs/architecture/RESPONSE_LAB.md) — what an agent would say to a real post, and everything that fed the answer
- [Cadence](docs/architecture/CADENCE.md) · [Capabilities](docs/architecture/CAPABILITIES.md) · [Easy Mode](docs/architecture/EASY_MODE.md)
- [Connecting an account and security challenges](docs/architecture/SIGN_IN.md) · [Persona sources](docs/architecture/PERSONA_SOURCES.md)
- [Browser runtime](docs/architecture/X_RUNTIME.md) · [Reading a channel](docs/architecture/X_READING.md) · [Owner notifications](docs/architecture/NOTIFICATIONS.md)
- [Agent packages](docs/architecture/AGENT_PACKAGES.md) · [Growth](docs/architecture/GROWTH.md) · [Security](docs/architecture/SECURITY.md) · [Updates](docs/architecture/UPDATES.md)

AI17Z can read these itself: attach `docs/` as a knowledge source and an agent
can answer questions about the exact version you are running.

---

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers
the workflow and what the gates expect, [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
covers the project's own spaces, and [SECURITY.md](SECURITY.md) is how to report
a vulnerability privately.

```bash
npm install          # install dependencies
npm run db:up        # Postgres in Docker
npm run migrate      # apply migrations
npm run dev          # api + worker + web
npm test             # unit and integration suites
npm run typecheck    # tsc across every package
```

---

## Token

AI17Z has an associated token. The **only** contract address is:

```
0x16CB7cBb26295b60DF7f4B3B39a99a9A3c585E81
```

Any other address claiming to be AI17Z is not. The token is not required to
install, run or use anything in this repository: AI17Z is MIT-licensed software
that runs locally and needs no token, wallet or payment.

---

## License

[MIT](LICENSE). Use it, change it, ship it; keep the copyright notice.

Nothing in the dependency tree argues with that. Of 372 installed packages: 305
MIT, 23 ISC, 13 Apache-2.0, 7 BlueOak-1.0.0, 6 BSD-3-Clause, 1 CC-BY-4.0, 1
0BSD, and 16 that declare nothing. No GPL, AGPL, SSPL or BUSL anywhere.

The licence covers this code. It does not cover what you do with it: the terms
of any service an agent acts on are between you and that service.
