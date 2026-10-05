import { describe, expect, it } from 'vitest';
import {
  BYOK_LINES,
  COST_CAVEATS,
  COST_LINES,
  DEFAULT_PLANNING_PERCENTILE,
  SHARED_LINES,
  judgePlanEconomics,
  minimumRetailUsd,
  minimumSampleFor,
  monthlyRuntimeCost,
  percentileUsd,
  totalCost,
} from '@xbam/runtime';
import { HOURS_PER_MONTH } from '@xbam/shared';

/**
 * Whether a plan clears what a tenant costs.
 *
 * The two things worth a test each are the ones that turn into a price: a
 * total that quietly omits lines reads exactly like a cheap tenant, and a plan
 * priced from an average loses money on the ordinary heavy customer.
 */

/** The measured Azure figure: Standard_DC2as_v5, eastus, Linux, on demand. */
const DC2AS_V5_PER_HOUR = 0.086;
const PRICED_AT = '2026-10-05T00:00:00.000Z';
const SOURCE = 'Azure retail prices API, eastus, Linux, consumption, read 2026-10-05';

describe('a total says what is not in it', () => {
  it('adds the lines up and separates direct from shared and BYOK', () => {
    const cost = monthlyRuntimeCost({
      runtimeClassId: 'standard',
      provider: 'AZURE',
      region: 'eastus',
      computePerHourUsd: DC2AS_V5_PER_HOUR,
      diskUsd: 4.8,
      backupStorageUsd: 1.2,
      egressUsd: 2,
      controlPlaneShareUsd: 3,
      source: SOURCE,
      pricedAt: PRICED_AT,
    });
    const totals = totalCost(cost);
    // Compute alone is the measured figure, and the direct total adds the rest.
    expect(totals.directUsd).toBeCloseTo(0.086 * HOURS_PER_MONTH + 4.8 + 1.2 + 2, 1);
    expect(totals.sharedUsd).toBeCloseTo(3, 2);
    expect(totals.byokUsd).toBe(0);
  });

  it('names every line it has no figure for', () => {
    /*
      A total with four of twelve lines filled in looks exactly like a cheap
      tenant. The only difference is whether anybody is told.
    */
    const totals = totalCost({
      runtimeClassId: 'standard',
      provider: 'AZURE',
      region: 'eastus',
      items: [{ line: 'CONFIDENTIAL_COMPUTE', usd: 62.78, source: SOURCE, pricedAt: PRICED_AT }],
    });
    expect(totals.directUsd).toBeCloseTo(62.78, 2);
    expect(totals.missing.length).toBe(COST_LINES.length - 1);
    expect(totals.missing).toContain('NETWORK_EGRESS');
    expect(totals.missing).toContain('BACKUP_STORAGE');
  });

  it('records a line a tenant has none of as zero rather than leaving it out', () => {
    const cost = monthlyRuntimeCost({
      runtimeClassId: 'standard',
      provider: 'AZURE',
      region: 'eastus',
      computePerHourUsd: DC2AS_V5_PER_HOUR,
      source: SOURCE,
      pricedAt: PRICED_AT,
    });
    // Twelve lines present, so `missing` is empty and an omission would mean
    // unknown rather than none.
    expect(totalCost(cost).missing).toEqual([]);
    expect(cost.items.find((i) => i.line === 'GPU')?.usd).toBe(0);
    expect(cost.items.find((i) => i.line === 'GPU')?.source).toContain('no plan requires one');
  });

  it('says where a figure came from and when, on every line', () => {
    const cost = monthlyRuntimeCost({
      runtimeClassId: 'standard',
      provider: 'AZURE',
      region: 'eastus',
      computePerHourUsd: DC2AS_V5_PER_HOUR,
      source: SOURCE,
      pricedAt: PRICED_AT,
    });
    for (const item of cost.items) {
      expect(item.source.length, item.line).toBeGreaterThan(10);
      expect(Number.isFinite(Date.parse(item.pricedAt)), item.line).toBe(true);
    }
  });

  it('bills model tokens to the customer, and keeps the line', () => {
    // So a later platform-funded option is metered separately rather than
    // absorbed into a compute subscription.
    expect(BYOK_LINES).toContain('MODEL_API');
    expect(COST_LINES).toContain('MODEL_API');
    const cost = monthlyRuntimeCost({
      runtimeClassId: 'standard',
      provider: 'AZURE',
      region: 'eastus',
      computePerHourUsd: DC2AS_V5_PER_HOUR,
      source: SOURCE,
      pricedAt: PRICED_AT,
    });
    expect(cost.items.find((i) => i.line === 'MODEL_API')?.source).toContain('BYOK');
  });

  it('keeps shared overhead out of the direct figure', () => {
    expect(SHARED_LINES).toContain('CONTROL_PLANE_SHARE');
    const totals = totalCost({
      runtimeClassId: 'standard',
      provider: 'AZURE',
      region: 'eastus',
      items: [
        { line: 'CONFIDENTIAL_COMPUTE', usd: 62.78, source: SOURCE, pricedAt: PRICED_AT },
        { line: 'CONTROL_PLANE_SHARE', usd: 10, source: SOURCE, pricedAt: PRICED_AT },
      ],
    });
    expect(totals.directUsd).toBeCloseTo(62.78, 2);
    expect(totals.sharedUsd).toBe(10);
  });
});

describe('planning on a percentile', () => {
  it('defaults to p95 rather than an average', () => {
    expect(DEFAULT_PLANNING_PERCENTILE).toBe(95);
  });

  it('returns a figure somebody actually paid', () => {
    // Nearest-rank, so nothing is invented between two observations.
    const observed = [10, 20, 30, 40, 100];
    expect(percentileUsd(observed, 95)).toBe(100);
    expect(percentileUsd(observed, 50)).toBe(30);
    expect(observed).toContain(percentileUsd(observed, 80));
  });

  it('refuses rather than returning a number when nothing has been measured', () => {
    /*
      The failure mode of a pricing function that answers anyway is a price,
      and a price is a promise that is expensive to take back.
    */
    const out = minimumRetailUsd({ observations: [], targetGrossMargin: 0.6 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.why).toContain('priced from a guess');
  });

  it('computes the least that clears the target', () => {
    // The owner's own worked example: $20 at 60% is $50.
    const out = minimumRetailUsd({ observations: [20], targetGrossMargin: 0.6 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.minimumRetailUsd).toBeCloseTo(50, 2);
  });

  it('prices from the heavy end rather than the middle', () => {
    /*
      Forty tenant-months: thirty quiet, ten heavy. The mean is about 26 and
      the p95 is 60, and the price follows the customer who would otherwise
      lose money on every renewal.
    */
    const observed = [...Array.from({ length: 30 }, () => 15), ...Array.from({ length: 10 }, () => 60)];
    const out = minimumRetailUsd({ observations: observed, targetGrossMargin: 0.6 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.p95DirectUsd).toBe(60);
    expect(out.minimumRetailUsd).toBeCloseTo(150, 1);
    expect(out.weak).toBeUndefined();
  });

  it('says when a percentile rests on too few months to be one', () => {
    /*
      Nearest-rank picks ceil(p/100 * n), so p95 on fewer than twenty samples
      is the largest value in the set. That is not wrong, it is just not a
      percentile, and pricing from three tenant-months at p95 prices the
      product out rather than protecting it.
    */
    const out = minimumRetailUsd({ observations: [10, 20, 90], targetGrossMargin: 0.6 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.sampleSize).toBe(3);
    expect(out.p95DirectUsd).toBe(90);
    expect(out.weak).toContain('distinguishable from the maximum');
  });

  it('knows how many months each percentile needs', () => {
    expect(minimumSampleFor(95)).toBe(20);
    expect(minimumSampleFor(99)).toBe(100);
    expect(minimumSampleFor(50)).toBe(2);
  });

  it('refuses a margin of one or more, where the price is infinite', () => {
    expect(minimumRetailUsd({ observations: [20], targetGrossMargin: 1 }).ok).toBe(false);
    expect(minimumRetailUsd({ observations: [20], targetGrossMargin: 1.5 }).ok).toBe(false);
    expect(minimumRetailUsd({ observations: [20], targetGrossMargin: -0.1 }).ok).toBe(false);
  });

  it('takes the margin as an argument, so it is not a policy in the code', () => {
    const sixty = minimumRetailUsd({ observations: [20], targetGrossMargin: 0.6 });
    const thirty = minimumRetailUsd({ observations: [20], targetGrossMargin: 0.3 });
    expect(sixty.ok && thirty.ok).toBe(true);
    if (!sixty.ok || !thirty.ok) return;
    expect(sixty.minimumRetailUsd).toBeGreaterThan(thirty.minimumRetailUsd);
  });
});

describe('refusing to provision a loss', () => {
  it('allows a plan that clears the target', () => {
    const out = judgePlanEconomics({ planId: 'standard', retailUsd: 199, expectedDirectUsd: 62.78, targetGrossMargin: 0.6 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.marginPercent).toBeGreaterThan(60);
  });

  it('refuses one below it, and says what would have to change', () => {
    // An operator reading this is choosing between a SKU, a region and a
    // commercial conversation, so "no" on its own is not enough.
    const out = judgePlanEconomics({ planId: 'cheap', retailUsd: 99, expectedDirectUsd: 62.78, targetGrossMargin: 0.6 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.suggestion).toContain('$156.95');
    expect(out.suggestion).toContain('under $39.6');
  });

  it('says plainly when a plan loses money on every month', () => {
    const out = judgePlanEconomics({ planId: 'underwater', retailUsd: 29, expectedDirectUsd: 62.78, targetGrossMargin: 0.6 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.marginPercent).toBeLessThan(0);
    expect(out.suggestion).toContain('loses money on every month');
  });

  it('refuses a plan with no price at all', () => {
    const out = judgePlanEconomics({ planId: 'free', retailUsd: 0, expectedDirectUsd: 62.78, targetGrossMargin: 0.6 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.why).toContain('no price');
    expect(out.suggestion).toContain('mark it internal');
  });

  it('is checked against the measured confidential floor, not an invented one', () => {
    /*
      $62.78 is Standard_DC2as_v5 in eastus on demand, which is the smallest
      confidential VM Azure sells. A plan under about $157 does not clear 60%
      on compute alone, before disk, egress or backup.
    */
    const floor = judgePlanEconomics({ planId: 'standard', retailUsd: 150, expectedDirectUsd: 62.78, targetGrossMargin: 0.6 });
    expect(floor.ok).toBe(false);
    const above = judgePlanEconomics({ planId: 'standard', retailUsd: 160, expectedDirectUsd: 62.78, targetGrossMargin: 0.6 });
    expect(above.ok).toBe(true);
  });
});

describe('what the ledger refuses to let anybody forget', () => {
  it('insists every figure is dated and sourced', () => {
    expect(COST_CAVEATS.join(' ')).toContain('a price somebody remembered');
  });

  it('says an omission means unknown', () => {
    expect(COST_CAVEATS.join(' ')).toContain('an omission means unknown');
  });

  it('says the margin target is not a business policy', () => {
    expect(COST_CAVEATS.join(' ')).toContain('not a business policy');
  });

  it('says nothing has been priced yet', () => {
    expect(COST_CAVEATS.join(' ')).toContain('no plan has been priced');
  });
});
