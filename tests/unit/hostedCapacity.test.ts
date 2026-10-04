import { describe, expect, it } from 'vitest';
import {
  CAPACITY_CAVEATS,
  entitlementChange,
  lapseEffect,
  mayProvisionAnother,
  mayUseBrowser,
  overCapacity,
  type CapacityEntitlement,
  type TenantUsage,
} from '@xbam/runtime';
import { RUNTIME_STATES } from '@xbam/shared';

/**
 * Capacity, bounded before a runtime exists rather than reconciled after.
 *
 * The two properties worth a test each: a suspended runtime still occupies
 * the entitlement it was created under, and a reduction never stops something
 * that is already running. Both are the cases where the easy implementation
 * produces a conversation nobody wants to have.
 */

const entitlement = (over: Partial<CapacityEntitlement> = {}): CapacityEntitlement => ({
  tenantId: 'tenant-1',
  runtimeClassId: 'standard',
  runtimes: 2,
  browser: true,
  coversUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  source: 'OPERATOR_GRANT',
  ...over,
});

const usage = (states: readonly string[], runtimeClassId = 'standard'): TenantUsage => ({
  runtimes: states.map((state) => ({ runtimeClassId, state: state as TenantUsage['runtimes'][number]['state'], browser: true })),
});

describe('starting another runtime', () => {
  it('allows one under the entitlement', () => {
    expect(mayProvisionAnother(entitlement(), usage(['ACTIVE']))).toEqual({ allowed: true });
  });

  it('refuses one over it', () => {
    const out = mayProvisionAnother(entitlement({ runtimes: 1 }), usage(['ACTIVE']));
    expect(out.allowed).toBe(false);
    if (out.allowed) return;
    expect(out.why).toContain('covers 1 runtime');
  });

  it('counts a suspended runtime, which still holds a database and a key', () => {
    // Counting only the acting ones would let somebody hold ten suspended
    // agents on an entitlement for one.
    const out = mayProvisionAnother(entitlement({ runtimes: 2 }), usage(['SUSPENDED', 'RETAINED']));
    expect(out.allowed).toBe(false);
    if (out.allowed) return;
    expect(out.why).toContain('suspended and retained');
  });

  it('does not count a deleted one', () => {
    expect(mayProvisionAnother(entitlement({ runtimes: 1 }), usage(['DELETED'])).allowed).toBe(true);
  });

  it('counts only the class this entitlement covers', () => {
    const mixed: TenantUsage = {
      runtimes: [
        { runtimeClassId: 'large', state: 'ACTIVE', browser: true },
        { runtimeClassId: 'large', state: 'ACTIVE', browser: true },
      ],
    };
    expect(mayProvisionAnother(entitlement({ runtimes: 1 }), mixed).allowed).toBe(true);
  });

  it('refuses on a lapsed entitlement, and says existing runtimes keep their state', () => {
    const out = mayProvisionAnother(entitlement({ coversUntil: new Date(Date.now() - 1_000).toISOString() }), usage([]));
    expect(out.allowed).toBe(false);
    if (out.allowed) return;
    expect(out.why).toContain('keep their state');
  });

  it('refuses an unreadable expiry rather than treating it as open ended', () => {
    const out = mayProvisionAnother(entitlement({ coversUntil: 'whenever' }), usage([]));
    expect(out.allowed).toBe(false);
    if (out.allowed) return;
    expect(out.why).toContain('covers nothing');
  });

  it('refuses an entitlement covering no runtimes', () => {
    expect(mayProvisionAnother(entitlement({ runtimes: 0 }), usage([])).allowed).toBe(false);
  });
});

describe('a browser slot', () => {
  it('is asked separately, because it is the scarcest thing on a host', () => {
    expect(mayUseBrowser(entitlement({ browser: true })).allowed).toBe(true);
  });

  it('absent is a text-only agent rather than a broken entitlement', () => {
    const out = mayUseBrowser(entitlement({ browser: false }));
    expect(out.allowed).toBe(false);
    if (out.allowed) return;
    expect(out.why).toContain('runs without one');
  });
});

describe('changing an entitlement', () => {
  it('widens immediately', () => {
    const out = entitlementChange(entitlement({ runtimes: 1 }), entitlement({ runtimes: 3 }), usage(['ACTIVE']));
    expect(out).toEqual({ kind: 'WIDENED', takesEffect: 'IMMEDIATELY' });
  });

  it('narrows only at renewal, and stops nothing', () => {
    // Applying a reduction immediately would mean choosing which of somebody's
    // agents to stop, and nothing should make that choice.
    const out = entitlementChange(entitlement({ runtimes: 3 }), entitlement({ runtimes: 1 }), usage(['ACTIVE', 'ACTIVE', 'ACTIVE']));
    expect(out.kind).toBe('NARROWED');
    if (out.kind !== 'NARROWED') return;
    expect(out.takesEffect).toBe('AT_RENEWAL');
    expect(out.overBy).toBe(2);
    expect(out.why).toContain('Nothing is stopped');
  });

  it('says a reduction changes nothing when nothing is above it', () => {
    const out = entitlementChange(entitlement({ runtimes: 3 }), entitlement({ runtimes: 2 }), usage(['ACTIVE']));
    expect(out.kind).toBe('NARROWED');
    if (out.kind !== 'NARROWED') return;
    expect(out.overBy).toBe(0);
    expect(out.why).toContain('changes nothing in practice');
  });

  it('reports no change as no change', () => {
    expect(entitlementChange(entitlement(), entitlement(), usage(['ACTIVE']))).toEqual({ kind: 'UNCHANGED' });
  });
});

describe('what a lapse does', () => {
  it('deletes nothing, from any state', () => {
    for (const state of RUNTIME_STATES) {
      expect(lapseEffect(state).deletesAnything, state).toBe(false);
    }
  });

  it('stops a runtime acting and says what is kept', () => {
    const out = lapseEffect('ACTIVE');
    expect(out.stopsActing).toBe(true);
    expect(out.why).toContain('memories');
    expect(out.why).toContain('export or renew');
  });

  it('says so when a runtime had already stopped', () => {
    expect(lapseEffect('SUSPENDED').why).toContain('already stopped acting');
  });
});

describe('being over capacity', () => {
  it('reports nothing when within it', () => {
    expect(overCapacity([entitlement({ runtimes: 2 })], usage(['ACTIVE', 'SUSPENDED']))).toEqual([]);
  });

  it('reports the class, what is entitled and what exists', () => {
    const out = overCapacity([entitlement({ runtimes: 1 })], usage(['ACTIVE', 'ACTIVE', 'RETAINED']));
    expect(out).toEqual([{ runtimeClassId: 'standard', entitled: 1, existing: 3 }]);
  });

  it('sums several entitlements for one class', () => {
    const out = overCapacity(
      [entitlement({ runtimes: 1 }), entitlement({ runtimes: 2 })],
      usage(['ACTIVE', 'ACTIVE', 'ACTIVE']),
    );
    expect(out).toEqual([]);
  });

  it('reports a class with no entitlement at all', () => {
    const out = overCapacity([], usage(['ACTIVE']));
    expect(out).toEqual([{ runtimeClassId: 'standard', entitled: 0, existing: 1 }]);
  });

  it('ignores deleted runtimes', () => {
    expect(overCapacity([entitlement({ runtimes: 0 })], usage(['DELETED', 'DELETED']))).toEqual([]);
  });
});

describe('what this does not do', () => {
  it('says it takes no payment', () => {
    expect(CAPACITY_CAVEATS.join(' ').toLowerCase()).toContain('takes a payment');
    expect(CAPACITY_CAVEATS.join(' ').toLowerCase()).toContain('paying is the owner act');
  });

  it('says a lapse never deletes anything and defers to the lifecycle', () => {
    expect(CAPACITY_CAVEATS.join(' ').toLowerCase()).toContain('hostedlifecycle.ts holds that');
  });

  it('says over capacity is reported rather than enforced', () => {
    expect(CAPACITY_CAVEATS.join(' ').toLowerCase()).toContain('reported, not enforced');
  });

  it('says no capacity has been sold', () => {
    expect(CAPACITY_CAVEATS.join(' ').toLowerCase()).toContain('no capacity has been sold');
  });
});
