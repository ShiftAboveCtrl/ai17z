import { describe, expect, it } from 'vitest';

import {
  FOOTPRINT_CAVEATS,
  HEADROOM,
  MEASURED_TENANT_FOOTPRINT,
  STALE_AFTER_DAYS,
  type TenantFootprint,
  judgeFootprint,
  sizeHoldsTenant,
  tenantsPerRuntime,
} from '@xbam/runtime';

const AT = new Date(MEASURED_TENANT_FOOTPRINT.measuredAt);
const laterBy = (days: number): Date => new Date(AT.getTime() + days * 86_400_000);

const footprint = (over: Partial<TenantFootprint> = {}): TenantFootprint => ({
  ...MEASURED_TENANT_FOOTPRINT,
  ...over,
});

describe('the measured tenant footprint', () => {
  it('came from inside a guest, because a figure from the host sees the VM and not the workload', () => {
    expect(MEASURED_TENANT_FOOTPRINT.method).toBe('IN_GUEST');
  });

  it('says what produced it, in a sentence rather than as a number on its own', () => {
    expect(MEASURED_TENANT_FOOTPRINT.how.length).toBeGreaterThan(40);
    expect(MEASURED_TENANT_FOOTPRINT.how).toMatch(/migrations|worker|health/i);
  });

  it('says which version it measured, because a different version is a different footprint', () => {
    expect(MEASURED_TENANT_FOOTPRINT.version).toMatch(/^v\d/);
  });

  it('records how much the guest was given, because the reading moves with it', () => {
    // The same tenant reads 575 MB and 410 MB and both are real: a guest with
    // memory to spare lets its page cache grow into it. A figure without its
    // condition cannot explain the difference.
    expect(MEASURED_TENANT_FOOTPRINT.memoryGivenMb).toBeGreaterThan(MEASURED_TENANT_FOOTPRINT.memoryMb);
    expect(MEASURED_TENANT_FOOTPRINT.memoryWhenSizedMb).not.toBeNull();
    expect(MEASURED_TENANT_FOOTPRINT.memoryWhenSizedMb!).toBeLessThan(MEASURED_TENANT_FOOTPRINT.memoryMb);
  });

  it('keeps the higher reading as the planning figure, deliberately', () => {
    // Sizing on the worse reading is the right direction for a number that
    // decides how many tenants fit on a machine.
    const verdict = judgeFootprint(MEASURED_TENANT_FOOTPRINT, laterBy(1));
    expect(verdict.usable).toBe(true);
    if (!verdict.usable) return;
    expect(verdict.memoryMb).toBeGreaterThan(MEASURED_TENANT_FOOTPRINT.memoryWhenSizedMb! * HEADROOM);
    expect(verdict.why).toContain('kept on purpose');
  });

  it('says the figure moves with what the guest was given', () => {
    expect(FOOTPRINT_CAVEATS.some((c) => /page cache|given/.test(c))).toBe(true);
  });

  it('says nothing about the condition when nobody measured a sized guest', () => {
    const verdict = judgeFootprint(footprint({ memoryWhenSizedMb: null }), laterBy(1));
    expect(verdict.usable).toBe(true);
    if (!verdict.usable) return;
    expect(verdict.why).not.toContain('kept on purpose');
  });

  it('admits no browser was running, which is the limitation that matters most', () => {
    expect(MEASURED_TENANT_FOOTPRINT.withBrowser).toBe(false);
    expect(FOOTPRINT_CAVEATS.some((c) => /browser|Chrome/.test(c))).toBe(true);
  });

  it('admits it was not measured on confidential hardware', () => {
    expect(FOOTPRINT_CAVEATS.some((c) => /confidential/i.test(c))).toBe(true);
  });

  it('admits it was measured idle', () => {
    expect(FOOTPRINT_CAVEATS.some((c) => /idle|load/i.test(c))).toBe(true);
  });
});

describe('judging a footprint', () => {
  it('sizes above what was observed, so a tenant has somewhere to go', () => {
    const verdict = judgeFootprint(MEASURED_TENANT_FOOTPRINT, laterBy(1));
    expect(verdict.usable).toBe(true);
    if (!verdict.usable) return;
    expect(verdict.memoryMb).toBeGreaterThan(MEASURED_TENANT_FOOTPRINT.memoryMb);
    expect(verdict.memoryMb).toBe(Math.ceil(MEASURED_TENANT_FOOTPRINT.memoryMb * HEADROOM));
  });

  it('says in its reason that no browser was running', () => {
    const verdict = judgeFootprint(MEASURED_TENANT_FOOTPRINT, laterBy(1));
    expect(verdict.usable).toBe(true);
    if (!verdict.usable) return;
    expect(verdict.why).toMatch(/Chrome|browser/);
  });

  it('refuses a measurement that has gone stale rather than pricing from it', () => {
    const verdict = judgeFootprint(MEASURED_TENANT_FOOTPRINT, laterBy(STALE_AFTER_DAYS + 1));
    expect(verdict.usable).toBe(false);
    if (verdict.usable) return;
    expect(verdict.why).toMatch(/Measure it again/);
  });

  it('counts a measurement still inside the window', () => {
    expect(judgeFootprint(MEASURED_TENANT_FOOTPRINT, laterBy(STALE_AFTER_DAYS - 1)).usable).toBe(true);
  });

  it('refuses a date in the future, which means a clock is wrong rather than a measurement is old', () => {
    const verdict = judgeFootprint(MEASURED_TENANT_FOOTPRINT, laterBy(-2));
    expect(verdict.usable).toBe(false);
    if (verdict.usable) return;
    expect(verdict.why).toMatch(/clock/);
  });

  it('refuses a date it cannot read', () => {
    expect(judgeFootprint(footprint({ measuredAt: 'last Tuesday' }), laterBy(1)).usable).toBe(false);
  });

  it('refuses a footprint of no memory', () => {
    expect(judgeFootprint(footprint({ memoryMb: 0 }), laterBy(1)).usable).toBe(false);
  });
});

describe('whether a size holds a tenant', () => {
  const sized = judgeFootprint(MEASURED_TENANT_FOOTPRINT, laterBy(1));
  const needed = sized.usable ? sized.memoryMb : 0;

  it('accepts the smallest confidential size, which is what the economics rest on', () => {
    // Standard_DC2as_v5: two vCPU, 8 GiB. The question the whole hosted price
    // depends on is whether a tenant fits in the smallest unit that exists.
    const verdict = sizeHoldsTenant({ vcpus: 2, memoryMb: 8192 }, MEASURED_TENANT_FOOTPRINT, laterBy(1));
    expect(verdict.fits).toBe(true);
    expect(verdict.why).toContain('8192');
  });

  it('refuses a size with less memory than the sized requirement, naming both figures', () => {
    const verdict = sizeHoldsTenant({ vcpus: 2, memoryMb: needed - 1 }, MEASURED_TENANT_FOOTPRINT, laterBy(1));
    expect(verdict.fits).toBe(false);
    expect(verdict.why).toContain(String(needed));
  });

  it('refuses a size with fewer vCPUs than the measurement was taken on', () => {
    const verdict = sizeHoldsTenant({ vcpus: 1, memoryMb: 65_536 }, MEASURED_TENANT_FOOTPRINT, laterBy(1));
    expect(verdict.fits).toBe(false);
    if (verdict.fits) return;
    expect(verdict.why).toMatch(/does not carry down/);
  });

  it('refuses every size once the measurement is stale, however large', () => {
    const verdict = sizeHoldsTenant({ vcpus: 64, memoryMb: 262_144 }, MEASURED_TENANT_FOOTPRINT, laterBy(STALE_AFTER_DAYS + 1));
    expect(verdict.fits).toBe(false);
  });

  it('does not quietly trim the headroom to make a smaller size work', () => {
    // The observed figure fits in 600 MB; the sized requirement does not. A
    // size between the two has to be refused, or the headroom is decorative.
    expect(MEASURED_TENANT_FOOTPRINT.memoryMb).toBeLessThan(600);
    expect(needed).toBeGreaterThan(600);
    expect(sizeHoldsTenant({ vcpus: 2, memoryMb: 600 }, MEASURED_TENANT_FOOTPRINT, laterBy(1)).fits).toBe(false);
  });
});

describe('how many tenants share a runtime', () => {
  it('is one, and says why two would be wrong rather than only that it is one', () => {
    const answer = tenantsPerRuntime();
    expect(answer.count).toBe(1);
    expect(answer.why).toMatch(/master key/);
    expect(answer.why).toMatch(/database/);
  });

  it('allows several of one customer\'s agents in it', () => {
    expect(tenantsPerRuntime().why).toMatch(/agents may share/);
  });
});
