import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';

/**
 * A server that speaks the AI17Z Plugin Registry protocol.
 *
 * The official registry has not been deployed and there is no website source
 * in this workspace, so the client would otherwise be tested against mocks of
 * itself. This is the alternative: a real HTTP server implementing the
 * contract in `docs/architecture/PLUGIN_REGISTRY.md`, so the client is proved
 * against the protocol rather than against an idea of it.
 *
 * It is deliberately small and deliberately strict. Where the contract says a
 * field is required, this refuses without it; where it says a key is optional,
 * this answers public Plugins without one and entitled Plugins only with one.
 * A test server that is more forgiving than the specification is a test server
 * that hides exactly the bugs it exists to catch.
 */

export interface RegistryPlugin {
  id: string;
  name: string;
  summary: string;
  publisher: string;
  version: string;
  /** Needs a key. Absent from the catalogue and refused without one. */
  entitled?: boolean;
  /** The manifest text. Its sha256 is published beside it. */
  manifest: string;
  /** Overrides the real hash, to prove the client checks it. */
  publishHashAs?: string;
}

export interface FakeRegistry {
  url: string;
  /** Every request path this received, so "did it ask" is testable. */
  requests: string[];
  /** Whether the last request carried a key, without recording the key. */
  sawKey: boolean;
  close(): Promise<void>;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function startRegistry(plugins: RegistryPlugin[]): Promise<FakeRegistry> {
  const state = { requests: [] as string[], sawKey: false };

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    state.requests.push(url.pathname + url.search);
    const key = request.headers.authorization;
    state.sawKey = Boolean(key);

    const send = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(text);
    };

    // The catalogue. Public Plugins need no key; entitled ones are simply not
    // listed without one, rather than listed and then refused.
    if (url.pathname === '/api/v1/plugins') {
      const search = (url.searchParams.get('q') ?? '').toLowerCase();
      const visible = plugins
        .filter((plugin) => (plugin.entitled ? Boolean(key) : true))
        .filter((plugin) => !search || plugin.name.toLowerCase().includes(search) || plugin.id.includes(search));
      send(200, {
        protocol: 1,
        plugins: visible.map((plugin) => ({
          id: plugin.id,
          name: plugin.name,
          summary: plugin.summary,
          publisher: plugin.publisher,
          version: plugin.version,
          entitled: Boolean(plugin.entitled),
        })),
      });
      return;
    }

    const detail = /^\/api\/v1\/plugins\/([A-Za-z0-9-]+)$/.exec(url.pathname);
    if (detail) {
      const plugin = plugins.find((entry) => entry.id === detail[1]);
      if (!plugin) {
        send(404, { error: 'no such plugin' });
        return;
      }
      if (plugin.entitled && !key) {
        // The one case a key changes: an entitled Plugin says so rather than
        // pretending it does not exist.
        send(403, { error: 'this plugin needs an entitlement' });
        return;
      }
      send(200, {
        protocol: 1,
        plugin: {
          id: plugin.id,
          name: plugin.name,
          summary: plugin.summary,
          publisher: plugin.publisher,
          version: plugin.version,
          entitled: Boolean(plugin.entitled),
        },
        manifest: plugin.manifest,
        manifestSha256: plugin.publishHashAs ?? sha256(plugin.manifest),
      });
      return;
    }

    send(404, { error: 'not found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    get requests() {
      return state.requests;
    },
    get sawKey() {
      return state.sawKey;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
