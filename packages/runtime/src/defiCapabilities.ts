import { z } from 'zod';
import { defineCapability, registerCapability } from '@xbam/tools';
import { ask, familyHealth, type DefiAnswer, type DefiQuery, type Provenance } from '@xbam/upstream';
import { resolveToken } from './token';

/**
 * What is locked where, what a token is worth, and how sure anyone is.
 *
 * ### Two sources that are allowed to disagree
 *
 * A price from a pool and a price from an aggregator are arrived at by
 * different methods, and when they differ the difference is the finding. The
 * temptation is to pick one -- the higher, the fresher, the one that makes a
 * sentence easier -- and that is exactly the thing not to do: somebody acts on
 * these numbers, and a quiet choice between two disagreeing sources is a
 * fabrication with a citation attached.
 *
 * So `market.price_check` asks both and reports what each said. When they agree
 * it says so, which is worth something on its own. When they do not, it says
 * that, and by how much, and does not resolve it.
 */

const ProvenanceOut = z.object({
  source: z.string(),
  host: z.string(),
  readAt: z.string(),
  fellBackFrom: z.array(z.string()),
});

function reported(provenance: Provenance): z.infer<typeof ProvenanceOut> {
  return {
    source: provenance.upstreamId,
    host: provenance.origin,
    readAt: provenance.fetchedAt,
    fellBackFrom: provenance.fellBackFrom,
  };
}

const Address = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'A token address is 0x followed by 40 hexadecimal characters.');

async function defiReadable(): Promise<{ status: 'AVAILABLE' | 'UNAVAILABLE'; why?: string }> {
  const health = await familyHealth('defi_tvl');
  return health.some((entry) => entry.health.state === 'READY')
    ? { status: 'AVAILABLE' }
    : { status: 'UNAVAILABLE', why: 'No source of protocol data is answering.' };
}

const protocolTvl = defineCapability({
  id: 'defi.protocol_tvl',
  name: 'How much is locked in a protocol',
  description:
    'The current total value locked in a named DeFi protocol, in dollars. ' +
    'Needs the protocol by name as it is catalogued; says it does not know that one rather than guessing.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ protocol: z.string().trim().min(1).max(80) }),
  output: z.object({
    protocol: z.string(),
    tvlUsd: z.number(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 20_000,
  readiness: () => defiReadable(),
  async run(input) {
    // Lower-cased and hyphenated because that is how the catalogue keys them,
    // and a slug that does not exist is answered as not found rather than as a
    // fault of the service.
    const slug = input.protocol.toLowerCase().replace(/\s+/g, '-');
    const answer = await ask<DefiQuery, DefiAnswer>('defi_tvl', { kind: 'protocol_tvl', slug });
    return {
      protocol: slug,
      tvlUsd: answer.value.tvlUsd ?? 0,
      provenance: reported(answer.provenance),
    };
  },
});

const chainTvl = defineCapability({
  id: 'defi.chain_tvl',
  name: 'How much is locked on each chain',
  description: 'What is locked across chains, largest first, so one chain can be put in proportion to the rest.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    chain: z.string().trim().min(1).max(40).optional(),
    limit: z.number().int().min(1).max(25).default(10),
  }),
  output: z.object({
    chains: z.array(z.object({ name: z.string(), tvlUsd: z.number(), tokenSymbol: z.string().nullable() })),
    totalReported: z.number(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 20_000,
  async run(input) {
    const answer = await ask<DefiQuery, DefiAnswer>('defi_chains', { kind: 'chains' });
    const all = (answer.value.chains ?? []).slice().sort((a, b) => b.tvlUsd - a.tvlUsd);
    const wanted = input.chain
      ? all.filter((row) => row.name.toLowerCase() === input.chain!.toLowerCase())
      : all.slice(0, input.limit);
    return { chains: wanted, totalReported: all.length, provenance: reported(answer.provenance) };
  },
});

/**
 * How far apart two prices have to be before it is worth saying.
 *
 * Two per cent. Below that, pools and aggregators differ for reasons that are
 * not news -- a different set of venues, a moment's lag. Above it, somebody
 * asking what a token is worth is being told two materially different things
 * and deserves to know that rather than whichever arrived first.
 */
const DISAGREEMENT = 0.02;

const priceCheck = defineCapability({
  id: 'market.price_check',
  name: 'Check a token price against a second source',
  description:
    'What a token is worth, asked of two independent sources, with whether they agree. ' +
    'Needs the exact chain and contract address. When the sources disagree it says so and reports both, ' +
    'rather than choosing one.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    chain: z.string().trim().min(1).max(40),
    address: Address,
  }),
  output: z.object({
    chain: z.string(),
    address: z.string(),
    agree: z.boolean().nullable(),
    /** Absent when only one source could answer, which is said rather than hidden. */
    differencePercent: z.number().nullable(),
    sources: z.array(
      z.object({
        name: z.string(),
        priceUsd: z.number(),
        confidence: z.number().nullable(),
        observedAt: z.string().nullable(),
        provenance: ProvenanceOut,
      }),
    ),
    summary: z.string(),
  }),
  modelCallable: true,
  timeoutMs: 30_000,
  async run(input) {
    const sources: {
      name: string;
      priceUsd: number;
      confidence: number | null;
      observedAt: string | null;
      provenance: z.infer<typeof ProvenanceOut>;
    }[] = [];

    // Asked independently, and a failure of one is not a failure of the answer:
    // one source and a note is better than nothing, and better than pretending
    // two agreed.
    const aggregate = await ask<DefiQuery, DefiAnswer>('price_usd', {
      kind: 'price',
      chain: input.chain,
      address: input.address,
    }).catch(() => null);
    if (aggregate?.value.price) {
      sources.push({
        name: 'aggregator',
        priceUsd: aggregate.value.price.usd,
        confidence: aggregate.value.price.confidence,
        observedAt: aggregate.value.price.observedAt,
        provenance: reported(aggregate.provenance),
      });
    }

    const pools = await resolveToken(
      { address: input.address, chain: input.chain, pairAddress: null, symbol: null, fromUrl: false },
      {},
    ).catch(() => null);
    if (pools?.facts?.priceUsd) {
      sources.push({
        name: 'pools',
        priceUsd: pools.facts.priceUsd,
        confidence: null,
        observedAt: null,
        // The resolver does not carry provenance out yet, so this names what is
        // known rather than inventing an upstream id.
        provenance: { source: 'market_pairs', host: 'api.dexscreener.com', readAt: '', fellBackFrom: [] },
      });
    }

    if (sources.length === 0) {
      return {
        chain: input.chain,
        address: input.address,
        agree: null,
        differencePercent: null,
        sources: [],
        summary: 'Neither source could price that contract on that chain.',
      };
    }
    if (sources.length === 1) {
      return {
        chain: input.chain,
        address: input.address,
        agree: null,
        differencePercent: null,
        sources,
        summary: `Only one source could price it, so there is nothing to check it against.`,
      };
    }

    const [a, b] = sources as [(typeof sources)[number], (typeof sources)[number]];
    const spread = Math.abs(a.priceUsd - b.priceUsd) / Math.max(a.priceUsd, b.priceUsd);
    const agree = spread <= DISAGREEMENT;
    return {
      chain: input.chain,
      address: input.address,
      agree,
      differencePercent: Number((spread * 100).toFixed(3)),
      sources,
      summary: agree
        ? `Both sources agree, within ${(spread * 100).toFixed(2)}%.`
        : `The sources disagree by ${(spread * 100).toFixed(2)}%. ` +
          `One says ${a.priceUsd}, the other ${b.priceUsd}. Neither has been preferred.`,
    };
  },
});

export function registerDefiCapabilities(): void {
  registerCapability(protocolTvl);
  registerCapability(chainTvl);
  registerCapability(priceCheck);
}
