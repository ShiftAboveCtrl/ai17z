import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What happens when a Toolspace invocation gives up.
 *
 * A capability is handed an `AbortSignal` and eventually causes an HTTP
 * request, through a family's read helper, `ask`, the quota coordinator and the
 * concurrency gauge. Abandoning it has to reach all of that -- otherwise an
 * invocation that timed out still queues for room it will never use, still
 * holds a slot somebody else wants, and its failure still looks like the
 * endpoint's fault.
 *
 * The signal travels ambiently rather than as a parameter through eleven
 * differently-shaped helpers, so a family written later is cancellable without
 * its author doing anything. These prove it end to end rather than proving the
 * plumbing exists.
 */

vi.mock('@xbam/database', () => ({
  capabilityInvocations: {
    async recordInvocation() {
      return { id: 'x' };
    },
  },
}));

const { z } = await import('zod');
const {
  InMemoryQuotaCoordinator,
  ask,
  healthOf,
  perMinute,
  registerUpstream,
  resetBreakerForTest,
  resetCacheForTest,
  resetLimiterForTest,
  resetUpstreamsForTest,
  useQuotaCoordinator,
} = await import('@xbam/upstream');
const { defineCapability, invokeCapability, registerCapability, resetCapabilitiesForTest } = await import(
  '@xbam/tools'
);
const { fakeUpstream } = await import('../support/fakeUpstream');

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
  resetCapabilitiesForTest();
  useQuotaCoordinator(new InMemoryQuotaCoordinator());
});
afterEach(() => {
  resetUpstreamsForTest();
  resetCapabilitiesForTest();
});

/** A capability that reads a family, the way every real one does. */
function reader(id: string, family: string, timeoutMs = 30_000) {
  return defineCapability({
    id,
    name: 'Read a thing',
    description: 'Reads a thing from somewhere outside.',
    category: 'READ',
    effect: 'READ',
    risk: 'LOW',
    input: z.object({}),
    output: z.object({ value: z.string() }),
    modelCallable: true,
    timeoutMs,
    // Deliberately does NOT take the context or pass a signal anywhere: the
    // point is that it is cancellable regardless.
    async run() {
      const answer = await ask<{ of: string }, string>(family, { of: 'thing' });
      return { value: answer.value };
    },
  });
}

async function invoke(id: string) {
  return invokeCapability({
    call: { id, input: {} },
    context: {
      agentId: 'agent-1',
      jobId: null,
      accountId: null,
      config: {},
      logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as never,
    },
    permission: { stored: 'ALLOWED', paused: false },
  });
}

describe('abandoning an invocation', () => {
  it('A. stops waiting for a rate window instead of making the request', async () => {
    // One request a minute, already spent, so the next caller would wait far
    // longer than the invocation's own timeout.
    const fake = fakeUpstream({
      id: 'slowrate.one',
      windows: [perMinute(1, { scope: 'MACHINE' })],
    });
    registerUpstream(fake.upstream);
    registerCapability(reader('test.rate', 'slowrate', 200));

    // Spend the budget.
    await ask('slowrate', { of: 'first' });
    expect(fake.calls).toHaveLength(1);

    const result = await invoke('test.rate');
    expect(result.outcome).not.toBe('SUCCEEDED');
    // The upstream was never asked a second time.
    expect(fake.calls).toHaveLength(1);
  });

  it('B. removes its waiter, so it never reaches the upstream at all', async () => {
    /**
     * One slot, occupied, and somebody queueing behind it who gives up.
     *
     * The observable that distinguishes a removed waiter from a leaked one is
     * whether the abandoned call ever reaches `fetch`. A leaked waiter sits in
     * the queue, gets woken when the slot frees, takes it, and only then
     * notices it was abandoned -- so the upstream sees a third call. A removed
     * one never gets there.
     */
    const fake = fakeUpstream({ id: 'narrow.one', concurrentPerProcess: 1, behaviour: { delayMs: 600 } });
    registerUpstream(fake.upstream);
    registerCapability(reader('test.slot', 'narrow', 120));

    // Occupies the only slot for 600ms.
    const holding = ask<{ of: string }, string>('narrow', { of: 'holding' });
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Queues behind it and gives up after 120ms, well before the slot frees.
    const abandoned = await invoke('test.slot');
    expect(abandoned.outcome).not.toBe('SUCCEEDED');

    await holding;
    expect(fake.calls, 'the abandoned call should never have reached the upstream').toHaveLength(1);

    // And the slot really is free for somebody who wants it.
    const later = await ask<{ of: string }, string>('narrow', { of: 'later' });
    expect(later.value).toContain('narrow.one');
    expect(fake.calls).toHaveLength(2);
  }, 20_000);

  it('C. aborts the request in flight and releases the slot', async () => {
    const fake = fakeUpstream({ id: 'slow.one', behaviour: { delayMs: 5_000 }, concurrentPerProcess: 1 });
    registerUpstream(fake.upstream);
    registerCapability(reader('test.slow', 'slow', 120));

    const result = await invoke('test.slow');
    expect(result.outcome).toBe('TIMED_OUT');

    // The one slot is back: if it had leaked, this would hang and time out.
    const after = fakeUpstream({ id: 'slow.two', family: 'slow', rank: 2 });
    registerUpstream(after.upstream);
    const later = await ask<{ of: string }, string>('slow', { of: 'later' });
    expect(later.value).toBeTruthy();
  }, 20_000);

  it('D. leaves other callers of the same family healthy', async () => {
    const fake = fakeUpstream({ id: 'shared.one' });
    registerUpstream(fake.upstream);
    registerCapability(reader('test.shared', 'shared', 120));

    const aborted = await invoke('test.shared').catch(() => null);
    expect(aborted).not.toBeNull();

    // An ordinary caller is unaffected: not blocked, not cooled off.
    const answer = await ask<{ of: string }, string>('shared', { of: 'ordinary' });
    expect(answer.value).toContain('shared.one');
    expect(healthOf('shared.one').state).toBe('READY');
  });

  it('E. does not blame the upstream for the caller giving up', async () => {
    const fake = fakeUpstream({ id: 'blameless.one', behaviour: { delayMs: 5_000 } });
    registerUpstream(fake.upstream);
    registerCapability(reader('test.blameless', 'blameless', 120));

    await invoke('test.blameless');

    // A cancelled request is not evidence that the endpoint is unwell, so the
    // breaker must not have cooled it off. Otherwise one impatient invocation
    // would take a healthy source out for every other agent.
    expect(healthOf('blameless.one').state).toBe('READY');
  }, 20_000);

  it('F. does not report giving up as the endpoint rate limiting us', async () => {
    const fake = fakeUpstream({ id: 'notlimited.one', behaviour: { delayMs: 5_000 } });
    registerUpstream(fake.upstream);
    registerCapability(reader('test.notlimited', 'notlimited', 120));

    const result = await invoke('test.notlimited');
    // "We gave up" and "they asked us to slow down" are different facts, and
    // the second would wrongly pace every other caller of that endpoint.
    expect(result.detail.toLowerCase()).not.toMatch(/rate limit|asked us to wait|429/);
    expect(result.outcome).toBe('TIMED_OUT');
  }, 20_000);
});
