import { z } from 'zod';
import { defineUpstream, type Upstream } from '../contract';
import { perMinute, perSecond } from '../quota';
import { registerUpstream } from '../registry';
import { safeFetch } from '../http';
import { UpstreamFailure, classifyStatus, classifyThrown } from '../failures';

/**
 * Where a token trades, and at what.
 *
 * ### This is not a second market client
 *
 * `packages/runtime/src/token.ts` already resolves which token somebody meant,
 * and it is careful in ways that took a live incident to learn: a ticker is not
 * an identity, the deepest pair is not the truest one, a search matches the
 * quote side as well as the base. None of that moves here. What moves is the
 * one `fetch` underneath it, so the same resolver gains pacing, caching,
 * coalescing, a breaker, fallback and provenance without a second opinion about
 * what a token is.
 *
 * ### Why the pairs come back as the API returned them
 *
 * With one source, "normalised" would mean renaming DexScreener's fields and
 * calling it a standard. The shape becomes real the day a second source has to
 * fit it -- and inventing it before then would mean guessing which of its
 * fields matter, in a domain where a wrong number is money. So this family
 * carries the pairs through and the resolver keeps reading them; when
 * GeckoTerminal or another source arrives, the normalisation lands here, where
 * both have to agree, and it is testable against two real shapes rather than
 * one imagined one.
 *
 * A deliberate limit of the current state, not an oversight.
 */

export const MarketQuery = z.discriminatedUnion('kind', [
  /** Every pair a specific contract trades in. The identity-safe question. */
  z.object({ kind: z.literal('token'), address: z.string().min(1).max(120) }),
  /** One exact pair on one exact chain. */
  z.object({ kind: z.literal('pair'), chain: z.string().min(1).max(40), pairAddress: z.string().min(1).max(120) }),
  /**
   * A ticker.
   *
   * Answered, because the resolver needs candidates to reason about -- and
   * never treated as an identification by anything downstream. Anyone can mint
   * a token called BTC, and somebody has.
   */
  z.object({ kind: z.literal('search'), symbol: z.string().min(1).max(40) }),
]);
export type MarketQuery = z.infer<typeof MarketQuery>;

export interface MarketPairs {
  /** Exactly what the API returned, in its own shape. See the note above. */
  pairs: unknown[];
}

const DEXSCREENER = 'https://api.dexscreener.com/latest/dex';

function urlFor(query: MarketQuery): string {
  if (query.kind === 'pair') {
    return `${DEXSCREENER}/pairs/${encodeURIComponent(query.chain)}/${encodeURIComponent(query.pairAddress)}`;
  }
  if (query.kind === 'token') {
    // The token endpoint returns only that contract's pairs. `search` matches
    // either side, which is how asking about a token comes back with a price
    // belonging to whatever it trades against.
    return `${DEXSCREENER}/tokens/${encodeURIComponent(query.address)}`;
  }
  return `${DEXSCREENER}/search?q=${encodeURIComponent(query.symbol)}`;
}

function dexscreener(): Upstream<MarketQuery, MarketPairs> {
  return defineUpstream<MarketQuery, MarketPairs>({
    id: 'market_pairs.dexscreener',
    family: 'market_pairs',
    name: 'dexscreener',
    description: 'Pairs, prices and liquidity for a token or pair.',
    origin: 'api.dexscreener.com',
    limit: {
      concurrentPerProcess: 2,
      // DexScreener publishes 60/minute for several of its endpoints and does
      // not state one for these -- checked September 2026. Rather than read
      // silence as permission, the published figure is adopted as our own
      // ceiling, and marked as ours because they did not say it about these.
      windows: [perSecond(2, { scope: 'MACHINE' }), perMinute(60, { scope: 'MACHINE' })],
    },
    timeoutMs: 12_000,
    // A price is stale in under a minute, and several agents asking about one
    // token in the same tick should cost one request. Thirty seconds is the
    // compromise; anything longer would be quoting an old number as current.
    freshMs: 30_000,
    rank: 1,
    cacheKey: (query) =>
      query.kind === 'pair'
        ? `pair:${query.chain}:${query.pairAddress.toLowerCase()}`
        : query.kind === 'token'
          ? `token:${query.address.toLowerCase()}`
          : `search:${query.symbol.toLowerCase()}`,
    async fetch(query, ctx) {
      try {
        const response = await safeFetch(urlFor(query), {
          signal: ctx.signal,
          headers: { accept: 'application/json' },
          maxBytes: 4_000_000,
        });

        const status = classifyStatus(response.status, response.headers);
        if (status) throw status;

        let body: { pairs?: unknown[] | null };
        try {
          body = JSON.parse(response.text) as { pairs?: unknown[] | null };
        } catch {
          throw new UpstreamFailure('BAD_RESPONSE', 'DexScreener answered with something that is not JSON.');
        }
        // No pairs is an answer: a contract nobody trades has none. Absent is
        // not zero and it is not a failure either.
        return { pairs: Array.isArray(body.pairs) ? body.pairs : [] };
      } catch (error) {
        throw classifyThrown(error);
      }
    },
  });
}

export function registerMarketUpstreams(): void {
  registerUpstream(dexscreener());
}
