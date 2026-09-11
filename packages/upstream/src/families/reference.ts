import { z } from 'zod';
import { defineUpstream, type Upstream } from '../contract';
import { perMinute, perSecond } from '../quota';
import { registerUpstream } from '../registry';
import { safeFetch } from '../http';
import { classifyStatus, classifyThrown } from '../failures';
import { parseExactJson } from '../exactNumbers';

/**
 * Looking a term up in a reference work. **Not a web search.**
 *
 * ### What the research found, and why this is shaped the way it is
 *
 * Probed September 2026, before any of this was written. **No suitable keyless
 * general-purpose search upstream was proven from the candidates tested** --
 * which is the honest form of the claim, and narrower than "none exists". Four
 * candidates were tried and all four were unusable:
 *
 *   `searx.be` -- 200, carrying an HTML "Verifying..." bot challenge.
 *   `search.inetol.net` -- 200, carrying "Security check - Substation".
 *   `opnxng.com`, `priv.au` -- 429 on the very first request.
 *   `api.marginalia.nu` -- timed out.
 *
 * The first two matter most, and they are the same trap as an IPFS gateway
 * serving a notice page: **a 200 whose body is not the answer.** Anything
 * switching on the status code alone would have fed a challenge page to a model
 * as search results. A SearXNG upstream added later would have to treat a
 * challenge page as a full stop -- recognised, engine abandoned, gap recorded
 * -- exactly as browser search already does.
 *
 * So this does not pretend to be web search. AI17Z already searches the open
 * web through the browser that is already running, and through a provider where
 * one is configured; there is no second research system here and this is not
 * one. What this adds is the thing that *is* freely readable without a browser:
 * two reference sources, for "what is this" rather than "what happened today".
 *
 * ### Two families rather than two members
 *
 * They are not interchangeable. An encyclopedia article and an instant answer
 * are different claims from different places, and a family's members have to be
 * substitutable. More to the point, a term missing from one may be present in
 * the other -- and `NOT_FOUND` deliberately does not fall through to a sibling,
 * because on a chain a transaction that does not exist does not exist anywhere.
 * Bending that shared rule for this would be wrong, so the capability asks both
 * families instead, exactly as token risk does.
 */

export const ENCYCLOPEDIA_FAMILY = 'encyclopedia';
export const INSTANT_ANSWER_FAMILY = 'instant_answer';

export const ReferenceQuery = z.object({
  term: z.string().trim().min(1).max(300),
});
export type ReferenceQuery = z.infer<typeof ReferenceQuery>;

/** One source's answer, normalised so a capability can report several. */
export interface ReferenceEntry {
  found: boolean;
  title: string | null;
  /** Third-party prose. Quoted by the capability, never followed. */
  summary: string | null;
  url: string | null;
  /** What to call this source when attributing it. */
  sourceName: string;
}

/**
 * Wikimedia asks for a descriptive user agent, and it is their bandwidth.
 *
 * Deliberately carries no address of anybody's: a project URL identifies the
 * software, which is what the policy is for.
 */
const USER_AGENT = 'AI17Z/1.0 (+https://github.com/ShiftAboveCtrl/ai17z)';

function wikipedia(): Upstream<ReferenceQuery, ReferenceEntry> {
  return defineUpstream<ReferenceQuery, ReferenceEntry>({
    id: `${ENCYCLOPEDIA_FAMILY}.wikipedia`,
    family: ENCYCLOPEDIA_FAMILY,
    name: 'wikipedia',
    description: 'The opening of the best-matching Wikipedia article for a term.',
    origin: 'en.wikipedia.org',
    limit: {
      concurrentPerProcess: 2,
      // No published figure for anonymous use -- checked September 2026.
      // Wikimedia asks for politeness rather than naming a number, so these are
      // ours and modest.
      windows: [perSecond(2, { scope: 'MACHINE' }), perMinute(40, { scope: 'MACHINE' })],
    },
    timeoutMs: 15_000,
    // An encyclopedia article does not change by the minute, and this is
    // explicitly not the source for anything current.
    freshMs: 30 * 60_000,
    rank: 1,
    cacheKey: (query) => query.term.toLowerCase(),
    async fetch(query, ctx) {
      try {
        // Search and intro extract in one request: `generator=search` feeds the
        // matching page straight into `prop=extracts`, so a lookup is one call
        // rather than a search followed by a fetch.
        const url =
          'https://en.wikipedia.org/w/api.php?action=query&generator=search' +
          `&gsrsearch=${encodeURIComponent(query.term)}` +
          '&gsrlimit=1&prop=extracts&exintro=1&explaintext=1&format=json&formatversion=2';

        const response = await safeFetch(url, {
          signal: ctx.signal,
          headers: { accept: 'application/json', 'user-agent': USER_AGENT },
          maxBytes: 500_000,
        });
        const status = classifyStatus(response.status, response.headers);
        if (status) throw status;

        const body = parseExactJson(response.text, 'the encyclopedia answer') as {
          query?: { pages?: { title?: unknown; extract?: unknown; pageid?: unknown }[] };
        };

        // No `query` key at all is how this API says nothing matched. An answer,
        // not a fault.
        const page = body.query?.pages?.[0];
        if (!page || typeof page.title !== 'string') {
          return { found: false, title: null, summary: null, url: null, sourceName: 'Wikipedia' };
        }

        const extract = typeof page.extract === 'string' ? page.extract.trim() : '';
        return {
          found: extract.length > 0,
          title: page.title,
          summary: extract.length > 0 ? extract : null,
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
          sourceName: 'Wikipedia',
        };
      } catch (error) {
        throw classifyThrown(error);
      }
    },
  });
}

function duckduckgo(): Upstream<ReferenceQuery, ReferenceEntry> {
  return defineUpstream<ReferenceQuery, ReferenceEntry>({
    id: `${INSTANT_ANSWER_FAMILY}.duckduckgo`,
    family: INSTANT_ANSWER_FAMILY,
    name: 'duckduckgo',
    description: 'A one-paragraph instant answer for a term, where one exists.',
    origin: 'api.duckduckgo.com',
    limit: {
      concurrentPerProcess: 2,
      windows: [perSecond(2, { scope: 'MACHINE' }), perMinute(40, { scope: 'MACHINE' })],
    },
    timeoutMs: 15_000,
    freshMs: 30 * 60_000,
    rank: 1,
    cacheKey: (query) => query.term.toLowerCase(),
    async fetch(query, ctx) {
      try {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query.term)}&format=json&no_html=1`;
        const response = await safeFetch(url, {
          signal: ctx.signal,
          // It answers as `application/x-javascript`, so nothing here may
          // switch on the content type -- it is JSON regardless of what the
          // header calls it.
          headers: { accept: 'application/json' },
          maxBytes: 500_000,
        });
        const status = classifyStatus(response.status, response.headers);
        if (status) throw status;

        const body = parseExactJson(response.text, 'the instant answer') as {
          AbstractText?: unknown;
          AbstractSource?: unknown;
          AbstractURL?: unknown;
          Heading?: unknown;
        };

        // Every field comes back as an empty string when there is no answer.
        // Reading that as an answer would report silence as a fact -- the same
        // mistake the token risk family exists to avoid.
        const text = typeof body.AbstractText === 'string' ? body.AbstractText.trim() : '';
        if (text.length === 0) {
          return { found: false, title: null, summary: null, url: null, sourceName: 'DuckDuckGo' };
        }

        return {
          found: true,
          title: typeof body.Heading === 'string' && body.Heading ? body.Heading : query.term,
          summary: text,
          url: typeof body.AbstractURL === 'string' && body.AbstractURL ? body.AbstractURL : null,
          sourceName:
            typeof body.AbstractSource === 'string' && body.AbstractSource
              ? `DuckDuckGo, quoting ${body.AbstractSource}`
              : 'DuckDuckGo',
        };
      } catch (error) {
        throw classifyThrown(error);
      }
    },
  });
}

export function registerReferenceUpstreams(): void {
  registerUpstream(wikipedia());
  registerUpstream(duckduckgo());
}
