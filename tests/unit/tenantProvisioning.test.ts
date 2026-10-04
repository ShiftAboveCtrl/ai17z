import { describe, expect, it } from 'vitest';
import {
  PROVISIONING_CAVEATS,
  PROVISIONING_STEPS,
  PROVISIONING_STEP_NAMES,
  mayMarkReady,
  nextAction,
  orphanReport,
  provisioningProblems,
  rollbackOrder,
  stateAfterFailure,
  type IsolationEvidence,
  type ProvisioningStep,
} from '@xbam/runtime';
import { runtimeMayAct } from '@xbam/shared';

/**
 * The dangerous state is half success.
 *
 * Every one of these pins an ordering or a refusal whose absence produces a
 * tenant that looks exactly like a working one: a guest booted before its
 * rules loaded, a grant issued before isolation was checked, a runtime marked
 * ready because the steps returned rather than because anything confirmed it.
 */

describe('the step list itself', () => {
  it('has no problems as shipped', () => {
    expect(provisioningProblems()).toEqual([]);
  });

  it('attaches the network before booting the guest', () => {
    // A guest that boots first is unfiltered for however long the rules take.
    const network = PROVISIONING_STEP_NAMES.indexOf('ATTACH_NETWORK');
    const boot = PROVISIONING_STEP_NAMES.indexOf('BOOT_GUEST');
    expect(network).toBeGreaterThanOrEqual(0);
    expect(network).toBeLessThan(boot);
  });

  it('mints the key before creating anything sealed under it', () => {
    expect(PROVISIONING_STEP_NAMES.indexOf('MINT_MASTER_KEY')).toBeLessThan(
      PROVISIONING_STEP_NAMES.indexOf('CREATE_DATABASE'),
    );
  });

  it('verifies isolation before a grant exists', () => {
    // Verifying afterwards means verifying something a customer can use.
    expect(PROVISIONING_STEP_NAMES.indexOf('VERIFY_ISOLATION')).toBeLessThan(
      PROVISIONING_STEP_NAMES.indexOf('ISSUE_GRANT'),
    );
  });

  it('marks ready last', () => {
    expect(PROVISIONING_STEP_NAMES[PROVISIONING_STEP_NAMES.length - 1]).toBe('MARK_READY');
  });

  it('gives every step an explanation', () => {
    for (const step of PROVISIONING_STEPS) expect(step.what.length, step.name).toBeGreaterThan(20);
  });

  it('makes every non-repeatable step undoable', () => {
    for (const step of PROVISIONING_STEPS) {
      if (!step.idempotent) expect(step.undo, step.name).toBeTruthy();
    }
  });

  it('refuses a reordered list that boots before attaching the network', () => {
    const reordered = [...PROVISIONING_STEPS];
    const network = reordered.findIndex((s) => s.name === 'ATTACH_NETWORK');
    const boot = reordered.findIndex((s) => s.name === 'BOOT_GUEST');
    [reordered[network], reordered[boot]] = [reordered[boot]!, reordered[network]!];
    expect(provisioningProblems(reordered).join(' ')).toContain('unfiltered');
  });

  it('refuses a list where a grant comes before verification', () => {
    const reordered = [...PROVISIONING_STEPS];
    const verify = reordered.findIndex((s) => s.name === 'VERIFY_ISOLATION');
    const grant = reordered.findIndex((s) => s.name === 'ISSUE_GRANT');
    [reordered[verify], reordered[grant]] = [reordered[grant]!, reordered[verify]!];
    expect(provisioningProblems(reordered).join(' ')).toContain('a customer can already use');
  });

  it('refuses a step that can neither be repeated nor undone', () => {
    const added: ProvisioningStep = {
      name: 'SOMETHING_ONE_WAY',
      what: 'An expensive one-way operation somebody added without an undo.',
      idempotent: false,
      undo: null,
    };
    const steps = [...PROVISIONING_STEPS.slice(0, -1), added, PROVISIONING_STEPS[PROVISIONING_STEPS.length - 1]!];
    expect(provisioningProblems(steps).join(' ')).toContain('unrecoverable');
  });

  it('refuses an undo that is itself a provisioning step', () => {
    const steps = PROVISIONING_STEPS.map((s) =>
      s.name === 'BOOT_GUEST' ? { ...s, undo: 'MARK_READY' } : s,
    );
    expect(provisioningProblems(steps).join(' ')).toContain('itself a provisioning step');
  });
});

describe('resuming', () => {
  it('starts at the first step', () => {
    const out = nextAction({ runtimeId: 'rt-1', completed: [] });
    expect(out.action).toBe('RUN');
    if (out.action !== 'RUN') return;
    expect(out.step.name).toBe(PROVISIONING_STEP_NAMES[0]);
  });

  it('continues from what was recorded rather than from the beginning', () => {
    const out = nextAction({ runtimeId: 'rt-1', completed: PROVISIONING_STEP_NAMES.slice(0, 4) });
    expect(out.action).toBe('RUN');
    if (out.action !== 'RUN') return;
    expect(out.step.name).toBe(PROVISIONING_STEP_NAMES[4]);
  });

  it('does not care what order the records arrived in', () => {
    const shuffled = [...PROVISIONING_STEP_NAMES.slice(0, 3)].reverse();
    const out = nextAction({ runtimeId: 'rt-1', completed: shuffled });
    expect(out.action).toBe('RUN');
    if (out.action !== 'RUN') return;
    expect(out.step.name).toBe(PROVISIONING_STEP_NAMES[3]);
  });

  it('is done when every step is recorded', () => {
    expect(nextAction({ runtimeId: 'rt-1', completed: [...PROVISIONING_STEP_NAMES] }).action).toBe('DONE');
  });

  it('rolls back rather than retrying a failure', () => {
    // Retrying a step that failed for a reason nobody has looked at is how a
    // provision loops against a host.
    const out = nextAction({
      runtimeId: 'rt-1',
      completed: PROVISIONING_STEP_NAMES.slice(0, 5),
      failed: { step: 'BOOT_GUEST', why: 'the jailer was not present' },
    });
    expect(out.action).toBe('ROLLBACK');
    if (out.action !== 'ROLLBACK') return;
    expect(out.why).toContain('the jailer was not present');
  });
});

describe('rolling back', () => {
  it('undoes newest first', () => {
    // An undo depends on what came before it still being there: dropping a
    // database after releasing the placement drops it on a host no longer
    // reserved for this tenant.
    const order = rollbackOrder(PROVISIONING_STEP_NAMES.slice(0, 5));
    expect(order[0]).toBe('DETACH_NETWORK');
    expect(order[order.length - 1]).toBe('RELEASE_PLACEMENT');
  });

  it('skips steps with nothing to undo', () => {
    const order = rollbackOrder([...PROVISIONING_STEP_NAMES]);
    expect(order).not.toContain('MIGRATE_SCHEMA');
    expect(order).not.toContain('VERIFY_ISOLATION');
  });

  it('undoes nothing when nothing was done', () => {
    expect(rollbackOrder([])).toEqual([]);
  });

  it('leaves a runtime in no state where it may act', () => {
    for (const succeeded of [true, false]) {
      const state = stateAfterFailure(succeeded);
      expect(runtimeMayAct(state), String(succeeded)).toBe(false);
    }
  });

  it('distinguishes a clean rollback from one that failed', () => {
    expect(stateAfterFailure(true)).toBe('DELETED');
    expect(stateAfterFailure(false)).toBe('FAILED');
  });
});

describe('a rollback that itself failed', () => {
  it('says nothing was left behind when nothing was', () => {
    const out = orphanReport({ runtimeId: 'rt-1', undosAttempted: ['STOP_GUEST'], undosFailed: [] });
    expect(out).toContain('rolled back cleanly');
  });

  it('names what is left on the host and says it needs a person', () => {
    // Nothing will find these by looking at the control plane, because the
    // runtime record is gone.
    const out = orphanReport({
      runtimeId: 'rt-1',
      undosAttempted: ['STOP_GUEST', 'DESTROY_DATA_DISK'],
      undosFailed: ['DESTROY_DATA_DISK'],
    });
    expect(out).toContain('DESTROY_DATA_DISK');
    expect(out).toContain('need a person');
  });
});

describe('before anything outside may reach a runtime', () => {
  const evidence = (over: Partial<IsolationEvidence> = {}): IsolationEvidence => ({
    egressEnforced: true,
    guestMatchesPlan: true,
    databaseIsolated: true,
    keyIsItsOwn: true,
    ...over,
  });

  it('allows ready when every boundary was confirmed', () => {
    expect(mayMarkReady(evidence())).toEqual({ ready: true });
  });

  it('refuses without confirmed egress', () => {
    const out = mayMarkReady(evidence({ egressEnforced: false }));
    expect(out.ready).toBe(false);
    if (out.ready) return;
    expect(out.missing.join(' ')).toContain('egress rules are loaded');
  });

  it('refuses when the guest is not the planned guest', () => {
    expect(mayMarkReady(evidence({ guestMatchesPlan: false })).ready).toBe(false);
  });

  it('refuses when the database was not confirmed by the server', () => {
    expect(mayMarkReady(evidence({ databaseIsolated: false })).ready).toBe(false);
  });

  it('refuses when the key was not confirmed to be its own', () => {
    expect(mayMarkReady(evidence({ keyIsItsOwn: false })).ready).toBe(false);
  });

  it('names every missing boundary rather than the first', () => {
    const out = mayMarkReady({
      egressEnforced: false,
      guestMatchesPlan: false,
      databaseIsolated: false,
      keyIsItsOwn: false,
    });
    expect(out.ready).toBe(false);
    if (out.ready) return;
    expect(out.missing).toHaveLength(4);
  });
});

describe('what this does not claim', () => {
  it('says no tenant has been provisioned', () => {
    expect(PROVISIONING_CAVEATS.join(' ').toLowerCase()).toContain('no tenant has been provisioned');
  });

  it('says a step returning is not a boundary existing', () => {
    expect(PROVISIONING_CAVEATS.join(' ').toLowerCase()).toContain('not a boundary that exists');
  });

  it('says a failed rollback needs a person', () => {
    expect(PROVISIONING_CAVEATS.join(' ').toLowerCase()).toContain('needs a person');
  });
});
