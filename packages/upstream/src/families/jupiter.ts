import { z } from 'zod';
import { defineUpstream, type Upstream } from '../contract';
import { perMinute, perSecond } from '../quota';
import { registerUpstream } from '../registry';
import { safeFetch } from '../http';
import { UpstreamFailure, classifyStatus, classifyThrown } from '../failures';

/**
 * Solana tokens as Jupiter's token index describes them.
 *
 * ### Why this source
 *
 * For a Solana memecoin the questions that matter first are about identity
 * and concentration: is this the mint people mean, is the mint authority
 * still live, how much does the top of the holder list own, how much does
 * the developer still hold, how many tokens has that developer launched
 * before. Jupiter's Tokens V2 answers all of those in one record, with the
 * block its price came from and when the record was last updated, and it is
 * reachable without a key.
 *
 * ### The limit, read from their documentation (October 2026)
 *
 * Keyless use is 0.5 requests a second on `api.jup.ag`, per organisation, on
 * a sixty-second sliding window. AI17Z takes less than that and shares it
 * across every agent on the machine: one a second at most and twenty-five a
 * minute. A key (`JUPITER_API_KEY`, sent as `x-api-key`) raises the published
 * ceiling; the windows here are unchanged by it, because a higher ceiling is
 * a reason to be refused less often, not to ask more.
 *
 * ### What is not here
 *
 * Swapping. This family reads. Execution truth for a Solana trade is a fresh
 * quote and a simulation on the path that would sign, never a cached record
 * from a discovery index.
 */

export const JUPITER_FAMILY = 'solana_tokens';

export const JUPITER_OPERATIONS = ['search', 'list', 'recent'] as const;

export const JUPITER_LISTS = ['toptrending', 'toptraded', 'toporganicscore'] as const;
export const JUPITER_INTERVALS = ['5m', '1h', '6h', '24h'] as const;

export const JupiterQuery = z.object({
  operation: z.enum(JUPITER_OPERATIONS),
  /** `search` only: a mint, a name or a symbol. */
  query: z.string().trim().max(120).default(''),
  /** `list` only. A closed set, because it becomes part of a path. */
  list: z.enum(JUPITER_LISTS).default('toptrending'),
  interval: z.enum(JUPITER_INTERVALS).default('1h'),
  limit: z.number().int().min(1).max(100).default(30),
});
export type JupiterQuery = z.infer<typeof JupiterQuery>;

export interface JupiterResult {
  /** The array of token records, in the source's own shape. Normalised by the capability. */
  tokens: unknown[];
}

const BASE = 'https://api.jup.ag/tokens/v2';

/** The one place a URL is built. Only `query` is caller text, and it is encoded. */
function urlFor(query: JupiterQuery): string {
  switch (query.operation) {
    case 'search':
      return `${BASE}/search?query=${encodeURIComponent(query.query)}`;
    case 'list':
      return `${BASE}/${query.list}/${query.interval}?limit=${query.limit}`;
    case 'recent':
      return `${BASE}/recent?limit=${query.limit}`;
  }
}

function jupiter(): Upstream<JupiterQuery, JupiterResult> {
  return defineUpstream<JupiterQuery, JupiterResult>({
    id: `${JUPITER_FAMILY}.jupiter`,
    family: JUPITER_FAMILY,
    name: 'jupiter',
    description: 'Solana token identity, holder concentration, launch history and trading activity.',
    origin: 'api.jup.ag',
    limit: {
      concurrentPerProcess: 1,
      windows: [perSecond(1, { scope: 'MACHINE' }), perMinute(25, { scope: 'MACHINE' })],
    },
    timeoutMs: 15_000,
    // Discovery and token pages, not execution: thirty seconds old is current
    // enough, and several agents looking at one list should cost one request.
    freshMs: 30_000,
    rank: 1,
    cacheKey: (query) => `${query.operation}:${query.query.toLowerCase()}:${query.list}:${query.interval}:${query.limit}`,
    async fetch(query, ctx) {
      if (!(JUPITER_OPERATIONS as readonly string[]).includes(query.operation)) {
        throw new UpstreamFailure('UNSUPPORTED', `${query.operation} is not something this reads.`);
      }
      if (query.operation === 'search' && !query.query) {
        throw new UpstreamFailure('UNSUPPORTED', 'A search needs something to search for.');
      }
      const key = process.env.JUPITER_API_KEY?.trim();
      try {
        const response = await safeFetch(urlFor(query), {
          signal: ctx.signal,
          headers: { accept: 'application/json', ...(key ? { 'x-api-key': key } : {}) },
          // A list of a hundred full records is about 150 KB.
          maxBytes: 600_000,
        });
        const status = classifyStatus(response.status, response.headers);
        if (status) throw status;
        let body: unknown;
        try {
          body = JSON.parse(response.text);
        } catch {
          throw new UpstreamFailure('BAD_RESPONSE', 'Jupiter answered with something that is not JSON.');
        }
        if (!Array.isArray(body)) throw new UpstreamFailure('BAD_RESPONSE', 'Jupiter answered with something other than a list of tokens.');
        // An empty list is an answer: nothing matched.
        return { tokens: body };
      } catch (error) {
        throw classifyThrown(error);
      }
    },
  });
}

export function registerJupiterUpstreams(): void {
  registerUpstream(jupiter());
}
