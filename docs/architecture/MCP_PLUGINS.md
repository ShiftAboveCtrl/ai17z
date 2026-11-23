# External MCP servers as Plugins

An owner attaches one HTTPS Streamable HTTP endpoint as one `LOCAL` installed
Plugin with kind `MCP_SERVER`. It contributes ordinary capabilities named
`plugin_<id>.<toolName>`. The existing registry, `invokeCapability`, permission
rows, readiness, per-agent Plugin hourly budget and invocation audit remain the
only execution machinery. No migration or additional permission table is needed.

## Attach and refresh

Use the authenticated owner API `POST /api/agents/:id/plugins/mcp` with a
`manifest` JSON string and an optional `credential`. The manifest contains the
usual Plugin identity and compatibility fields, `kind: "MCP_SERVER"`, and:

```json
{
  "mcp": {
    "url": "https://mcp.example.invalid/mcp",
    "timeoutMs": 10000,
    "quotaPerHour": 30,
    "credentialKey": "api_key"
  },
  "config": [
    { "key": "api_key", "label": "MCP credential", "secret": true, "required": true }
  ]
}
```

Omit `credentialKey` and its config declaration for a public server. Credentials
are bearer tokens sealed with the existing Plugin secret store under the master
key, scoped to the specified agent. They never enter a manifest or audit payload.
Other agents supply their own credentials through the existing Plugin config API.
Endpoint URLs reject userinfo, query strings and fragments to keep credentials out
of portable metadata. Only public HTTPS destinations pass `safeFetch`; redirects
are refused before credentials can leave the approved endpoint.
An endpoint change is checked for footprint expansion before discovery can send
an existing sealed credential to the proposed address.

Refresh with `POST /api/agents/:id/plugins/:pluginId/mcp/refresh`. Both attach
and refresh fetch the entire paginated `tools/list`, bound its size, and save the
snapshot in the installed manifest. Supplied snapshots are replaced by discovery.
Workers register that saved snapshot without contacting the server. Invocation
detects the protocol era and calls the named tool without listing tools again.

Every new tool starts `DISABLED` for every agent. Enabling the Plugin writes the
ordinary capability permission rows. A refresh that adds tools, changes input
schemas, makes a refused tool readable, changes the endpoint or raises limits
uses `pluginFootprint` and `footprintExpansion`. A refusal returns
`needsAcknowledgement` sentences and leaves the previous snapshot registered.
The owner repeats with `acknowledgeExpansion: true` after reviewing those facts.
Acknowledging expansion does not enable a newly added tool.

## Boundaries

Only tools explicitly annotated `readOnlyHint: true` may run. All other tools are
listed with an unavailable sentence, including tools with missing annotations.
Annotations are claims made by the server. They cannot prove that its remote
implementation is read-only; the owner still chooses which endpoint to trust.

Descriptions are untrusted data. Before entering a capability or model menu they
are capped, escaped and enclosed in an `untrusted-mcp` fence. Server titles and
schema descriptions never become trusted instructions. Input schemas support a
bounded subset of JSON Schema for objects, arrays, primitives and enums. Unsupported
schemas stay listed but unavailable. No schema loads a reference, regex, file,
module or program. Unknown argument fields are refused even when a server schema
allows extras. Server text and tool names never become local paths or code.

The endpoint hostname is the allowlist. Timeouts range from 1 to 30 seconds and
quotas from 1 to 600 calls per hour per agent per Plugin. A call is charged before
network execution. Responses are bounded to 512 KB; discovery is bounded to 64
tools and 16 pages. Text results are fenced and capped at 16000 source characters
in total. Non-text assets and resource links are not followed. MCP errors produce
local sentences, and results that echo the bearer credential are refused, so
server errors and echoed credentials do not enter logs and audits.

## Protocol and limits

The minimal client follows the [2026-07-28 Streamable HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http):
POST JSON-RPC, JSON and SSE responses, per-request protocol and capability
metadata, and matching protocol, method and tool-name headers. `server/discover`
detects the protocol era without listing tools. Recognized modern errors never
trigger a downgrade. A documented legacy HTTP rejection selects the
[2025-11-25 initialization flow](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
with negotiated protocol and optional session headers. SSE reads stop when
the matching response arrives, even when the server keeps the stream open.
There is no stdio, subprocess, legacy SSE endpoint discovery, OAuth flow,
server-driven sampling, elicitation, roots, background GET subscription or
automatic replay of interrupted calls. Only complete modern results are accepted;
requests for sampling, roots or other client input are refused. Custom
`x-mcp-header` schema annotations are outside the supported input subset, so those
tools remain listed and unavailable. An expired legacy session can be initialized
again once; an interrupted tool call is never retried automatically.

Tests use a local fake MCP peer with a test-only transport mapping and mock
agents. Production has no switch that permits private MCP endpoints. These tests
prove local protocol behavior and canonical permission/audit integration. They
do not certify third-party server behavior or a live public deployment.
