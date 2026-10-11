import { z } from 'zod';
import { defineUpstream, type Upstream } from '../contract';
import { perMinute, perSecond } from '../quota';
import { registerUpstream } from '../registry';
import { safeFetch } from '../http';
import { UpstreamFailure, classifyStatus, classifyThrown } from '../failures';

/**
 * What a Solana swap would get right now, as Jupiter's router answers it.
 *
 * ### Which API, read from their documentation (October 2026)
 *
 * Swap API V2, `GET /swap/v2/order`. V1 (`/swap/v1/quote`) and Ultra
 * (`ultra-api.jup.ag`) are marked deprecated there, and nothing new is built
 * against a deprecated surface.
 *
 * ### Why there is no taker here
 *
 * Given a `taker`, the order answer carries an assembled transaction for that
 * wallet to sign. This family never sends one, so `transaction` is always
 * null and nothing it returns can be signed. It answers "what would this
 * fetch", which is a read; building the transaction an owner approves is the
 * wallet adapter's, on the path that signs.
 *
 * ### Never cached
 *
 * `freshMs` is zero. A quote is a price at one moment, and a cached one is a
 * stale price presented as a current one, which is the one thing an execution
 * path must never be handed. Its windows are MACHINE-scoped on the same origin
 * as the token index, so the two share Jupiter's keyless allowance rather than
 * each assuming the whole of it.
 */

export const JUPITER_SWAP_FAMILY = 'solana_swap_quote';

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const SwapQuoteQuery = z.object({
  inputMint: z.string().regex(SOLANA_ADDRESS),
  outputMint: z.string().regex(SOLANA_ADDRESS),
  /** Exact, in the input token's smallest unit. */
  amount: z.string().regex(/^[1-9][0-9]{0,30}$/),
  slippageBps: z.number().int().min(0).max(5_000),
});
export type SwapQuoteQuery = z.infer<typeof SwapQuoteQuery>;

export interface SwapQuoteResult {
  /** The order answer in the source's own shape. Normalised by the capability. */
  order: Record<string, unknown>;
}

const BASE = 'https://api.jup.ag/swap/v2';

/** The one place the URL is built. Every value is validated above and encoded here. */
function urlFor(query: SwapQuoteQuery): string {
  const params = new URLSearchParams({
    inputMint: query.inputMint,
    outputMint: query.outputMint,
    amount: query.amount,
    slippageBps: String(query.slippageBps),
  });
  return `${BASE}/order?${params.toString()}`;
}

function jupiterSwap(): Upstream<SwapQuoteQuery, SwapQuoteResult> {
  return defineUpstream<SwapQuoteQuery, SwapQuoteResult>({
    id: `${JUPITER_SWAP_FAMILY}.jupiter`,
    family: JUPITER_SWAP_FAMILY,
    name: 'jupiter-swap',
    description: 'What a Solana swap would return now, from Jupiter’s router. A quote, never a transaction.',
    origin: 'api.jup.ag',
    limit: {
      concurrentPerProcess: 1,
      windows: [perSecond(1, { scope: 'MACHINE' }), perMinute(25, { scope: 'MACHINE' })],
    },
    timeoutMs: 15_000,
    freshMs: 0,
    rank: 1,
    cacheKey: (query) => `${query.inputMint}:${query.outputMint}:${query.amount}:${query.slippageBps}`,
    async fetch(query, ctx) {
      const parsed = SwapQuoteQuery.safeParse(query);
      if (!parsed.success) throw new UpstreamFailure('UNSUPPORTED', 'A quote needs two exact mints, a whole amount and a slippage.');
      if (parsed.data.inputMint === parsed.data.outputMint) throw new UpstreamFailure('UNSUPPORTED', 'A swap needs two different tokens.');
      const key = process.env.JUPITER_API_KEY?.trim();
      try {
        const response = await safeFetch(urlFor(parsed.data), {
          signal: ctx.signal,
          headers: { accept: 'application/json', ...(key ? { 'x-api-key': key } : {}) },
          // An order with a long route plan is a few kilobytes.
          maxBytes: 200_000,
        });
        const status = classifyStatus(response.status, response.headers);
        if (status) throw status;
        let body: unknown;
        try {
          body = JSON.parse(response.text);
        } catch {
          throw new UpstreamFailure('BAD_RESPONSE', 'Jupiter answered with something that is not JSON.');
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new UpstreamFailure('BAD_RESPONSE', 'Jupiter answered with something other than an order.');
        const order = body as Record<string, unknown>;
        // A route it could not find comes back as an error in a 200; that is an answer, not a quote.
        if (typeof order.error === 'string' || typeof order.errorMessage === 'string') {
          throw new UpstreamFailure('NOT_FOUND', `Jupiter found no route: ${String(order.errorMessage ?? order.error).slice(0, 160)}`);
        }
        if (typeof order.outAmount !== 'string') throw new UpstreamFailure('BAD_RESPONSE', 'Jupiter’s order carried no output amount.');
        return { order };
      } catch (error) {
        throw classifyThrown(error);
      }
    },
  });
}

export function registerJupiterSwapUpstreams(): void {
  registerUpstream(jupiterSwap());
}
