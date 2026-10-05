import { describe, expect, it } from 'vitest';

import { HOURS_PER_MONTH, SMALLEST_CONFIDENTIAL_VCPUS } from '@xbam/shared/contracts';
import {
  COMMITMENT_USD,
  CONFIDENTIAL_SKUS,
  MEASURED_TENANT_FOOTPRINT,
  PRICE_STALE_AFTER_DAYS,
  REGION_SPREAD,
  SKU_CAVEATS,
  computeFloor,
  pricesStillCount,
  skusForTenant,
} from '@xbam/runtime';

const PRICED_AT = new Date(CONFIDENTIAL_SKUS[0]!.pricedAt);
const after = (days: number): Date => new Date(PRICED_AT.getTime() + days * 86_400_000);
/** Within both windows: the prices and the footprint measurement. */
const SOON = new Date(Math.max(PRICED_AT.getTime(), Date.parse(MEASURED_TENANT_FOOTPRINT.measuredAt)) + 86_400_000);

describe('the confidential sizes that exist', () => {
  it('carries a date and a source on every price, so one can go stale', () => {
    for (const sku of CONFIDENTIAL_SKUS) {
      expect(Number.isNaN(Date.parse(sku.pricedAt)), sku.sku).toBe(false);
      expect(sku.priceSource.length, sku.sku).toBeGreaterThan(10);
    }
  });

  it('has nothing smaller than the smallest confidential size', () => {
    for (const sku of CONFIDENTIAL_SKUS) {
      expect(sku.vcpus, sku.sku).toBeGreaterThanOrEqual(SMALLEST_CONFIDENTIAL_VCPUS);
    }
  });

  it('names the provider SKU verbatim rather than a label somebody chose', () => {
    for (const sku of CONFIDENTIAL_SKUS) expect(sku.sku).toMatch(/^Standard_DC\d+[ae]s_v\d$/);
  });

  it('records both TEEs, because the choice is not made by brand', () => {
    const tees = new Set(CONFIDENTIAL_SKUS.map((s) => s.tee));
    expect(tees.has('AMD_SEV_SNP')).toBe(true);
    expect(tees.has('INTEL_TDX')).toBe(true);
  });
});

describe('which size holds a tenant', () => {
  it('the smallest confidential size does, which is what the economics rest on', () => {
    const rows = skusForTenant(MEASURED_TENANT_FOOTPRINT, SOON);
    const smallest = rows.find((r) => r.sku.sku === 'Standard_DC2as_v5');
    expect(smallest?.fits).toBe(true);
  });

  it('returns the sizes that do not fit as well, with their reasons', () => {
    // "The smallest one that works" means nothing without the ones that do
    // not, so a caller gets the whole list rather than a filtered one.
    const rows = skusForTenant(MEASURED_TENANT_FOOTPRINT, SOON);
    expect(rows).toHaveLength(CONFIDENTIAL_SKUS.length);
    for (const row of rows) expect(row.why.length, row.sku.sku).toBeGreaterThan(20);
  });

  it('prices a month as the hours this project states once', () => {
    const rows = skusForTenant(MEASURED_TENANT_FOOTPRINT, SOON);
    const smallest = rows.find((r) => r.sku.sku === 'Standard_DC2as_v5')!;
    expect(smallest.monthlyUsd).toBeCloseTo(0.086 * HOURS_PER_MONTH, 2);
  });
});

describe('the compute floor', () => {
  it('is the cheapest size that holds a tenant, and says it is compute only', () => {
    const floor = computeFloor(MEASURED_TENANT_FOOTPRINT, SOON);
    expect(floor.known).toBe(true);
    if (!floor.known) return;
    expect(floor.sku).toBe('Standard_DC2as_v5');
    expect(floor.cheapestMonthlyUsd).toBeCloseTo(62.78, 1);
    expect(floor.why).toContain('Compute only');
  });

  it('refuses rather than guessing when nothing holds a tenant', () => {
    const vast = { ...MEASURED_TENANT_FOOTPRINT, memoryMb: 1_000_000 };
    const floor = computeFloor(vast, SOON);
    expect(floor.known).toBe(false);
    if (floor.known) return;
    expect(floor.why).toContain('No confidential size holds a tenant');
  });

  it('refuses when there are no sizes at all', () => {
    expect(computeFloor(MEASURED_TENANT_FOOTPRINT, SOON, []).known).toBe(false);
  });

  it('refuses once the measurement it is sizing against has gone stale', () => {
    const late = new Date(Date.parse(MEASURED_TENANT_FOOTPRINT.measuredAt) + 400 * 86_400_000);
    expect(computeFloor(MEASURED_TENANT_FOOTPRINT, late).known).toBe(false);
  });
});

describe('whether the prices still count', () => {
  it('counts them while they are fresh, and says how old they are', () => {
    const verdict = pricesStillCount(after(1));
    expect(verdict.usable).toBe(true);
    if (!verdict.usable) return;
    expect(verdict.days).toBe(1);
  });

  it('refuses them past the window rather than planning from them', () => {
    const verdict = pricesStillCount(after(PRICE_STALE_AFTER_DAYS + 1));
    expect(verdict.usable).toBe(false);
    if (verdict.usable) return;
    expect(verdict.why).toContain('Read them again');
  });

  it('is decided by the oldest row, not the newest', () => {
    const mixed = [
      { ...CONFIDENTIAL_SKUS[0]!, pricedAt: after(0).toISOString() },
      { ...CONFIDENTIAL_SKUS[1]!, pricedAt: after(-400).toISOString() },
    ];
    const verdict = pricesStillCount(after(1), mixed);
    expect(verdict.usable).toBe(false);
    if (verdict.usable) return;
    expect(verdict.why).toContain(CONFIDENTIAL_SKUS[1]!.sku);
  });

  it('refuses a price dated in the future', () => {
    expect(pricesStillCount(after(-2)).usable).toBe(false);
  });
});

describe('what the spread and the commitment say', () => {
  it('records a cheapest and a dearest region, because a margin moves with geography', () => {
    const monthly = REGION_SPREAD.map((r) => r.monthlyUsd);
    expect(Math.min(...monthly)).toBeCloseTo(40.59, 2);
    expect(Math.max(...monthly)).toBeCloseTo(89.79, 2);
  });

  it('has a three-year commitment well below on demand, which is a different business', () => {
    expect(COMMITMENT_USD.threeYearMonthly).toBeLessThan(COMMITMENT_USD.onDemandMonthly * 0.7);
    expect(COMMITMENT_USD.threeYearMonthly * 36).toBeCloseTo(COMMITMENT_USD.threeYearTotal, 0);
  });

  it('keeps the on-demand figure beside the commitment rather than instead of it', () => {
    // The commitment is the number that cannot be taken back.
    expect(COMMITMENT_USD.onDemandMonthly).toBeGreaterThan(COMMITMENT_USD.oneYearMonthly);
    expect(COMMITMENT_USD.oneYearMonthly).toBeGreaterThan(COMMITMENT_USD.threeYearMonthly);
  });
});

describe('what this is not', () => {
  it('says these are costs and not prices', () => {
    expect(SKU_CAVEATS.join(' ')).toContain('costs, not prices');
  });

  it('says it is compute only and names what is missing', () => {
    const all = SKU_CAVEATS.join(' ');
    expect(all).toContain('Compute only');
    for (const line of ['Disk', 'egress', 'backup', 'control plane']) expect(all).toContain(line);
  });

  it('says none of these has been paid', () => {
    expect(SKU_CAVEATS.join(' ')).toContain('none of these has been paid');
  });

  it("says Google's all-in figure is absent and why", () => {
    expect(SKU_CAVEATS.join(' ')).toContain('billing catalog credential');
  });
});
