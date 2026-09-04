import { describe, expect, it } from 'vitest';
import { DEFAULT_RESTART_POLICY, decideRestart } from '@xbam/shared';

/**
 * The native worker is the only process that can drive a browser, and it ran
 * with nothing watching it: if it died, an agent simply stopped.
 *
 * Restarting is the easy half. The half that matters is not restarting for
 * ever -- a worker that cannot start fails in a second, and answering that with
 * another attempt every second produces thousands of identical failures and no
 * clearer picture than the first one gave.
 */
describe('deciding whether to start it again', () => {
  it('restarts something that had been running and then died', () => {
    const decision = decideRestart({ ranForMs: 6 * 60_000, code: 1 }, 0);
    expect(decision.restart).toBe(true);
    expect(decision.delayMs).toBe(0);
    expect(decision.reason).toContain('360s');
  });

  it('leaves a clean exit alone', () => {
    // Exit 0 is something having been asked to stop. Restarting it would fight
    // whoever asked, and the commonest asker is the stop script.
    const decision = decideRestart({ ranForMs: 5 * 60_000, code: 0 }, 0);
    expect(decision.restart).toBe(false);
    expect(decision.reason).toContain('exited cleanly');
  });

  it('leaves something that was killed alone', () => {
    // A supervisor that restarts through a deliberate kill is a process nobody
    // can stop.
    const decision = decideRestart({ ranForMs: 5 * 60_000, code: null }, 0);
    expect(decision.restart).toBe(false);
    expect(decision.reason).toContain('stopped');
  });

  it('backs off further each time it fails to start', () => {
    const delays: number[] = [];
    let quick = 0;
    for (let i = 0; i < 4; i += 1) {
      const decision = decideRestart({ ranForMs: 400, code: 1 }, quick);
      quick = decision.quickFailures;
      delays.push(decision.delayMs);
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000]);
  });

  it('never waits longer than the ceiling', () => {
    const decision = decideRestart({ ranForMs: 100, code: 1 }, 3, {
      ...DEFAULT_RESTART_POLICY,
      maxQuickFailures: 50,
      maxDelayMs: 5_000,
    });
    expect(decision.delayMs).toBe(5_000);
  });

  it('gives up when it plainly cannot start, and says why', () => {
    let quick = 0;
    let last = decideRestart({ ranForMs: 300, code: 1 }, quick);
    for (let i = 0; i < 10 && last.restart; i += 1) {
      quick = last.quickFailures;
      last = decideRestart({ ranForMs: 300, code: 1 }, quick);
    }
    expect(last.restart).toBe(false);
    expect(last.quickFailures).toBe(DEFAULT_RESTART_POLICY.maxQuickFailures);
    // Not "it failed", but which kind of wrong it is and where to look.
    expect(last.reason).toContain('configuration');
  });

  it('forgives the earlier stumbles once it stays up', () => {
    // A worker that failed twice, started properly, and later died is not a
    // worker that cannot start, and must not inherit a spent budget.
    const stumbled = decideRestart({ ranForMs: 500, code: 1 }, 1);
    expect(stumbled.quickFailures).toBe(2);

    const recovered = decideRestart({ ranForMs: 20 * 60_000, code: 1 }, stumbled.quickFailures);
    expect(recovered.restart).toBe(true);
    expect(recovered.quickFailures).toBe(0);
  });

  it('treats a run just over the line as a real run', () => {
    const decision = decideRestart({ ranForMs: DEFAULT_RESTART_POLICY.tooQuickMs + 1, code: 1 }, 4);
    expect(decision.restart).toBe(true);
    expect(decision.quickFailures).toBe(0);
  });
});
