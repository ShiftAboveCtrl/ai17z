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
 * ### What was measured, and what was refused
 *
 * Every endpoint here was fetched once and weighed, September 2026. Size is the
 * governing constraint at DefiLlama, not the rate limit:
 *
 *     stablecoinchains                       19 KB   adopted
 *     v2/historicalChainTvl/Ethereum        118 KB   adopted
 *     stablecoins (every one there is)      540 KB   adopted
 *     overview/fees (charts excluded)       4.2 MB   refused
 *     protocols (8,227 of them)             8.6 MB   refused
 *     protocol/aave                        10.2 MB   refused
 *     yields pools (17,210 of them)        11.5 MB   refused
 *     stablecoin/1 (one single asset)      20.6 MB   refused
 *
 * The last line is the one worth remembering. Asking about *one* stablecoin
 * costs thirty-eight times what asking about *all* of them costs, because the
 * single-asset endpoint carries the full daily history of every chain it is on.
 * The specific question being far more expensive than the general one is not the
 * shape anyone assumes, and assuming the other way round is how a worker ends up
 * holding twenty megabytes to report one number.
 *
 * The four refused above are not gaps to fill later with a bigger cap. Yields
 * and the protocol list are answers to questions nobody asked precisely, and a
 * capability that returns 17,210 pools has not answered anything -- it has moved
 * the problem into the prompt.
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
  /** Every stablecoin, its peg and what is circulating. */
  z.object({ kind: z.literal('stablecoins') }),
  /** How much stablecoin supply sits on each chain. */
  z.object({ kind: z.literal('stablecoin_chains') }),
  /** One chain's value locked, daily, for as long as it has been measured. */
  z.object({ kind: z.literal('chain_history'), chain: z.string().min(1).max(40) }),
]);
export type DefiQuery = z.infer<typeof DefiQuery>;

export interface DefiAnswer {
  /** Present for `protocol_tvl`. */
  tvlUsd?: number;
  /** Present for `chains`. */
  chains?: { name: string; tvlUsd: number; tokenSymbol: string | null }[];
  /** Present for `stablecoins`. */
  stablecoins?: {
    name: string;
    symbol: string;
    pegType: string | null;
    pegMechanism: string | null;
    circulating: number | null;
    price: number | null;
  }[];
  /** Present for `stablecoin_chains`. */
  stablecoinChains?: { name: string; circulatingUsd: number }[];
  /** Present for `chain_history`. */
  history?: { at: string; tvlUsd: number }[];
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

/**
 * The host each kind actually talks to.
 *
 * Not cosmetic. `origin` is what a MACHINE-scoped window is keyed on and what
 * provenance shows a person, so a family that declares one host and fetches
 * another would share an allowance with a service it never calls and attribute
 * its answer to a service that never gave one.
 */
function originFor(kind: DefiQuery['kind']): string {
  if (kind === 'price') return 'coins.llama.fi';
  if (kind === 'stablecoins' || kind === 'stablecoin_chains') return 'stablecoins.llama.fi';
  return 'api.llama.fi';
}

function llama(kind: DefiQuery['kind'], family: string): Upstream<DefiQuery, DefiAnswer> {
  return defineUpstream<DefiQuery, DefiAnswer>({
    id: `${family}.defillama`,
    family,
    name: 'defillama',
    description: 'Value locked and token prices, from DefiLlama.',
    origin: originFor(kind),
    limit: {
      concurrentPerProcess: 2,
      // DefiLlama publishes no number for the free endpoints -- checked
      // September 2026. It is a public good, so these are ours and deliberately
      // modest.
      windows: [perSecond(2, { scope: 'MACHINE' }), perMinute(60, { scope: 'MACHINE' })],
    },
    timeoutMs: 15_000,
    // Value locked moves slowly and a price does not move usefully faster than
    // this for anything an agent would say about it. Stablecoin supply moves
    // slower still, and its list is 540 KB -- so it is held ten minutes, which
    // is what turns a half-megabyte fetch into something several agents share
    // rather than each pay for.
    freshMs:
      kind === 'price'
        ? 60_000
        : kind === 'stablecoins' || kind === 'stablecoin_chains'
          ? 10 * 60_000
          : 5 * 60_000,
    rank: 1,
    cacheKey: (query) =>
      query.kind === 'protocol_tvl'
        ? `tvl:${query.slug.toLowerCase()}`
        : query.kind === 'price'
          ? `price:${query.chain.toLowerCase()}:${query.address.toLowerCase()}`
          : query.kind === 'chain_history'
            ? `history:${query.chain.toLowerCase()}`
            : query.kind,
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

        if (query.kind === 'stablecoins') {
          const response = await safeFetch('https://stablecoins.llama.fi/stablecoins', {
            signal: ctx.signal,
            headers: { accept: 'application/json' },
            // Measured at 540 KB for every stablecoin there is. Large, and the
            // smallest way to ask the question: the *single asset* endpoint is
            // 20.6 MB, because it carries full history. The specific URL being
            // bigger than the general one is not the shape anybody expects.
            maxBytes: 1_200_000,
          });
          const status = classifyStatus(response.status, response.headers);
          if (status) throw status;
          const body = JSON.parse(response.text) as { peggedAssets?: Record<string, unknown>[] };
          if (!Array.isArray(body.peggedAssets)) {
            throw new UpstreamFailure('BAD_RESPONSE', 'DefiLlama answered with no stablecoin list.');
          }
          return {
            stablecoins: body.peggedAssets
              .filter((row) => typeof row.name === 'string' && typeof row.symbol === 'string')
              .map((row) => {
                const circulating = row.circulating as Record<string, unknown> | undefined;
                const amount = circulating ? Object.values(circulating).find((v) => typeof v === 'number') : undefined;
                return {
                  name: row.name as string,
                  symbol: row.symbol as string,
                  pegType: typeof row.pegType === 'string' ? row.pegType : null,
                  pegMechanism: typeof row.pegMechanism === 'string' ? row.pegMechanism : null,
                  circulating: typeof amount === 'number' ? amount : null,
                  price: typeof row.price === 'number' ? row.price : null,
                };
              }),
          };
        }

        if (query.kind === 'stablecoin_chains') {
          const response = await safeFetch('https://stablecoins.llama.fi/stablecoinchains', {
            signal: ctx.signal,
            headers: { accept: 'application/json' },
            // 19 KB. One of the few small things here.
            maxBytes: 200_000,
          });
          const status = classifyStatus(response.status, response.headers);
          if (status) throw status;
          const rows = JSON.parse(response.text) as Record<string, unknown>[];
          if (!Array.isArray(rows)) throw new UpstreamFailure('BAD_RESPONSE', 'DefiLlama answered with no chain list.');
          return {
            stablecoinChains: rows
              .filter((row) => typeof row.name === 'string')
              .map((row) => {
                const total = row.totalCirculatingUSD as Record<string, unknown> | undefined;
                const amount = total ? Object.values(total).find((v) => typeof v === 'number') : undefined;
                return { name: row.name as string, circulatingUsd: typeof amount === 'number' ? amount : 0 };
              }),
          };
        }

        if (query.kind === 'chain_history') {
          const response = await safeFetch(
            `https://api.llama.fi/v2/historicalChainTvl/${encodeURIComponent(query.chain)}`,
            {
              signal: ctx.signal,
              headers: { accept: 'application/json' },
              // 118 KB for Ethereum's whole history, which is every daily point
              // since 2017. The capability trims it; the wire cost is bounded.
              maxBytes: 500_000,
            },
          );
          // A chain nobody has is a 404 of nginx's own HTML, which the general
          // classifier already reads as NOT_FOUND -- correctly, and with the
          // breaker left alone. What it cannot do is say *what* was not found,
          // and "It has no such thing (404)" is not something to show a person
          // who asked about a chain by name. Probed September 2026.
          if (response.status === 404) {
            throw new UpstreamFailure('NOT_FOUND', `DefiLlama has no history for a chain called "${query.chain}".`);
          }
          const status = classifyStatus(response.status, response.headers);
          if (status) throw status;
          const rows = JSON.parse(response.text) as { date?: unknown; tvl?: unknown }[];
          if (!Array.isArray(rows)) throw new UpstreamFailure('BAD_RESPONSE', 'DefiLlama answered with no history.');
          return {
            history: rows
              .filter((row) => typeof row.date === 'number' && typeof row.tvl === 'number')
              .map((row) => ({ at: new Date((row.date as number) * 1000).toISOString(), tvlUsd: row.tvl as number })),
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
  registerUpstream(llama('stablecoins', 'defi_stablecoins'));
  registerUpstream(llama('stablecoin_chains', 'defi_stablecoin_chains'));
  registerUpstream(llama('chain_history', 'defi_chain_history'));
}
