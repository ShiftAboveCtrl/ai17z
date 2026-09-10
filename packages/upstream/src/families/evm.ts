import { z } from 'zod';
import { defineUpstream, type Upstream } from '../contract';
import { registerUpstream } from '../registry';
import { safeFetch } from '../http';

/**
 * Reading an EVM chain, from whichever public node is answering.
 *
 * The first family, and the shape the rest follow: several endpoints that
 * answer the same question, ranked, so one being down is a fallback rather than
 * a failure. Everything about pacing, caching, coalescing and provenance is in
 * `ask` and none of it is repeated here.
 *
 * ### It can only read, and that is enforced rather than intended
 *
 * `READ_METHODS` is an allowlist, and a method not in it is refused before a
 * request is built. This is the difference between "a JSON-RPC client we only
 * use for reads" and one that cannot do anything else -- and it is the reason
 * there is no way to reach `eth_sendRawTransaction`, `eth_sendTransaction`,
 * `personal_*`, or any other method that signs, spends or unlocks. A generic
 * passthrough would be a wallet with extra steps, and this is deliberately not
 * one.
 *
 * Note what is *not* on the list as well: `eth_call` is absent. It is a read in
 * the protocol's sense and an arbitrary contract invocation in practice, and
 * one that a model could be talked into shaping. When a capability genuinely
 * needs a contract read it should arrive as its own narrow query -- "the
 * decimals of this token" -- rather than as a hole shaped like `eth_call`.
 *
 * ### The chain is checked, not assumed
 *
 * Every node in this family claims to serve one chain. `eth_chainId` says which
 * one it actually serves, and a node that has been repointed -- or a URL that
 * was wrong in the first place -- answers questions about a different chain
 * while looking perfectly healthy. Numbers from the wrong chain are worse than
 * no numbers, so the id is verified and a mismatch is a failure.
 */

/**
 * Exactly what may be asked, and nothing else.
 *
 * Adding to this list is a decision, not a convenience. Every entry here is a
 * read that cannot move a balance, sign anything or reveal a key.
 */
export const READ_METHODS = [
  'eth_blockNumber',
  'eth_chainId',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'net_version',
] as const;
export type ReadMethod = (typeof READ_METHODS)[number];

/** Chains this family knows, and the id each one must prove it is. */
export const EVM_CHAINS: Record<string, number> = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
};

export const EvmQuery = z.object({
  chain: z.enum(Object.keys(EVM_CHAINS) as [string, ...string[]]),
  method: z.enum(READ_METHODS),
  params: z.array(z.unknown()).max(4).default([]),
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

async function rpc(
  url: string,
  method: string,
  params: unknown[],
  signal: AbortSignal,
  headers: Record<string, string>,
): Promise<unknown> {
  const response = await safeFetch(url, {
    signal,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    maxBytes: 1_000_000,
  });
  if (response.status !== 200) throw new Error(`${url} answered ${response.status}.`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error(`${url} answered with something that is not JSON.`);
  }
  const body = JsonRpcResponse.safeParse(parsed);
  if (!body.success) throw new Error(`${url} answered with something that is not a JSON-RPC response.`);
  if (body.data.error) throw new Error(`${url} refused: ${body.data.error.message}`);
  if (body.data.result === undefined) throw new Error(`${url} answered with neither a result nor an error.`);
  return body.data.result;
}

function node(input: {
  name: string;
  url: string;
  chain: string;
  rank: number;
  perSecond: number;
  secretHeader?: { header: string; key: string; why: string };
}): Upstream<EvmQuery, EvmResult> {
  const expectedChainId = EVM_CHAINS[input.chain]!;
  return defineUpstream<EvmQuery, EvmResult>({
    id: `evm.${input.name}`,
    family: 'evm',
    name: input.name,
    description: `Reads the ${input.chain} chain.`,
    origin: new URL(input.url).hostname,
    limit: { perSecond: input.perSecond, concurrent: 4 },
    timeoutMs: 10_000,
    // A chain's head moves every few seconds, so nothing here is worth keeping
    // for long. Short enough to be current, long enough that four agents asking
    // in the same tick cost one request.
    freshMs: 4_000,
    rank: input.rank,
    ...(input.secretHeader
      ? { secret: { key: input.secretHeader.key, why: input.secretHeader.why, required: false } }
      : {}),
    cacheKey: (query) => `${query.chain}:${query.method}:${JSON.stringify(query.params)}`,
    async fetch(query, ctx) {
      // Belt and braces: the schema already refuses anything outside the list,
      // and a caller that builds a query by hand rather than by parsing would
      // get past that. This is the check that cannot be skipped.
      if (!(READ_METHODS as readonly string[]).includes(query.method)) {
        throw new Error(`${query.method} is not a method this reads. Only these are: ${READ_METHODS.join(', ')}.`);
      }
      if (query.chain !== input.chain) {
        throw new Error(`This node serves ${input.chain}, not ${query.chain}.`);
      }

      const headers = ctx.secret && input.secretHeader ? { [input.secretHeader.header]: ctx.secret } : {};

      // The chain is proved before the answer is trusted. A node that has been
      // repointed answers everything else perfectly while describing a
      // different chain, and a block height from the wrong chain is worse than
      // none at all.
      const claimed = await rpc(input.url, 'eth_chainId', [], ctx.signal, headers);
      const chainId = typeof claimed === 'string' ? Number.parseInt(claimed, 16) : Number.NaN;
      if (chainId !== expectedChainId) {
        throw new Error(
          `${input.url} says it is chain ${Number.isNaN(chainId) ? String(claimed) : chainId}, ` +
            `but this node is configured for ${input.chain} (${expectedChainId}). Nothing was read from it.`,
        );
      }

      if (query.method === 'eth_chainId') return { result: claimed, chainId };
      return { result: await rpc(input.url, query.method, query.params, ctx.signal, headers), chainId };
    },
  });
}

/**
 * The public nodes, in the order they are tried.
 *
 * Rates are deliberately below what each publishes. These are free endpoints
 * run by somebody else, and the point of the layer above is to ask for less
 * than is allowed rather than as much as will be borne.
 */
export function registerEvmUpstreams(): void {
  for (const upstream of [
    node({ name: 'publicnode', url: 'https://ethereum-rpc.publicnode.com', chain: 'ethereum', rank: 1, perSecond: 5 }),
    node({ name: 'llamarpc', url: 'https://eth.llamarpc.com', chain: 'ethereum', rank: 2, perSecond: 3 }),
    node({ name: 'cloudflare', url: 'https://cloudflare-eth.com', chain: 'ethereum', rank: 3, perSecond: 3 }),
  ]) {
    registerUpstream(upstream);
  }
}
