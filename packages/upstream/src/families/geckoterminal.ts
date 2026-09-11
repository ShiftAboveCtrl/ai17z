import { z } from 'zod';
import { defineUpstream, type Upstream } from '../contract';
import { perMinute, perSecond, perTenSeconds } from '../quota';
import { registerUpstream } from '../registry';
import { safeFetch } from '../http';
import { UpstreamFailure, classifyStatus, classifyThrown } from '../failures';
import { parseExactJson } from '../exactNumbers';

/**
 * On-chain market data from a second, independent source.
 *
 * ### Why a second one at all
 *
 * `market_pairs` already reads DexScreener, and `market.price_check` already
 * asks two sources and reports disagreement rather than resolving it. This is
 * the other half of that: a genuinely different operator with its own indexing,
 * which is what makes an agreement worth anything. Two transports over one
 * dataset would be redundancy; two indexers over the same chains is a
 * cross-check.
 *
 * It also answers questions DexScreener does not: price history for an exact
 * pair, and which pools were created recently.
 *
 * ### The limit is about bursts, and was measured
 *
 * Probed September 2026. The documented free allowance is thirty calls a
 * minute, but five calls inside six seconds was enough to be refused with a 429
 * and `retry-after: 0` -- and the same endpoints answered perfectly twenty
 * seconds later. So the thing to respect is the burst, not the minute, and the
 * windows below are shaped for that: one a second, four in ten seconds, twenty
 * a minute, and one request in flight at a time.
 *
 * ### Sizes, measured rather than assumed
 *
 *   a pool            1.5 KB
 *   a token             966 B
 *   OHLCV, 3 candles    573 B
 *   a token's pools    30 KB
 *   new pools          28 KB
 *   trending pools     31 KB
 *   **300 trades      223 KB**
 *
 * The last is why there is no trades capability: a fifth of a megabyte of
 * individual swaps is a large answer to a question nobody asked precisely, and
 * the cap below would refuse it anyway.
 */

export const GECKO_FAMILY = 'market_gecko';

export const GECKO_OPERATIONS = ['pool', 'token', 'token_pools', 'ohlcv', 'new_pools', 'trending'] as const;
export type GeckoOperation = (typeof GECKO_OPERATIONS)[number];

export const GeckoQuery = z.object({
  operation: z.enum(GECKO_OPERATIONS),
  /** Their network id -- `eth`, `bsc`, `solana`. Not a chain name of ours. */
  network: z.string().trim().max(40).default(''),
  /** A pool or token address, exactly. */
  address: z.string().trim().max(120).default(''),
  /** OHLCV only. */
  timeframe: z.enum(['minute', 'hour', 'day']).default('hour'),
  limit: z.number().int().min(1).max(100).default(24),
});
export type GeckoQuery = z.infer<typeof GeckoQuery>;

export interface GeckoResult {
  /** The `data` member, in the source's own shape. Normalised by the capability. */
  data: unknown;
}

const BASE = 'https://api.geckoterminal.com/api/v2';

/** The one place a URL is built. */
function pathFor(query: GeckoQuery): string {
  const network = encodeURIComponent(query.network);
  const address = encodeURIComponent(query.address);
  switch (query.operation) {
    case 'pool':
      return `/networks/${network}/pools/${address}`;
    case 'token':
      return `/networks/${network}/tokens/${address}`;
    case 'token_pools':
      return `/networks/${network}/tokens/${address}/pools`;
    case 'ohlcv':
      return `/networks/${network}/pools/${address}/ohlcv/${query.timeframe}?limit=${query.limit}`;
    case 'new_pools':
      return `/networks/${network}/new_pools?page=1`;
    case 'trending':
      return `/networks/trending_pools?page=1`;
  }
}

function geckoterminal(): Upstream<GeckoQuery, GeckoResult> {
  return defineUpstream<GeckoQuery, GeckoResult>({
    id: `${GECKO_FAMILY}.geckoterminal`,
    family: GECKO_FAMILY,
    name: 'geckoterminal',
    description: 'Pools, prices and price history from an independent on-chain market indexer.',
    origin: 'api.geckoterminal.com',
    limit: {
      // One at a time: the refusal observed was about concurrency and burst,
      // not about a minute's worth of calls.
      concurrentPerProcess: 1,
      windows: [
        perSecond(1, { scope: 'MACHINE' }),
        perTenSeconds(4, { scope: 'MACHINE' }),
        // Thirty a minute is what they publish; twenty is what AI17Z takes.
        perMinute(20, { scope: 'MACHINE' }),
      ],
    },
    timeoutMs: 20_000,
    // A pool's price moves constantly; a minute is current enough for a
    // question about one and cheap when several agents ask together.
    freshMs: 60_000,
    rank: 1,
    cacheKey: (query) =>
      `${query.operation}:${query.network}:${query.address}:${query.timeframe}:${query.limit}`,
    async fetch(query, ctx) {
      if (!(GECKO_OPERATIONS as readonly string[]).includes(query.operation)) {
        throw new UpstreamFailure('UNSUPPORTED', `${query.operation} is not something this reads.`);
      }

      try {
        const response = await safeFetch(`${BASE}${pathFor(query)}`, {
          signal: ctx.signal,
          // Their versioned media type. Without it the shape can change under
          // us on their schedule rather than ours.
          headers: { accept: 'application/json;version=20230302' },
          // The largest thing reachable here is a trending or new-pools page at
          // about 31 KB. Generous enough for those and far under the 223 KB a
          // trades page would be -- which is deliberate, since nothing asks for
          // one.
          maxBytes: 120_000,
        });

        const status = classifyStatus(response.status, response.headers);
        if (status) throw status;

        const body = parseExactJson(response.text, 'the market answer') as {
          data?: unknown;
          status?: { error_code?: unknown; error_message?: unknown };
        };

        // They answer 200 with an error envelope in some cases, so the status
        // code alone is not the verdict.
        if (body.status?.error_code) {
          throw new UpstreamFailure('BAD_RESPONSE', `It refused: ${String(body.status.error_message ?? 'unknown')}.`);
        }
        if (body.data === undefined) {
          throw new UpstreamFailure('BAD_RESPONSE', 'It answered with neither data nor an error.');
        }
        return { data: body.data };
      } catch (error) {
        throw classifyThrown(error);
      }
    },
  });
}

export function registerGeckoUpstreams(): void {
  registerUpstream(geckoterminal());
}
