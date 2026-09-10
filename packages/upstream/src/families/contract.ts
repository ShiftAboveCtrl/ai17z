import { z } from 'zod';
import { defineUpstream, type Upstream } from '../contract';
import { perMinute, perSecond } from '../quota';
import { registerUpstream } from '../registry';
import { safeFetch } from '../http';
import { UpstreamFailure, classifyStatus, classifyThrown } from '../failures';
import { EVM_CHAINS, type EvmChain } from './evm';

/**
 * What is known about a contract's source, from whoever verified it.
 *
 * Bytecode says what a contract *does*; verified source says what somebody
 * claims it *is*, and the two are only connected when a verifier has recompiled
 * the source and matched it against what is on chain. That match is the whole
 * value here, so its quality travels with every answer rather than being
 * flattened into "verified: true".
 *
 * ### Sourcify, and why it is asked by chain
 *
 * One service covers many chains, but a family's members must be
 * interchangeable *for the question asked* -- and the question always names a
 * chain. So the families are `contract_ethereum`, `contract_base` and so on,
 * which is also what lets a chain-specific explorer be added beside Sourcify
 * later without either pretending to answer for the other.
 *
 * ### Only the fields that are wanted
 *
 * `?fields=all` on a large contract returns its whole source tree, both
 * bytecodes and the full standard-json input -- megabytes, for a question about
 * a compiler version. Every call here names the fields it needs.
 *
 * Checked against the live service in September 2026. The v1 API was turned off
 * in July 2026; this is v2.
 */

/** What Sourcify is asked for, per question. */
export const ContractQuery = z.object({
  chain: z.enum(Object.keys(EVM_CHAINS) as [EvmChain, ...EvmChain[]]),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  /** Which parts of the record are wanted. Never "all". */
  fields: z.array(z.enum(['compilation', 'abi', 'deployment', 'proxyResolution', 'sourceIds', 'metadata'])).min(1),
});
export type ContractQuery = z.infer<typeof ContractQuery>;

const Implementation = z.object({ address: z.string(), name: z.string().optional() });

/**
 * What came back, normalised.
 *
 * `null` for a contract nobody has verified is a real answer and not a failure:
 * most contracts are unverified, and saying so is the useful thing.
 */
export const ContractRecord = z.object({
  found: z.boolean(),
  chainId: z.number(),
  address: z.string(),
  /** How well the recompiled source matched what is on chain. */
  runtimeMatch: z.string().nullable(),
  creationMatch: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  name: z.string().nullable(),
  compiler: z.string().nullable(),
  compilerVersion: z.string().nullable(),
  language: z.string().nullable(),
  abi: z.array(z.unknown()).nullable(),
  sourceFiles: z.array(z.string()),
  deployment: z
    .object({
      transactionHash: z.string().nullable(),
      blockNumber: z.string().nullable(),
      deployer: z.string().nullable(),
    })
    .nullable(),
  proxy: z
    .object({
      isProxy: z.boolean(),
      proxyType: z.string().nullable(),
      implementations: z.array(Implementation),
    })
    .nullable(),
});
export type ContractRecord = z.infer<typeof ContractRecord>;

const SOURCIFY = 'https://sourcify.dev/server';

function sourcify(chain: EvmChain, rank: number): Upstream<ContractQuery, ContractRecord> {
  const chainId = EVM_CHAINS[chain];
  return defineUpstream<ContractQuery, ContractRecord>({
    id: `contract_${chain}.sourcify`,
    family: `contract_${chain}`,
    name: 'sourcify',
    description: `Verified source for contracts on ${chain}.`,
    origin: 'sourcify.dev',
    limit: {
      concurrentPerProcess: 2,
      // Sourcify publishes no number for the public server -- checked September
      // 2026 -- so these are ours. It is a public good run by a foundation, and
      // the right posture is well under whatever it would tolerate.
      windows: [perSecond(2, { scope: 'MACHINE' }), perMinute(40, { scope: 'MACHINE' })],
    },
    timeoutMs: 20_000,
    // A verification does not change. The only thing that moves is a contract
    // being verified for the first time, and an hour is soon enough to notice.
    freshMs: 60 * 60_000,
    rank,
    cacheKey: (query) => `${query.chain}:${query.address.toLowerCase()}:${[...query.fields].sort().join(',')}`,
    async fetch(query, ctx) {
      try {
        const url = `${SOURCIFY}/v2/contract/${chainId}/${query.address}?fields=${query.fields.join(',')}`;
        const response = await safeFetch(url, { signal: ctx.signal, maxBytes: 8_000_000 });

        // Sourcify answers 404 with a body that says so plainly. An unverified
        // contract is an answer, not a fault -- and it must not reach the
        // breaker, or looking up ordinary unverified contracts would cool off a
        // service that is working perfectly.
        if (response.status === 404) {
          return {
            found: false,
            chainId,
            address: query.address,
            runtimeMatch: null,
            creationMatch: null,
            verifiedAt: null,
            name: null,
            compiler: null,
            compilerVersion: null,
            language: null,
            abi: null,
            sourceFiles: [],
            deployment: null,
            proxy: null,
          };
        }

        const status = classifyStatus(response.status, response.headers);
        if (status) throw status;

        let body: Record<string, unknown>;
        try {
          body = JSON.parse(response.text) as Record<string, unknown>;
        } catch {
          throw new UpstreamFailure('BAD_RESPONSE', 'Sourcify answered with something that is not JSON.');
        }

        const compilation = (body.compilation ?? {}) as Record<string, unknown>;
        const deployment = body.deployment as Record<string, unknown> | undefined;
        const proxy = body.proxyResolution as Record<string, unknown> | undefined;
        const sourceIds = (body.sourceIds ?? {}) as Record<string, unknown>;

        return {
          found: true,
          chainId,
          address: query.address,
          runtimeMatch: typeof body.runtimeMatch === 'string' ? body.runtimeMatch : null,
          creationMatch: typeof body.creationMatch === 'string' ? body.creationMatch : null,
          verifiedAt: typeof body.verifiedAt === 'string' ? body.verifiedAt : null,
          name: typeof compilation.name === 'string' ? compilation.name : null,
          compiler: typeof compilation.compiler === 'string' ? compilation.compiler : null,
          compilerVersion: typeof compilation.compilerVersion === 'string' ? compilation.compilerVersion : null,
          language: typeof compilation.language === 'string' ? compilation.language : null,
          abi: Array.isArray(body.abi) ? (body.abi as unknown[]) : null,
          sourceFiles: Object.keys(sourceIds),
          deployment: deployment
            ? {
                transactionHash: typeof deployment.transactionHash === 'string' ? deployment.transactionHash : null,
                blockNumber: typeof deployment.blockNumber === 'string' ? deployment.blockNumber : null,
                deployer: typeof deployment.deployer === 'string' ? deployment.deployer : null,
              }
            : null,
          proxy: proxy
            ? {
                isProxy: proxy.isProxy === true,
                proxyType: typeof proxy.proxyType === 'string' ? proxy.proxyType : null,
                implementations: Array.isArray(proxy.implementations)
                  ? (proxy.implementations as Record<string, unknown>[])
                      .filter((entry) => typeof entry.address === 'string')
                      .map((entry) => ({
                        address: entry.address as string,
                        ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
                      }))
                  : [],
              }
            : null,
        };
      } catch (error) {
        throw classifyThrown(error);
      }
    },
  });
}

/**
 * Which chains Sourcify is asked about.
 *
 * Every chain this installation knows. Sourcify covers far more than these; the
 * limit is what AI17Z can name, not what it supports.
 */
export function registerContractUpstreams(): void {
  for (const chain of Object.keys(EVM_CHAINS) as EvmChain[]) {
    registerUpstream(sourcify(chain, 1));
  }
}
