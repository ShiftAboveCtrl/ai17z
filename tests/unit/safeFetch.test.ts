import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeFetch, UnsafeUrlError } from '@xbam/upstream';

/**
 * Fetching a URL without it becoming a way to reach this machine.
 *
 * The address classifier next door decides what an address *is*; this decides
 * whether a **request** may be made, which has three more ways to go wrong: a
 * scheme that is not a fetch at all, a name that resolves to several addresses
 * of which only one is private, and a perfectly public URL that answers 302 to a
 * private one.
 *
 * ### Why the resolver is injected rather than the network stubbed
 *
 * Because the property that matters is *when* the judgement happens. The
 * version before this resolved a name, judged it, and then connected by name --
 * asking a second time, with a window in between for the answer to change. A
 * test that stubs DNS at the module level cannot tell those two designs apart;
 * a resolver that deliberately answers differently on its second call can, and
 * that is the rebinding case in the middle of this file.
 */

const signal = () => new AbortController().signal;

/** What `dns.lookup` hands back, in the shape the connect hook receives it. */
type LookupCallback = (error: Error | null, addresses: { address: string; family: number }[] | '', family: number) => void;

/** A resolver that answers from a table, in the shape `dns.lookup` uses. */
function resolverFor(table: Record<string, string[]>) {
  const asked: string[] = [];
  const resolver = ((hostname: string, _options: unknown, callback: LookupCallback) => {
    asked.push(hostname);
    const found = table[hostname];
    if (!found) return callback(new Error(`getaddrinfo ENOTFOUND ${hostname}`), '', 0);
    callback(
      null,
      found.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
      0,
    );
  }) as never;
  return { resolver, asked };
}

/** Answers without a socket, for the cases that are about scheme and redirects. */
function transportFor(responses: { status: number; location?: string; body?: string }[]) {
  const asked: string[] = [];
  const options: Record<string, unknown>[] = [];
  const transport = vi.fn(async (input: unknown, init?: Record<string, unknown>) => {
    asked.push(String(input));
    options.push(init ?? {});
    const next = responses.shift() ?? { status: 200, body: 'ok' };
    const headers = new Headers();
    if (next.location) headers.set('location', next.location);
    return new Response(next.body ?? '', { status: next.status, headers });
  }) as never;
  return { transport, asked, options };
}

const PUBLIC = ['93.184.216.34'];

afterEach(() => vi.restoreAllMocks());

describe('schemes that are not a fetch', () => {
  it('refuses file, data and ftp before anything is resolved', async () => {
    const { resolver, asked } = resolverFor({});
    for (const url of ['file:///etc/passwd', 'data:text/plain,hello', 'ftp://example.com/x']) {
      await expect(safeFetch(url, { signal: signal(), resolver })).rejects.toThrow(UnsafeUrlError);
    }
    expect(asked).toEqual([]);
  });

  it('refuses plain http unless an upstream deliberately asked for it', async () => {
    const { resolver } = resolverFor({ 'api.example.com': PUBLIC });
    await expect(safeFetch('http://api.example.com/x', { signal: signal(), resolver })).rejects.toThrow(/Only https/);

    // A node somebody runs themselves is a configuration, not a forgery -- and
    // it is never available to anything reading a URL a stranger supplied.
    const { transport } = transportFor([{ status: 200, body: 'local' }]);
    const answer = await safeFetch('http://localhost:8545/', {
      signal: signal(),
      resolver,
      transport,
      allowPrivate: true,
    });
    expect(answer.text).toBe('local');
  });
});

describe('names that point somewhere private', () => {
  it('refuses a public name that resolves to loopback', async () => {
    // Thousands of real names do this on purpose. No list of bad hostnames
    // catches them, which is why the address is what gets judged.
    const { resolver } = resolverFor({ 'localtest.me': ['127.0.0.1'] });
    await expect(safeFetch('https://localtest.me/', { signal: signal(), resolver })).rejects.toThrow(/127\.0\.0\.1/);
  });

  it('refuses when only one of several addresses is private', async () => {
    // A name answering with one public and one loopback address passes a check
    // that looks at whichever the resolver happened to order first.
    const { resolver } = resolverFor({ 'both.example': ['93.184.216.34', '127.0.0.1'] });
    await expect(safeFetch('https://both.example/', { signal: signal(), resolver })).rejects.toThrow(/not fetched/);
  });

  it('refuses an IPv4-mapped IPv6 private address', async () => {
    const { resolver } = resolverFor({ 'mapped.example': ['::ffff:10.0.0.1'] });
    await expect(safeFetch('https://mapped.example/', { signal: signal(), resolver })).rejects.toThrow(/not fetched/);
  });

  it('refuses IPv6 loopback, by name and as a literal', async () => {
    const { resolver } = resolverFor({ 'six.example': ['::1'] });
    await expect(safeFetch('https://six.example/', { signal: signal(), resolver })).rejects.toThrow(/not fetched/);
    await expect(safeFetch('https://[::1]/x', { signal: signal(), resolver })).rejects.toThrow(/this machine/i);
  });

  it('refuses the cloud metadata address by name or by number', async () => {
    const { resolver } = resolverFor({ 'metadata.google.internal': ['169.254.169.254'] });
    await expect(safeFetch('https://metadata.google.internal/', { signal: signal(), resolver })).rejects.toThrow(
      /metadata/i,
    );
    await expect(
      safeFetch('https://169.254.169.254/latest/meta-data/', { signal: signal(), resolver }),
    ).rejects.toThrow(/metadata/i);
  });

  it('judges a literal without asking a resolver at all', async () => {
    const { resolver, asked } = resolverFor({});
    await expect(safeFetch('https://10.0.0.1/x', { signal: signal(), resolver })).rejects.toThrow(/not fetched/);
    expect(asked).toEqual([]);
  });

  it('refuses a name that resolves to nothing rather than trying anyway', async () => {
    const { resolver } = resolverFor({});
    await expect(safeFetch('https://nowhere.example/', { signal: signal(), resolver })).rejects.toThrow();
  });
});

describe('a resolver that changes its mind', () => {
  it('is asked exactly once, so there is no window to change its mind in', async () => {
    // This is the whole of the rebinding closure, stated as a count. The old
    // shape asked once to validate and once to connect, and a resolver that
    // answered publicly for the first and privately for the second sent the
    // socket to loopback with every other check passed. One question cannot be
    // answered two ways.
    let call = 0;
    const resolver = ((hostname: string, _options: unknown, callback: LookupCallback) => {
      call += 1;
      void hostname;
      // Private, so the attempt ends at the connect hook rather than on a real
      // network -- the count is what is being asserted, not the destination.
      callback(null, [{ address: '127.0.0.1', family: 4 }], 0);
    }) as never;

    await expect(safeFetch('https://rebind.example/', { signal: signal(), resolver })).rejects.toThrow(/127\.0\.0\.1/);
    expect(call).toBe(1);
  });

  it('does no resolving of its own before the socket is opened', async () => {
    // With a transport that never connects, nothing should have been resolved
    // at all: every judgement about a name now happens in the connect hook. A
    // resolution here would be the second question coming back.
    const { resolver, asked } = resolverFor({ 'api.example.com': PUBLIC });
    const { transport } = transportFor([{ status: 200, body: 'ok' }]);
    await safeFetch('https://api.example.com/x', { signal: signal(), resolver, transport });
    expect(asked).toEqual([]);
  });
});

describe('a redirect is a second request and is judged like one', () => {
  it('never asks the transport to follow one for it', async () => {
    // White-box, deliberately: a stub hands back the 302 whichever mode was
    // asked for, so every behavioural redirect test passes just as well with
    // `follow` -- which in production would take the hop inside undici where
    // none of these checks can see it. Found by mutating one to the other and
    // watching nothing fail.
    const { resolver } = resolverFor({ 'api.example.com': PUBLIC });
    const { transport, options } = transportFor([{ status: 200, body: 'ok' }]);
    await safeFetch('https://api.example.com/x', { signal: signal(), resolver, transport });
    expect(options[0]?.redirect).toBe('manual');
  });

  it('judges the hop, so a public URL cannot redirect to a private one', async () => {
    const { resolver } = resolverFor({ 'evil.example': PUBLIC });
    const { transport } = transportFor([{ status: 302, location: 'http://169.254.169.254/latest/meta-data/' }]);
    await expect(safeFetch('https://evil.example/', { signal: signal(), resolver, transport })).rejects.toThrow(
      UnsafeUrlError,
    );
  });

  it('follows an ordinary redirect and reports where it ended up', async () => {
    const { resolver } = resolverFor({ 'moved.example': PUBLIC, 'api.example.com': PUBLIC });
    const { transport, asked } = transportFor([
      { status: 301, location: 'https://api.example.com/final' },
      { status: 200, body: 'arrived' },
    ]);
    const answer = await safeFetch('https://moved.example/start', { signal: signal(), resolver, transport });
    expect(answer.text).toBe('arrived');
    expect(answer.url).toBe('https://api.example.com/final');
    expect(asked).toHaveLength(2);
  });

  it('resolves a relative redirect against where it came from', async () => {
    const { resolver } = resolverFor({ 'api.example.com': PUBLIC });
    const { transport } = transportFor([{ status: 302, location: '/second' }, { status: 200, body: 'relative' }]);
    const answer = await safeFetch('https://api.example.com/first', { signal: signal(), resolver, transport });
    expect(answer.url).toBe('https://api.example.com/second');
    expect(answer.text).toBe('relative');
  });

  it('gives up rather than following a loop for ever', async () => {
    const { resolver } = resolverFor({ 'api.example.com': PUBLIC });
    const { transport } = transportFor(
      Array.from({ length: 10 }, () => ({ status: 302, location: 'https://api.example.com/round' })),
    );
    await expect(safeFetch('https://api.example.com/round', { signal: signal(), resolver, transport })).rejects.toThrow(
      /redirected more/,
    );
  });
});

describe('bounds on what comes back', () => {
  it('stops at the cap rather than finding out afterwards', async () => {
    const { resolver } = resolverFor({ 'api.example.com': PUBLIC });
    const { transport } = transportFor([{ status: 200, body: 'x'.repeat(5_000) }]);
    await expect(
      safeFetch('https://api.example.com/big', { signal: signal(), resolver, transport, maxBytes: 1_000 }),
    ).rejects.toThrow(/larger than 1000 bytes/);
  });

  it('reads one that fits', async () => {
    const { resolver } = resolverFor({ 'api.example.com': PUBLIC });
    const { transport } = transportFor([{ status: 200, body: 'small enough' }]);
    const answer = await safeFetch('https://api.example.com/small', {
      signal: signal(),
      resolver,
      transport,
      maxBytes: 1_000,
    });
    expect(answer.text).toBe('small enough');
    expect(answer.status).toBe(200);
  });

  it('gives up when the caller does', async () => {
    const { resolver } = resolverFor({ 'api.example.com': PUBLIC });
    const controller = new AbortController();
    const transport = (async (_input: unknown, init?: Record<string, unknown>) => {
      const inner = init?.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        inner.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      });
    }) as never;

    const pending = safeFetch('https://api.example.com/slow', { signal: controller.signal, resolver, transport });
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  });
});
