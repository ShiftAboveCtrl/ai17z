import { describe, expect, it } from 'vitest';
import {
  budgetFor,
  describeBudget,
  memoryClassFor,
  pressureFor,
  throttleFor,
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
  it('never lets Chrome have more than half the machine', () => {
    // The other half is the operating system, Docker, and whatever the owner
    // was actually doing. A browser automation tool that takes the whole
    // machine is one people uninstall.
    for (const bytes of [4, 8, 16, 32, 64, 128].map((n) => n * GB)) {
      const budget = budgetFor(bytes);
      expect(budget.chromeHardBytes).toBeLessThan(bytes / 2);
    }
  });

  it('always leaves somewhere to recycle before anything has to wait', () => {
    for (const bytes of [4, 8, 16, 32, 64, 128].map((n) => n * GB)) {
      const budget = budgetFor(bytes);
      expect(budget.chromeSoftBytes).toBeLessThan(budget.chromeHardBytes);
    }
  });

  it('gives a small machine less parallelism and a tighter recycling threshold', () => {
    const small = budgetFor(6 * GB);
    const ordinary = budgetFor(16 * GB);
    expect(small.browserConcurrency).toBeLessThan(ordinary.browserConcurrency);
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
    expect(enormous.chromeHardBytes).toBe(big.chromeHardBytes);
  });

  it('always keeps at least two tabs live, whatever the machine', () => {
    // ACTION has to stay live while something reads, or a reply queues behind
    // a monitor.
    for (const bytes of [1, 2, 4, 8, 64].map((n) => n * GB)) {
      expect(budgetFor(bytes).maxLiveTabs).toBeGreaterThanOrEqual(2);
    }
  });

  it('produces nothing absurd from an absurd machine', () => {
    for (const nonsense of [0, -5, Number.NaN]) {
      const budget = budgetFor(nonsense);
      expect(budget.chromeSoftBytes).toBeGreaterThan(0);
      expect(budget.browserConcurrency).toBeGreaterThanOrEqual(1);
      expect(budget.workerHeapMb).toBeGreaterThan(0);
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
    expect(normal.pauseBackground).toBe(false);
  });

  it('delays background work rather than dropping it', () => {
    // Durable jobs are never lost to memory pressure. They wait.
    for (const state of ['PRESSURED', 'CRITICAL'] as const) {
      expect(throttleFor(state).pauseBackground).toBe(true);
      expect(throttleFor(state).concurrencyFactor).toBeLessThan(1);
      expect(throttleFor(state).concurrencyFactor).toBeGreaterThan(0);
    }
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
