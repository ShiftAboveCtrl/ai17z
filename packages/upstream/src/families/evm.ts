import { z } from 'zod';
import { defineUpstream, type Upstream } from '../contract';
import { perMinute, perSecond } from '../quota';
import { registerUpstream } from '../registry';
import { safeFetch } from '../http';
import { UpstreamFailure, classifyStatus, classifyThrown } from '../failures';

/**
 * Reading an EVM chain, from whichever public node is answering.
 *
 * ### One family per chain, not one family called "evm"
 *
 * Fallback happens inside a family, and a family's members have to be
 * interchangeable to the caller. A node serving Base cannot stand in for one
 * serving Ethereum -- it would answer confidently about the wrong world. So the
 * families are `evm_ethereum`, `evm_base` and so on, and asking one only ever
 * reaches nodes that serve it.
 *
 * ### It can only read, and that is enforced rather than intended
 *
 * `READ_METHODS` is an allowlist, and anything else is refused before a request
 * is built. There is no path from here to `eth_sendRawTransaction`,
 * `eth_sendTransaction`, `personal_*`, or anything that signs, spends or
 * unlocks. Checked twice: the query schema refuses it, and `fetch` refuses it
 * again for a caller that built a query by hand rather than by parsing.
 *
 * `eth_call` is deliberately absent. It is a read in the protocol's sense and an
 * arbitrary contract invocation in practice, and one a model could be talked
 * into shaping. A contract read should arrive as its own narrow question -- the
 * decimals of this token -- rather than as a hole shaped like `eth_call`.
 *
 * ### The chain is checked, not assumed
 *
 * A node that has been repointed, or a URL that was wrong to begin with, answers
 * everything perfectly while describing a different chain. Numbers from the
 * wrong chain are worse than no numbers, so `eth_chainId` is asked first and a
 * mismatch is a failure rather than a degradation.
 *
 * ### Which endpoints, and why these
 *
 * Every one was probed in September 2026 and answered `eth_chainId` with the
 * expected value. Three were not adopted, and the reasons are worth keeping:
 *
 *   `eth.llamarpc.com` -- did not answer at all when probed. It had been
 *     registered here on no evidence, having never actually been reached: the
 *     family always fell to PublicNode first. Removed rather than left as a
 *     rank-2 member that would only be tried when the good one was already down.
 *   `rpc.ankr.com/eth` -- answers 200 with no result, so its keyless path has
 *     gone or changed. Deferred rather than guessed at.
 *   `polygon-rpc.com` -- answers 401. It wants credentials now, which makes it
 *     a keyed upstream rather than a public one.
 */

/**
 * Exactly what may be asked, and nothing else.
 *
 * Adding to this list is a decision, not a convenience. Every entry is a read
 * that cannot move a balance, sign anything or reveal a key.
 */
export const READ_METHODS = [
  'eth_blockNumber',
  'eth_chainId',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getLogs',
  'eth_getStorageAt',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'net_version',
] as const;
export type ReadMethod = (typeof READ_METHODS)[number];

/**
 * The chains this knows, and the id each node must prove it is serving.
 *
 * Not a hardwired "EVM means Ethereum". Every id here was read back from a live
 * node rather than copied from a list.
 */
export const EVM_CHAINS = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
  bnb: 56,
  avalanche: 43114,
} as const;
export type EvmChain = keyof typeof EVM_CHAINS;

/** The family that answers for one chain. */
export function evmFamily(chain: EvmChain): string {
  return `evm_${chain}`;
}

export const EvmQuery = z.object({
  chain: z.enum(Object.keys(EVM_CHAINS) as [EvmChain, ...EvmChain[]]),
  method: z.enum(READ_METHODS),
  params: z.array(z.unknown()).max(5).default([]),
});
export type EvmQuery = z.infer<typeof EvmQuery>;

/** What a node answered, with the chain it proved it was serving. */
export interface EvmResult {
  result: unknown;
  chainId: number;
}

const JsonRpcResponse = z.object({
  jsonrpc: z.literal('2.0').optional(),
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number().optional(), message: z.string() }).optional(),
});

/**
 * JSON-RPC error codes worth telling apart.
 *
 * A node that does not implement a method is not a node that is broken, and
 * asking three siblings the same unsupported question wastes three budgets.
 */
function fromRpcError(message: string, code?: number): UpstreamFailure {
  if (code === -32601) return new UpstreamFailure('UNSUPPORTED', `It does not implement that: ${message}`);
  if (code === -32602) return new UpstreamFailure('BAD_CONFIGURATION', `It refused the arguments: ${message}`);
  if (/rate|limit|too many/i.test(message)) return new UpstreamFailure('RATE_LIMITED', message);
  return new UpstreamFailure('BAD_RESPONSE', `It refused: ${message}`);
}

async function rpc(url: string, method: string, params: unknown[], signal: AbortSignal): Promise<unknown> {
  const response = await safeFetch(url, {
    signal,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    maxBytes: 4_000_000,
  });

  const status = classifyStatus(response.status, response.headers);
  if (status) throw status;

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
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

interface NodeOptions {
  name: string;
  url: string;
  chain: EvmChain;
  rank: number;
  /** Requests a second AI17Z allows itself. See the note on limits below. */
  perSecondOurs: number;
}

function node(input: NodeOptions): Upstream<EvmQuery, EvmResult> {
  const expectedChainId = EVM_CHAINS[input.chain];
  return defineUpstream<EvmQuery, EvmResult>({
    id: `${evmFamily(input.chain)}.${input.name}`,
    family: evmFamily(input.chain),
    name: input.name,
    description: `Reads the ${input.chain} chain.`,
    origin: new URL(input.url).hostname,
    limit: {
      concurrentPerProcess: 4,
      // None of these operators publishes a number for its free endpoint --
      // checked September 2026; they are fair-use and counted per address -- so
      // these are limits AI17Z sets for itself, and every window says so. The
      // minute window is the one that matters: a burst inside a second is
      // ordinary, and a sustained rate is what an operator notices.
      windows: [
        perSecond(input.perSecondOurs, { scope: 'MACHINE' }),
        perMinute(input.perSecondOurs * 20, { scope: 'MACHINE' }),
      ],
    },
    timeoutMs: 10_000,
    // A chain's head moves every few seconds, so nothing here keeps for long.
    // Short enough to be current, long enough that several agents asking in one
    // tick cost one request.
    freshMs: 4_000,
    rank: input.rank,
    cacheKey: (query) => `${query.chain}:${query.method}:${JSON.stringify(query.params)}`,
    async fetch(query, ctx) {
      // Belt and braces: the schema refuses anything outside the list, and a
      // caller that builds a query by hand rather than by parsing gets past
      // that. This is the check that cannot be skipped.
      if (!(READ_METHODS as readonly string[]).includes(query.method)) {
        throw new UpstreamFailure(
          'UNSUPPORTED',
          `${query.method} is not a method this reads. Only these are: ${READ_METHODS.join(', ')}.`,
        );
      }
      if (query.chain !== input.chain) {
        throw new UpstreamFailure('BAD_CONFIGURATION', `This node serves ${input.chain}, not ${query.chain}.`);
      }

      try {
        // The chain is proved before the answer is trusted.
        const claimed = await rpc(input.url, 'eth_chainId', [], ctx.signal);
        const chainId = typeof claimed === 'string' ? Number.parseInt(claimed, 16) : Number.NaN;
        if (chainId !== expectedChainId) {
          throw new UpstreamFailure(
            'WRONG_NETWORK',
            `${input.url} says it is chain ${Number.isNaN(chainId) ? String(claimed) : chainId}, ` +
              `but this node is configured for ${input.chain} (${expectedChainId}). Nothing was read from it.`,
          );
        }

        if (query.method === 'eth_chainId') return { result: claimed, chainId };
        return { result: await rpc(input.url, query.method, query.params, ctx.signal), chainId };
      } catch (error) {
        // Classified here so a socket error, a 429 and a malformed body do not
        // all arrive upstairs as the same shrug.
        throw classifyThrown(error);
      }
    },
  });
}

/**
 * The nodes, per chain, in the order they are tried.
 *
 * Every one answered `eth_chainId` with the expected value when probed. Rates
 * are what AI17Z allows itself, not allowances anybody granted: these are free
 * endpoints run by other people, and the point of the layer above is to ask for
 * less than is tolerated rather than as much as will be borne.
 */
const NODES: NodeOptions[] = [
  { chain: 'ethereum', name: 'publicnode', url: 'https://ethereum-rpc.publicnode.com', rank: 1, perSecondOurs: 5 },
  { chain: 'ethereum', name: 'drpc', url: 'https://eth.drpc.org', rank: 2, perSecondOurs: 3 },
  { chain: 'ethereum', name: 'cloudflare', url: 'https://cloudflare-eth.com', rank: 3, perSecondOurs: 3 },

  { chain: 'base', name: 'publicnode', url: 'https://base-rpc.publicnode.com', rank: 1, perSecondOurs: 5 },
  { chain: 'base', name: 'official', url: 'https://mainnet.base.org', rank: 2, perSecondOurs: 3 },
  { chain: 'base', name: 'drpc', url: 'https://base.drpc.org', rank: 3, perSecondOurs: 3 },

  { chain: 'arbitrum', name: 'publicnode', url: 'https://arbitrum-one-rpc.publicnode.com', rank: 1, perSecondOurs: 5 },
  { chain: 'arbitrum', name: 'official', url: 'https://arb1.arbitrum.io/rpc', rank: 2, perSecondOurs: 3 },
  { chain: 'arbitrum', name: 'drpc', url: 'https://arbitrum.drpc.org', rank: 3, perSecondOurs: 3 },

  { chain: 'optimism', name: 'publicnode', url: 'https://optimism-rpc.publicnode.com', rank: 1, perSecondOurs: 5 },
  { chain: 'optimism', name: 'official', url: 'https://mainnet.optimism.io', rank: 2, perSecondOurs: 3 },
  { chain: 'optimism', name: 'drpc', url: 'https://optimism.drpc.org', rank: 3, perSecondOurs: 3 },

  // One node each. Fewer sources is a smaller claim, not a broken one: the
  // family answers or says it could not, and inventing a second endpoint that
  // has not been checked would be worse than having one that has.
  { chain: 'polygon', name: 'publicnode', url: 'https://polygon-bor-rpc.publicnode.com', rank: 1, perSecondOurs: 5 },
  { chain: 'bnb', name: 'publicnode', url: 'https://bsc-rpc.publicnode.com', rank: 1, perSecondOurs: 5 },
  {
    chain: 'avalanche',
    name: 'publicnode',
    url: 'https://avalanche-c-chain-rpc.publicnode.com',
    rank: 1,
    perSecondOurs: 5,
  },
];

/** Chains with more than one source, so a failure there is a fallback. */
export function chainsWithFallback(): EvmChain[] {
  const counts = new Map<EvmChain, number>();
  for (const entry of NODES) counts.set(entry.chain, (counts.get(entry.chain) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n > 1).map(([chain]) => chain);
}

export function registerEvmUpstreams(): void {
  for (const entry of NODES) registerUpstream(node(entry));
}
