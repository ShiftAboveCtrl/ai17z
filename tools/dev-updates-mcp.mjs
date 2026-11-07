#!/usr/bin/env node
/**
 * AI17Z development updates, as an MCP server over stdio.
 *
 * A coding assistant working on a project calls `share_dev_update` when
 * something worth telling people about is finished. The update goes to the
 * owner's AI17Z installation, which decides (or lets the owner decide) whether
 * and when the project's agent posts about it.
 *
 * Plain Node with no dependencies, on purpose: it runs wherever the assistant
 * runs, which is usually not where AI17Z's own packages are installed. Node 18
 * or later, for the global fetch.
 *
 * Configuration, all from the environment:
 *
 *   AI17Z_API_URL              where the AI17Z API listens (default http://localhost:8787)
 *   AI17Z_DEV_UPDATES_TOKEN    the sender token the owner issued for this project
 *   AI17Z_DEV_UPDATES_PROJECT  the project key that token belongs to
 *
 * The token can submit and read this one project's updates. It cannot approve
 * anything, change how the project posts, or see any other project.
 *
 * Nothing here reads the repository. What is shared is exactly what the
 * assistant puts in the call.
 */
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export const SERVER_NAME = 'ai17z-dev-updates';
export const SERVER_VERSION = '1.0.0';
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = [
  'Use share_dev_update when a meaningful piece of work on this project is finished and verified:',
  'a feature people can use, a fix for a bug people hit, a measurable improvement, a milestone or a release.',
  'Not for chores, refactors, CI, docs, dependency bumps or work in progress.',
  'Share only facts that are already public or that you have been told may be public.',
  'Never include code, diffs, file paths, internal URLs, hostnames, IP addresses, emails, tokens or keys.',
  'Never share security work of any kind (vulnerabilities, exploits, auth bypasses, CVEs, security fixes, incidents or leaks),',
  'and never share anything unreleased, unannounced, embargoed, under NDA, confidential or internal. These are refused even when',
  'publicConfirmed is true, and setting publicConfirmed does not make them safe: if in doubt, do not call this tool.',
  'Write the post the way the developer who shipped it would: plain, specific, casual, first person or no person,',
  'no hype, at most one hashtag, no @mentions, and never mention Claude, AI, an assistant, an agent or automation as the author.',
  'The owner reviews updates unless they chose auto mode, and posting is capped and spaced, so one good update beats several small ones.',
].join(' ');

const KINDS = ['FEATURE', 'FIX', 'IMPROVEMENT', 'MILESTONE', 'RELEASE'];
const EVIDENCE_TYPES = ['COMMIT', 'PULL_REQUEST', 'ISSUE', 'RELEASE', 'TEST', 'BENCHMARK', 'NOTE'];

export const TOOLS = [
  {
    name: 'share_dev_update',
    title: 'Share a development update',
    description:
      'Hand a finished, public piece of work on this project to the AI17Z agent that posts about it. ' +
      'Returns whether it was accepted, refused (with the rule it broke), or already known. ' +
      INSTRUCTIONS,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'title', 'summary', 'why', 'evidence', 'publicConfirmed'],
      properties: {
        kind: { type: 'string', enum: KINDS, description: 'What sort of thing shipped.' },
        title: {
          type: 'string',
          maxLength: 120,
          description: 'What changed, specifically. "Replies keep their thread after a restart", not "bug fixes".',
        },
        summary: {
          type: 'string',
          maxLength: 600,
          description: 'What is different now for somebody using the project, in a sentence or two. No code.',
        },
        why: { type: 'string', maxLength: 300, description: 'Why it matters to the people using it.' },
        evidence: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          description:
            'What shows it is real: a commit sha, pull request or issue number, release tag, a passing test suite or a measured number.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'detail'],
            properties: {
              type: { type: 'string', enum: EVIDENCE_TYPES },
              ref: { type: 'string', maxLength: 80, description: 'Short sha, "#123", a tag like "v1.4.0". Optional.' },
              detail: { type: 'string', maxLength: 200, description: 'One line, public, no code.' },
            },
          },
        },
        post: {
          type: 'string',
          maxLength: 280,
          description:
            'Optional. The post itself, in the developer\'s own casual voice, 280 characters at most. Leave it out and AI17Z writes one from the facts.',
        },
        publicConfirmed: {
          type: 'boolean',
          description: 'True only if every fact in this update may be published. Anything else is refused.',
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'dev_update_status',
    title: 'Check a development update',
    description:
      'What happened to an update shared earlier: waiting for review, approved, posted (with the link), rehearsed, rejected or failed, and why.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'string', description: 'The id share_dev_update returned.' } },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_dev_updates',
    title: 'List recent development updates',
    description: 'The most recent updates shared for this project and where each one is. Check before sharing to avoid repeating one.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many, newest first. Default 10.' } },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'dev_update_rules',
    title: 'How this project posts',
    description: 'Whether updates wait for the owner, how many may go out a day, how far apart, and whether the project is only rehearsing.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

function text(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function toolResult(data, isError = false) {
  const result = { content: [{ type: 'text', text: text(data) }], isError };
  if (data && typeof data === 'object' && !Array.isArray(data)) result.structuredContent = data;
  return result;
}

/** A retried call with the same facts is the same request, so it cannot become two updates. */
export function requestIdFor(args) {
  return createHash('sha256')
    .update(`${args.kind}|${String(args.title ?? '').trim().toLowerCase()}|${String(args.summary ?? '').trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * The server, without the transport, so it can be driven by a test.
 *
 * `handle` takes one parsed JSON-RPC message and returns the response, or null
 * for a notification.
 */
export function createServer(options = {}) {
  const env = options.env ?? process.env;
  const apiUrl = String(env.AI17Z_API_URL || 'http://localhost:8787').replace(/\/+$/, '');
  const token = env.AI17Z_DEV_UPDATES_TOKEN || env.XBAM_DEV_UPDATES_TOKEN || '';
  const projectKey = String(env.AI17Z_DEV_UPDATES_PROJECT || env.XBAM_DEV_UPDATES_PROJECT || '').trim().toLowerCase();
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function api(method, path, body) {
    let response;
    try {
      response = await fetchImpl(`${apiUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      return { ok: false, message: `AI17Z is not reachable at ${apiUrl} (${error instanceof Error ? error.message : String(error)}). Is it running?` };
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // A body that is not JSON is reported by status below; there is nothing in it to show.
    }
    if (payload && payload.ok === true) return { ok: true, data: payload.data };
    const error = payload && payload.error ? payload.error : null;
    return {
      ok: false,
      status: response.status,
      message: error?.message ?? `AI17Z answered ${response.status}.`,
      details: error?.details,
    };
  }

  function notConfigured() {
    const missing = [!token && 'AI17Z_DEV_UPDATES_TOKEN', !projectKey && 'AI17Z_DEV_UPDATES_PROJECT'].filter(Boolean);
    if (missing.length === 0) return null;
    return toolResult(
      `This server is not configured: set ${missing.join(' and ')}. The project owner creates the project in AI17Z and issues the token.`,
      true,
    );
  }

  async function callTool(name, args = {}) {
    const unset = notConfigured();
    if (unset) return unset;

    if (name === 'share_dev_update') {
      if (args.publicConfirmed !== true) {
        return toolResult('Not sent. Set publicConfirmed to true only once every fact in the update may be published.', true);
      }
      const body = {
        projectKey,
        kind: args.kind,
        title: args.title,
        summary: args.summary,
        why: args.why,
        evidence: Array.isArray(args.evidence) ? args.evidence : [],
        disclosure: 'PUBLIC',
        ...(typeof args.post === 'string' && args.post.trim() ? { post: args.post } : {}),
        clientRequestId: requestIdFor(args),
      };
      const result = await api('POST', '/api/dev-updates/sender/updates', body);
      if (!result.ok) {
        const refusals = result.details?.refusals;
        return toolResult(
          refusals ? { refused: true, message: result.message, refusals } : { refused: false, message: result.message },
          true,
        );
      }
      const { outcome, update, reason } = result.data;
      if (outcome === 'DUPLICATE') {
        return toolResult({ outcome, reason, id: update?.id ?? null, status: update?.status ?? null, url: update?.url ?? null });
      }
      return toolResult({ outcome, id: update.id, status: update.status, reason: update.reason, post: update.post });
    }

    if (name === 'dev_update_status') {
      if (typeof args.id !== 'string' || !args.id) return toolResult('Give the id share_dev_update returned.', true);
      const result = await api('GET', `/api/dev-updates/sender/updates/${encodeURIComponent(args.id)}`);
      if (!result.ok) return toolResult(result.message, true);
      const u = result.data;
      return toolResult({ id: u.id, title: u.title, status: u.status, reason: u.reason, waitingBecause: u.waitingBecause, url: u.url, post: u.post });
    }

    if (name === 'list_dev_updates') {
      const limit = Number.isInteger(args.limit) ? Math.min(50, Math.max(1, args.limit)) : 10;
      const result = await api('GET', `/api/dev-updates/sender/updates?limit=${limit}`);
      if (!result.ok) return toolResult(result.message, true);
      return toolResult({
        items: result.data.items.map((u) => ({ id: u.id, kind: u.kind, title: u.title, status: u.status, reason: u.reason, url: u.url, createdAt: u.createdAt })),
      });
    }

    if (name === 'dev_update_rules') {
      const result = await api('GET', '/api/dev-updates/sender/project');
      if (!result.ok) return toolResult(result.message, true);
      return toolResult(result.data);
    }

    return null;
  }

  async function handle(message) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
    }
    const isNotification = message.id === undefined || message.id === null;
    const reply = (result) => (isNotification ? null : { jsonrpc: '2.0', id: message.id, result });
    const failure = (code, msg) => (isNotification ? null : { jsonrpc: '2.0', id: message.id, error: { code, message: msg } });

    switch (message.method) {
      case 'initialize': {
        const requested = message.params?.protocolVersion;
        return reply({
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, title: 'AI17Z development updates', version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const name = message.params?.name;
        if (!TOOLS.some((t) => t.name === name)) return failure(-32602, `Unknown tool: ${name}`);
        try {
          return reply(await callTool(name, message.params?.arguments ?? {}));
        } catch (error) {
          return reply(toolResult(`The update could not be handled: ${error instanceof Error ? error.message : String(error)}`, true));
        }
      }
      default:
        return failure(-32601, `Method not found: ${message.method}`);
    }
  }

  return { handle, callTool };
}

/** Newline-delimited JSON-RPC on stdin and stdout. Nothing else may write to stdout. */
export function runStdio(server = createServer(), input = process.stdin, output = process.stdout) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const write = (msg) => output.write(`${JSON.stringify(msg)}\n`);
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const batch = Array.isArray(message) ? message : [message];
    for (const item of batch) {
      Promise.resolve(server.handle(item)).then((response) => {
        if (response) write(response);
      });
    }
  });
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio\n`);
  runStdio();
}
