import { z } from 'zod';
import { safeFetch } from '@xbam/upstream';
import { PluginMcpServer, PluginMcpTool } from '@xbam/shared/contracts';

type Transport = typeof safeFetch;
const VERSION = '2025-11-25';
const MODERN_VERSION = '2026-07-28';
const VERSIONS = new Set([VERSION, '2025-06-18', '2025-03-26']);
const MAX_BYTES = 512 * 1024;
class LegacyEndpoint extends Error {}

/** Server descriptions are evidence, never instructions or trusted markup. */
export function fenceMcpText(raw: string, limit = 600): string {
  const text = raw.slice(0, limit).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/`/g, '&#96;').split('').filter(char => char === '\n' || char === '\t' ||
      (char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)).join('').slice(0, limit * 2);
  return `<untrusted-mcp>\n${text}\n</untrusted-mcp>`;
}

function messages(text: string): unknown[] {
  if (text.trimStart().startsWith('{')) return [JSON.parse(text)];
  return text.split(/\r?\n\r?\n/).slice(0, -1).flatMap(event => {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, '')).join('\n');
    return data.trim() ? [JSON.parse(data)] : [];
  });
}

const Reply = z.object({ jsonrpc: z.literal('2.0'), id: z.number(),
  result: z.unknown().optional(), error: z.unknown().optional() });

/** No server-supplied addresses, code, roots, sampling or subprocesses. */
export class McpClient {
  private nextId = 0;
  private session: string | undefined;
  private version = MODERN_VERSION;
  private legacy = false;

  constructor(private readonly url: string, private readonly signal: AbortSignal,
    private readonly credential?: string, private readonly transport: Transport = safeFetch) {
    PluginMcpServer.pick({ url: true }).parse({ url });
    this.url = new URL(url).toString();
    if (credential && (credential.length > 4000 || [...credential].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) {
      throw new Error('The MCP credential is invalid.');
    }
  }

  private async post(method: string, params: Record<string, unknown>, notification = false, recoverSession = true): Promise<unknown> {
    const id = ++this.nextId;
    try {
      const response = await this.transport(this.url, {
        signal: this.signal, method: 'POST', maxBytes: MAX_BYTES, noRedirects: true,
        headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json',
          'mcp-protocol-version': this.version,
          ...(!this.legacy ? { 'mcp-method': method, ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}) } : {}),
          ...(this.session ? { 'mcp-session-id': this.session } : {}),
          ...(this.credential ? { authorization: `Bearer ${this.credential}` } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method,
          params: this.legacy ? params : { ...params, _meta: {
            'io.modelcontextprotocol/protocolVersion': this.version,
            'io.modelcontextprotocol/clientInfo': { name: 'AI17Z', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          } } }),
        textComplete: text => {
          try { return messages(text).some(value => Reply.safeParse(value).data?.id === id); }
          catch { return false; } // A partial JSON chunk is not a protocol error yet.
        },
      });
      if (response.url === this.url && method === 'server/discover' && [400, 404, 405].includes(response.status)) {
        let modernError = false;
        try {
          const body = z.object({ error: z.object({ code: z.number() }) }).parse(JSON.parse(response.text));
          modernError = [-32020, -32021, -32022, -32601].includes(body.error.code);
        } catch { /* An empty or non-protocol error is the documented legacy detection signal. */ }
        if (!modernError) throw new LegacyEndpoint();
      }
      if (response.url === this.url && response.status === 404 && this.session && recoverSession && !notification && method !== 'initialize') {
        await this.initialize();
        if (method === 'tools/list') return this.post(method, params, false, false);
        // A call is never replayed. A later invocation starts a fresh session.
        throw new Error('The MCP session expired.');
      }
      if (response.url !== this.url || response.status < 200 || response.status >= 300) {
        throw new Error('The MCP endpoint refused the request.');
      }
      if (notification) {
        if (response.status !== 202 || response.text.trim()) throw new Error('The MCP notification was not accepted.');
        return undefined;
      }
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
      if (contentType !== 'application/json' && contentType !== 'text/event-stream') {
        throw new Error('The MCP response had an unsupported content type.');
      }
      const candidates = messages(response.text).map(value => Reply.safeParse(value))
        .flatMap(value => value.success && value.data.id === id ? [value.data] : []);
      const reply = candidates[0];
      if (candidates.length !== 1 || !reply || reply.error !== undefined || reply.result === undefined) {
        throw new Error('The MCP response was not a matching successful JSON-RPC response.');
      }
      if (this.credential && JSON.stringify(reply.result).includes(JSON.stringify(this.credential).slice(1, -1))) {
        throw new Error('The MCP response echoed a credential.');
      }
      if (!this.legacy && z.object({ resultType: z.literal('complete') }).safeParse(reply.result).success === false) {
        throw new Error('This MCP request needs unsupported interaction or has an invalid result type.');
      }
      if (method === 'initialize') {
        const session = response.headers.get('mcp-session-id');
        if (session && !/^[\x21-\x7e]{1,256}$/.test(session)) throw new Error('The MCP session header was invalid.');
        this.session = session ?? undefined;
      }
      return reply.result;
    } catch (error) {
      if (error instanceof LegacyEndpoint) throw error;
      // Server errors can echo a credential. Only locally authored text escapes.
      throw new Error(`The MCP ${method === 'initialize' || method === 'server/discover' ? 'initialization' : 'response'} failed or was not supported.`);
    }
  }

  async initialize(): Promise<void> {
    this.session = undefined;
    if (!this.legacy) {
      try {
        const result = z.object({ supportedVersions: z.array(z.string()).max(20),
          capabilities: z.object({ tools: z.object({}).optional() }) }).parse(await this.post('server/discover', {}));
        if (!result.supportedVersions.includes(MODERN_VERSION) || !result.capabilities.tools) {
          throw new Error('This MCP server does not support the current tools protocol.');
        }
        return;
      } catch (error) {
        if (!(error instanceof LegacyEndpoint)) throw error;
        this.legacy = true;
        this.version = VERSION;
      }
    }
    const result = z.object({ protocolVersion: z.string(), capabilities: z.object({ tools: z.object({}).optional() }) })
      .parse(await this.post('initialize', { protocolVersion: VERSION, capabilities: {},
        clientInfo: { name: 'AI17Z', version: '1.0.0' } }));
    if (!VERSIONS.has(result.protocolVersion) || !result.capabilities.tools) throw new Error('This MCP server does not support the tools protocol.');
    this.version = result.protocolVersion;
    await this.post('notifications/initialized', {}, true);
  }

  async listTools(): Promise<PluginMcpTool[]> {
    const tools: PluginMcpTool[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 16; page += 1) {
      const result = z.object({ tools: z.array(z.object({
        name: z.string(), description: z.string().optional(), inputSchema: z.record(z.string(), z.unknown()),
        annotations: z.object({ readOnlyHint: z.unknown().optional() }).optional(),
      })).max(64), nextCursor: z.string().min(1).max(2048).optional() })
        .parse(await this.post('tools/list', cursor ? { cursor } : {}));
      for (const tool of result.tools) {
        if (tools.some(old => old.name === tool.name)) throw new Error('The MCP tool list contains duplicate names.');
        tools.push(PluginMcpTool.parse({ name: tool.name, description: tool.description ?? '',
          inputSchema: tool.inputSchema, readOnlyHint: tool.annotations?.readOnlyHint === true }));
      }
      if (tools.length > 64) throw new Error('An MCP Plugin may contribute at most 64 tools.');
      cursor = result.nextCursor;
      if (!cursor) return tools;
      if (seen.has(cursor)) throw new Error('The MCP tool list repeated a page.');
      seen.add(cursor);
    }
    throw new Error('The MCP tool list exceeded 16 pages.');
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    PluginMcpTool.shape.name.parse(name);
    const result = z.object({ content: z.array(z.record(z.string(), z.unknown())).max(100),
      structuredContent: z.record(z.string(), z.unknown()).optional(), isError: z.boolean().optional() })
      .parse(await this.post('tools/call', { name, arguments: args }));
    if (result.isError) throw new Error('The MCP tool reported that its read failed.');
    // Only textual evidence is exposed. Resource links and executable assets are not followed.
    let remaining = 16_000;
    return { content: result.content.flatMap(block => {
      if (block.type !== 'text' || typeof block.text !== 'string' || remaining <= 0) return [];
      const text = block.text.slice(0, remaining);
      remaining -= text.length;
      return [{ type: 'text', text: fenceMcpText(text, 16_000) }];
    }) };
  }
}
