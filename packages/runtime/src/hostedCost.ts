import { HOURS_PER_MONTH, type ConfidentialProvider } from '@xbam/shared';

/**
 * What a hosted tenant costs, and whether a plan clears it.
 *
 * Every figure that goes in here is measured or read from a provider's own
 * pricing interface, and carries where it came from. The reason that is a
 * structural requirement rather than good manners: a cost model assembled from
 * remembered numbers produces a plan price, and a plan price is a promise to a
 * customer that is expensive to take back.
 *
 * Two decisions are encoded and both are the owner's.
 *
 * **Planning is on a percentile, not an average.** A plan priced from the mean
 * is a plan where the ordinary heavy customer is structurally unprofitable, and
 * "ordinary heavy" is most of the ones worth having. The default is p95 and it
 * is named rather than assumed.
 *
 * **The margin target is configurable and has a default.** 60% is an
 * engineering planning figure, not a business policy, and nothing here treats
 * it as one: it arrives as an argument.
 */

// ---------------------------------------------------------------------------
// What a cost is made of
// ---------------------------------------------------------------------------

/**
 * The lines a hosted runtime actually costs money on.
 *
 * Kept as a closed list so a new cost cannot be added without appearing in the
 * ledger, which is how a significant cost gets buried: not by anybody hiding
 * it, but by it never having a line to go on.
 */
export const COST_LINES = [
  'CONFIDENTIAL_COMPUTE',
  'CONFIDENTIAL_PREMIUM',
  'PERSISTENT_DISK',
  'SNAPSHOT_STORAGE',
  'BACKUP_STORAGE',
  'BACKUP_TRANSFER',
  'NETWORK_EGRESS',
  'PUBLIC_IPV4',
  'LOAD_BALANCER',
  'GPU',
  'CONTROL_PLANE_SHARE',
  'MODEL_API',
] as const;
export type CostLine = (typeof COST_LINES)[number];

/**
 * Whether a line is a direct cost of one runtime or a share of something
 * everybody uses.
 *
 * Kept apart because a margin computed against a figure with shared overhead
 * folded into it cannot be checked: an operator asking "what does this tenant
 * cost" and an operator asking "what does the platform cost" get the same
 * number and neither is right.
 */
export const SHARED_LINES: readonly CostLine[] = ['CONTROL_PLANE_SHARE', 'LOAD_BALANCER'];

/**
 * Lines that are a customer's own spend rather than the platform's.
 *
 * `MODEL_API` is here because the initial policy is BYOK: the customer brings
 * their own provider key and the tokens are billed to them. It stays on the
 * list so that a later platform-funded option has somewhere to be metered,
 * which is the only way it gets priced separately rather than absorbed.
 */
export const BYOK_LINES: readonly CostLine[] = ['MODEL_API'];

export interface CostItem {
  line: CostLine;
  /** US dollars for the month. */
  usd: number;
  /** Where the figure came from, in enough detail to check it. */
  source: string;
  /** When it was read. A price with no date is a price somebody remembered. */
  pricedAt: string;
}

export interface RuntimeCost {
  runtimeClassId: string;
  provider: ConfidentialProvider;
  region: string;
  items: readonly CostItem[];
}

export interface CostTotals {
  /** What this one runtime costs, excluding shared lines and the customer's own spend. */
  directUsd: number;
  /** The platform's share of things every tenant uses. */
  sharedUsd: number;
  /** Billed to the customer, not to the platform. */
  byokUsd: number;
  /** Lines the model knows about and this cost has no figure for. */
  missing: readonly CostLine[];
}

/**
 * Adds a cost up, and says what is not in it.
 *
 * `missing` is the half that matters. A total with four of twelve lines filled
 * in looks exactly like a cheap tenant, and the only difference is whether
 * anybody is told.
 */
export function totalCost(cost: RuntimeCost): CostTotals {
  const present = new Set(cost.items.map((i) => i.line));
  let direct = 0;
  let shared = 0;
  let byok = 0;
  for (const item of cost.items) {
    if (BYOK_LINES.includes(item.line)) byok += item.usd;
    else if (SHARED_LINES.includes(item.line)) shared += item.usd;
    else direct += item.usd;
  }
  return {
    directUsd: round(direct),
    sharedUsd: round(shared),
    byokUsd: round(byok),
    // A line a tenant genuinely has none of still has to be stated as zero
    // rather than omitted, so an omission means unknown.
    missing: COST_LINES.filter((l) => !present.has(l)),
  };
}

const round = (n: number): number => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Planning on a percentile
// ---------------------------------------------------------------------------

/**
 * The percentile a plan is priced from.
 *
 * p95 by default. Not the mean: a plan priced from the mean is one where the
 * ordinary heavy customer loses money on every renewal, and those are most of
 * the customers worth having. Not the maximum either, because pricing for the
 * worst month anybody ever had prices the product out.
 */
export const DEFAULT_PLANNING_PERCENTILE = 95;

/**
 * The percentile of a set of observed monthly costs.
 *
 * Nearest-rank on a sorted sample, which is the definition that does not
 * invent a value between two observations: every figure this returns is one
 * somebody actually paid.
 */
export function percentileUsd(observations: readonly number[], percentile = DEFAULT_PLANNING_PERCENTILE): number | null {
  const sample = observations.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (sample.length === 0) return null;
  const rank = Math.ceil((percentile / 100) * sample.length);
  return sample[Math.min(sample.length - 1, Math.max(0, rank - 1))]!;
}

export interface PlanningInput {
  /** One monthly direct cost per observed tenant-month. */
  observations: readonly number[];
  percentile?: number;
  /** 0.6 is the engineering default and is not a business policy. */
  targetGrossMargin: number;
}

export type PlanningVerdict =
  | {
      ok: true;
      percentile: number;
      p95DirectUsd: number;
      minimumRetailUsd: number;
      /** How many tenant-months this rests on. */
      sampleSize: number;
      /**
       * Present when the sample is too small for the percentile to mean what
       * it says, which is not an error and is not nothing either.
       */
      weak?: string;
      detail: string;
    }
  | { ok: false; why: string };

/**
 * How many observations a percentile needs before it is distinguishable from
 * the maximum.
 *
 * Nearest-rank picks `ceil(p/100 * n)`, so p95 on fewer than twenty samples is
 * the largest value in the set. That is not wrong, it is just not a
 * percentile: pricing from three tenant-months at p95 is pricing from the
 * worst month anybody has had, which prices the product out rather than
 * protecting it.
 */
export function minimumSampleFor(percentile: number): number {
  if (percentile <= 0 || percentile >= 100) return 1;
  return Math.ceil(100 / (100 - percentile));
}

/**
 * The least a plan may be sold for and still clear the target margin.
 *
 * `cost / (1 - margin)`, on the percentile rather than the mean. Refuses
 * rather than guessing where there is nothing to compute from, because the
 * failure mode of a pricing function that returns something anyway is a price.
 */
export function minimumRetailUsd(input: PlanningInput): PlanningVerdict {
  const percentile = input.percentile ?? DEFAULT_PLANNING_PERCENTILE;
  if (input.targetGrossMargin < 0 || input.targetGrossMargin >= 1) {
    return { ok: false, why: 'A target gross margin is a fraction below one. At one, the price is infinite.' };
  }
  const cost = percentileUsd(input.observations, percentile);
  if (cost === null) {
    return {
      ok: false,
      why: 'There are no observed tenant-months to price from. A plan priced before anything was measured is a plan priced from a guess.',
    };
  }
  const minimum = cost / (1 - input.targetGrossMargin);
  const needed = minimumSampleFor(percentile);
  const sampleSize = input.observations.filter((n) => Number.isFinite(n)).length;
  return {
    ok: true,
    percentile,
    p95DirectUsd: round(cost),
    minimumRetailUsd: round(minimum),
    sampleSize,
    weak:
      sampleSize < needed
        ? `p${percentile} needs at least ${needed} tenant-months to be distinguishable from the maximum, and this rests on ${sampleSize}. The figure is the worst month observed rather than a percentile of them.`
        : undefined,
    detail: `p${percentile} direct cost across ${sampleSize} tenant-month(s) is $${round(cost)}, so $${round(minimum)} is the least that clears a ${Math.round(input.targetGrossMargin * 100)}% margin.`,
  };
}

// ---------------------------------------------------------------------------
// Refusing to provision something structurally unprofitable
// ---------------------------------------------------------------------------

export interface PlanEconomics {
  planId: string;
  /** What the customer pays each month. */
  retailUsd: number;
  /** What this runtime class is expected to cost, from the ledger. */
  expectedDirectUsd: number;
  targetGrossMargin: number;
}

export type ProfitabilityVerdict =
  | { ok: true; marginPercent: number; detail: string }
  | { ok: false; marginPercent: number; why: string; suggestion: string };

/**
 * Whether provisioning this would lose money by construction.
 *
 * Checked before a runtime exists, for the same reason the entitlement is: a
 * reconciliation that finds a loss-making tenant has already given somebody a
 * machine. Refusing names what would have to change rather than only saying
 * no, because an operator reading this is deciding between a different SKU, a
 * different region and a commercial conversation.
 */
export function judgePlanEconomics(plan: PlanEconomics): ProfitabilityVerdict {
  if (plan.retailUsd <= 0) {
    return {
      ok: false,
      marginPercent: -Infinity,
      why: 'This plan has no price, so every runtime on it is a cost with no revenue against it.',
      suggestion: 'Price the plan, or mark it internal so it is not counted as revenue.',
    };
  }
  const margin = (plan.retailUsd - plan.expectedDirectUsd) / plan.retailUsd;
  const percent = Math.round(margin * 1000) / 10;
  if (margin >= plan.targetGrossMargin) {
    return { ok: true, marginPercent: percent, detail: `$${plan.retailUsd} against $${plan.expectedDirectUsd} is ${percent}%.` };
  }
  const needed = round(plan.expectedDirectUsd / (1 - plan.targetGrossMargin));
  const headroom = round(plan.retailUsd * (1 - plan.targetGrossMargin));
  return {
    ok: false,
    marginPercent: percent,
    why: `$${plan.retailUsd} against an expected $${plan.expectedDirectUsd} is ${percent}%, below the ${Math.round(plan.targetGrossMargin * 100)}% target.`,
    suggestion:
      margin < 0
        ? `This loses money on every month. The plan needs $${needed}, or a runtime class costing under $${headroom}.`
        : `Either the plan needs $${needed}, or a runtime class costing under $${headroom}, or somebody decides this plan runs thinner on purpose.`,
  };
}

/**
 * A runtime-class cost from its own measured pieces.
 *
 * Takes hourly compute and monthly everything-else, because that is the shape
 * providers quote in and converting at the call site is how two call sites
 * disagree about how long a month is.
 */
export function monthlyRuntimeCost(input: {
  runtimeClassId: string;
  provider: ConfidentialProvider;
  region: string;
  computePerHourUsd: number;
  confidentialPremiumPerHourUsd?: number;
  diskUsd?: number;
  backupStorageUsd?: number;
  backupTransferUsd?: number;
  egressUsd?: number;
  publicIpUsd?: number;
  gpuUsd?: number;
  controlPlaneShareUsd?: number;
  source: string;
  pricedAt: string;
}): RuntimeCost {
  const at = input.pricedAt;
  const src = input.source;
  const items: CostItem[] = [
    { line: 'CONFIDENTIAL_COMPUTE', usd: round(input.computePerHourUsd * HOURS_PER_MONTH), source: src, pricedAt: at },
    {
      line: 'CONFIDENTIAL_PREMIUM',
      usd: round((input.confidentialPremiumPerHourUsd ?? 0) * HOURS_PER_MONTH),
      source: input.confidentialPremiumPerHourUsd ? src : `${src} (this provider charges no separate premium)`,
      pricedAt: at,
    },
    { line: 'PERSISTENT_DISK', usd: round(input.diskUsd ?? 0), source: src, pricedAt: at },
    { line: 'SNAPSHOT_STORAGE', usd: 0, source: `${src} (no snapshots are taken yet)`, pricedAt: at },
    { line: 'BACKUP_STORAGE', usd: round(input.backupStorageUsd ?? 0), source: src, pricedAt: at },
    { line: 'BACKUP_TRANSFER', usd: round(input.backupTransferUsd ?? 0), source: src, pricedAt: at },
    { line: 'NETWORK_EGRESS', usd: round(input.egressUsd ?? 0), source: src, pricedAt: at },
    { line: 'PUBLIC_IPV4', usd: round(input.publicIpUsd ?? 0), source: src, pricedAt: at },
    { line: 'LOAD_BALANCER', usd: 0, source: `${src} (not attributed per runtime)`, pricedAt: at },
    { line: 'GPU', usd: round(input.gpuUsd ?? 0), source: `${src} (no plan requires one)`, pricedAt: at },
    { line: 'CONTROL_PLANE_SHARE', usd: round(input.controlPlaneShareUsd ?? 0), source: src, pricedAt: at },
    { line: 'MODEL_API', usd: 0, source: 'BYOK: the customer own provider key, so tokens are billed to them', pricedAt: at },
  ];
  return { runtimeClassId: input.runtimeClassId, provider: input.provider, region: input.region, items };
}

export const COST_CAVEATS: readonly string[] = [
  'Every figure carries where it came from and when it was read. A price with no date is a price somebody remembered.',
  'A line a tenant has none of is recorded as zero rather than omitted, so an omission means unknown and the total says which lines are missing.',
  'Shared overhead is kept apart from direct runtime cost. A margin computed against the two folded together cannot be checked.',
  'Planning is on a percentile and p95 is the default. A plan priced from the mean loses money on the ordinary heavy customer, who is most of the ones worth having.',
  'The 60% margin target is an engineering planning figure, not a business policy, and arrives as an argument rather than a constant.',
  'Model API cost is BYOK and billed to the customer. It keeps a line so a later platform-funded option is metered separately rather than absorbed.',
  'A percentile needs enough observations to be one. p95 on fewer than twenty tenant-months is the maximum wearing a percentile name, and minimumRetailUsd says so rather than letting it pass as one.',
  'No tenant has been billed and no plan has been priced. The observations list is empty, and minimumRetailUsd refuses rather than returning a number.',
];
