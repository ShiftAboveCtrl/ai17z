# Local agent MCP server

`tools/agent-mcp.mts` exposes the actual agent to a local MCP client over stdio.
It opens no listening socket. It uses the installation database and master key,
so run it on the installation host with that installation's environment file.
Apply migrations first with `npm run migrate`.

## Tools

The exported set is closed and pinned by the stdio integration contract:

| Tool | Input | Result |
| --- | --- | --- |
| `list_agents` | `{}` | IDs, names and states within this token's agent scope |
| `ask_agent` | `agentId`, `question` (1 to 8,000 characters) | Owner-chat answer, status and recorded evidence |
| `agent_recent_trace` | `agentId` | Latest published action's recorded decision summary, or an explicit statement that nothing was recorded |

All input schemas reject unknown fields. There are no resources or prompts,
and no tool can publish, post, like, trade, sign, change settings, save memory
or change permissions. Asking for a change cannot grant it indirectly:
the capability loop requires both a `READ` effect and membership in the
explicit `EXTERNAL_READ_CAPABILITIES` allowlist of reviewed pure reads,
and refuses a model that names a capability outside its offered menu.

## Issue and revoke a credential

Use an existing owner session in `AI17Z_OWNER_TOKEN`, supplied through the
process environment, never a command argument. Set:

* `AI17Z_AGENT_MCP_TOKEN_FILE`: a new private file outside the checkout.
* `AI17Z_AGENT_MCP_AGENTS`: comma-separated agent UUIDs owned by that session.
* `AI17Z_AGENT_MCP_QUOTA`: optional hourly tool-call limit, default 60,
  minimum 1 and maximum 1,000.

Run `npm run agent:mcp -- issue`. It prints only the credential's UUID and
writes the bearer encrypted with the existing AES-256-GCM sealed-secret
format. Creation refuses to overwrite a file. Unix permissions are 0600;
on Windows keep the file in the owner's private profile with a private ACL.
The DB stores only the token's hash, following dev-update sender tokens.
Lookup uses indexed SHA-256 equality in SQL, not a constant-time string
comparison. The bearer contains 256 random bits. The file path is reserved
before issuance, and a failed write revokes the grant before cleanup.
Issuance verifies every agent's owner. A dev-update sender token cannot be
used here, since its project permissions do not grant private owner chat.

Revoke with `npm run agent:mcp -- revoke <credential-uuid>`, again using an
owner session from the environment. The DB revocation applies to every
running process immediately on its next authorization check. Remove the
sealed file separately when retiring the client. To rotate, issue a new file
and revoke the old credential. The bearer is never printed or returned.

## Client configuration

Run the client command from the repository or installation directory:

```json
{
  "mcpServers": {
    "ai17z-agent": {
      "command": "node",
      "args": ["--import", "tsx", "tools/agent-mcp.mts"],
      "env": {
        "AI17Z_AGENT_MCP_TOKEN_FILE": "<private-credential-file>",
        "AI17Z_ENV_FILE": "<installation-env-file>"
      }
    }
  }
}
```

Use absolute script paths and the installation working directory if the client
does not inherit it. `npm --silent run agent:mcp` is an alternative: the
`--silent` is necessary because npm's script banner is not MCP protocol.
No bearer or master key belongs in client arguments. The server reads and
decrypts its credential file locally. Startup failures use a fixed message
without local paths or exception details.

## Execution and limits

Each question creates a fresh single-agent owner conversation. Its answer
runs inline through `writeAnswer`, the existing prompt engine, model gateway,
policy validator, budget check and capability loop. It has the agent's own
persona, memory and beliefs. Nothing is saved as durable memory. There is no
worker-claimable pending answer, so another worker cannot run the question
with broader permissions. The server registers built-in utility and OWNER
introspection capabilities and reconciles installed Plugins through their
existing registry. Management capabilities are registered but excluded by the
read-only gate. It does not load wallet adapters or browser sessions.
The READ labels on `agent.cannot_change` and `paper.trade` also cover request
bookkeeping and simulated trading in ordinary chat. Both are excluded here;
their labels stay unchanged to preserve existing permission behaviour.
Plugin capabilities are excluded unless explicitly reviewed and allowlisted.
Deleted agents are refused at authorization even if their UUID remains in scope.
Questions requiring web research follow owner chat's existing availability
behavior, including an explicit failed result if a browser handoff is required.

Trace summaries invoke `agent.explain_action` with `audience: OWNER` through
`invokeCapability` and the agent's current permission/configuration. They
return recorded conclusions rather than hidden reasoning. An agent with no
published action returns the capability's explicit missing-record answer.

PAUSE ALL blocks every tool operation. Authorization and pause are checked
before work, before each model/capability step, and before returning an answer.
Revocation or a missing/changed owner fails closed. Calls already inside a
provider cannot be recalled, but no later step or answer is released after
the next check refuses it.

The hourly quota is a UTC clock-hour window per token, enforced by one
conditional database UPDATE. It survives restarts and simultaneous stdio
processes. Authenticated tool calls, including unknown names and invalid
arguments, spend quota. Paused calls and invalid JSON-RPC envelopes do not.
Protocol handshake, menu and ping requests do not spend quota. Each admitted
tool attempt writes an `audit_events` row before execution. Protocol traffic
and quota, pause or authentication refusals are collapsed to one row per
minute per credential and traffic class across processes. Invalid credentials
share one global refusal bucket. Thus tool audit volume is bounded by quota,
with at most two extra rows per minute per token. Audit rows contain
only the actor, credential UUID and a fixed operation name. Arguments,
questions, answers, bearer hashes and exception details are never audited.
If audit storage fails, execution is refused.

Each tool's text content is capped at 6,000 characters. An oversized result is
wrapped as `truncated: true`, an explicit limit message and a preview. The
full sanitized owner answer and evidence remain in the owner conversation.
Raw model prompts and outputs are not retained for this surface. Free-text
credential patterns, known environment credentials, the bearer and this owner's
provider keys are filtered before responses, capability records, chat evidence
or model metadata are persisted. Secret-shaped input is refused before chat
storage. Runtime informational logs are suppressed so stdout contains only
newline-delimited JSON-RPC. Credentials must still be kept out of ordinary
agent content; pattern filtering cannot identify an arbitrary unlabeled secret.
Public chain addresses and transaction hashes are preserved unless they match
a known secret literal. Environment values of eight or more characters whose
names contain TOKEN, KEY, SECRET or PASSWORD are treated as secret literals;
benign values in those variables can also be redacted. Input frames are limited
to 32,768 bytes while streaming, before a complete line is buffered.

## Verification

`tests/integration/agentMcp.test.ts` spawns the real stdio entry against the
per-process integration database. It covers the exact tool menu, owner scope,
owner-chat evidence, trace reads, PAUSE ALL, live revocation, concurrent quota,
sealed credentials, bounded answers, secret exclusion and indirect write refusal.
Unit coverage checks credential filtering and the capability loop's write
restriction and authorization checkpoint after generation.

Integration setup creates and migrates one database per process. Abandoned
databases are pruned separately with `node --import tsx tools/prune-test-databases.mts`.
Run maintenance between suites: PostgreSQL database deletion can wait for a
checkpoint longer than the default hook timeout. It never belongs in setup.
