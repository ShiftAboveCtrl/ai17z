import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript with no declarations, on purpose: it runs where AI17Z's packages are not installed.
import { TOOLS, createServer, requestIdFor, runStdio } from '../../tools/dev-updates-mcp.mjs';

/**
 * The MCP server a coding assistant talks to.
 *
 * Two halves are pinned: the protocol (what an MCP client sends and expects
 * back), and the contract with AI17Z's sender API (what the server actually
 * sends, which is the half that decides whether anything private leaves the
 * assistant's machine).
 */

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

type Handle = (message: unknown) => Promise<Record<string, unknown> | null>;

function fakeApi(respond: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const { status, body } = respond(call);
    return { status, json: async () => body };
  };
  return { calls, fetch };
}

const env = {
  AI17Z_API_URL: 'http://127.0.0.1:9999/',
  AI17Z_DEV_UPDATES_TOKEN: 'ai17z_dus_test-token-value-0000000000',
  AI17Z_DEV_UPDATES_PROJECT: 'AI17Z',
};

const update = {
  kind: 'FIX',
  title: 'Replies keep their thread after a restart',
  summary: 'A worker restart used to drop the conversation a reply belonged to.',
  why: 'Long conversations stop losing their context.',
  evidence: [{ type: 'COMMIT', ref: '3b724fe', detail: 'Thread binding survives recovery' }],
  publicConfirmed: true,
};

function server(respond: (call: Call) => { status: number; body: unknown }, overrides: Record<string, string> = {}) {
  const api = fakeApi(respond);
  const s = createServer({ env: { ...env, ...overrides }, fetch: api.fetch }) as { handle: Handle };
  return { handle: s.handle, calls: api.calls };
}

const ok = (data: unknown) => ({ status: 200, body: { ok: true, data } });

describe('the MCP protocol', () => {
  it('initializes with the version the client asked for when it is supported', async () => {
    const { handle } = server(() => ok({}));
    const response = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    const result = response!.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2025-06-18');
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
    expect((result.serverInfo as { name: string }).name).toBe('ai17z-dev-updates');
    expect(String(result.instructions)).toMatch(/never mention Claude/i);
  });

  it('offers its newest version to a client asking for one it does not know', async () => {
    const { handle } = server(() => ok({}));
    const response = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect((response!.result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25');
  });

  it('answers ping, stays silent on notifications, and rejects unknown methods', async () => {
    const { handle } = server(() => ok({}));
    expect(await handle({ jsonrpc: '2.0', id: 2, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect((await handle({ jsonrpc: '2.0', id: 3, method: 'resources/list' }))!.error).toMatchObject({ code: -32601 });
    expect((await handle({ id: 4, method: 'ping' }))!.error).toMatchObject({ code: -32600 });
  });

  it('lists four tools with schemas, and only one of them writes', async () => {
    const { handle } = server(() => ok({}));
    const response = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
    const tools = (response!.result as { tools: Array<{ name: string; inputSchema: { type: string }; annotations: { readOnlyHint?: boolean } }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(['share_dev_update', 'dev_update_status', 'list_dev_updates', 'dev_update_rules']);
    for (const tool of tools) expect(tool.inputSchema.type).toBe('object');
    expect(tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name)).toEqual(['share_dev_update']);
    expect(TOOLS).toHaveLength(4);
  });

  it('calls an unknown tool a protocol error', async () => {
    const { handle } = server(() => ok({}));
    const response = await handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'approve_update', arguments: {} } });
    expect(response!.error).toMatchObject({ code: -32602 });
  });
});

describe('sharing an update', () => {
  it('sends exactly the facts given, with the disclosure, project key and a stable request id', async () => {
    const { handle, calls } = server(() => ({
      status: 201,
      body: { ok: true, data: { outcome: 'ACCEPTED', update: { id: 'u1', status: 'PENDING_REVIEW', reason: 'Waiting.', post: 'p' } } },
    }));
    const response = await handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'share_dev_update', arguments: update } });
    const result = response!.result as { isError: boolean; structuredContent: Record<string, unknown> };
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ outcome: 'ACCEPTED', id: 'u1', status: 'PENDING_REVIEW' });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('http://127.0.0.1:9999/api/dev-updates/sender/updates');
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe(`Bearer ${env.AI17Z_DEV_UPDATES_TOKEN}`);
    expect(call.body).toEqual({
      projectKey: 'ai17z',
      kind: update.kind,
      title: update.title,
      summary: update.summary,
      why: update.why,
      evidence: update.evidence,
      disclosure: 'PUBLIC',
      clientRequestId: requestIdFor(update),
    });
    // A retried call is the same request.
    expect(requestIdFor({ ...update })).toBe(requestIdFor(update));
  });

  it('sends nothing at all unless the facts are confirmed public', async () => {
    const { handle, calls } = server(() => ok({}));
    const response = await handle({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'share_dev_update', arguments: { ...update, publicConfirmed: false } },
    });
    expect((response!.result as { isError: boolean }).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('reports a refusal as a tool error with the rules, so the assistant can rewrite', async () => {
    const { handle } = server(() => ({
      status: 422,
      body: {
        ok: false,
        error: {
          code: 'VALIDATION_FAILED',
          message: 'This update cannot be shared.',
          details: { refusals: [{ code: 'ATTRIBUTION', field: 'post', message: 'Write it as the person shipping the work.' }] },
        },
      },
    }));
    const response = await handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'share_dev_update', arguments: update } });
    const result = response!.result as { isError: boolean; structuredContent: { refused: boolean; refusals: unknown[] } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.refused).toBe(true);
    expect(result.structuredContent.refusals).toHaveLength(1);
  });

  it('says plainly when it is not configured, without calling anybody', async () => {
    const { handle, calls } = server(() => ok({}), { AI17Z_DEV_UPDATES_TOKEN: '' });
    const response = await handle({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'dev_update_rules', arguments: {} } });
    const result = response!.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('AI17Z_DEV_UPDATES_TOKEN');
    expect(calls).toHaveLength(0);
  });

  it('turns an unreachable AI17Z into a sentence, not a crash', async () => {
    const s = createServer({
      env,
      fetch: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    }) as { handle: Handle };
    const response = await s.handle({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'list_dev_updates', arguments: {} } });
    const result = response!.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/not reachable/);
  });
});

describe('the stdio transport', () => {
  it('reads newline-delimited requests and writes one response line each', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const s = createServer({ env, fetch: async () => ({ status: 200, json: async () => ({ ok: true, data: {} }) }) });
    runStdio(s, input, output);

    const lines: string[] = [];
    output.on('data', (chunk: Buffer) => lines.push(...chunk.toString('utf8').split('\n').filter(Boolean)));
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write('not json\n');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);

    const deadline = Date.now() + 5_000;
    while (lines.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    const messages = lines.map((l) => JSON.parse(l) as { id: number | null; result?: unknown; error?: { code: number } });
    expect(messages).toHaveLength(3);
    expect(messages.find((m) => m.id === 1)?.result).toBeTruthy();
    expect(messages.find((m) => m.id === null)?.error?.code).toBe(-32700);
    expect(messages.find((m) => m.id === 2)?.result).toBeTruthy();
    input.end();
  });

  it('runs as its own process with plain node, and keeps stdout for the protocol', async () => {
    const script = fileURLToPath(new URL('../../tools/dev-updates-mcp.mjs', import.meta.url));
    const child = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk.toString('utf8')));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
    const deadline = Date.now() + 10_000;
    while (!out.join('').includes('\n') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    child.stdin.end();
    await new Promise((resolve) => child.once('exit', resolve));
    expect(JSON.parse(out.join('').trim())).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  }, 20_000);
});
