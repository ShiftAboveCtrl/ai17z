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
  // Durable approval records and claims are exercised against Postgres in integration.
  capabilityApprovals: { async propose() {} },
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
  it.each([false, true])('survives a failed proposal write (goal plan: %s)', async goal => {
    const { capabilityApprovals } = await import('@xbam/database');
    const save = vi.spyOn(capabilityApprovals, 'propose').mockRejectedValueOnce(new Error('private-db-error'));
    const generate = vi.fn().mockResolvedValueOnce(call('test.clock')).mockResolvedValue('Could not queue the call.');
    try {
      const result = await runCapabilityLoop({ ...base, generate, maxSteps: 1,
        permissions: new Map([['test.clock', 'OWNER_APPROVAL']]),
        ...(goal ? { goalPlan: {
          checkpoint: async () => ({ permissions: new Map([['test.clock', 'OWNER_APPROVAL' as const]]),
            configs: new Map(), paused: false, autonomy: 'SUGGEST' as const, enabled: true }),
          onStep: async () => {},
        } } : {}),
      });
      expect(result.steps[0]?.detail).toContain('could not be queued');
      if (!goal) expect(generate.mock.calls[1]![0]).toContainEqual(expect.objectContaining({
        role: 'system', content: expect.stringContaining('could not be queued'),
      }));
    } finally { save.mockRestore(); }
  });

  it('offers an approved pure read while excluding an unknown READ-labelled capability', async () => {
    registerCapability(defineCapability({ ...clock, id: 'time.now' }));
    const outcome = await runCapabilityLoop({ ...base, task: 'time.now test.clock test.settings',
      permissions: new Map([['time.now', 'ALLOWED'], ['test.clock', 'ALLOWED'], ['test.settings', 'ALLOWED']]),
      readOnly: { sanitize: text => text, checkpoint: async () => undefined },
      generate: async () => 'No lookup needed.',
    });
    expect(outcome.shortlist.offered.map(c => c.id)).toEqual(['time.now']);
  });
  it.each(['agent.cannot_change', 'paper.trade', 'plugin.mislabelled_read'])('excludes READ-labelled writer %s from external turns', async id => {
    let writes = 0;
    registerCapability(defineCapability({ ...clock, id, async run() { writes++; return { now: 'written' }; } }));
    const outcome = await runCapabilityLoop({ ...base, audience: 'OWNER', task: id,
      permissions: new Map([[id, 'ALLOWED']]),
      readOnly: { sanitize: text => text, checkpoint: async () => undefined },
      generate: vi.fn().mockResolvedValueOnce(call(id)).mockResolvedValueOnce('No changes.'),
    });
    expect(writes).toBe(0);
    expect(outcome.shortlist.offered.every(c => ['time.now', 'agent.self_state', 'agent.explain_action'].includes(c.id))).toBe(true);
    expect(outcome.steps[0]?.outcome).toBe('REFUSED');
  });

  it('an external read-only turn refuses even an explicitly allowed write capability', async () => {
    let writes = 0;
    registerCapability(defineCapability({
      id: 'test.write', name: 'Clock write', description: 'Change the clock.',
      category: 'ENGAGE', effect: 'WRITE', risk: 'LOW', modelCallable: true,
      input: z.object({}), output: z.object({ ok: z.boolean() }), timeoutMs: 1_000,
      async run() { writes++; return { ok: true }; },
    }));
    let turns = 0;
    const outcome = await runCapabilityLoop({ ...base,
      task: 'change the clock with test.write',
      permissions: new Map([['test.write', 'ALLOWED']]),
      readOnly: { sanitize: text => text, checkpoint: async () => undefined },
      generate: async () => turns++ === 0 ? call('test.write') : 'No change was made.',
    });
    expect(writes).toBe(0);
    expect(outcome.shortlist.offered.map(c => c.id)).not.toContain('test.write');
    expect(outcome.steps[0]?.outcome).toBe('REFUSED');
  });

  it('checks external revocation again after generation and before invoking a read', async () => {
    let checks = 0;
    await expect(runCapabilityLoop({ ...base,
      readOnly: { sanitize: text => text, checkpoint: async () => { if (++checks === 2) throw new Error('revoked'); } },
      generate: async () => call('test.clock'),
    })).rejects.toThrow('revoked');
    expect(recorded).toHaveLength(0);
  });

  it.each([
    { input: { ignored: 'not retained' }, parsed: {} },
    { input: 'invalid input', parsed: null },
  ])('records one refusal for a not-offered call with input $input without invoking it', async ({ input, parsed }) => {
    const tools = await import('@xbam/tools');
    const { capabilityInvocations } = await import('@xbam/database');
    const invoke = vi.spyOn(tools, 'invokeCapability');
    const run = vi.spyOn(settingsProbe, 'run');
    const audit = vi.spyOn(capabilityInvocations, 'recordInvocation');
    const generate = vi.fn().mockResolvedValueOnce(call('test.settings', input)).mockResolvedValueOnce('Answered without it.');
    try {
      const result = await runCapabilityLoop({ ...base, generate });
      expect(audit).toHaveBeenCalledExactlyOnceWith({
        agentId: 'agent-1', jobId: 'job-1', accountId: null,
        capabilityId: 'test.settings', step: 1, outcome: 'REFUSED',
        detail: expect.stringContaining('not offered'), input: parsed, output: null, durationMs: 0,
      });
      expect(result.steps).toEqual([{
        capabilityId: 'test.settings', outcome: 'REFUSED', detail: expect.stringContaining('not offered'),
        input: parsed, output: null, durationMs: 0,
      }]);
      expect(invoke).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(result.answer).toBe('Answered without it.');
      expect(generate.mock.calls[1]![0]).toContainEqual({
        role: 'system', content: `test.settings did not run: ${result.steps[0]!.detail}`,
      });
    } finally { vi.restoreAllMocks(); }
  });

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

  it('records a refusal when the model names an unknown capability', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce(call('test.invented'))
      .mockResolvedValueOnce('I could not look that up.');
    const result = await runCapabilityLoop({ ...base, generate });

    expect(result.steps).toMatchObject([{ capabilityId: 'test.invented', outcome: 'REFUSED', input: null }]);
    expect(recorded).toEqual([{ capabilityId: 'test.invented', outcome: 'REFUSED', step: 1 }]);
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
    expect(result.steps).toMatchObject([{ capabilityId: 'test.settings', outcome: 'REFUSED' }]);
    expect(recorded).toEqual([{ capabilityId: 'test.settings', outcome: 'REFUSED', step: 1 }]);
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

  it('records a refusal for a disabled capability missing from the menu', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce(call('test.clock'))
      .mockResolvedValueOnce('Answered without it.');
    const result = await runCapabilityLoop({
      ...base,
      generate,
      permissions: new Map([['test.clock', 'DISABLED' as const]]),
    });
    expect(result.steps).toMatchObject([{ capabilityId: 'test.clock', outcome: 'REFUSED' }]);
    expect(recorded).toEqual([{ capabilityId: 'test.clock', outcome: 'REFUSED', step: 1 }]);
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

  it.each(['ACT', 'SUGGEST'] as const)('at %s stops and records a not-offered call without proposing it', async autonomy => {
    const onStep = vi.fn();
    const result = await runCapabilityLoop({
      ...base, generate: async () => call('test.settings'),
      goalPlan: {
        checkpoint: async () => ({ ...await checkpoint(), autonomy }), onStep,
      },
    });
    expect(result).toMatchObject({ halted: 'STOPPED', exhausted: false, reason: expect.stringContaining('not offered') });
    expect(result.steps).toMatchObject([{ capabilityId: 'test.settings', outcome: 'REFUSED' }]);
    expect(onStep).toHaveBeenCalledExactlyOnceWith(result.steps[0], 1);
    expect(recorded).toEqual([{ capabilityId: 'test.settings', outcome: 'REFUSED', step: 1 }]);
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

  it.each(['THINK', 'SUGGEST'] as const)('at %s executes a read and returns its outcome', async autonomy => {
    const result = await runCapabilityLoop({
      ...base, generate: vi.fn().mockResolvedValueOnce(call('test.clock')).mockResolvedValue('Checked.'),
      goalPlan: {
        checkpoint: async () => ({ ...await checkpoint(), autonomy }),
        onStep: async () => undefined,
      },
    });
    expect(result.halted).toBeUndefined();
    expect(result.steps).toMatchObject([{ outcome: 'SUCCEEDED', output: { now: 'noon' } }]);
    expect(recorded).toEqual([{ capabilityId: 'test.clock', outcome: 'SUCCEEDED', step: 1 }]);
  });

  it.each([false, true])('at OBSERVE stops before running a read (downgraded during generation: %s)', async downgrade => {
    let autonomy: 'THINK' | 'OBSERVE' = downgrade ? 'THINK' : 'OBSERVE';
    const generate = vi.fn(async () => { autonomy = 'OBSERVE'; return call('test.clock'); });
    const result = await runCapabilityLoop({
      ...base, generate,
      goalPlan: {
        checkpoint: async () => ({ ...await checkpoint(), autonomy }),
        onStep: async () => undefined,
      },
    });
    expect(result.halted).toBe('STOPPED');
    expect(result.steps).toEqual([]);
    expect(recorded).toEqual([]);
    expect(generate).toHaveBeenCalledTimes(downgrade ? 1 : 0);
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
