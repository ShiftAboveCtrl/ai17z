import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fetching a URL without it becoming a way to reach this machine.
 *
 * The address classifier next door decides what an address is; this decides
 * whether a *request* may be made, which is a different question with three
 * more ways to get it wrong: a scheme that is not a fetch at all, a name that
 * resolves to several addresses of which only one is private, and a perfectly
 * public URL that answers 302 to a private one.
 *
 * DNS and `fetch` are both stubbed, because what is under test is the decision
 * rather than the network, and a test that needed a real resolver would be a
 * test that fails on an aeroplane.
 */

const lookups = new Map<string, { address: string }[]>();
const resolved: string[] = [];

vi.mock('node:dns/promises', () => ({
  async lookup(hostname: string) {
    resolved.push(hostname);
    const found = lookups.get(hostname);
    if (!found) throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    return found;
  },
}));

const { safeFetch, UnsafeUrlError } = await import('@xbam/upstream');

/** One response, or a chain of them for the redirect cases. */
function serve(responses: { status: number; location?: string; body?: string }[]) {
  const asked: string[] = [];
  const options: RequestInit[] = [];
  const fetcher = vi.fn(async (input: URL | string, init?: RequestInit) => {
    asked.push(input.toString());
    options.push(init ?? {});
    const next = responses.shift() ?? { status: 200, body: 'ok' };
    const headers = new Headers();
    if (next.location) headers.set('location', next.location);
    return new Response(next.body ?? '', { status: next.status, headers });
  });
  vi.stubGlobal('fetch', fetcher);
  return { asked, options };
}

const signal = () => new AbortController().signal;

beforeEach(() => {
  lookups.clear();
  resolved.length = 0;
  lookups.set('api.example.com', [{ address: '93.184.216.34' }]);
});
afterEach(() => vi.unstubAllGlobals());

describe('schemes that are not a fetch', () => {
  it('refuses file, data and ftp before anything is resolved', async () => {
    serve([]);
    for (const url of ['file:///etc/passwd', 'data:text/plain,hello', 'ftp://example.com/x']) {
      await expect(safeFetch(url, { signal: signal() })).rejects.toThrow(UnsafeUrlError);
    }
  });

  it('refuses plain http unless an upstream deliberately asked for it', async () => {
    lookups.set('localhost', [{ address: '127.0.0.1' }]);
    await expect(safeFetch('http://api.example.com/x', { signal: signal() })).rejects.toThrow(/Only https/);

    // A node somebody runs themselves is a configuration, not a forgery -- and
    // it is never available to anything reading a URL a stranger supplied.
    serve([{ status: 200, body: 'local' }]);
    const answer = await safeFetch('http://localhost:8545/', { signal: signal(), allowPrivate: true });
    expect(answer.text).toBe('local');
  });
});

describe('names that point somewhere private', () => {
  it('refuses a public name that resolves to loopback', async () => {
    // Thousands of real names do this on purpose. No list of bad hostnames
    // catches them, which is why the address is what gets judged.
    lookups.set('localtest.me', [{ address: '127.0.0.1' }]);
    serve([]);
    await expect(safeFetch('https://localtest.me/', { signal: signal() })).rejects.toThrow(/127\.0\.0\.1/);
  });

  it('refuses when only one of several addresses is private', async () => {
    // A name answering with one public and one loopback address passes a check
    // that looks at whichever came back first.
    lookups.set('both.example', [{ address: '93.184.216.34' }, { address: '127.0.0.1' }]);
    serve([]);
    await expect(safeFetch('https://both.example/', { signal: signal() })).rejects.toThrow(/not fetched/);
  });

  it('refuses the cloud metadata address by name or by number', async () => {
    lookups.set('metadata.google.internal', [{ address: '169.254.169.254' }]);
    serve([]);
    await expect(safeFetch('https://metadata.google.internal/', { signal: signal() })).rejects.toThrow(/metadata/i);
    await expect(safeFetch('https://169.254.169.254/latest/meta-data/', { signal: signal() })).rejects.toThrow(
      /metadata/i,
    );
  });

  it('judges an address that is already an address, without asking a resolver', async () => {
    // A round trip to be told what it says on the tin, and it puts a resolver
    // between the check and the thing being checked.
    serve([{ status: 200, body: 'direct' }]);
    const answer = await safeFetch('https://93.184.216.34/x', { signal: signal() });
    expect(answer.text).toBe('direct');
    expect(resolved).toEqual([]);

    await expect(safeFetch('https://[::1]/x', { signal: signal() })).rejects.toThrow(/this machine/i);
    expect(resolved).toEqual([]);
  });

  it('refuses a name that resolves to nothing rather than trying anyway', async () => {
    serve([]);
    await expect(safeFetch('https://nowhere.example/', { signal: signal() })).rejects.toThrow(/could not be resolved/);
  });
});

describe('a redirect is a second request and is judged like one', () => {
  it('refuses a public URL that redirects to a private one', async () => {
    // The one that undoes everything else. `redirect: "follow"` would take this
    // hop inside the machine without another word.
    lookups.set('evil.example', [{ address: '93.184.216.34' }]);
    serve([{ status: 302, location: 'http://169.254.169.254/latest/meta-data/' }]);
    await expect(safeFetch('https://evil.example/', { signal: signal() })).rejects.toThrow(UnsafeUrlError);
  });

  it('never asks the fetch implementation to follow one for it', async () => {
    // A white-box assertion, deliberately, because the behaviour cannot be
    // reached from outside: a stub hands back the 302 whichever mode was asked
    // for, so every test above passes just as well with `follow` -- which in
    // production would follow the hop inside undici, where none of this can see
    // it. Found by mutating `manual` to `follow` and watching nothing fail.
    const { options } = serve([{ status: 200, body: 'ok' }]);
    await safeFetch('https://api.example.com/x', { signal: signal() });
    expect(options[0]?.redirect).toBe('manual');
  });

  it('follows an ordinary redirect and reports where it ended up', async () => {
    lookups.set('moved.example', [{ address: '93.184.216.34' }]);
    const { asked } = serve([
      { status: 301, location: 'https://api.example.com/final' },
      { status: 200, body: 'arrived' },
    ]);
    const answer = await safeFetch('https://moved.example/start', { signal: signal() });
    expect(answer.text).toBe('arrived');
    expect(answer.url).toBe('https://api.example.com/final');
    expect(asked).toHaveLength(2);
  });

  it('resolves a relative redirect against where it came from', async () => {
    serve([{ status: 302, location: '/second' }, { status: 200, body: 'relative' }]);
    const answer = await safeFetch('https://api.example.com/first', { signal: signal() });
    expect(answer.url).toBe('https://api.example.com/second');
    expect(answer.text).toBe('relative');
  });

  it('gives up rather than following a loop for ever', async () => {
    serve(Array.from({ length: 10 }, () => ({ status: 302, location: 'https://api.example.com/round' })));
    await expect(safeFetch('https://api.example.com/round', { signal: signal() })).rejects.toThrow(/redirected more/);
  });
});

describe('a response larger than expected', () => {
  it('stops at the cap rather than finding out afterwards', async () => {
    // A check after `await response.text()` has already read it into memory,
    // which on a response with no end is how a worker dies reading one page.
    serve([{ status: 200, body: 'x'.repeat(5_000) }]);
    await expect(safeFetch('https://api.example.com/big', { signal: signal(), maxBytes: 1_000 })).rejects.toThrow(
      /larger than 1000 bytes/,
    );
  });

  it('reads one that fits', async () => {
    serve([{ status: 200, body: 'small enough' }]);
    const answer = await safeFetch('https://api.example.com/small', { signal: signal(), maxBytes: 1_000 });
    expect(answer.text).toBe('small enough');
    expect(answer.status).toBe(200);
  });
});
