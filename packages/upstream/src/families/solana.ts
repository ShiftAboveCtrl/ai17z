import { z } from 'zod';
import { defineUpstream, type Upstream } from '../contract';
import { perMinute, perSecond } from '../quota';
import { registerUpstream } from '../registry';
import { safeFetch } from '../http';
import { UpstreamFailure, classifyStatus, classifyThrown } from '../failures';
import { parseExactJson } from '../exactNumbers';

/**
 * Reading Solana, on Solana's own terms.
 *
 * ### Not EVM with different words
 *
 * The temptation is to map this onto the chain family already here and call a
 * signature a hash and a slot a block. Three things make that wrong, and each
 * one changes what an honest answer looks like:
 *
 *   **Commitment.** A Solana read happens at `processed`, `confirmed` or
 *   `finalized`, and the first two can still be rolled back. "The balance is X"
 *   is not a complete sentence here; "the balance is X, finalized" is. Every
 *   read defaults to `finalized` and every answer carries which was used.
 *
 *   **Everything is an account.** A wallet, a token mint, a token balance and a
 *   program are all accounts, distinguished by which program owns them. There
 *   is no separate notion of "contract code at an address", so `read_account`
 *   is the primitive and the rest are readings of it.
 *
 *   **u64 does not fit in a double.** Lamports, token supplies and rent epochs
 *   are u64. `JSON.parse` rounds them. See `exactNumbers.ts` -- this was
 *   measured against mainnet, not anticipated.
 *
 * ### One endpoint, and the reason it is one
 *
 * Every keyless public Solana RPC was probed in September 2026 with a single
 * `getGenesisHash`. Only one answered:
 *
 *   `api.mainnet-beta.solana.com` -- 200, correct genesis hash, 81 bytes,
 *     429ms. It is also the only one that publishes its limits, in response
 *     headers: `rps-limit: 250`, `method-limit: 150`, `conn-limit: 40`,
 *     `tier: free`.
 *   `solana.drpc.org` -- 400, "chain is not available on free plan".
 *   `rpc.ankr.com/solana` -- 403, wants a key, exactly as its Ethereum
 *     endpoint now does.
 *   `solana.api.onfinality.io/public` -- 429 on the first request, with
 *     `x-ratelimit-limit-sec: 1` shared across everybody. Exhausted before it
 *     is useful.
 *   `endpoints.omniatech.io/v1/sol/mainnet/public` -- 521, origin down.
 *   `api.blockeden.xyz` -- 402, paid plan required.
 *   `solana-mainnet.rpc.extrnode.com` -- NXDOMAIN.
 *   `solana.public-rpc.com` -- **a self-signed certificate**. Refused, and it
 *     stays refused: the fix for a bad certificate is not to stop checking.
 *   `solana-rpc.publicnode.com` -- could not be reached from the machine this
 *     was researched on, whose resolver returns `0.0.0.0` for it. That looks
 *     like local DNS filtering rather than a dead host, but an endpoint nobody
 *     here has actually reached does not get registered on a guess. That rule
 *     was learned from `eth.llamarpc.com`, which sat in the EVM family having
 *     never once answered.
 *
 * So this family has one member and no fallback, which is a smaller claim
 * rather than a broken one: it answers, or it says it could not. Adding a
 * sibling that has not been reached would be worse than having none.
 *
 * ### It can only read
 *
 * `READ_METHODS` is an allowlist checked twice. There is no path to
 * `sendTransaction`, `requestAirdrop` or anything that signs or spends.
 * `simulateTransaction` is deliberately absent as well: it reads in the
 * protocol's sense and executes caller-supplied instructions in practice, which
 * is the same objection that keeps `eth_call` out of the EVM family.
 * `getProgramAccounts` is absent because it scans -- it is the request that
 * gets an endpoint to stop answering.
 */

/**
 * Exactly what may be asked, and nothing else.
 *
 * Every entry is a read that cannot move a lamport, sign anything, or ask the
 * node to execute something a caller supplied.
 */
export const SOLANA_READ_METHODS = [
  'getAccountInfo',
  'getBalance',
  'getBlockHeight',
  'getEpochInfo',
  'getGenesisHash',
  'getHealth',
  'getLatestBlockhash',
  'getMultipleAccounts',
  'getSignaturesForAddress',
  'getSignatureStatuses',
  'getSlot',
  'getTokenAccountBalance',
  'getTokenSupply',
  'getTransaction',
  'getVersion',
] as const;
export type SolanaReadMethod = (typeof SOLANA_READ_METHODS)[number];

/**
 * The genesis hash mainnet-beta must prove it is serving.
 *
 * The native equivalent of asking a node its chain id, and read back from the
 * live cluster rather than copied from a list. Devnet answers
 * `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`, which is how this check was
 * confirmed to discriminate rather than merely pass.
 */
export const SOLANA_MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

/**
 * How sure the cluster is about what it just told you.
 *
 * `processed` can be rolled back and `confirmed` is not final either. Anything
 * anybody might act on is read at `finalized`, which is the default everywhere
 * here; the others exist because "what is the very latest" is a real question,
 * and the answer says which was used.
 */
export const COMMITMENTS = ['finalized', 'confirmed', 'processed'] as const;
export type Commitment = (typeof COMMITMENTS)[number];

export const SOLANA_FAMILY = 'solana_mainnet';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Decodes base58, so an address is checked rather than pattern-matched.
 *
 * A length regex accepts strings that are not addresses and rejects short ones
 * that are -- a 32-byte value with leading zero bytes encodes shorter. Decoding
 * and counting the bytes is the actual question, and it is twenty lines.
 */
export function base58Bytes(input: string): Uint8Array | null {
  if (input.length === 0 || input.length > 128) return null;
  const bytes: number[] = [];
  for (const character of input) {
    let carry = BASE58.indexOf(character);
    if (carry < 0) return null;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Every leading '1' is a leading zero byte, which the arithmetic above drops.
  for (let i = 0; i < input.length && input[i] === '1'; i += 1) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

/** An account address: 32 bytes, base58. */
export function isAddress(value: string): boolean {
  return base58Bytes(value)?.length === 32;
}

/** A transaction signature: 64 bytes, base58. */
export function isSignature(value: string): boolean {
  return base58Bytes(value)?.length === 64;
}

export const SolanaQuery = z.object({
  method: z.enum(SOLANA_READ_METHODS),
  params: z.array(z.unknown()).max(4).default([]),
  /** Part of the cache key: the same question at two commitments is two questions. */
  commitment: z.enum(COMMITMENTS).default('finalized'),
});
export type SolanaQuery = z.infer<typeof SolanaQuery>;

/** What the cluster answered, and how sure it was. */
export interface SolanaResult {
  result: unknown;
  commitment: Commitment;
  /**
   * The slot the value was read at, when the method reports one.
   *
   * Solana puts this on every state read, which is a better answer to "as of
   * when" than anything that has to be asked for separately.
   */
  slot: number | null;
}

const JsonRpcResponse = z.object({
  jsonrpc: z.literal('2.0').optional(),
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number().optional(), message: z.string() }).optional(),
});

function fromRpcError(message: string, code?: number): UpstreamFailure {
  if (code === -32601) return new UpstreamFailure('UNSUPPORTED', `It does not implement that: ${message}`);
  if (code === -32602) return new UpstreamFailure('BAD_CONFIGURATION', `It refused the arguments: ${message}`);
  // -32005 is the node saying it is behind or overloaded, which is not the
  // question being wrong.
  if (code === -32005 || /rate|limit|too many/i.test(message)) return new UpstreamFailure('RATE_LIMITED', message);
  return new UpstreamFailure('BAD_RESPONSE', `It refused: ${message}`);
}

async function rpc(url: string, method: string, params: unknown[], signal: AbortSignal): Promise<unknown> {
  const response = await safeFetch(url, {
    signal,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    // Every read here measured under 800 bytes when probed. The cap is for the
    // one that misbehaves, not for the ones that do not.
    maxBytes: 2_000_000,
  });

  const status = classifyStatus(response.status, response.headers);
  if (status) throw status;

  let parsed: unknown;
  try {
    // Exact rather than fast: this is where a u64 would otherwise be rounded.
    parsed = parseExactJson(response.text, `the answer from ${url}`);
  } catch (error) {
    if (error instanceof UpstreamFailure) throw error;
    throw new UpstreamFailure('BAD_RESPONSE', `${url} answered with something that is not JSON.`);
  }
  const body = JsonRpcResponse.safeParse(parsed);
  if (!body.success) {
    throw new UpstreamFailure('BAD_RESPONSE', `${url} answered with something that is not a JSON-RPC response.`);
  }
  if (body.data.error) throw fromRpcError(body.data.error.message, body.data.error.code);
  if (body.data.result === undefined) {
    throw new UpstreamFailure('BAD_RESPONSE', `${url} answered with neither a result nor an error.`);
  }
  return body.data.result;
}

/** The slot a state read reports, when it reports one. */
function slotOf(result: unknown): number | null {
  if (result && typeof result === 'object' && 'context' in result) {
    const context = (result as { context?: { slot?: unknown } }).context;
    if (context && typeof context.slot === 'number') return context.slot;
  }
  return null;
}

interface NodeOptions {
  name: string;
  url: string;
  rank: number;
  perSecondOurs: number;
}

function node(input: NodeOptions): Upstream<SolanaQuery, SolanaResult> {
  return defineUpstream<SolanaQuery, SolanaResult>({
    id: `${SOLANA_FAMILY}.${input.name}`,
    family: SOLANA_FAMILY,
    name: input.name,
    description: 'Reads the Solana mainnet-beta cluster.',
    origin: new URL(input.url).hostname,
    limit: {
      concurrentPerProcess: 4,
      // This endpoint publishes 250 requests a second and 150 per method in its
      // own response headers, and Solana's documentation says plainly that it is
      // not for production use. Both are true at once, so what AI17Z allows
      // itself is far below what is offered -- these are ours, and say so.
      windows: [
        perSecond(input.perSecondOurs, { scope: 'MACHINE' }),
        perMinute(input.perSecondOurs * 20, { scope: 'MACHINE' }),
      ],
    },
    timeoutMs: 15_000,
    // A slot is about 400ms. Short enough to be current, long enough that
    // several agents asking at once cost one request.
    freshMs: 4_000,
    rank: input.rank,
    cacheKey: (query) => `${query.commitment}:${query.method}:${JSON.stringify(query.params)}`,
    async fetch(query, ctx) {
      // Belt and braces, as in the EVM family: the schema refuses anything
      // outside the list, and this catches a query built by hand rather than
      // parsed. It is the check that cannot be skipped.
      if (!(SOLANA_READ_METHODS as readonly string[]).includes(query.method)) {
        throw new UpstreamFailure(
          'UNSUPPORTED',
          `${query.method} is not a method this reads. Only these are: ${SOLANA_READ_METHODS.join(', ')}.`,
        );
      }

      try {
        // The cluster is proved before anything it says is trusted. A node
        // repointed at devnet answers everything perfectly about the wrong
        // world, and numbers from the wrong cluster are worse than none.
        const genesis = await rpc(input.url, 'getGenesisHash', [], ctx.signal);
        if (genesis !== SOLANA_MAINNET_GENESIS) {
          throw new UpstreamFailure(
            'WRONG_NETWORK',
            `${input.url} reports genesis ${String(genesis)}, which is not Solana mainnet-beta. Nothing was read from it.`,
          );
        }

        if (query.method === 'getGenesisHash') {
          return { result: genesis, commitment: query.commitment, slot: null };
        }

        const result = await rpc(input.url, query.method, query.params, ctx.signal);
        return { result, commitment: query.commitment, slot: slotOf(result) };
      } catch (error) {
        throw classifyThrown(error);
      }
    },
  });
}

/**
 * The nodes, in the order they are tried.
 *
 * One, for the reasons set out at the top of this file. Five a second is far
 * under what it offers and is about what a handful of agents asking questions
 * actually needs.
 */
const NODES: NodeOptions[] = [
  { name: 'official', url: 'https://api.mainnet-beta.solana.com', rank: 1, perSecondOurs: 5 },
];

export function registerSolanaUpstreams(): void {
  for (const options of NODES) registerUpstream(node(options));
}
