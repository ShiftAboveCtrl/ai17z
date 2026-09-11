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

async function readable(family: string, why: string): Promise<{ status: 'AVAILABLE' | 'UNAVAILABLE'; why?: string }> {
  const health = await familyHealth(family);
  return health.some((entry) => entry.health.state === 'READY') ? { status: 'AVAILABLE' } : { status: 'UNAVAILABLE', why };
}

async function defiReadable(): Promise<{ status: 'AVAILABLE' | 'UNAVAILABLE'; why?: string }> {
  return readable('defi_tvl', 'No source of protocol data is answering.');
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

/**
 * The only peg this can measure against.
 *
 * The source reports a price in dollars and a peg type, and those are two
 * different currencies for everything but `peggedUSD`. A euro stablecoin
 * trading at 1.08 dollars is exactly on its peg, and calling that "eight per
 * cent off" would be a fabricated alarm about a perfectly healthy asset. So
 * deviation is computed for dollar pegs and reported as unmeasurable for the
 * rest, which is the honest answer rather than the convenient one.
 */
const DOLLAR_PEG = 'peggedUSD';

const stablecoins = defineCapability({
  id: 'defi.stablecoins',
  name: 'Stablecoins, their supply and where they are trading',
  description:
    'Circulating supply and current price for stablecoins, largest first, with how far a dollar-pegged one is ' +
    'from a dollar. Can be narrowed to one by symbol. Supply is counted in each coin\'s own pegged unit, named in ' +
    'circulatingUnit, so a euro coin is counted in euros and must not be read as dollars. ' +
    'Reports observations, never a verdict on whether a coin is safe.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    /** A ticker is enough here: a stablecoin list is a catalogue, not a contract. */
    symbol: z.string().trim().min(1).max(20).optional(),
    limit: z.number().int().min(1).max(25).default(10),
  }),
  output: z.object({
    stablecoins: z.array(
      z.object({
        name: z.string(),
        symbol: z.string(),
        pegType: z.string().nullable(),
        pegMechanism: z.string().nullable(),
        /** In `circulatingUnit`, which is the coin's own peg -- not necessarily dollars. */
        circulating: z.number().nullable(),
        /**
         * What `circulating` is counted in.
         *
         * Stated rather than implied. The source counts a euro stablecoin in
         * euros and a rouble one in roubles, and 465,693,298 read as dollars
         * when it means euros is a sixteen per cent error in a figure somebody
         * might quote.
         */
        circulatingUnit: z.string().nullable(),
        priceUsd: z.number().nullable(),
        /** Null when the peg is not to the dollar, or when there is no price. */
        pegDeviationPercent: z.number().nullable(),
        /** Why a deviation could not be measured, when it could not. */
        deviationUnmeasurable: z.string().nullable(),
      }),
    ),
    totalReported: z.number(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 30_000,
  readiness: () => readable('defi_stablecoins', 'No source of stablecoin data is answering.'),
  async run(input) {
    const answer = await ask<DefiQuery, DefiAnswer>('defi_stablecoins', { kind: 'stablecoins' });
    // Ordered by supply in each coin's own unit, which mixes currencies. Every
    // alternative is worse: converting needs a rate nothing here has, and
    // ordering only the dollar ones would silently drop the rest off a list
    // that says it is every stablecoin. The list is dominated by dollar pegs,
    // and `circulatingUnit` is what stops a reader mistaking one for another.
    const all = (answer.value.stablecoins ?? []).slice().sort((a, b) => (b.circulating ?? 0) - (a.circulating ?? 0));

    const wanted = input.symbol
      ? all.filter((row) => row.symbol.toLowerCase() === input.symbol!.toLowerCase())
      : all.slice(0, input.limit);

    return {
      stablecoins: wanted.map((row) => {
        const dollarPegged = row.pegType === DOLLAR_PEG;
        const measurable = dollarPegged && typeof row.price === 'number';
        return {
          name: row.name,
          symbol: row.symbol,
          pegType: row.pegType,
          pegMechanism: row.pegMechanism,
          circulating: row.circulating,
          circulatingUnit: row.pegType,
          priceUsd: row.price,
          pegDeviationPercent: measurable ? Number(((row.price! - 1) * 100).toFixed(4)) : null,
          deviationUnmeasurable: measurable
            ? null
            : dollarPegged
              ? 'The source reported no current price for it.'
              : `Its peg is ${row.pegType ?? 'not stated'}, not the dollar, so a dollar price says nothing about it.`,
        };
      }),
      totalReported: all.length,
      provenance: reported(answer.provenance),
    };
  },
});

const stablecoinChains = defineCapability({
  id: 'defi.stablecoin_supply_by_chain',
  name: 'Where stablecoin supply sits',
  description:
    'How much stablecoin value is issued on each chain, largest first. Answers which chains actually carry ' +
    'settlement, as opposed to which have the most locked in protocols.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    chain: z.string().trim().min(1).max(40).optional(),
    limit: z.number().int().min(1).max(25).default(10),
  }),
  output: z.object({
    chains: z.array(z.object({ name: z.string(), circulatingUsd: z.number() })),
    totalReported: z.number(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 20_000,
  readiness: () => readable('defi_stablecoin_chains', 'No source of stablecoin data is answering.'),
  async run(input) {
    const answer = await ask<DefiQuery, DefiAnswer>('defi_stablecoin_chains', { kind: 'stablecoin_chains' });
    const all = (answer.value.stablecoinChains ?? []).slice().sort((a, b) => b.circulatingUsd - a.circulatingUsd);
    const wanted = input.chain
      ? all.filter((row) => row.name.toLowerCase() === input.chain!.toLowerCase())
      : all.slice(0, input.limit);
    return { chains: wanted, totalReported: all.length, provenance: reported(answer.provenance) };
  },
});

/**
 * How many daily points may reach a prompt.
 *
 * Ethereum has been measured since 2017, which is about three thousand of them.
 * Handing a model three thousand numbers to answer "is it up or down this
 * month" spends the context window on arithmetic it will do badly. The window
 * is trimmed here and the movement is computed in code, so the model gets a
 * figure it can quote rather than a series it has to reduce.
 */
const MAX_HISTORY_POINTS = 90;

const chainHistory = defineCapability({
  id: 'defi.chain_tvl_history',
  name: 'How a chain has moved',
  description:
    'Daily total value locked for one chain over a recent window, with the change across it. ' +
    'Answers whether a chain is growing or shrinking, rather than only what it is worth today.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    chain: z.string().trim().min(1).max(40),
    days: z.number().int().min(2).max(MAX_HISTORY_POINTS).default(30),
  }),
  output: z.object({
    chain: z.string(),
    points: z.array(z.object({ at: z.string(), tvlUsd: z.number() })),
    first: z.object({ at: z.string(), tvlUsd: z.number() }).nullable(),
    last: z.object({ at: z.string(), tvlUsd: z.number() }).nullable(),
    /** Null when the window has no usable start, so a change cannot be stated. */
    changePercent: z.number().nullable(),
    /** How far back the source actually goes, which is usually further than asked. */
    totalDaysAvailable: z.number(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 25_000,
  readiness: () => readable('defi_chain_history', 'No source of chain history is answering.'),
  async run(input) {
    const answer = await ask<DefiQuery, DefiAnswer>('defi_chain_history', {
      kind: 'chain_history',
      chain: input.chain,
    });
    const series = answer.value.history ?? [];
    const points = series.slice(-input.days);
    const first = points[0] ?? null;
    const last = points[points.length - 1] ?? null;
    // A start of zero is where the series begins rather than a real baseline,
    // and dividing by it produces an infinite growth figure that reads like a
    // discovery.
    const changePercent =
      first && last && first.tvlUsd > 0
        ? Number((((last.tvlUsd - first.tvlUsd) / first.tvlUsd) * 100).toFixed(3))
        : null;
    return {
      chain: input.chain,
      points,
      first,
      last,
      changePercent,
      totalDaysAvailable: series.length,
      provenance: reported(answer.provenance),
    };
  },
});

export function registerDefiCapabilities(): void {
  registerCapability(protocolTvl);
  registerCapability(chainTvl);
  registerCapability(priceCheck);
  registerCapability(stablecoins);
  registerCapability(stablecoinChains);
  registerCapability(chainHistory);
}
