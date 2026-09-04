import { describe, expect, it } from 'vitest';
import { checkUrl, fetchPage, readableText, robotsAllows } from '@xbam/memory';

/** A fetch that answers from a map, so no test touches the network. */
function fakeFetch(pages: Record<string, { status?: number; type?: string; body: string }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const page = pages[url];
    if (!page) {
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    return new Response(page.body, {
      status: page.status ?? 200,
      headers: { 'content-type': page.type ?? 'text/html; charset=utf-8' },
    });
  }) as typeof fetch;
}

const DOC = `<!doctype html><html><head><title>Cadence</title></head><body>
<nav><a href="/other">Other page</a></nav>
<h1>Cadence</h1>
<p>Timing is per account, versioned, and lives in the database. There is one engine and every
question about when something may happen goes through it. Do not add a second timer.</p>
<h2>The poller</h2>
<p>The poller has no schedule: it asks which accounts are due, and the claim moves the next poll
forward in the same statement, which is what stops two workers polling one account and stops a
restart stampeding every account at once.</p>
<script>console.log('ignored')</script>
<footer>Copyright</footer>
</body></html>`;

describe('what a knowledge source is allowed to point at', () => {
  it('takes an ordinary web address', () => {
    expect(checkUrl('https://example.com/docs/cadence').refusal).toBeNull();
  });

  it('refuses something that is not an address', () => {
    expect(checkUrl('cadence docs').refusal).toContain('not a web address');
  });

  it('refuses a file:// address', () => {
    expect(checkUrl('file:///etc/passwd').refusal).toContain('cannot be read');
  });

  it('refuses this machine', () => {
    // Pointing a fetcher at localhost reads whatever this installation is
    // running, which is not a document anybody meant to teach an agent.
    expect(checkUrl('http://localhost:8787/api/health').refusal).toContain('private network');
    expect(checkUrl('http://127.0.0.1/').refusal).toContain('private network');
  });

  it('refuses a private network address', () => {
    for (const host of ['http://10.0.0.5/', 'http://192.168.1.1/', 'http://172.16.0.1/']) {
      expect(checkUrl(host).refusal, host).toContain('private network');
    }
  });

  it('refuses the cloud metadata address specifically', () => {
    // 169.254.169.254 is how a naive fetcher reads credentials instead of a
    // document, and it is in a range people forget about.
    expect(checkUrl('http://169.254.169.254/latest/meta-data/').refusal).toContain('private network');
  });
});

describe('robots.txt', () => {
  it('permits a path nothing mentions', () => {
    expect(robotsAllows('User-agent: *\nDisallow: /private', '/docs/cadence')).toBe(true);
  });

  it('refuses a path under a disallowed prefix', () => {
    expect(robotsAllows('User-agent: *\nDisallow: /private', '/private/thing')).toBe(false);
  });

  it('ignores a group written for somebody else', () => {
    expect(robotsAllows('User-agent: SomeBot\nDisallow: /docs', '/docs/cadence')).toBe(true);
  });

  it('lets a longer Allow beat a shorter Disallow', () => {
    const robots = 'User-agent: *\nDisallow: /docs\nAllow: /docs/public';
    expect(robotsAllows(robots, '/docs/public/page')).toBe(true);
    expect(robotsAllows(robots, '/docs/private/page')).toBe(false);
  });

  it('treats an empty Disallow as no restriction, which is what it means', () => {
    expect(robotsAllows('User-agent: *\nDisallow:', '/anything')).toBe(true);
  });

  it('ignores comments', () => {
    expect(robotsAllows('User-agent: *\nDisallow: /docs # everything here', '/docs/x')).toBe(false);
  });
});

describe('turning a page into something an agent can read', () => {
  it('keeps the prose and the headings', () => {
    const { title, text } = readableText(DOC);
    expect(title).toBe('Cadence');
    expect(text).toContain('# Cadence');
    expect(text).toContain('## The poller');
    expect(text).toContain('every question about when something may happen goes through it');
  });

  it('drops the script, the nav and the footer', () => {
    const { text } = readableText(DOC);
    expect(text).not.toContain('console.log');
    expect(text).not.toContain('Other page');
    expect(text).not.toContain('Copyright');
  });

  it('decodes entities rather than teaching an agent to write &amp;', () => {
    expect(readableText('<html><body><p>Tom &amp; Jerry &#8212; &quot;quoted&quot;</p></body></html>').text).toContain(
      'Tom & Jerry',
    );
  });
});

describe('reading one page', () => {
  const url = 'https://example.com/docs/cadence';

  it('returns the text, a title and a content hash', async () => {
    const page = await fetchPage(url, {
      fetchImpl: fakeFetch({
        'https://example.com/robots.txt': { body: 'User-agent: *\nDisallow: /private', type: 'text/plain' },
        [url]: { body: DOC },
      }),
    });
    expect(page.refusal).toBeNull();
    expect(page.title).toBe('Cadence');
    expect(page.text).toContain('The poller has no schedule');
    expect(page.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives the same hash for the same page, so an unchanged page writes nothing', async () => {
    const impl = fakeFetch({
      'https://example.com/robots.txt': { body: '', type: 'text/plain' },
      [url]: { body: DOC },
    });
    const first = await fetchPage(url, { fetchImpl: impl });
    const second = await fetchPage(url, { fetchImpl: impl });
    expect(second.contentHash).toBe(first.contentHash);
  });

  it('stops when robots.txt says not to, and says which host asked', async () => {
    const page = await fetchPage('https://example.com/private/thing', {
      fetchImpl: fakeFetch({
        'https://example.com/robots.txt': { body: 'User-agent: *\nDisallow: /private', type: 'text/plain' },
      }),
    });
    expect(page.refusal).toContain('example.com');
    expect(page.refusal).toContain('robots.txt');
  });

  it('reads on when robots.txt is missing, because absence is not a refusal', async () => {
    const page = await fetchPage(url, { fetchImpl: fakeFetch({ [url]: { body: DOC } }) });
    expect(page.refusal).toBeNull();
  });

  it('reports the status code rather than indexing an error page', async () => {
    const page = await fetchPage(url, {
      fetchImpl: fakeFetch({ [url]: { body: '<html><body>gone</body></html>', status: 404 } }),
    });
    expect(page.refusal).toContain('404');
  });

  it('refuses something that is not a page of text', async () => {
    const page = await fetchPage(url, {
      fetchImpl: fakeFetch({ [url]: { body: 'PK...', type: 'application/zip' } }),
    });
    expect(page.refusal).toContain('application/zip');
  });

  /**
   * The silent failure, in a different costume from the scanned PDF: a page
   * that builds itself in the browser returns valid HTML consisting of an empty
   * div, and indexing it teaches nothing while looking like a success.
   */
  it('refuses a page that renders itself with JavaScript', async () => {
    const page = await fetchPage(url, {
      fetchImpl: fakeFetch({
        [url]: { body: '<html><head><title>Docs</title></head><body><div id="root"></div></body></html>' },
      }),
    });
    expect(page.text).toBe('');
    expect(page.refusal).toContain('no readable text');
    expect(page.refusal).toContain('builds itself in the browser');
    // And says what to do instead.
    expect(page.refusal).toContain('Paste the text in');
  });

  it('says what to do even when the page has a scrap of text on it', async () => {
    // The near-empty case used to explain the fault and stop there, which
    // leaves somebody knowing they are stuck and not how to get unstuck.
    const page = await fetchPage(url, {
      fetchImpl: fakeFetch({
        [url]: { body: '<html><body><div id="root">Loading the documentation, one moment.</div></body></html>' },
      }),
    });
    expect(page.refusal).toContain('only ');
    expect(page.refusal).toContain('Paste the text in');
    // States the measurement and offers the cause. A short page can be short
    // because it is short: example.com is 129 characters of real text, and
    // telling somebody it renders in the browser sends them after a fault
    // that is not there.
    expect(page.refusal).toContain('usually means');
  });

  it('does not count the page title as body text', async () => {
    // Otherwise an empty page with a long title looks like it had prose on it.
    const page = await fetchPage(url, {
      fetchImpl: fakeFetch({
        [url]: {
          body: '<html><head><title>A very long documentation page title that is not content</title></head><body><div></div></body></html>',
        },
      }),
    });
    expect(page.refusal).toContain('no readable text');
  });

  it('follows no links, ever', async () => {
    // The whole boundary in one assertion: only the named page and its
    // robots.txt are ever requested, whatever the page links to.
    const asked: string[] = [];
    const impl = (async (input: RequestInfo | URL) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      asked.push(href);
      if (href.endsWith('/robots.txt')) return new Response('', { headers: { 'content-type': 'text/plain' } });
      return new Response(DOC, { headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;

    await fetchPage(url, { fetchImpl: impl });
    expect(asked).toEqual(['https://example.com/robots.txt', url]);
  });

  it('never throws, whatever the network does', async () => {
    const page = await fetchPage(url, {
      fetchImpl: (async () => {
        throw new Error('socket hang up');
      }) as typeof fetch,
    });
    expect(page.refusal).toContain('socket hang up');
  });
});
