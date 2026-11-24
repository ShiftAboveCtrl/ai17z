import { z } from 'zod';
import { defineCapability, registerCapability } from '@xbam/tools';

// Below the chat lease and loop budgets so settlement has time to finish.
export const DELEGATION_TIMEOUT_MS = 45_000;

const delegate = defineCapability({
  id: 'room.delegate',
  name: 'Delegate a room question',
  description: 'Delegate one bounded sub-task to another agent in this owner chat room. ' +
    'Ask the other agent by agentId and task. It answers as itself using its own memory and permissions. ' +
    'Only one delegation per turn is allowed; the delegate cannot delegate again.',
  category: 'RESEARCH', effect: 'WRITE', risk: 'MEDIUM',
  audience: 'OWNER', unsetPermission: 'OWNER_APPROVAL',
  input: z.object({ agentId: z.uuid(), task: z.string().trim().min(1).max(1_200) }).strict(),
  output: z.object({ agentId: z.string(), content: z.string(), detail: z.string(), jobId: z.string().nullable() }),
  modelCallable: true,
  timeoutMs: DELEGATION_TIMEOUT_MS + 5_000,
  async readiness(ctx) {
    return ctx.audience === 'OWNER' && ctx.delegation
      ? { status: 'AVAILABLE' }
      : { status: 'UNAVAILABLE', why: 'Delegation is available only on an original owner room turn.' };
  },
  async run(input, ctx) {
    if (ctx.audience !== 'OWNER' || !ctx.delegation) throw new Error('Delegation requires an owner room turn.');
    return ctx.delegation.run(input.agentId, input.task, ctx.signal);
  },
});

export function registerDelegationCapability(): void {
  registerCapability(delegate);
}
