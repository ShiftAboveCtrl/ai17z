import type { FetchText, Fetched } from '@xbam/runtime';

/**
 * A pretend web for knowledge-collection tests: a map from URL to what it
 * serves, and a record of every request, so a test can prove a crawl stayed in
 * bounds as well as what it read. Every page is invented.
 */
export interface FakeWeb {
  fetch: FetchText;
  requests: string[];
  pages: Map<string, Partial<Fetched> & { text: string }>;
}

export function fakeWeb(pages: Record<string, string | (Partial<Fetched> & { text: string })>): FakeWeb {
  const map = new Map<string, Partial<Fetched> & { text: string }>();
  for (const [url, value] of Object.entries(pages)) map.set(url, typeof value === 'string' ? { text: value } : value);
  const requests: string[] = [];
  const fetch: FetchText = async (url) => {
    requests.push(url);
    const page = map.get(url);
    if (!page) return { status: 404, url, contentType: 'text/html', text: 'not found' };
    return {
      status: page.status ?? 200,
      url: page.url ?? url,
      contentType: page.contentType ?? (url.endsWith('.txt') || url.includes('raw.githubusercontent') ? 'text/plain' : url.includes('api.github.com') ? 'application/json' : 'text/html'),
      text: page.text,
    };
  };
  return { fetch, requests, pages: map };
}

/** A documentation page with a sidebar every page repeats, which is what real sites do. */
export function docPage(title: string, body: string, links: string[] = []): string {
  const sidebar = '<div class="sidebar">Getting started. Guides. Reference. Changelog.</div>';
  const nav = links.map((l) => `<a href="${l}">${l}</a>`).join(' ');
  return `<html><head><title>${title}</title></head><body>${sidebar}<main><h1>${title}</h1><p>${body}</p><p>${nav}</p></main><div>Was this page helpful? Edit this page on GitHub.</div></body></html>`;
}

export const lorem = (subject: string) =>
  `${subject} explained in enough words to be worth teaching. The router sends each swap through the pool with the deepest liquidity, charges the configured fee, and records the outcome so it can be audited later. This paragraph exists so the page has real readable text.`;
