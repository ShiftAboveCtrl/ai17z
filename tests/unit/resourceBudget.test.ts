import { describe, expect, it } from 'vitest';
import {
  budgetFor,
  describeBudget,
  freshHold,
  loopAllowed,
  memoryClassFor,
  pressureFor,
  settlePressure,
  throttleFor,
  PRESSURE_RECOVER_MS,
  PRESSURE_WORSEN_MS,
  type MemoryClass,
} from '@xbam/shared';

/**
 * What a machine can afford AI17Z to use.
 *
 * Every size below is an argument rather than a machine, which is the whole
 * reason the mapping is a pure function: the interesting cases are an 8 GB
 * laptop and a 128 GB workstation, and the machine running these tests is
 * neither. Tying any of this to the developer's own RAM would make the suite
 * pass here and say nothing about anywhere else.
 */

const GB = 1024 ** 3;

describe('what size of machine this is', () => {
  it.each([
    [4 * GB, 'LOW'],
    [8 * GB, 'LOW'],
    [12 * GB, 'NORMAL'],
    [16 * GB, 'NORMAL'],
    [32 * GB, 'HIGH'],
    [128 * GB, 'HIGH'],
  ] as [number, MemoryClass][])('calls %i bytes %s', (bytes, expected) => {
    expect(memoryClassFor(bytes)).toBe(expected);
  });

  it('treats a machine it cannot measure as ordinary', () => {
    // Not as small. A platform that will not say how much memory it has is not
    // a reason to run the product in its most restricted mode for ever.
    for (const nonsense of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(memoryClassFor(nonsense)).toBe('NORMAL');
    }
  });
});

describe('the budget that follows from it', () => {
  /*
    Every assertion here is about a number something enforces.

    There used to be four more, about `chromeSoftBytes`, `chromeHardBytes`,
    `browserConcurrency` and `workerHeapMb`. All four were computed here and
    read by nothing: no code path compared Chrome's memory against a budget, no
    semaphore bounded browser operations, and `--max-old-space-size` appeared
    in this repository exactly once, in the comment claiming it was passed.
    Tests that pin the arithmetic of an unused number make a dead field look
    maintained, which is how it survived.
  */
  it('gives a small machine fewer live tabs and a tighter recycling threshold', () => {
    const small = budgetFor(6 * GB);
    const ordinary = budgetFor(16 * GB);
    expect(small.maxLiveTabs).toBeLessThan(ordinary.maxLiveTabs);
    // Sooner, because on a small machine the operating system kills the
    // renderer long before V8's own ceiling is in sight.
    expect(small.tabRecycleHeapFraction).toBeLessThan(ordinary.tabRecycleHeapFraction);
  });

  it('stops being more generous past a point, however large the machine', () => {
    // Past a point more headroom buys nothing: a single renderer still dies at
    // V8's own ceiling however much is free.
    const big = budgetFor(64 * GB);
    const enormous = budgetFor(512 * GB);
    expect(enormous.maxLiveTabs).toBe(big.maxLiveTabs);
    expect(enormous.tabRecycleHeapFraction).toBe(big.tabRecycleHeapFraction);
  });

  it('never lets a tab run to V8 own ceiling', () => {
    // The crash happens on the allocation that crosses it, and the tab is gone
    // before anything can act, so the fraction has to leave real headroom.
    for (const bytes of [4, 8, 16, 32, 64, 128].map((n) => n * GB)) {
      expect(budgetFor(bytes).tabRecycleHeapFraction).toBeLessThanOrEqual(0.7);
    }
  });

  it('always keeps at least two tabs live, whatever the machine', () => {
    // ACTION has to stay live while something reads, or a reply queues behind
    // a monitor.
    for (const bytes of [1, 2, 4, 8, 64].map((n) => n * GB)) {
      expect(budgetFor(bytes).maxLiveTabs).toBeGreaterThanOrEqual(2);
    }
  });

  it('never promises more live tabs than there are roles to fill them', () => {
    // A cap above the number of roles is a cap that can never bind, which is
    // the shape the removed fields all had.
    for (const bytes of [1, 8, 64, 512].map((n) => n * GB)) {
      expect(budgetFor(bytes).maxLiveTabs).toBeLessThanOrEqual(4);
    }
  });

  it('produces nothing absurd from an absurd machine', () => {
    for (const nonsense of [0, -5, Number.NaN]) {
      const budget = budgetFor(nonsense);
      expect(budget.maxLiveTabs).toBeGreaterThanOrEqual(2);
      expect(budget.tabRecycleHeapFraction).toBeGreaterThan(0);
      expect(budget.tabRecycleHeapFraction).toBeLessThan(1);
    }
  });
});

describe('how much of the machine is spoken for', () => {
  it('reads plenty of free memory as normal', () => {
    expect(pressureFor({ totalBytes: 16 * GB, availableBytes: 8 * GB, inContainer: false })).toBe('NORMAL');
  });

  it('reads a machine down to its last tenth as pressured', () => {
    expect(pressureFor({ totalBytes: 16 * GB, availableBytes: 1.6 * GB, inContainer: false })).toBe('PRESSURED');
  });

  it('reads a machine about to start killing things as critical', () => {
    expect(pressureFor({ totalBytes: 16 * GB, availableBytes: 0.5 * GB, inContainer: false })).toBe('CRITICAL');
  });

  it('says normal when the platform will not say', () => {
    // Throttling a machine nobody has measured is a product that mysteriously
    // does less on hardware that was fine.
    expect(pressureFor({ totalBytes: 16 * GB, availableBytes: null, inContainer: false })).toBe('NORMAL');
    expect(pressureFor({ totalBytes: 0, availableBytes: 0, inContainer: false })).toBe('NORMAL');
  });
});

describe('what pressure changes', () => {
  it('changes nothing at all when there is no pressure', () => {
    const normal = throttleFor('NORMAL');
    expect(normal.concurrencyFactor).toBe(1);
    // Everything runs, down to the most speculative loop there is.
    expect(normal.runLoopsDownTo).toBe('OPTIONAL');
  });

  it('delays background work rather than dropping it', () => {
    // Durable jobs are never lost to memory pressure. They wait.
    for (const state of ['PRESSURED', 'CRITICAL'] as const) {
      expect(throttleFor(state).concurrencyFactor).toBeLessThan(1);
      expect(throttleFor(state).concurrencyFactor).toBeGreaterThan(0);
    }
  });

  /*
    The agent stops speculating before it stops answering people.

    This used to be one boolean saying "pause background work", which nothing
    read: the health row claimed everything speculative had stopped while only
    job concurrency had moved. An ordering is both honest and enforceable.
  */
  it('gives up speculation first and never gives up answering people', () => {
    expect(throttleFor('PRESSURED').runLoopsDownTo).toBe('STANDARD');
    expect(throttleFor('CRITICAL').runLoopsDownTo).toBe('ESSENTIAL');

    // Mentions, the owner's commands and recovery run at every pressure there is.
    for (const state of ['NORMAL', 'PRESSURED', 'CRITICAL'] as const) {
      expect(loopAllowed('ESSENTIAL', throttleFor(state).runLoopsDownTo)).toBe(true);
    }
    // Watching repositories is the first thing dropped.
    expect(loopAllowed('OPTIONAL', throttleFor('PRESSURED').runLoopsDownTo)).toBe(false);
    // Thinking survives merely tight memory and stops when it is critical.
    expect(loopAllowed('STANDARD', throttleFor('PRESSURED').runLoopsDownTo)).toBe(true);
    expect(loopAllowed('STANDARD', throttleFor('CRITICAL').runLoopsDownTo)).toBe(false);
  });

  it('does less as pressure rises', () => {
    expect(throttleFor('CRITICAL').concurrencyFactor).toBeLessThan(throttleFor('PRESSURED').concurrencyFactor);
  });
});

describe('what the owner is told', () => {
  it('says the size of the machine and what it decided, in words', () => {
    const said = describeBudget(budgetFor(16 * GB), 'NORMAL');
    expect(said).toContain('16.0 GB machine (normal)');
    expect(said).toContain('running normally');
  });

  it('does not call a container share "the machine"', () => {
    // Inside a container `totalmem` reports the container's slice: the API
    // container on a 63 GB Windows machine reads 30.9 GB. Calling that "the
    // machine" tells the owner something untrue. What is decided never used
    // that number -- the browser worker runs on the host -- but the sentence
    // did.
    const said = describeBudget(budgetFor(30 * GB), 'NORMAL', true);
    expect(said).toContain('available to AI17Z');
    expect(said).not.toContain('machine');
  });

  it('explains a throttle rather than just reporting a state', () => {
    expect(describeBudget(budgetFor(16 * GB), 'PRESSURED')).toContain('background work is waiting');
    expect(describeBudget(budgetFor(16 * GB), 'CRITICAL')).toContain('only essential browser work');
  });
});

/*
  What the pressure states actually change.

  A budget that is measured and displayed but never acted on is a dashboard,
  not a defence. The one thing it has to do is reduce load *before* the
  operating system starts killing things, because what it kills is Chrome: a
  renderer is the largest process AI17Z has and the first thing an
  out-of-memory killer reaches for.
*/
describe('reducing work under pressure', () => {
  /** The job worker's effective capacity, which is what consumes the throttle. */
  const allowed = (concurrency: number, state: Parameters<typeof throttleFor>[0]) =>
    Math.max(1, Math.floor(concurrency * throttleFor(state).concurrencyFactor));

  it('runs everything it was configured for when memory is fine', () => {
    expect(allowed(4, 'NORMAL')).toBe(4);
  });

  it('does less when memory is tight, and less again when it is critical', () => {
    expect(allowed(4, 'PRESSURED')).toBe(2);
    expect(allowed(4, 'CRITICAL')).toBe(1);
  });

  it('never stops entirely, however bad it gets', () => {
    // An installation under pressure still makes progress, just slowly. A
    // worker that claims nothing is one that looks broken.
    for (const state of ['NORMAL', 'PRESSURED', 'CRITICAL'] as const) {
      expect(allowed(1, state)).toBeGreaterThanOrEqual(1);
      expect(allowed(8, state)).toBeGreaterThanOrEqual(1);
    }
  });

  it('delays rather than drops', () => {
    // Reducing how many are claimed leaves the rest in the queue. Nothing here
    // can lose a durable job, which is the property that makes throttling safe
    // to do automatically.
    expect(allowed(8, 'CRITICAL')).toBeLessThan(8);
    expect(allowed(8, 'CRITICAL')).toBeGreaterThan(0);
  });
});

/**
 * A verdict that does not change its mind every few seconds.
 *
 * `freemem` moves constantly, and the throttle used to be re-read raw on every
 * tick with no memory of the last answer. A machine hovering near a threshold
 * would therefore start and abandon the same background work repeatedly, which
 * is worse than either state: nothing finishes and every partial attempt is
 * paid for twice.
 */
describe('hysteresis', () => {
  const at = (ms: number) => 1_000_000 + ms;

  it('does not believe a worse reading the instant it appears', () => {
    const hold = settlePressure(freshHold('NORMAL'), 'PRESSURED', at(0));
    expect(hold.state).toBe('NORMAL');
    expect(hold.pending).toBe('PRESSURED');
  });

  it('believes a worse reading that holds', () => {
    let hold = settlePressure(freshHold('NORMAL'), 'PRESSURED', at(0));
    hold = settlePressure(hold, 'PRESSURED', at(PRESSURE_WORSEN_MS));
    expect(hold.state).toBe('PRESSURED');
  });

  it('forgets a worse reading that goes away before it counts', () => {
    let hold = settlePressure(freshHold('NORMAL'), 'PRESSURED', at(0));
    hold = settlePressure(hold, 'NORMAL', at(1_000));
    expect(hold.state).toBe('NORMAL');
    expect(hold.pending).toBeNull();
  });

  /*
    Recovery is slower than deterioration, deliberately.

    The thing being avoided is the operating system killing a renderer, so
    getting worse is believed quickly. A dip in usage is not the same as the
    pressure having passed, so getting better is believed slowly.
  */
  it('takes longer to believe things are better than that they are worse', () => {
    expect(PRESSURE_RECOVER_MS).toBeGreaterThan(PRESSURE_WORSEN_MS);

    let hold = freshHold('CRITICAL');
    hold = settlePressure(hold, 'NORMAL', at(0));
    hold = settlePressure(hold, 'NORMAL', at(PRESSURE_WORSEN_MS));
    // Long enough to have been believed if it were getting worse.
    expect(hold.state).toBe('CRITICAL');
    hold = settlePressure(hold, 'NORMAL', at(PRESSURE_RECOVER_MS));
    expect(hold.state).toBe('NORMAL');
  });

  it('does not oscillate across a threshold', () => {
    let hold = freshHold('NORMAL');
    // Ten flaps inside the worsening window: the verdict must not move.
    for (let i = 0; i < 10; i += 1) {
      hold = settlePressure(hold, i % 2 === 0 ? 'PRESSURED' : 'NORMAL', at(i * 1_000));
    }
    expect(hold.state).toBe('NORMAL');
  });
});
