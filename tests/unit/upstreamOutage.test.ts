import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An agent whose sources have all gone away.
 *
 * This is the property everything else rests on, and the reason to prove it now
 * rather than after twenty more families are stacked on top: **an outside
 * service failing must never break the agent.** Somebody's endpoint goes down at
 * three in the morning, and what should happen is a reply that says it could not
 * check something -- not a crashed job, not a hang, and above all not an answer
 * that quietly makes the number up.
 *
 * Three shapes of gone, because they fail differently:
 *
 *   every member of a family failing;
 *   a family with no members at all, which is what an installation looks like
 *     before anything is registered, and what a capability sees when the pack it
 *     belongs to was never set up;
 *   a capability failing inside the loop, which is the one that reaches the
 *     model.
 */

const { ask, resetBreakerForTest, resetCacheForTest, resetLimiterForTest, resetUpstreamsForTest, registerUpstream } =
  await import('@xbam/upstream');
const { fakeUpstream } = await import('../support/fakeUpstream');
const { registerCapability, resetCapabilitiesForTest, defineCapability, CALL_OPEN, CALL_CLOSE } = await import(
  '@xbam/tools'
);

vi.mock('@xbam/database', () => ({
  capabilityInvocations: {
    async recordInvocation() {
      return { id: 'x' };
    },
  },
}));

const { runCapabilityLoop } = await import('@xbam/runtime');
const { z } = await import('zod');

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
  resetCapabilitiesForTest();
});
afterEach(() => {
  resetUpstreamsForTest();
  resetCapabilitiesForTest();
});

describe('every source in a family is down', () => {
  it('says which ones were tried and why, rather than hanging or shrugging', async () => {
    // Ranked deliberately, registered in the wrong order, and **named against
    // the rank on purpose**: alphabetically these are alpha, mike, zulu, and by
    // rank they are the reverse. Naming them first/second/third made the two
    // orders agree, and the assertion below then passed with rank ordering
    // removed from the registry entirely -- proving nothing at all.
    const fakes = [
      fakeUpstream({ id: 'fam.mike', rank: 2, behaviour: { answers: [{ kind: 'throw', message: 'ECONNREFUSED' }] } }),
      fakeUpstream({ id: 'fam.alpha', rank: 3, behaviour: { answers: [{ kind: 'throw', message: 'ECONNREFUSED' }] } }),
      fakeUpstream({ id: 'fam.zulu', rank: 1, behaviour: { answers: [{ kind: 'throw', message: 'ECONNREFUSED' }] } }),
    ];
    for (const fake of fakes) registerUpstream(fake.upstream);

    const started = Date.now();
    // Every one of them tried, each with the reason it could not answer. An
    // operator reading this has to be able to tell "all three refused the
    // connection" from "the first one was still cooling off".
    const error = await ask('fam', { of: 'anything' }).then(
      () => null,
      (thrown: Error) => thrown,
    );
    expect(error?.message).toMatch(/fam\.zulu \(NETWORK: ECONNREFUSED\)/);
    expect(error?.message).toMatch(/fam\.mike \(NETWORK: ECONNREFUSED\)/);
    expect(error?.message).toMatch(/fam\.alpha \(NETWORK: ECONNREFUSED\)/);
    // Best first, whatever order they were registered in and whatever they are
    // called.
    expect(fakes.every((fake) => fake.calls.length === 1)).toBe(true);
    expect(error!.message.indexOf('fam.zulu')).toBeLessThan(error!.message.indexOf('fam.mike'));
    expect(error!.message.indexOf('fam.mike')).toBeLessThan(error!.message.indexOf('fam.alpha'));

    // Promptly. A family that took a timeout per member would spend half a
    // minute discovering what the first one already showed.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('is a family with nothing in it, not a crash', async () => {
    // What an installation looks like before anything is registered, and what a
    // capability sees when its pack was never set up.
    await expect(ask('nothing_registered', { of: 'x' })).rejects.toThrow(/Nothing is registered/);
  });
});

describe('a capability whose source has gone', () => {
  /** A capability that reads a family, the way the real ones do. */
  const reader = defineCapability({
    id: 'test.read_thing',
    name: 'Read a thing',
    description: 'Reads a thing from somewhere outside.',
    category: 'READ',
    effect: 'READ',
    risk: 'LOW',
    input: z.object({}),
    output: z.object({ value: z.string() }),
    modelCallable: true,
    timeoutMs: 5_000,
    async run() {
      const answer = await ask<{ of: string }, string>('fam', { of: 'thing' });
      return { value: answer.value };
    },
  });

  it('lets the model finish its answer instead of taking the job down', async () => {
    // The one that reaches a person. An agent mid-sentence whose lookup failed
    // has to keep talking -- saying it could not check, which is true and
    // useful -- rather than the whole job failing.
    registerCapability(reader);
    registerUpstream(
      fakeUpstream({ id: 'fam.only', behaviour: { answers: [{ kind: 'throw', message: 'ECONNREFUSED' }] } }).upstream,
    );

    const generate = vi
      .fn()
      .mockResolvedValueOnce(`${CALL_OPEN}${JSON.stringify({ id: 'test.read_thing', input: {} })}${CALL_CLOSE}`)
      .mockResolvedValueOnce('I could not check that just now.');

    const result = await runCapabilityLoop({
      agentId: 'agent-1',
      jobId: null,
      accountId: null,
      messages: [{ role: 'user', content: 'what is the thing?' }],
      generate,
      permissions: new Map([['test.read_thing', 'ALLOWED' as const]]),
      paused: false,
    });

    // It answered.
    expect(result.answer).toBe('I could not check that just now.');
    // And the failure is on the record rather than swallowed.
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.outcome).toBe('FAILED');
    expect(result.steps[0]!.capabilityId).toBe('test.read_thing');
  });

  it('tells the model what went wrong, so it can say so rather than invent', async () => {
    // The failure text is fed back into the conversation. An agent that is told
    // only "that did not work" will reach for something plausible instead.
    registerCapability(reader);
    registerUpstream(
      fakeUpstream({ id: 'fam.only', behaviour: { answers: [{ kind: 'throw', message: 'ECONNREFUSED' }] } }).upstream,
    );

    const generate = vi
      .fn()
      .mockResolvedValueOnce(`${CALL_OPEN}${JSON.stringify({ id: 'test.read_thing', input: {} })}${CALL_CLOSE}`)
      .mockResolvedValueOnce('Could not check.');

    await runCapabilityLoop({
      agentId: 'agent-1',
      jobId: null,
      accountId: null,
      messages: [{ role: 'user', content: 'what is the thing?' }],
      generate,
      permissions: new Map([['test.read_thing', 'ALLOWED' as const]]),
      paused: false,
    });

    // The second call is where the outcome is handed back.
    const fedBack = JSON.stringify(generate.mock.calls[1]![0]);
    expect(fedBack).toMatch(/fam\.only|could not|failed/i);
  });

  it('carries on when a capability is switched off, rather than failing the job', async () => {
    // Turning a pack off must leave an agent healthy, not broken.
    registerCapability(reader);
    const generate = vi
      .fn()
      .mockResolvedValueOnce(`${CALL_OPEN}${JSON.stringify({ id: 'test.read_thing', input: {} })}${CALL_CLOSE}`)
      .mockResolvedValueOnce('Answered without it.');

    const result = await runCapabilityLoop({
      agentId: 'agent-1',
      jobId: null,
      accountId: null,
      messages: [{ role: 'user', content: 'hello' }],
      generate,
      permissions: new Map([['test.read_thing', 'DISABLED' as const]]),
      paused: false,
    });

    expect(result.answer).toBe('Answered without it.');
    expect(result.steps[0]!.outcome).toBe('REFUSED');
  });

  it('answers normally when nothing is asked for at all', async () => {
    // Every pack off. The ordinary path has to be untouched by any of this.
    const generate = vi.fn().mockResolvedValue('An ordinary answer.');
    const result = await runCapabilityLoop({
      agentId: 'agent-1',
      jobId: null,
      accountId: null,
      messages: [{ role: 'user', content: 'hello' }],
      generate,
      permissions: new Map(),
      paused: false,
    });

    expect(result.answer).toBe('An ordinary answer.');
    expect(result.steps).toEqual([]);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
