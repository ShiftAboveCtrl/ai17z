import { describe, expect, it } from 'vitest';
import { GithubRepositoryConfig, knowledgeFreshness } from '@xbam/shared/contracts';
import {
  canonicalPageUrl,
  crawlDocumentationSite,
  defaultPathPrefix,
  linksIn,
  parseRepoLocation,
  selectRepoFiles,
  stripBoilerplate,
} from '@xbam/runtime';
import { preferMentionedVersion } from '@xbam/memory';
import { docPage, fakeWeb, lorem } from '../support/fakeWeb';

const SITE = 'https://docs.example.com';

describe('what counts as the same page', () => {
  it('drops the fragment, the query and a trailing index file or slash', () => {
    expect(canonicalPageUrl(`${SITE}/v2/guide/#install`)).toBe(`${SITE}/v2/guide`);
    expect(canonicalPageUrl(`${SITE}/v2/guide/index.html?ref=nav`)).toBe(`${SITE}/v2/guide`);
    expect(canonicalPageUrl(`${SITE}/`)).toBe(`${SITE}/`);
    expect(canonicalPageUrl('mailto:someone@example.com')).toBeNull();
  });

  it('scopes a crawl to the directory of the address it started from', () => {
    expect(defaultPathPrefix(new URL(`${SITE}/v2/`))).toBe('/v2/');
    expect(defaultPathPrefix(new URL(`${SITE}/v2/intro.html`))).toBe('/v2/');
    expect(defaultPathPrefix(new URL(`${SITE}/v2`))).toBe('/v2/');
  });

  it('reads links from anchors only, resolved against the page', () => {
    const links = linksIn('<a href="guide">g</a><a href="/v2/ref#x">r</a><a href="#top">t</a><script>go("/secret")</script>', `${SITE}/v2/`);
    expect(links.sort()).toEqual([`${SITE}/v2/guide`, `${SITE}/v2/ref`]);
  });
});

describe('a documentation site is read within bounds', () => {
  const site = () =>
    fakeWeb({
      [`${SITE}/robots.txt`]: { text: 'User-agent: *\nDisallow: /v2/private', contentType: 'text/plain' },
      [`${SITE}/v2`]: docPage('Home', lorem('The home page'), ['/v2/guide', '/v2/private/keys', '/v1/old', 'https://elsewhere.example/x', '/v2/logo.png', '/v2/noindex']),
      [`${SITE}/v2/guide`]: docPage('Guide', lorem('The guide'), ['/v2/deep/one']),
      [`${SITE}/v2/deep/one`]: docPage('Deep one', lorem('A deep page'), ['/v2/deep/two']),
      [`${SITE}/v2/deep/two`]: docPage('Deep two', lorem('A deeper page')),
      [`${SITE}/v2/private/keys`]: docPage('Keys', lorem('Never read')),
      [`${SITE}/v2/noindex`]: `<html><head><meta name="robots" content="noindex"></head><body><p>${lorem('Hidden')}</p></body></html>`,
      [`${SITE}/v1/old`]: docPage('Old', lorem('Out of scope')),
    });

  it('stays on the host and under the prefix, honours robots.txt and noindex, and skips files', async () => {
    const web = site();
    const crawl = await crawlDocumentationSite(`${SITE}/v2`, {}, { fetch: web.fetch, delayMs: 0 });
    const read = crawl.pages.map((p) => new URL(p.url).pathname).sort();
    expect(read).toEqual(['/v2', '/v2/deep/one', '/v2/deep/two', '/v2/guide']);
    expect(web.requests.some((r) => r.includes('elsewhere.example'))).toBe(false);
    expect(web.requests.some((r) => r.includes('/v1/'))).toBe(false);
    expect(web.requests.some((r) => r.endsWith('.png'))).toBe(false);
    expect(web.requests.some((r) => r.includes('/private/'))).toBe(false);
    expect(crawl.refused.map((r) => r.reason).join(' ')).toMatch(/robots\.txt/);
    expect(crawl.refused.map((r) => r.reason).join(' ')).toMatch(/not to be indexed/);
    expect(crawl.stoppedBecause).toBeNull();
  });

  it('stops at its page budget and depth, and says so', async () => {
    const web = site();
    const budget = await crawlDocumentationSite(`${SITE}/v2`, { maxPages: 2 }, { fetch: web.fetch, delayMs: 0 });
    expect(budget.pages).toHaveLength(2);
    expect(budget.stoppedBecause).toMatch(/2 pages/);
    const shallow = await crawlDocumentationSite(`${SITE}/v2`, { maxDepth: 1 }, { fetch: site().fetch, delayMs: 0 });
    expect(shallow.pages.map((p) => new URL(p.url).pathname)).not.toContain('/v2/deep/two');
  });

  it('refuses a config asking for more than the ceiling', async () => {
    await expect(crawlDocumentationSite(`${SITE}/v2`, { maxPages: 100_000 }, { fetch: site().fetch, delayMs: 0 })).rejects.toThrow();
  });

  it('refuses a private address before asking anything', async () => {
    const web = site();
    const crawl = await crawlDocumentationSite('http://127.0.0.1/docs', {}, { fetch: web.fetch, delayMs: 0 });
    expect(crawl.pages).toEqual([]);
    expect(crawl.stoppedBecause).toMatch(/private network|this machine/);
    expect(web.requests).toEqual([]);
  });

  it('removes the sidebar and footer every page repeats, keeping headings', () => {
    const pages = ['a', 'b', 'c', 'd', 'e'].map((n) => ({
      url: `${SITE}/${n}`,
      title: n,
      text: `# Page ${n}\n\nGetting started. Guides. Reference.\n\nUnique body for ${n}.\n\nEdit this page on GitHub.`,
      contentHash: '',
      depth: 0,
    }));
    stripBoilerplate(pages);
    expect(pages[0]!.text).toBe('# Page a\n\nUnique body for a.');
  });
});

describe('a repository is read as a repository', () => {
  const tree = [
    { path: 'README.md', type: 'blob', sha: 'a', size: 100 },
    { path: 'docs/guide.md', type: 'blob', sha: 'b', size: 100 },
    { path: 'docs/img/logo.png', type: 'blob', sha: 'c', size: 100 },
    { path: 'contracts/Router.sol', type: 'blob', sha: 'd', size: 100 },
    { path: 'node_modules/x/README.md', type: 'blob', sha: 'e', size: 100 },
    { path: 'package-lock.json', type: 'blob', sha: 'f', size: 100 },
    { path: 'docs/huge.md', type: 'blob', sha: 'g', size: 10_000_000 },
    { path: 'src/index.ts', type: 'blob', sha: 'h', size: 100 },
  ];

  it('reads the prose by default and never vendored or built folders', () => {
    const files = selectRepoFiles(tree, GithubRepositoryConfig.parse({}));
    expect(files.map((f) => `${f.kind}:${f.path}`)).toEqual(['README:README.md', 'DOC:docs/guide.md']);
  });

  it('reads source only where the owner said, and keeps its kind', () => {
    const files = selectRepoFiles(tree, GithubRepositoryConfig.parse({ sourcePaths: ['contracts'] }));
    expect(files.map((f) => `${f.kind}:${f.path}`)).toContain('SOURCE:contracts/Router.sol');
    expect(files.map((f) => f.path)).not.toContain('src/index.ts');
  });

  it('understands the ways somebody names a repository', () => {
    expect(parseRepoLocation('https://github.com/acme/pons-docs')).toEqual({ owner: 'acme', repo: 'pons-docs' });
    expect(parseRepoLocation('https://github.com/acme/pons-docs/tree/main/docs')).toEqual({ owner: 'acme', repo: 'pons-docs' });
    expect(parseRepoLocation('acme/pons-docs.git')).toEqual({ owner: 'acme', repo: 'pons-docs' });
    expect(parseRepoLocation('https://gitlab.com/acme/x')).toBeNull();
  });
});

describe('freshness is a verdict derived from facts', () => {
  const base = { indexedAt: '2026-09-01T00:00:00Z', lastError: null, errorKind: null, refreshingSince: null, nextRefreshAt: null, lastChange: null };
  const now = Date.parse('2026-09-29T12:00:00Z');

  it('reads each state', () => {
    expect(knowledgeFreshness({ ...base, indexedAt: null }, now)).toBe('NEVER_READ');
    expect(knowledgeFreshness(base, now)).toBe('HEALTHY');
    expect(knowledgeFreshness({ ...base, nextRefreshAt: '2026-09-29T00:00:00Z' }, now)).toBe('REFRESH_DUE');
    expect(knowledgeFreshness({ ...base, refreshingSince: '2026-09-29T11:59:00Z' }, now)).toBe('REFRESHING');
    expect(knowledgeFreshness({ ...base, lastError: 'x', errorKind: 'FAILED' }, now)).toBe('FAILED');
    expect(knowledgeFreshness({ ...base, lastError: 'x', errorKind: 'UNAVAILABLE' }, now)).toBe('UNAVAILABLE');
    expect(knowledgeFreshness({ ...base, lastChange: { added: 1, changed: 0, removed: 0, at: '2026-09-29T06:00:00Z' } }, now)).toBe('CHANGED');
  });

  it('does not believe a refresh that has been running for an hour', () => {
    expect(knowledgeFreshness({ ...base, refreshingSince: '2026-09-29T10:00:00Z' }, now)).toBe('HEALTHY');
  });
});

describe('two generations of one product stay apart', () => {
  const row = (generation: string | null, id: string) => ({
    id,
    scope: 'KNOWLEDGE',
    origin: { path: id, heading: null, revision: null, sourceName: 'Pons docs', generation },
  });
  const rows = [row('V1', 'v1-fees'), row('V2', 'v2-fees'), row(null, 'general'), { id: 'm', scope: 'EPISODIC', origin: null }];

  it('keeps only the named version and anything unlabelled', () => {
    expect(preferMentionedVersion(rows, 'how do fees work in V2?').map((r) => r.id)).toEqual(['v2-fees', 'general', 'm']);
    expect(preferMentionedVersion(rows, 'and on v1').map((r) => r.id)).toEqual(['v1-fees', 'general', 'm']);
  });

  it('keeps both, labelled, when the message names neither or both', () => {
    expect(preferMentionedVersion(rows, 'how do fees work?')).toHaveLength(4);
    expect(preferMentionedVersion(rows, 'what changed from V1 to V2?')).toHaveLength(4);
  });

  it('does not mistake a word inside another word for a label', () => {
    expect(preferMentionedVersion(rows, 'the v1234 contract')).toHaveLength(4);
  });
});
