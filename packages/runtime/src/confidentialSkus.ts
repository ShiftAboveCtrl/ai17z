/**
 * The confidential sizes that exist, with what each one costs.
 *
 * These figures were in `CONFIDENTIAL_COMPUTE.md` as a table and nowhere else,
 * which meant AI17Z had never computed a cost: `monthlyRuntimeCost` had no SKU
 * to work from, and a price in prose is a price nobody can check against a
 * measurement. Here they are data, each carrying when it was read and from
 * where, so `pricedAt` can go stale and say so rather than quietly ageing.
 *
 * **Nothing here is a price for a customer.** It is what the compute costs,
 * which is one line of the ledger in `hostedCost.ts` and the only line big
 * enough to decide the shape of a plan. `minimumRetailUsd` still refuses to
 * price from a sample too small to be a percentile, and no plan has been
 * priced.
 *
 * Read from the Azure retail prices API on 2026-10-05, `eastus`, Linux,
 * consumption, unless the row says otherwise. Google is deliberately absent
 * except as a premium: its all-in figure needs a Cloud Billing Catalog
 * credential this repository does not have, and reciting instance prices from
 * memory is the thing all of this is arranged to avoid.
 */
import {
  HOURS_PER_MONTH,
  SMALLEST_CONFIDENTIAL_VCPUS,
  monthlyComputeUsd,
  type ConfidentialSku,
} from '@xbam/shared/contracts';

import { MEASURED_TENANT_FOOTPRINT, sizeHoldsTenant, type TenantFootprint } from './tenantFootprint';

const AZURE_PRICES_READ_AT = '2026-10-05T00:00:00.000Z';
const AZURE_SOURCE = 'Azure retail prices API, eastus, Linux, consumption';

/**
 * The sizes, as read.
 *
 * `memoryMb` comes from the size's published shape rather than from the price
 * API, which prices a size and does not describe it. The DC*as_v5 family is
 * four gigabytes a vCPU.
 */
export const CONFIDENTIAL_SKUS: readonly ConfidentialSku[] = [
  {
    provider: 'AZURE',
    sku: 'Standard_DC2as_v5',
    tee: 'AMD_SEV_SNP',
    vcpus: 2,
    memoryMb: 8_192,
    localDiskGb: null,
    region: 'eastus',
    pricePerHourUsd: 0.086,
    confidentialPremiumPerHourUsd: 0,
    pricedAt: AZURE_PRICES_READ_AT,
    priceSource: AZURE_SOURCE,
  },
  {
    provider: 'AZURE',
    sku: 'Standard_DC4as_v5',
    tee: 'AMD_SEV_SNP',
    vcpus: 4,
    memoryMb: 16_384,
    localDiskGb: null,
    region: 'eastus',
    pricePerHourUsd: 0.172,
    confidentialPremiumPerHourUsd: 0,
    pricedAt: AZURE_PRICES_READ_AT,
    priceSource: AZURE_SOURCE,
  },
  {
    provider: 'AZURE',
    sku: 'Standard_DC8as_v5',
    tee: 'AMD_SEV_SNP',
    vcpus: 8,
    memoryMb: 32_768,
    localDiskGb: null,
    region: 'eastus',
    pricePerHourUsd: 0.344,
    confidentialPremiumPerHourUsd: 0,
    pricedAt: AZURE_PRICES_READ_AT,
    priceSource: AZURE_SOURCE,
  },
  {
    provider: 'AZURE',
    sku: 'Standard_DC2es_v6',
    tee: 'INTEL_TDX',
    vcpus: 2,
    memoryMb: 8_192,
    localDiskGb: null,
    region: 'eastus',
    pricePerHourUsd: 0.111,
    confidentialPremiumPerHourUsd: 0,
    pricedAt: AZURE_PRICES_READ_AT,
    priceSource: AZURE_SOURCE,
  },
  {
    provider: 'AZURE',
    sku: 'Standard_DC4es_v6',
    tee: 'INTEL_TDX',
    vcpus: 4,
    memoryMb: 16_384,
    localDiskGb: null,
    region: 'eastus',
    pricePerHourUsd: 0.222,
    confidentialPremiumPerHourUsd: 0,
    pricedAt: AZURE_PRICES_READ_AT,
    priceSource: AZURE_SOURCE,
  },
];

/**
 * What the same size costs elsewhere, which is the spread a plan has to survive.
 *
 * One size across the regions the price API lists, because a plan sold at one
 * price and served from whichever region a customer is near is a plan whose
 * margin moves with geography. The cheapest and dearest are what matter;
 * the middle is in the document.
 */
export const REGION_SPREAD: readonly { region: string; monthlyUsd: number; note: string }[] = [
  { region: 'centralindia', monthlyUsd: 40.59, note: 'the cheapest of the 18 regions the API lists' },
  { region: 'eastus', monthlyUsd: 62.78, note: 'the region everything else here is priced in' },
  { region: 'northeurope', monthlyUsd: 70.08, note: 'typical of Europe' },
  { region: 'switzerlandnorth', monthlyUsd: 89.79, note: 'the dearest' },
];

/**
 * What a commitment buys, for `Standard_DC2as_v5` in `eastus`.
 *
 * It matters more than any other number here: three years takes the floor from
 * $62.78 to $37.67, which is a different business. It is also the number that
 * cannot be taken back, so it belongs beside the on-demand figure rather than
 * instead of it.
 */
export const COMMITMENT_USD = {
  onDemandMonthly: 62.78,
  oneYearTotal: 603.0,
  oneYearMonthly: 50.25,
  threeYearTotal: 1_356.0,
  threeYearMonthly: 37.67,
} as const;

/**
 * Google's SEV-SNP premium, which is all this repository can honestly say.
 *
 * Small, and on top of the N2D instance price, which is not recorded because
 * getting it needs a Cloud Billing Catalog credential. A total built from this
 * premium and a remembered instance price would look like a measurement.
 */
export const GOOGLE_SEV_SNP_PREMIUM_PER_VCPU_HOUR_USD = 0.0027502;

export interface SkuForTenant {
  sku: ConfidentialSku;
  monthlyUsd: number;
  /** Whether the measured tenant fits, and why. */
  fits: boolean;
  why: string;
}

/**
 * Which sizes hold one measured tenant, and what each costs a month.
 *
 * Judged by `sizeHoldsTenant` rather than by comparing numbers here, so the
 * headroom is applied in one place and a size is refused rather than trimmed
 * to fit. The list is returned whole, including the sizes that do not fit,
 * because "the smallest one that works" is only meaningful next to the ones
 * that do not.
 */
export function skusForTenant(
  footprint: TenantFootprint = MEASURED_TENANT_FOOTPRINT,
  now: Date = new Date(),
  skus: readonly ConfidentialSku[] = CONFIDENTIAL_SKUS,
): readonly SkuForTenant[] {
  return skus.map((sku) => {
    const verdict = sizeHoldsTenant({ vcpus: sku.vcpus, memoryMb: sku.memoryMb }, footprint, now);
    return { sku, monthlyUsd: monthlyComputeUsd(sku), fits: verdict.fits, why: verdict.why };
  });
}

export type FloorVerdict =
  | { known: true; cheapestMonthlyUsd: number; sku: string; why: string }
  | { known: false; why: string };

/**
 * The compute floor for one tenant: the cheapest size that holds it.
 *
 * Refuses rather than guessing when nothing fits or the measurement has gone
 * stale, because a floor is the number a plan is built on and a wrong one is
 * worse than none. It is compute only: no disk, no egress, no backup storage,
 * no control-plane share, all of which are lines in `hostedCost.ts`.
 */
export function computeFloor(
  footprint: TenantFootprint = MEASURED_TENANT_FOOTPRINT,
  now: Date = new Date(),
  skus: readonly ConfidentialSku[] = CONFIDENTIAL_SKUS,
): FloorVerdict {
  const held = skusForTenant(footprint, now, skus).filter((row) => row.fits);
  if (held.length === 0) {
    const first = skusForTenant(footprint, now, skus)[0];
    return {
      known: false,
      why: first ? `No confidential size holds a tenant: ${first.why}` : 'There are no confidential sizes recorded.',
    };
  }
  const cheapest = held.reduce((best, row) => (row.monthlyUsd < best.monthlyUsd ? row : best));
  return {
    known: true,
    cheapestMonthlyUsd: cheapest.monthlyUsd,
    sku: cheapest.sku.sku,
    why: `${cheapest.sku.sku}, ${cheapest.sku.vcpus} vCPU and ${cheapest.sku.memoryMb} MB, at $${cheapest.monthlyUsd.toFixed(2)} a month on demand in ${cheapest.sku.region}. Compute only. ${cheapest.why}`,
  };
}

/** How old a price may be before it stops counting as one. */
export const PRICE_STALE_AFTER_DAYS = 90;

export type PriceAgeVerdict = { usable: true; days: number } | { usable: false; why: string };

/**
 * Whether these prices are still worth believing.
 *
 * Cloud prices move, and a figure read once and carried for a year is the
 * thing `CONFIDENTIAL_COMPUTE.md` says it exists to avoid. The oldest row
 * decides, because a plan built from the set is only as current as its worst
 * member.
 */
export function pricesStillCount(now: Date = new Date(), skus: readonly ConfidentialSku[] = CONFIDENTIAL_SKUS): PriceAgeVerdict {
  if (skus.length === 0) return { usable: false, why: 'There are no prices recorded.' };
  const oldest = skus.reduce((worst, sku) => (Date.parse(sku.pricedAt) < Date.parse(worst.pricedAt) ? sku : worst));
  const at = Date.parse(oldest.pricedAt);
  if (Number.isNaN(at)) return { usable: false, why: `${oldest.sku} has no usable date on its price.` };
  const days = Math.floor((now.getTime() - at) / 86_400_000);
  if (days < 0) return { usable: false, why: 'A price is dated in the future, which means a clock somewhere is wrong.' };
  if (days > PRICE_STALE_AFTER_DAYS) {
    return { usable: false, why: `${oldest.sku}'s price is ${days} days old, past ${PRICE_STALE_AFTER_DAYS}. Read them again rather than planning from these.` };
  }
  return { usable: true, days };
}

export const SKU_CAVEATS: readonly string[] = [
  'These are costs, not prices. No plan has been priced and no price has been published.',
  'Compute only. Disk, egress, backup storage, the public address and the control plane are separate lines in hostedCost.ts and none of them is zero.',
  `The smallest confidential size anywhere is ${SMALLEST_CONFIDENTIAL_VCPUS} vCPU, so a tenant runtime costs at least one of these whether the agent needs it or not.`,
  `A month here is ${HOURS_PER_MONTH} hours of being switched on. A runtime an owner pauses costs less and a plan may not assume they will.`,
  'Google is absent except as a premium, because its all-in figure needs a billing catalog credential this repository does not have.',
  'No confidential VM has been provisioned, so none of these has been paid.',
];
