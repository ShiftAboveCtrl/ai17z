import { z } from 'zod';
import { defineUpstream, type Upstream } from '../contract';
import { perMinute, perSecond } from '../quota';
import { registerUpstream } from '../registry';
import { safeFetch } from '../http';
import { UpstreamFailure, classifyStatus, classifyThrown } from '../failures';

/**
 * How much is locked in a protocol, and what a token is worth.
 *
 * ### Which endpoint, and why not the obvious one
 *
 * `api.llama.fi/protocol/aave` is the endpoint somebody reaches for and it
 * returns **ten megabytes** -- the entire historical series, in answer to "how
 * much is in Aave". `overview/dexs` returns nineteen. Both were measured rather
 * than assumed, and both are refused by the size cap, which is the cap doing its
 * job rather than a limitation to work around.
 *
 * `api.llama.fi/tvl/{slug}` answers the same question in eighteen bytes. The
 * lesson generalises: an API that offers one shape for a chart and another for a
 * number is offering a choice, and taking the chart to read a number is how a
 * worker ends up holding megabytes to report one figure.
 *
 * ### A price here is a second opinion, not the price
 *
 * DexScreener already answers what a token trades at, from pools. This answers
 * from a different method entirely, and carries a confidence figure with it.
 * Two independent sources are only useful if neither is quietly preferred, so
 * nothing in this file decides which is right -- that comparison belongs to the
 * capability that asks both, and its job is to report a disagreement rather than
 * to resolve one.
 *
 * Free, no key, checked September 2026.
 */

export const DefiQuery = z.discriminatedUnion('kind', [
  /** Current value locked in one protocol, by its DefiLlama slug. */
  z.object({ kind: z.literal('protocol_tvl'), slug: z.string().min(1).max(80) }),
  /** Every chain and what is locked on it. */
  z.object({ kind: z.literal('chains') }),
  /**
   * What a token is worth, by exact chain and contract.
   *
   * Never by ticker. Anyone can mint a token called anything, and a price
   * attached to the wrong contract is the error that costs somebody money.
   */
  z.object({ kind: z.literal('price'), chain: z.string().min(1).max(40), address: z.string().min(1).max(120) }),
]);
export type DefiQuery = z.infer<typeof DefiQuery>;

export interface DefiAnswer {
  /** Present for `protocol_tvl`. */
  tvlUsd?: number;
  /** Present for `chains`. */
  chains?: { name: string; tvlUsd: number; tokenSymbol: string | null }[];
  /** Present for `price`. */
  price?: {
    usd: number;
    symbol: string | null;
    decimals: number | null;
    /**
     * How sure the source is, as it reports it.
     *
     * Carried rather than dropped: a price at 0.7 confidence and one at 0.99
     * are different claims, and flattening them would make a shaky number look
     * like a firm one.
     */
    confidence: number | null;
    observedAt: string | null;
  };
}

function llama(kind: DefiQuery['kind'], family: string): Upstream<DefiQuery, DefiAnswer> {
  return defineUpstream<DefiQuery, DefiAnswer>({
    id: `${family}.defillama`,
    family,
    name: 'defillama',
    description: 'Value locked and token prices, from DefiLlama.',
    origin: kind === 'price' ? 'coins.llama.fi' : 'api.llama.fi',
    limit: {
      concurrentPerProcess: 2,
      // DefiLlama publishes no number for the free endpoints -- checked
      // September 2026. It is a public good, so these are ours and deliberately
      // modest.
      windows: [perSecond(2, { scope: 'MACHINE' }), perMinute(60, { scope: 'MACHINE' })],
    },
    timeoutMs: 15_000,
    // Value locked moves slowly and a price does not move usefully faster than
    // this for anything an agent would say about it.
    freshMs: kind === 'price' ? 60_000 : 5 * 60_000,
    rank: 1,
    cacheKey: (query) =>
      query.kind === 'protocol_tvl'
        ? `tvl:${query.slug.toLowerCase()}`
        : query.kind === 'price'
          ? `price:${query.chain.toLowerCase()}:${query.address.toLowerCase()}`
          : 'chains',
    async fetch(query, ctx) {
      try {
        if (query.kind === 'protocol_tvl') {
          const response = await safeFetch(`https://api.llama.fi/tvl/${encodeURIComponent(query.slug)}`, {
            signal: ctx.signal,
            headers: { accept: 'application/json' },
            maxBytes: 10_000,
          });
          // A slug nobody has is answered with 400 and a sentence. That is the
          // question being wrong, not the service, so it must not reach the
          // breaker -- looking up an unknown protocol would otherwise cool off
          // a source that is working perfectly.
          if (response.status === 400 && /not found/i.test(response.text)) {
            throw new UpstreamFailure('NOT_FOUND', `DefiLlama has no protocol called "${query.slug}".`);
          }
          const status = classifyStatus(response.status, response.headers);
          if (status) throw status;

          const value = Number(response.text.trim());
          if (!Number.isFinite(value)) {
            throw new UpstreamFailure('BAD_RESPONSE', 'DefiLlama answered with something that is not a number.');
          }
          return { tvlUsd: value };
        }

        if (query.kind === 'chains') {
          const response = await safeFetch('https://api.llama.fi/v2/chains', {
            signal: ctx.signal,
            headers: { accept: 'application/json' },
            maxBytes: 1_000_000,
          });
          const status = classifyStatus(response.status, response.headers);
          if (status) throw status;
          const rows = JSON.parse(response.text) as Record<string, unknown>[];
          if (!Array.isArray(rows)) throw new UpstreamFailure('BAD_RESPONSE', 'DefiLlama answered with no chain list.');
          return {
            chains: rows
              .filter((row) => typeof row.name === 'string' && typeof row.tvl === 'number')
              .map((row) => ({
                name: row.name as string,
                tvlUsd: row.tvl as number,
                tokenSymbol: typeof row.tokenSymbol === 'string' ? row.tokenSymbol : null,
              })),
          };
        }

        const key = `${query.chain}:${query.address}`;
        const response = await safeFetch(`https://coins.llama.fi/prices/current/${encodeURIComponent(key)}`, {
          signal: ctx.signal,
          headers: { accept: 'application/json' },
          maxBytes: 100_000,
        });
        const status = classifyStatus(response.status, response.headers);
        if (status) throw status;

        const body = JSON.parse(response.text) as { coins?: Record<string, Record<string, unknown>> };
        const coin = body.coins?.[key];
        // An unpriced contract comes back as an empty set rather than an error.
        // Absent is not zero, and a price of nothing is not a price of nought.
        if (!coin || typeof coin.price !== 'number') {
          throw new UpstreamFailure('NOT_FOUND', `DefiLlama has no price for ${key}.`);
        }
        return {
          price: {
            usd: coin.price,
            symbol: typeof coin.symbol === 'string' ? coin.symbol : null,
            decimals: typeof coin.decimals === 'number' ? coin.decimals : null,
            confidence: typeof coin.confidence === 'number' ? coin.confidence : null,
            observedAt: typeof coin.timestamp === 'number' ? new Date(coin.timestamp * 1000).toISOString() : null,
          },
        };
      } catch (error) {
        throw classifyThrown(error);
      }
    },
  });
}

export function registerDefiUpstreams(): void {
  registerUpstream(llama('protocol_tvl', 'defi_tvl'));
  registerUpstream(llama('chains', 'defi_chains'));
  registerUpstream(llama('price', 'price_usd'));
}
