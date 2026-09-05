# Privacy

What AI17Z does with your data, and where it goes.

## AI17Z collects nothing

There is no analytics, no telemetry, no crash reporting, no update ping, no
licence check and no account with us. AI17Z has no servers. Nothing about your
use of it reaches the people who wrote it.

The installer does not phone home. Running AI17Z does not phone home. If you
never configure anything, AI17Z makes no outbound network requests at all
beyond what you can see on its own screens.

## Where your data lives

On your machine, in two places:

| | |
| --- | --- |
| `%LOCALAPPDATA%\AI17Z` | your environment file, stored files, and browser profiles including signed-in sessions |
| A Docker volume | the PostgreSQL database: your agents, their memories, relationships, knowledge and history |

Neither is synchronised anywhere. Removing them removes the data; there is no
copy elsewhere to delete.

## What leaves your machine, and only because you asked

AI17Z talks to services **you** configure, using credentials **you** supply:

- **Model providers** — OpenAI, Anthropic, DeepSeek, xAI, OpenRouter, a local
  Ollama, or any OpenAI-compatible endpoint you point it at. Prompts and the
  context assembled for them are sent to whichever provider you chose.
- **X**, through the real Google Chrome on your machine, signed in as you. AI17Z
  reads and posts as the account you connected.
- **Search and market data**, when an agent looks something up: the open web
  through your browser, and DexScreener for a contract address or ticker.
- **Telegram**, if you connect a bot for owner notifications.

Each of these is off until you configure it. What is sent is what that feature
needs to do its job, and the Activity screen shows what was sent and when.

## Credentials

Provider API keys and other secrets are encrypted with AES-256-GCM under a
master key generated on first run and stored in your environment file. They are
readable only by the one function that needs to decrypt them, and they are kept
out of API responses, log lines, audit rows, traces and agent exports.

The master key never leaves your machine. If you lose it, the sealed credentials
cannot be recovered and have to be entered again.

## Your browser session

Connecting an X account signs you in through a real Chrome profile that AI17Z
keeps under your data directory. That profile holds a live session, exactly as
your ordinary browser profile does.

**AI17Z never types a password and never answers a security challenge.** When a
service asks for a CAPTCHA, a second factor, an emailed code or confirmation of
an unusual sign-in, AI17Z stops, leaves the window open and untouched, and waits
for you.

## What agents remember about other people

An agent records what happened between it and someone it spoke to: the exchange,
what was said, and a stance it has taken publicly. It does not infer anything
sensitive about anybody, and the entity graph records only that two things were
mentioned together.

Everything an agent has learned is visible and removable on its own screens.

## Removing everything

Uninstalling asks whether to remove the data directory, and keeps it unless you
say otherwise. `packaging\windows\Uninstall-Data.ps1` removes it separately if
you change your mind. The database lives in a Docker volume and is removed with
`docker compose down -v`, which is deliberately a separate action because it
cannot be undone.

## Questions

Open an issue: <https://github.com/ShiftAboveCtrl/ai17z/issues>
