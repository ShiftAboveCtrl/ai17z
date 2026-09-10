import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { addressVerdict } from './addresses';

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
 * ### What this does not close
 *
 * The name is resolved and judged, and then the request is made by name, so a
 * resolver that answers differently the second time -- DNS rebinding -- has a
 * window. Closing it means connecting to the address that was judged and
 * carrying the name only in the Host header, which needs a custom dispatcher.
 * That is worth doing and is not done here, and this comment is the honest
 * version of that rather than a claim the hole is shut. The window is small,
 * every hop is re-judged, and the alternative -- saying nothing -- is how a
 * partial defence gets treated as a complete one.
 */

/** How many redirects are followed before giving up. */
const MAX_HOPS = 4;

export interface SafeFetchOptions {
  signal: AbortSignal;
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

/** Judges one URL: its scheme, and every address its host resolves to. */
async function judge(url: URL, allowPrivate: boolean): Promise<void> {
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    throw new UnsafeUrlError(
      `${url.protocol}// is not fetched. Only https is, and only to an address on the public internet.`,
    );
  }
  if (allowPrivate) return;

  // An address that is already an address is judged as one. Sending it through
  // a resolver first is a round trip to be told what it says on the tin, and it
  // puts a resolver between the check and the thing being checked for no
  // benefit. `URL.hostname` keeps the brackets on an IPv6 literal.
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare)) {
    const verdict = addressVerdict(bare);
    if (!verdict.allowed) throw new UnsafeUrlError(`${bare} is not fetched: ${verdict.why}`);
    return;
  }

  let addresses: { address: string }[];
  try {
    // Every address, not the first: a name that answers with one public and one
    // loopback address would pass a check that looked at whichever came first.
    addresses = await lookup(url.hostname, { all: true });
  } catch (error) {
    throw new UnsafeUrlError(`${url.hostname} could not be resolved: ${(error as Error).message}`);
  }
  if (addresses.length === 0) throw new UnsafeUrlError(`${url.hostname} resolved to nothing.`);

  for (const { address } of addresses) {
    const verdict = addressVerdict(address);
    if (!verdict.allowed) {
      throw new UnsafeUrlError(`${url.hostname} resolves to ${address}, which is not fetched: ${verdict.why}`);
    }
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

  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    await judge(url, allowPrivate);

    const response = await fetch(url, {
      signal: options.signal,
      method: options.method ?? 'GET',
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.body === undefined ? {} : { body: options.body }),
      // Followed by hand so every hop is judged. `follow` would let one 302
      // undo all of this.
      redirect: 'manual',
    });

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop === MAX_HOPS) throw new UnsafeUrlError(`${rawUrl} redirected more than ${MAX_HOPS} times.`);
      // Resolved against the current URL, so a relative Location works and an
      // absolute one to somewhere else is judged on its own merits.
      url = new URL(location, url);
      continue;
    }

    return { status: response.status, url: url.toString(), headers: response.headers, text: await read(response, maxBytes) };
  }

  throw new UnsafeUrlError(`${rawUrl} redirected more than ${MAX_HOPS} times.`);
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
