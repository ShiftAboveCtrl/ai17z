import { fetch as undiciFetch, type Dispatcher } from 'undici';
import { isIP } from 'node:net';
import { addressVerdict } from './addresses';
import { BlockedAddressError, pinnedAgent, type Resolver } from './pinnedAgent';

/**
 * Fetching a URL without it becoming a way to reach this machine.
 *
 * Every upstream goes through here, and so would any capability that reads a
 * URL somebody else chose -- which is the one that actually needs it. An agent
 * asked to "read this link" will read whatever it is handed, and what it is
 * handed can be `http://169.254.169.254/latest/meta-data/iam/security-
 * credentials/`, or the API container by its Docker name, or an admin page on
 * loopback that trusts anything arriving locally.
 *
 * Four checks, and each exists because leaving it out defeats the others:
 *
 *   the **scheme**, because `file:` reads the disk and `data:` is not a fetch;
 *   the **address**, every one the name resolves to, because a hostname is only
 *     a promise about an address and thousands of public names resolve to
 *     127.0.0.1 on purpose;
 *   the **redirects**, one hop at a time, because a public URL that answers 302
 *     to a private one gets there just as well;
 *   the **size**, while it streams, because a check after the fact has already
 *     read the response into memory.
 *
 * ### Rebinding, and why there is no longer a window
 *
 * The first version resolved the name, judged what came back, and then made the
 * request by name -- asking the resolver a second time. A resolver can change
 * its mind between those two questions, so a name that validated as public
 * could connect to loopback with every other check here having passed on the
 * way. There is one resolution now: `pinnedAgent` judges inside undici's
 * connect hook, and whatever that returns is what the socket uses, so the
 * judgement and the connection are the same act.
 *
 * TLS is untouched. The certificate is still verified against the hostname and
 * `rejectUnauthorized` is never set: solving request forgery by weakening HTTPS
 * would trade one hole for a worse one.
 */

/** How many redirects are followed before giving up. */
const MAX_HOPS = 4;

export interface SafeFetchOptions {
  signal: AbortSignal;
  /** Swapped in tests to prove the address connected to is the address judged. */
  resolver?: Resolver;
  /** Swapped in tests that are about the scheme, redirect and size logic. */
  transport?: typeof undiciFetch;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: string;
  /** Refused past this, while it streams rather than after. */
  maxBytes?: number;
  /**
   * Permits `http:` and addresses on this machine's own networks.
   *
   * For an upstream that is deliberately local -- somebody's own node on
   * localhost -- which is a configuration, not a forgery. Off unless an
   * upstream asks, and never available to anything that reads a URL a model or
   * a stranger supplied.
   */
  allowPrivate?: boolean;
}

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

const MAX_BYTES_DEFAULT = 2_000_000;

/**
 * Judges what can be judged before a socket exists: the scheme, and a literal
 * address.
 *
 * A hostname is deliberately *not* resolved here. It is judged once, inside the
 * connect hook, at the moment the socket is opened -- because resolving it here
 * as well is the second question that made rebinding possible in the first
 * place.
 */
function judge(url: URL, allowPrivate: boolean): void {
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    throw new UnsafeUrlError(
      `${url.protocol}// is not fetched. Only https is, and only to an address on the public internet.`,
    );
  }
  if (allowPrivate) return;

  // No resolver is involved for a literal, so there is nothing to pin: what is
  // written is what will be connected to. `URL.hostname` keeps the brackets on
  // an IPv6 literal.
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare)) {
    const verdict = addressVerdict(bare);
    if (!verdict.allowed) throw new UnsafeUrlError(`${bare} is not fetched: ${verdict.why}`);
  }
}

export interface SafeResponse {
  status: number;
  /** The URL that actually answered, after any redirects. */
  url: string;
  headers: Headers;
  text: string;
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions): Promise<SafeResponse> {
  const maxBytes = options.maxBytes ?? MAX_BYTES_DEFAULT;
  const allowPrivate = options.allowPrivate ?? false;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError(`"${rawUrl}" is not a URL.`);
  }

  const agent = pinnedAgent({
    ...(options.resolver ? { resolver: options.resolver } : {}),
    allowPrivate,
  });
  const transport = options.transport ?? undiciFetch;

  try {
    for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
      judge(url, allowPrivate);

      const response = await attempt(transport, url, {
        signal: options.signal,
        method: options.method ?? 'GET',
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.body === undefined ? {} : { body: options.body }),
        // Followed by hand so every hop is judged. `follow` would let one 302
        // undo all of this inside the transport, where none of these checks can
        // see it.
        redirect: 'manual',
        dispatcher: agent as Dispatcher,
      });

      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        if (hop === MAX_HOPS) throw new UnsafeUrlError(`${rawUrl} redirected more than ${MAX_HOPS} times.`);
        // Resolved against the current URL, so a relative Location works and an
        // absolute one elsewhere is judged on its own merits.
        url = new URL(location, url);
        continue;
      }

      return {
        status: response.status,
        url: url.toString(),
        headers: response.headers as unknown as Headers,
        text: await read(response as unknown as Response, maxBytes),
      };
    }

    throw new UnsafeUrlError(`${rawUrl} redirected more than ${MAX_HOPS} times.`);
  } finally {
    // One agent per call, closed with it. A shared pool would keep sockets open
    // to a host a later judgement might refuse.
    await agent.close().catch(() => undefined);
  }
}

/**
 * Makes the request, and lets the reason out.
 *
 * undici reports a refusal from the connect hook as a bare "fetch failed" with
 * the real error underneath in `cause`. Left alone, an owner whose URL was
 * refused for pointing at loopback is told only that a fetch failed -- which is
 * the same unactionable no this whole file exists to avoid.
 */
async function attempt(
  transport: typeof undiciFetch,
  url: URL,
  init: Parameters<typeof undiciFetch>[1],
): ReturnType<typeof undiciFetch> {
  try {
    return await transport(url, init);
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof BlockedAddressError) throw new UnsafeUrlError(cause.message);
    if (error instanceof BlockedAddressError) throw new UnsafeUrlError(error.message);
    throw error;
  }
}

/**
 * Reads a body, stopping at the cap rather than finding out afterwards.
 *
 * `await response.text()` on a response with no end is how a worker runs out of
 * memory reading one page.
 */
async function read(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UnsafeUrlError(`That response is larger than ${maxBytes} bytes, so it was not read.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return new TextDecoder().decode(await new Blob(chunks as BlobPart[]).arrayBuffer());
}
