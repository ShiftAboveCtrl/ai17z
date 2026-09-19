import { describe, expect, it, vi } from 'vitest';

/**
 * A plan that reaches past the rules does not reach past the clock.
 *
 * The deterministic pass already refuses to send "what time is it" to a search
 * engine. It is not the only way a lookup gets made: `worthPlanning` consults a
 * classifier whenever the message carries a question mark, and the classifier
 * is free to plan whatever it likes.
 *
 * Measured against the classifier a live agent actually runs, asked
 * "what time is it right now?", the plan came back as
 * `search:what time is it right now?`. That is the lookup that fails and then
 * arrives in the prompt as a failure, which is what stops the model reaching
 * for `time.now` in its own menu.
 *
 * So it is enforced on the plan rather than requested in the instruction, for
 * the same reason the emoji cap and the dash rule are enforced on finished text
 * rather than asked for in a prompt.
 */

const PLAN = JSON.stringify({
  needsImage: false,
  lookups: [
    { kind: 'search', query: 'what time is it right now?', reason: 'they asked the time' },
    { kind: 'search', query: 'what did the team ship this week?', reason: 'changes by the day' },
  ],
});

vi.mock('@xbam/models', () => ({
  async generate() {
    return { text: PLAN };
  },
  async resolveTargets() {
    // Non-empty, so `hasPlanner` says a classifier is configured.
    return [{ model: 'test-classifier' }];
  },
}));

const { planLookups } = await import('@xbam/runtime');

const ask = (incoming: string) =>
  planLookups('agent-1', null, {
    incoming,
    parent: null,
    hasMedia: false,
    links: [],
    deterministic: [],
    timeoutMs: 5_000,
  });

describe('the model may plan a lookup, but never a clock lookup', () => {
  it('drops the clock question the classifier asked for', async () => {
    const plan = await ask('what time is it right now?');
    expect(plan.decidedBy).toBe('model');
    expect(plan.lookups.map((l) => l.query)).not.toContain('what time is it right now?');
  });

  /*
    The rest of the plan survives. This is a filter on one question, not a
    reason to distrust a plan that contained one.
  */
  it('keeps everything else the plan asked for', async () => {
    const plan = await ask('what time is it right now? and what shipped?');
    expect(plan.lookups.map((l) => l.query)).toEqual(['what did the team ship this week?']);
  });
});
