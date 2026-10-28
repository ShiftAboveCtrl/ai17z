<div align="center">

<img src="packaging/brand/ai17z-logo.png" alt="AI17Z" width="120" />

# AI17Z

**Self-hosted platform for running autonomous AI agents on your own machine.**

[![Latest release](https://img.shields.io/github/v/release/ShiftAboveCtrl/ai17z?display_name=release&label=latest&color=2ea44f)](https://github.com/ShiftAboveCtrl/ai17z/releases/latest)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Ubuntu-informational)](#install)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**[Download the latest release](https://github.com/ShiftAboveCtrl/ai17z/releases/latest)**

[Overview](#overview) · [Features](#features) · [Install](#install) · [Architecture](#architecture) · [Status](#status) · [Documentation](#documentation)

</div>

---

## Overview

AI17Z runs AI agents that keep their identity, memory and configuration
independently of the language model behind them. Each agent has a persona,
long-term memory, relationships, knowledge sources, goals and a policy, all
stored in a local Postgres database. The model provider can be changed at any
time without losing any of it.

Agents connect to channels such as X through a real Google Chrome session,
decide whether and how to respond, and record why. Everything runs locally:
the database, the browser profile, provider keys and agent memory never leave
the machine.

---

## Features

**Durable job pipeline.** Every inbound event is stored and processed as a job.
Each step commits before the next starts, so a restart resumes work instead of
repeating it.

**No duplicate actions.** Events, jobs and outbound actions are deduplicated by
unique database constraints, and the target is verified again immediately
before anything is sent.

**Full audit trail.** Each response stores its prompt, the memories retrieved
and why, every model attempt, and the verification before the action. Decisions
not to respond are recorded with their reasons too.

**Any model provider.** OpenAI, Anthropic, OpenRouter, Ollama, any
OpenAI-compatible endpoint, and a deterministic mock, behind one gateway with
fallback. Local models are fully supported.

**Real browser sessions.** Browser-backed channels drive installed Google
Chrome over CDP with a persistent profile. CAPTCHAs, two-factor prompts and
other security challenges are always handed to a person; AI17Z never attempts
to solve or bypass them.

**Dry run by default.** The full pipeline runs and verifies its target, then
stops before taking any real action.

**Plugins and permissions.** Capabilities are granted per agent and checked
both when work is queued and again before it executes.

**Portable agents.** Any agent can be exported to a single file and imported
into another installation.

---

## Install

AI17Z runs on **Windows 10 and 11**, **macOS 13+** and **Ubuntu 22.04+**. It
uses Docker for the database. Git is not required, and the macOS and Ubuntu
packages include their own Node runtime. Google Chrome is optional and enables
browser-backed channels.

| Platform | Recommended | Also available in each release |
| --- | --- | --- |
| Windows 10 and 11 | The command below | `AI17Z-Setup-<version>.exe` |
| macOS 13+ (Apple silicon and Intel) | [`install-ai17z-macos.sh`](https://github.com/ShiftAboveCtrl/ai17z/releases/latest/download/install-ai17z-macos.sh) | `AI17Z-macos-arm64-<version>.tar.gz`, `AI17Z-macos-x64-<version>.tar.gz` |
| Ubuntu 22.04+ (amd64 and arm64) | [`install-ai17z-ubuntu.sh`](https://github.com/ShiftAboveCtrl/ai17z/releases/latest/download/install-ai17z-ubuntu.sh) | `ai17z_<version>_amd64.deb`, `ai17z_<version>_arm64.deb` |

Checksums for every file are in each release's
[`SHA256SUMS.txt`](https://github.com/ShiftAboveCtrl/ai17z/releases/latest/download/SHA256SUMS.txt).
Releases are published on [GitHub](https://github.com/ShiftAboveCtrl/ai17z/releases)
and [AI17Z Code](https://code.ai17z.io/AI17Z/ai17z/releases) with identical
files. Release names such as `beta-v9.7` correspond to semver tags such as
`v1.0.0-beta.87`.

### Windows

Open Windows Terminal and run:

```powershell
irm https://code.ai17z.io/AI17Z/ai17z/raw/branch/main/install.ps1 | iex
```

The installer checks the system, installs any missing prerequisites, installs
AI17Z, starts it, confirms it is working and opens it in your browser.

### macOS and Ubuntu

Download the installer for your system from the table above and run it. Both
are short shell scripts that can be reviewed before running.

> **Install AI17Z only with the command published here** or from the release
> pages linked above. Nowhere else distributes it. The command downloads
> `code.ai17z.io/AI17Z/ai17z/raw/branch/main/install.ps1`, verifies the setup
> script against the release's `SHA256SUMS.txt` before writing anything, and
> verifies it again immediately before running it.
>
> The installer does not disable SmartScreen, Defender, UAC or the PowerShell
> execution policy. [docs/SETUP_AUDIT.md](docs/SETUP_AUDIT.md) lists every host
> it contacts and every change it makes, including what the checksum does not
> protect against.

### Code signing

AI17Z releases are not code-signed at this time.
We will never ask you to disable SmartScreen, Smart App Control or your antivirus.
We will never ask you to click past a warning. See [Windows trust and SmartScreen](docs/WINDOWS_TRUST.md) and the
[code signing policy](docs/CODE_SIGNING_POLICY.md) for details.

Full instructions, building from source, updating, running several copies and
troubleshooting are in [docs/INSTALL.md](docs/INSTALL.md).

---

## Architecture

```
apps/api            Fastify HTTP API. Owns no browsers.
apps/worker         Job worker, channel poller and browser runner.
apps/web            React web interface.

packages/shared     Shared contracts, crypto, logging and environment.
packages/database   Postgres pool, migrations and repositories.
packages/jobs       Postgres-backed job queue with leases and recovery.
packages/models     Model gateway and provider adapters.
packages/memory     Memory scopes, retrieval and write policy.
packages/prompts    Layered prompt engine.
packages/channels   Channel contract, mock channel and X adapter.
packages/browser    Chrome session management over CDP.
packages/persona    Persona corpus processing and trait derivation.
packages/tools      Capability contract and built-in capabilities.
packages/runtime    Validation, policy, ingest and the pipeline state machine.
```

Each action follows the same pipeline:

```
inbound event → stored event → job → context and memory
  → prompt and model → validation and policy
  → target verification → action or recorded decision not to act
  → outcome → learning
```

Platform-specific details stay inside `packages/channels`. Everything else
works on normalised contracts.

---

## Status

AI17Z is in **beta** and under active development.

| Area | Status |
| --- | --- |
| Job pipeline, recovery and deduplication | Available |
| Memory, relationships, beliefs and knowledge | Available |
| Model gateway with provider fallback | Available |
| Browser-backed channels with Google Chrome | Available |
| Owner chat, Agent Foundry and Response Lab | Available |
| Plugins and capability permissions | Available |
| Agent export and import | Available |
| Windows, macOS and Ubuntu packages | Available |
| Agent wallet (owner-approved, read-only to models) | Available, off by default |
| Hosted runtimes | In development ([details](docs/architecture/HOSTING.md)) |
| Trading | In development, no live funds ([details](docs/architecture/TRADING.md)) |

Every release must pass the full test suite, typecheck, lint, a production web
build, a dependency audit, ShellCheck, database migrations from empty and from
the previous release, a privacy and secret scan, and a clean install and
upgrade test that confirms no data is lost.

---

## Privacy

- **No telemetry.** AI17Z sends no usage data anywhere.
- **Encrypted keys.** Provider API keys are encrypted with AES-256-GCM under a
  master key that stays on your machine, and never appear in API responses,
  logs or traces.
- **Your choice of services.** The only outside services contacted are the
  model providers and channels you configure. [docs/PRIVACY.md](docs/PRIVACY.md)
  lists them.

---

## Documentation

**Getting started**

- [Installing and running AI17Z](docs/INSTALL.md)
- [Setup audit](docs/SETUP_AUDIT.md): every host contacted and change made by the installer
- [Windows trust and SmartScreen](docs/WINDOWS_TRUST.md) · [Code signing policy](docs/CODE_SIGNING_POLICY.md)
- [Uninstalling](docs/WINDOWS_UNINSTALL.md) · [Privacy](docs/PRIVACY.md)
- [Local setup](docs/operations/LOCAL_SETUP.md) · [Docker](docs/operations/DOCKER.md) · [Browser sessions](docs/operations/BROWSER_SESSIONS.md)

**Architecture**

- [Overview](docs/architecture/OVERVIEW.md) · [Data model](docs/architecture/DATA_MODEL.md) · [Jobs](docs/architecture/JOBS.md) · [Data flow](docs/architecture/DATA_FLOW.md)
- [Memory](docs/architecture/MEMORY.md) · [Channels](docs/architecture/CHANNELS.md) · [Models](docs/architecture/MODELS.md) · [Pipelines](docs/architecture/PIPELINES.md)
- [Social layer](docs/architecture/SOCIAL.md) · [Deliberation](docs/architecture/DELIBERATION.md) · [Response Lab](docs/architecture/RESPONSE_LAB.md)
- [Cadence](docs/architecture/CADENCE.md) · [Capabilities](docs/architecture/CAPABILITIES.md) · [Easy Mode](docs/architecture/EASY_MODE.md)
- [Sign-in and security challenges](docs/architecture/SIGN_IN.md) · [Persona sources](docs/architecture/PERSONA_SOURCES.md)
- [Browser runtime](docs/architecture/X_RUNTIME.md) · [Reading channels](docs/architecture/X_READING.md) · [Notifications](docs/architecture/NOTIFICATIONS.md)
- [Agent packages](docs/architecture/AGENT_PACKAGES.md) · [Security](docs/architecture/SECURITY.md) · [Updates](docs/architecture/UPDATES.md)
- [Engineering notes](docs/ENGINEERING.md)

---

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md),
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md) for
reporting vulnerabilities privately.

```bash
npm install          # install dependencies
npm run db:up        # start Postgres in Docker
npm run migrate      # apply migrations
npm run dev          # run api, worker and web
npm test             # unit and integration tests
npm run typecheck    # typecheck every package
```

---

## Token

The **only** official AI17Z token contract address is:

```
0x16CB7cBb26295b60DF7f4B3B39a99a9A3c585E81
```

Any other address claiming to be AI17Z is not official. The token is not
required to install or use AI17Z.

---

## License

AI17Z is released under the [MIT License](LICENSE). The terms of any service
an agent connects to remain between you and that service.
