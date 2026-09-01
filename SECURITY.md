# Security

AI17Z runs on your machine, holds credentials for accounts you own, and drives a
browser you are signed in to. That is a lot of trust for a piece of software, so
this is what it does with it.

## Reporting something

Open a private security advisory on the repository rather than a public issue.
Include what you did, what happened, and what you expected. If you are not sure
whether something counts, report it anyway.

Please do not open a public issue for anything that would let somebody else read
another person's credentials, drive their browser, or act on their accounts.

## What is stored, and where

| What | Where | Protection |
| --- | --- | --- |
| Provider API keys | Postgres | AES-256-GCM under your master key |
| X sessions and cookies | `storage/browser-profiles/` | Chrome's own profile encryption |
| Agent configuration, memories, relationships | Postgres | None beyond filesystem permissions |
| Failure screenshots | `storage/diagnostics/` | None; they can show page content |
| The master key | `.env` | Filesystem permissions only |

## The master key

Generated during installation, per installation. Nothing is shipped, and no
default exists.

It cannot be rotated. If it is lost, every stored provider credential becomes
unreadable and has to be entered again. AI17Z will not silently generate a
replacement when one is missing — it refuses to start that path, because a
silent regeneration looks like everything is fine right up until a provider call
fails for a reason nobody can trace. **Back up `.env`.**

`XBAM_MASTER_KEY` is still read as a fallback so that secrets sealed before the
rename stay readable. New installations use `AI17Z_MASTER_KEY`.

## What never leaves

Provider keys are readable only through one function and never appear in an API
response, a log line, an audit row or a trace. This is tested rather than
asserted: a sentinel value is sealed through the real path and then looked for
in every text, varchar and jsonb column of every table, in the trace events, and
in the redactor across the shapes a key actually arrives in.

The redactor blanks anything key-shaped before it reaches a log.

## What does leave

The runtime is local. The model is not, unless you choose a local one.

A configured remote provider — OpenAI, Anthropic, OpenRouter, DeepSeek, or any
OpenAI-compatible endpoint — receives the context AI17Z sends it: the incoming
post, the conversation around it, the memories retrieved for that reply, and the
persona. That is how it answers. Ollama runs on your machine and sends nothing
anywhere.

Nothing else is transmitted. There is no telemetry, no analytics, and no
callback to anywhere.

## Security challenges are yours

AI17Z never types a password and never answers a security challenge. When X asks
for a CAPTCHA, a second factor, an emailed or texted code, a hardware key, or
confirmation of an unusual login, the account moves to `CHALLENGE_REQUIRES_USER`,
the window is left open and untouched, and the watcher stops reading the page.

There is no setting for this and no code path around it. The function that
observes an authentication page has no branch that clicks, fills or dismisses
anything, and a test fails if any of those are ever called.

## The browser

Chrome's debugging port binds to loopback. A debugging port reachable from the
network is a signed-in browser anyone can drive.

Each account gets its own Chrome profile directory, derived from the account id,
and only one Chrome may hold a profile at a time.

## Untrusted content

Everything an agent reads from X is data, not instruction. A post telling the
agent to ignore its instructions, reveal its prompt, or name the model behind it
is treated as text somebody wrote, and the identity rules are enforced on the
finished output rather than requested in the prompt.

## Exposing this to a network

Do not. AI17Z assumes it is reachable only from the machine it runs on: a single
owner account, no rate limiting on the API, and a browser it can drive. Putting
it behind a public address gives anyone who finds it your agents and your
sessions.
