import { describe, expect, it } from 'vitest';
import { RUNTIME_STATES, type RuntimeState } from '@xbam/shared/contracts';
import {
  DEFAULT_LIFECYCLE,
  lifecycleAction,
  ownerOptionsFor,
  spendPermissionFor,
  type LifecycleView,
} from '@xbam/runtime';

/**
 * What happens to somebody's agent when the subscription lapses.
 *
 * The behaviour being protected: it stops acting, it does not get destroyed,
 * and paying again brings it back. Every duration is configuration, so the
 * tests pass a policy rather than waiting a month.
 */

const NOW = new Date('2026-10-04T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

const view = (over: Partial<LifecycleView> = {}): LifecycleView => ({
  state: 'ACTIVE',
  entitledUntil: inDays(30),
  since: daysAgo(1),
  ...over,
});

describe('a lapse stops an agent without destroying it', () => {
  it('moves a lapsed active runtime into grace rather than stopping it dead', () => {
    const out = lifecycleAction(view({ entitledUntil: daysAgo(1) }), DEFAULT_LIFECYCLE, NOW);
    expect(out.action).toBe('TO_GRACE');
    expect(out.detail).toContain('grace');
  });

  it('suspends after grace, and says nothing is lost', () => {
    const out = lifecycleAction(
      view({ state: 'GRACE', entitledUntil: daysAgo(10), since: daysAgo(DEFAULT_LIFECYCLE.graceDays + 1) }),
      DEFAULT_LIFECYCLE,
      NOW,
    );
    expect(out.action).toBe('TO_SUSPENDED');
    expect(out.detail).toContain('keeps everything it knows');
  });

  it('parks a long-suspended runtime and keeps export available', () => {
    const out = lifecycleAction(
      view({ state: 'SUSPENDED', entitledUntil: daysAgo(60), since: daysAgo(DEFAULT_LIFECYCLE.suspendedDays + 1) }),
      DEFAULT_LIFECYCLE,
      NOW,
    );
    expect(out.action).toBe('TO_RETAINED');
    expect(out.detail).toContain('exportable');
  });

  it('never deletes, only ever schedules a deletion somebody can still stop', () => {
    // Destroying an agent should take a separate, later, deliberate step.
    const out = lifecycleAction(
      view({ state: 'RETAINED', entitledUntil: daysAgo(200), since: daysAgo(DEFAULT_LIFECYCLE.retainedDays + 1) }),
      DEFAULT_LIFECYCLE,
      NOW,
    );
    expect(out.action).toBe('SCHEDULE_DELETION');
    if (out.action !== 'SCHEDULE_DELETION') return;
    expect(Date.parse(out.deleteAfter)).toBeGreaterThan(NOW.getTime());
    expect(out.detail).toContain('can still stop');
  });

  it('returns no deletion action for any state, ever', () => {
    // Asserted across the whole state space rather than the cases above.
    for (const state of RUNTIME_STATES) {
      for (const since of [daysAgo(0), daysAgo(1_000)]) {
        const out = lifecycleAction(view({ state, entitledUntil: daysAgo(500), since }), DEFAULT_LIFECYCLE, NOW);
        expect(out.action, `${state} ${since}`).not.toBe('DELETED');
      }
    }
  });

  it('waits rather than acting early', () => {
    for (const state of ['GRACE', 'SUSPENDED', 'RETAINED'] as const) {
      const out = lifecycleAction(view({ state, entitledUntil: daysAgo(1), since: daysAgo(0) }), DEFAULT_LIFECYCLE, NOW);
      expect(out.action, state).toBe('NONE');
    }
  });
});

describe('paying again brings it back', () => {
  it('restores from grace, suspension and retention alike', () => {
    for (const state of ['GRACE', 'SUSPENDED', 'RETAINED'] as const) {
      const out = lifecycleAction(view({ state, entitledUntil: inDays(30), since: daysAgo(100) }), DEFAULT_LIFECYCLE, NOW);
      expect(out.action, state).toBe('TO_ACTIVE');
    }
  });

  it('cancels a pending deletion when somebody comes back in time', () => {
    const out = lifecycleAction(
      view({ state: 'DELETION_SCHEDULED', entitledUntil: inDays(1), since: daysAgo(1) }),
      DEFAULT_LIFECYCLE,
      NOW,
    );
    expect(out.action).toBe('TO_ACTIVE');
    expect(out.detail).toContain('restored rather than removed');
  });

  it('does not resurrect something already deleted', () => {
    const out = lifecycleAction(view({ state: 'DELETED', entitledUntil: inDays(30) }), DEFAULT_LIFECYCLE, NOW);
    expect(out.action).toBe('NONE');
  });

  it('does not treat a runtime with no entitlement recorded as lapsed', () => {
    /*
      This asserted the opposite. The reasoning that changed it: an absent
      expiry and an expiry in the past are different facts, and reading the
      first as the second sent an operator-created runtime, or one whose
      billing integration failed to write the column, to GRACE and from there
      to a scheduled deletion in about three months. The errors are not
      symmetric. A runtime running longer than somebody paid for costs money
      an operator can see on this screen; an agent scheduled for deletion
      because a column was never written is irreversible.
    */
    const out = lifecycleAction(view({ entitledUntil: null }), DEFAULT_LIFECYCLE, NOW);
    expect(out.action).toBe('NONE');
    expect(out.detail).toContain('No entitlement is recorded');
  });
});

describe('suspended means the same thing everywhere', () => {
  it('stops autonomy, browsing, trading and model spend together', () => {
    // Four separate opinions about what suspended means is how an agent that
    // is supposed to be stopped keeps costing somebody money.
    for (const state of ['SUSPENDED', 'RETAINED', 'DELETION_SCHEDULED', 'HOST_UNREACHABLE', 'FAILED'] as const) {
      const p = spendPermissionFor(state);
      expect(p.autonomousActions, state).toBe(false);
      expect(p.browserWork, state).toBe(false);
      expect(p.trading, state).toBe(false);
      expect(p.modelSpend, state).toBe(false);
    }
  });

  it('lets an agent work while active or in grace', () => {
    for (const state of ['ACTIVE', 'GRACE'] as const) {
      const p = spendPermissionFor(state);
      expect(p.autonomousActions, state).toBe(true);
      expect(p.modelSpend, state).toBe(true);
    }
  });

  it('keeps owner access alive right up to deletion', () => {
    // Being able to get your agent out is the entire reason it was kept.
    for (const state of RUNTIME_STATES.filter((s) => s !== 'DELETED')) {
      expect(spendPermissionFor(state as RuntimeState).ownerAccess, state).toBe(true);
    }
    expect(spendPermissionFor('DELETED').ownerAccess).toBe(false);
  });

  it('never grants spend without granting owner access', () => {
    // A state where the agent may spend but the owner may not look would be
    // the wrong way round.
    for (const state of RUNTIME_STATES) {
      const p = spendPermissionFor(state as RuntimeState);
      if (p.modelSpend) expect(p.ownerAccess, state).toBe(true);
    }
  });
});

describe('what an owner is told they can do', () => {
  it('offers renewal only when it would change something', () => {
    expect(ownerOptionsFor('ACTIVE')).not.toContain('Renew to start it working again');
    expect(ownerOptionsFor('SUSPENDED')).toContain('Renew to start it working again');
  });

  it('always offers export and delete while anything is left', () => {
    for (const state of RUNTIME_STATES.filter((s) => s !== 'DELETED')) {
      const options = ownerOptionsFor(state as RuntimeState);
      expect(options.join(' '), state).toContain('Export');
      expect(options.join(' '), state).toContain('Delete');
    }
  });

  it('offers nothing once an agent is gone', () => {
    expect(ownerOptionsFor('DELETED')).toEqual([]);
  });

  it('speaks about the agent rather than naming a state', () => {
    // Shown to a person: it should say what is possible, not which enum
    // value they are in.
    for (const state of RUNTIME_STATES) {
      for (const option of ownerOptionsFor(state as RuntimeState)) {
        expect(option, option).not.toMatch(/SUSPENDED|RETAINED|DELETION_SCHEDULED|HOST_UNREACHABLE/);
      }
    }
  });
});

describe('the durations are configuration, not engineering facts', () => {
  it('honours a policy that is not the default', () => {
    const impatient = { graceDays: 0, suspendedDays: 0, retainedDays: 0, deletionNoticeDays: 1 };
    expect(lifecycleAction(view({ state: 'GRACE', entitledUntil: daysAgo(1), since: daysAgo(0) }), impatient, NOW).action).toBe('TO_SUSPENDED');
  });

  it('errs towards keeping an agent in its defaults', () => {
    // Keeping one costs storage; the other mistake costs somebody their agent.
    expect(DEFAULT_LIFECYCLE.graceDays).toBeGreaterThan(0);
    expect(DEFAULT_LIFECYCLE.suspendedDays).toBeGreaterThanOrEqual(30);
    expect(DEFAULT_LIFECYCLE.retainedDays).toBeGreaterThanOrEqual(30);
    expect(DEFAULT_LIFECYCLE.deletionNoticeDays).toBeGreaterThan(0);
  });
});

describe('an absent entitlement is not a lapsed one', () => {
  const since = new Date(Date.now() - 400 * 86_400_000).toISOString();

  it('does nothing to an ACTIVE runtime with no expiry recorded', () => {
    // Reading null as lapsed sent a runtime nobody had written an expiry for
    // to GRACE, and from there to a scheduled deletion in about three months.
    const out = lifecycleAction({ state: 'ACTIVE', entitledUntil: null, since });
    expect(out.action).toBe('NONE');
    expect(out.detail).toContain('not an expired one');
  });

  it('does nothing from any state when the expiry is unrecorded', () => {
    for (const state of ['GRACE', 'SUSPENDED', 'RETAINED'] as const) {
      expect(lifecycleAction({ state, entitledUntil: null, since }).action, state).toBe('NONE');
    }
  });

  it('refuses to read an unparseable expiry as either answer', () => {
    const out = lifecycleAction({ state: 'ACTIVE', entitledUntil: 'whenever', since });
    expect(out.action).toBe('NONE');
    expect(out.detail).toContain('not a date anything can read');
  });

  it('still moves a runtime whose expiry really has passed', () => {
    const lapsed = new Date(Date.now() - 1_000).toISOString();
    expect(lifecycleAction({ state: 'ACTIVE', entitledUntil: lapsed, since }).action).toBe('TO_GRACE');
  });
});
