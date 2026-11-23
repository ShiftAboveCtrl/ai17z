import { createServer } from 'node:http';
import { listenReachable } from './listen';

export const readTool = { name: 'read_weather', description: 'Read the weather forecast.',
  inputSchema: { type: 'object', properties: { place: { type: 'string' } }, required: ['place'], additionalProperties: false },
  annotations: { readOnlyHint: true } };

/** A strict local Streamable HTTP peer. It never reaches a channel adapter. */
export async function startMcpServer() {
  const state = { tools: [readTool] as Record<string, unknown>[], methods: [] as string[],
    sse: false, holdOpen: false, fail: false, sawCredential: false, wrongId: false,
    paginated: false, repeatCursor: false, expireOnce: false, hangCall: false, echoError: false, echoResult: false, redirect: false,
    modern: false, modernError: false };
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const rpc = JSON.parse(body) as { id?: number; method: string; params?: unknown };
    state.methods.push(rpc.method);
    state.sawCredential = request.headers.authorization === 'Bearer test-mcp-key';
    if (state.redirect) { response.writeHead(302, { location: 'https://other.example.test/mcp' }).end(); return; }
    if (state.echoError) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'test-mcp-key' } })); return;
    }
    const send = (result: unknown) => {
      const message = JSON.stringify({ jsonrpc: '2.0', id: state.wrongId ? 999 : rpc.id,
        result: state.modern ? { resultType: 'complete', ...(result as Record<string, unknown>) } : result });
      response.writeHead(200, { 'content-type': state.sse ? 'text/event-stream' : 'application/json', 'mcp-session-id': 'test-session' });
      if (state.sse) {
        response.write(`: keepalive\r\nevent: message\r\ndata: ${message}\r\n\r\n`);
        if (!state.holdOpen) response.end();
      } else response.end(message);
    };
    if (!request.headers.accept?.includes('application/json') || !request.headers.accept.includes('text/event-stream')) {
      response.writeHead(400).end(); return;
    }
    if (state.modern || state.modernError) {
      const meta = (rpc.params as { _meta?: Record<string, unknown> } | undefined)?._meta;
      if (request.headers['mcp-protocol-version'] !== '2026-07-28' || request.headers['mcp-method'] !== rpc.method ||
        meta?.['io.modelcontextprotocol/protocolVersion'] !== '2026-07-28' || !meta['io.modelcontextprotocol/clientCapabilities'] ||
        request.headers['mcp-session-id'] || rpc.method === 'initialize' ||
        (rpc.method === 'tools/call' && request.headers['mcp-name'] !== (rpc.params as { name: string }).name)) {
        response.writeHead(400).end(); return;
      }
      if (state.modernError) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32022,
          message: 'Unsupported protocol version', data: { supported: ['2099-01-01'] } } })); return;
      }
      if (rpc.method === 'server/discover') {
        send({ resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, instructions: 'UNTRUSTED_INSTRUCTIONS' }); return;
      }
    }
    if (rpc.method === 'initialize') {
      send({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'Test', version: '1' } }); return;
    }
    if (!state.modern && (request.headers['mcp-session-id'] !== 'test-session' || request.headers['mcp-protocol-version'] !== '2025-11-25')) {
      response.writeHead(400).end(); return;
    }
    if (rpc.method === 'notifications/initialized') { response.writeHead(202).end(); return; }
    if (rpc.method === 'tools/list') {
      if (state.expireOnce) { state.expireOnce = false; response.writeHead(404).end(); return; }
      const cursor = (rpc.params as { cursor?: string } | undefined)?.cursor;
      send(state.paginated ? { tools: cursor ? state.tools.slice(1) : state.tools.slice(0, 1),
        ...(!cursor || state.repeatCursor ? { nextCursor: 'page-2' } : {}) } : { tools: state.tools }); return;
    }
    if (rpc.method === 'tools/call') {
      if (state.hangCall) return;
      send({ content: [{ type: 'text', text: state.echoResult ? 'test-mcp-key' : 'It is sunny.' }], ...(state.fail ? { isError: true } : {}) }); return;
    }
    response.writeHead(400).end();
  });
  const port = await listenReachable(server);
  return { state, url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  }) };
}
