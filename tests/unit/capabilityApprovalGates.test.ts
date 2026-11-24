import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLogger } from '@xbam/shared';
import { defineCapability, invokeCapability, registerCapability, resetCapabilitiesForTest } from '@xbam/tools';

afterEach(() => resetCapabilitiesForTest());

describe('approval retains the invocation gates', () => {
  it.each(['DISABLED', 'PAUSED'] as const)('rechecks %s after readiness before executing', async gate => {
    let runs = 0;
    let ready = false;
    registerCapability(defineCapability({
      id: 'test.approved', name: 'Approved write', description: 'Write a report.',
      category: 'CREATE', effect: 'WRITE', risk: 'HIGH', modelCallable: true,
      input: z.object({}), output: z.object({}), timeoutMs: 1000,
      async readiness() { ready = true; return { status: 'AVAILABLE' }; },
      async run() { runs += 1; return {}; },
    }));
    const result = await invokeCapability({ call: { id: 'test.approved', input: {} },
      context: { agentId: 'agent', jobId: null, accountId: null, config: {}, logger: createLogger('test') },
      permission: { stored: 'OWNER_APPROVAL', approved: true, paused: false },
      recheckPermission: async () => {
        expect(ready).toBe(true);
        return { stored: gate === 'DISABLED' ? 'DISABLED' : 'OWNER_APPROVAL', approved: true, paused: gate === 'PAUSED' };
      },
    });
    expect(result.outcome).toBe('REFUSED');
    expect(runs).toBe(0);
  });
});
