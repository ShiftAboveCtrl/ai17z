import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recorded: { capabilityId: string; outcome: string; step: number }[] = [];

// The loop writes an audit row for every step. Mocked rather than run against
// Postgres because what is being tested here is the loop's shape -- how many
// times it asks, what it feeds back, when it stops -- and a database would only
// make those questions slower to ask. `tests/integration` covers the row.
vi.mock('@xbam/database', () => ({
  // peerReview.ts reads agents.getAgent while the runtime is imported; nothing here calls it.
  agents: {},
  capabilityInvocations: {
    async recordInvocation(input: { capabilityId: string; outcome: string; step: number }) {
      recorded.push({ capabilityId: input.capabilityId, outcome: input.outcome, step: input.step });
      return { id: 'x' };
    },
  },
}));

const { runCapabilityLoop } = await import('@xbam/runtime');
const { defineCapability, registerCapability, resetCapabilitiesForTest, CALL_OPEN, CALL_CLOSE } = await import(
  '@xbam/tools'
);

const clock = defineCapability({
  id: 'test.clock',
  name: 'Clock',
  description: 'The time.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({}),
  output: z.object({ now: z.string() }),
  modelCallable: true,
  timeoutMs: 1_000,
  async run() {
    return { now: 'noon' };
  },
});

/** Reports the settings it was handed, so a caller can see what arrived. */
const settingsProbe = defineCapability({
  id: 'test.settings',
  name: 'Settings',
  description: 'What this capability was configured with.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({}),
  output: z.object({ seen: z.string() }),
  modelCallable: true,
  timeoutMs: 1_000,
  async run(_input, context) {
    return { seen: JSON.stringify(context.config) };
  },
});

const call = (id: string, input: unknown = {}) =>
  `${CALL_OPEN}${JSON.stringify({ id, input })}${CALL_CLOSE}`;

beforeEach(() => {
  recorded.length = 0;
  resetCapabilitiesForTest();
  registerCapability(clock);
  registerCapability(settingsProbe);
});
afterEach(() => resetCapabilitiesForTest());

const base = {
  agentId: 'agent-1',
  jobId: 'job-1',
  accountId: null,
  messages: [{ role: 'user' as const, content: 'what time is it?' }],
  permissions: new Map(),
  paused: false,
};

describe('the capability loop', () => {
  it('answers without asking for anything when it does not need to', async () => {
    const generate = vi.fn().mockResolvedValue('It is noon.');
    const result = await runCapabilityLoop({ ...base, generate });
    expect(result.answer).toBe('It is noon.');
    expect(result.steps).toEqual([]);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(recorded).toEqual([]);
  });

  it('offers the menu, runs what was chosen, and feeds the result back', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce(call('test.clock'))
      .mockResolvedValueOnce('It is noon.');
    const result = await runCapabilityLoop({ ...base, generate });

    expect(result.answer).toBe('It is noon.');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ capabilityId: 'test.clock', outcome: 'SUCCEEDED' });

    // The menu is in the conversation, and so is the result of what it chose.
    const firstMessages = generate.mock.calls[0]![0] as { content: string }[];
    expect(firstMessages.some((m) => m.content.includes('test.clock'))).toBe(true);
    const secondMessages = generate.mock.calls[1]![0] as { content: string }[];
    expect(secondMessages.some((m) => m.content.includes('noon'))).toBe(true);
  });

  it('treats an unknown capability as a malformed turn without invoking or proposing it', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce(call('test.invented'))
      .mockResolvedValueOnce('I could not look that up.');
    const result = await runCapabilityLoop({ ...base, generate });

    expect(result.steps).toEqual([]);
    expect(recorded).toEqual([]);
    expect(generate.mock.calls[1]![0].some((m: { content: string }) => m.content.includes('not offered'))).toBe(true);
  });

  it('exhausts the step budget when the final turn is malformed', async () => {
    const result = await runCapabilityLoop({ ...base, maxSteps: 1,
      generate: vi.fn().mockResolvedValueOnce(`${CALL_OPEN}bad${CALL_CLOSE}`).mockResolvedValueOnce('Stopped.') });
    expect(result.exhausted).toBe(true);
    expect(result.steps).toEqual([]);
  });

  it('does not invoke a registered capability that was not offered', async () => {
    const result = await runCapabilityLoop({ ...base, permissions: new Map([['test.settings', 'DISABLED' as const]]),
      generate: vi.fn().mockResolvedValueOnce(call('test.settings')).mockResolvedValueOnce('Stopped.') });
    expect(result.steps).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it('tells the model plainly when its call was malformed', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce(`${CALL_OPEN}not json${CALL_CLOSE}`)
      .mockResolvedValueOnce('Fine, noon.');
    const result = await runCapabilityLoop({ ...base, generate });
    expect(result.answer).toBe('Fine, noon.');
    const second = generate.mock.calls[1]![0] as { content: string }[];
    expect(second.some((m) => m.content.includes('not a usable capability call'))).toBe(true);
  });

  it('stops asking after the ceiling and answers with what it has', async () => {
    // A model that keeps asking runs out of asks. Without this the loop is one
    // provider outage away from a job that never ends.
    const generate = vi.fn().mockResolvedValue(call('test.clock'));
    const result = await runCapabilityLoop({ ...base, generate, maxSteps: 2 });

    expect(result.exhausted).toBe(true);
    expect(result.steps).toHaveLength(2);
    // Two loop turns plus the final one it is given with no menu.
    expect(generate).toHaveBeenCalledTimes(3);
    const last = generate.mock.calls[2]![0] as { content: string }[];
    expect(last.some((m) => m.content.includes('no more lookups'))).toBe(true);
  });

  it('stops when the budget is spent, whatever the step count allows', async () => {
    const generate = vi.fn().mockResolvedValue(call('test.clock'));
    const result = await runCapabilityLoop({ ...base, generate, maxSteps: 10, budgetMs: -1 });
    expect(result.exhausted).toBe(true);
    expect(result.steps).toHaveLength(0);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('refuses everything while paused, and keeps going', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce(call('test.clock'))
      .mockResolvedValueOnce('I cannot check right now.');
    const result = await runCapabilityLoop({ ...base, generate, paused: true });
    expect(result.steps[0]).toMatchObject({ outcome: 'REFUSED' });
    expect(result.steps[0]!.detail).toContain('paused');
  });

  it('never leaves a call tag in the answer', async () => {
    // A model that writes a call on its last turn has still said something, and
    // the tag must not reach a reply that goes to X.
    const generate = vi.fn().mockResolvedValue(`${call('test.clock')}\nProbably noon.`);
    const result = await runCapabilityLoop({ ...base, generate, maxSteps: 1 });
    expect(result.answer).not.toContain(CALL_OPEN);
    expect(result.answer).toContain('Probably noon.');
  });
});

/**
 * The settings an owner recorded, arriving where a capability can read them.
 *
 * `CapabilityContext.config` was described as per-agent configuration for as
 * long as capabilities have existed and was always `{}`: the loop accepted
 * `configs` and `stepGenerate`, its only production caller, never passed any.
 * The loop half was right all along, which is exactly why nothing caught it --
 * so this pins the half that was, and the integration suite pins the storage
 * and the reader that now feed it.
 */
describe('the menu the model is shown', () => {
  /** The system message the loop puts in front of the model. */
  const menuFrom = (generate: { mock: { calls: unknown[][] } }): string =>
    JSON.stringify(generate.mock.calls[0]?.[0] ?? []);

  it('describes a capability the owner allowed', async () => {
    const generate = vi.fn().mockResolvedValue('It is noon.');
    await runCapabilityLoop({ ...base, generate, permissions: new Map([['test.clock', 'ALLOWED' as const]]) });
    expect(menuFrom(generate)).toContain('test.clock');
  });

  it('does not describe one the owner switched off', async () => {
    // It used to. An owner who turned a pack off still had every capability in
    // it described to their agent, which could then choose one and be refused
    // -- a step and a model call spent being told no. The menu is also prompt:
    // 38 capabilities measured about 2,700 tokens on every generation.
    const generate = vi.fn().mockResolvedValue('It is noon.');
    await runCapabilityLoop({ ...base, generate, permissions: new Map([['test.clock', 'DISABLED' as const]]) });
    expect(menuFrom(generate)).not.toContain('test.clock');
  });

  it('still describes one that asks first, because asking is the point of it', async () => {
    const generate = vi.fn().mockResolvedValue('It is noon.');
    await runCapabilityLoop({
      ...base,
      generate,
      permissions: new Map([['test.clock', 'OWNER_APPROVAL' as const]]),
    });
    expect(menuFrom(generate)).toContain('test.clock');
  });

  it('sends no menu at all when everything is off', async () => {
    const generate = vi.fn().mockResolvedValue('An ordinary answer.');
    const result = await runCapabilityLoop({
      ...base,
      generate,
      permissions: new Map([
        ['test.clock', 'DISABLED' as const],
        ['test.settings', 'DISABLED' as const],
      ]),
    });
    // The agent answers the question it was always going to be asked, with no
    // preamble and no wasted tokens.
    expect(result.answer).toBe('An ordinary answer.');
    expect(generate.mock.calls[0]![0]).toHaveLength(1);
  });

  it('treats a disabled capability missing from the menu as a malformed turn', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce(call('test.clock'))
      .mockResolvedValueOnce('Answered without it.');
    const result = await runCapabilityLoop({
      ...base,
      generate,
      permissions: new Map([['test.clock', 'DISABLED' as const]]),
    });
    expect(result.steps).toEqual([]);
    expect(recorded).toEqual([]);
  });
});

describe('what a capability is configured with', () => {
  it('hands over the settings recorded for that capability', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce(call('test.settings'))
      .mockResolvedValueOnce('Done.');

    const result = await runCapabilityLoop({
      ...base,
      generate,
      configs: new Map([['test.settings', { maxResults: 5, language: 'en' }]]),
      task: 'test.settings',
    });

    expect(result.steps[0]!.outcome).toBe('SUCCEEDED');
    // The second call is where the loop feeds the result back to the model.
    const fedBack = JSON.stringify(generate.mock.calls[1]![0]);
    expect(fedBack).toContain('maxResults');
    expect(fedBack).toContain('language');
  });

  it('hands over an empty bag when nothing was recorded for it', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce(call('test.settings'))
      .mockResolvedValueOnce('Done.');

    await runCapabilityLoop({
      ...base,
      generate,
      configs: new Map([['test.clock', { irrelevant: true }]]),
      task: 'test.settings',
    });

    // Another capability's settings must never arrive here.
    const fedBack = JSON.stringify(generate.mock.calls[1]![0]);
    expect(fedBack).toContain('{}');
    expect(fedBack).not.toContain('irrelevant');
  });
});

describe('a goal plan uses the same loop with live gates', () => {
  const checkpoint = () => Promise.resolve({
    permissions: new Map(), configs: new Map(), paused: false,
    autonomy: 'ACT' as const, enabled: true,
  });

  it('stops before invoking a call returned after the time budget', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const result = await runCapabilityLoop({
        ...base, budgetMs: 10,
        generate: async () => { now = 11; return call('test.clock'); },
        goalPlan: { checkpoint, onStep: async () => undefined },
      });
      expect(result.exhausted).toBe(true);
      expect(result.steps).toHaveLength(0);
      expect(recorded).toHaveLength(0);
    } finally { vi.restoreAllMocks(); }
  });

  it('proposes at SUGGEST without executing or claiming a refused invocation', async () => {
    const result = await runCapabilityLoop({
      ...base, generate: async () => call('test.clock'),
      goalPlan: {
        checkpoint: async () => ({ ...await checkpoint(), autonomy: 'SUGGEST' }),
        onStep: async () => undefined,
      },
    });
    expect(result.halted).toBe('PROPOSED');
    expect(result.steps).toMatchObject([{ outcome: 'PROPOSED' }]);
    expect(recorded).toHaveLength(0);
  });

  it('refreshes a permission revoked while the model was generating', async () => {
    let allowed = true;
    const result = await runCapabilityLoop({
      ...base, generate: async () => { allowed = false; return call('test.clock'); },
      goalPlan: {
        checkpoint: async () => ({
          ...await checkpoint(), permissions: new Map([['test.clock', allowed ? 'ALLOWED' : 'DISABLED']]),
        }),
        onStep: async () => undefined,
      },
    });
    expect(result.halted).toBe('STOPPED');
    expect(result.steps).toMatchObject([{ outcome: 'REFUSED', output: null }]);
    expect(recorded).toEqual([{ capabilityId: 'test.clock', outcome: 'REFUSED', step: 1 }]);
  });
});
