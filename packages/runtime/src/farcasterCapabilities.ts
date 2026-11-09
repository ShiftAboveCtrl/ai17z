import { z } from 'zod';
import { ContextPost, ResolvedContext } from '@xbam/shared/contracts';
import { PipelineError } from '@xbam/shared';
import { accounts, capabilities, jobs } from '@xbam/database';
import { FarcasterCastReference, farcasterReads } from '@xbam/channels';
import { defineCapability, registerCapability } from '@xbam/tools';
import type { CapabilityContext } from '@xbam/tools';
import { buildChannelContext } from './channelContext';
import { performCapabilityAction } from './capabilityActions';
import { loadJobBundle } from './loadJob';
import { checkActionRate } from './policyGate';
import { remoteActionsAllowed } from './killSwitch';

async function channel(ctx: Pick<CapabilityContext, 'accountId' | 'agentId' | 'jobId'>) {
  const account = ctx.accountId ? await accounts.getAccount(ctx.accountId) : null;
  if (!account || account.channel !== 'farcaster' || account.status !== 'CONNECTED' || !account.enabled) {
    throw PipelineError.permanent('farcaster_unavailable', 'This job needs a connected Farcaster account.');
  }
  const grants = await capabilities.grantsFor(ctx.agentId, account.id);
  if (!grants.has('READ')) throw PipelineError.permanent('capability_not_granted', 'This agent is not permitted to read through this Farcaster account.');
  return buildChannelContext(account, ctx.jobId, 'BROAD');
}

async function readiness(ctx: Omit<CapabilityContext, 'signal'>) {
  try { await channel(ctx); return { status: 'AVAILABLE' as const }; }
  catch { return { status: 'UNAVAILABLE' as const, why: 'Link a connected Farcaster account and grant reading first.' }; }
}

/** Posts and replies remain pipeline actions behind POST and REPLY grants. */
export function registerFarcasterCapabilities(): void {
  registerCapability(defineCapability({
    id: 'farcaster.read_cast', name: 'Read a Farcaster cast',
    description: 'Read one Farcaster cast by its full farcaster:FID:hash reference, including its author and text.',
    category: 'READ', effect: 'READ', risk: 'LOW', modelCallable: true, timeoutMs: 30_000,
    input: z.object({ cast: FarcasterCastReference }), output: ContextPost, readiness,
    async run(input, ctx) { return farcasterReads.readPost(await channel(ctx), input.cast); },
  }));
  registerCapability(defineCapability({
    id: 'farcaster.read_thread', name: 'Read a Farcaster conversation',
    description: 'Read the ancestor conversation of a Farcaster cast by its full farcaster:FID:hash reference.',
    category: 'READ', effect: 'READ', risk: 'LOW', modelCallable: true, timeoutMs: 60_000,
    input: z.object({ cast: FarcasterCastReference }), output: ResolvedContext, readiness,
    async run(input, ctx) { return farcasterReads.readThread(await channel(ctx), input.cast); },
  }));
  for (const [id, type, risk] of [
    ['farcaster.like', 'LIKE', 'MEDIUM'], ['farcaster.recast', 'REPOST', 'HIGH'],
  ] as const) {
    registerCapability(defineCapability({
      id, name: type === 'LIKE' ? 'Like a Farcaster cast' : 'Recast on Farcaster',
      description: type === 'LIKE' ? 'Acknowledge one Farcaster cast with a like.'
        : 'Share one Farcaster cast with the followers of this account, without adding commentary.',
      category: 'ENGAGE', effect: 'WRITE', risk, unsetPermission: 'DISABLED', modelCallable: true, timeoutMs: 60_000,
      input: z.object({ cast: FarcasterCastReference }),
      output: z.object({ performed: z.boolean(), alreadyDone: z.boolean(), detail: z.string() }),
      async readiness(ctx) {
        if (!ctx.jobId) return { status: 'UNAVAILABLE' as const, why: 'Farcaster actions require a durable job.' };
        return readiness(ctx);
      },
      async run(input, ctx) {
        await channel(ctx);
        const job = ctx.jobId ? await jobs.getJob(ctx.jobId) : null;
        if (!job || job.agentId !== ctx.agentId || job.accountId !== ctx.accountId || job.channel !== 'farcaster') {
          throw PipelineError.permanent('farcaster_wrong_job', 'This action must belong to this agent\'s Farcaster job.');
        }
        const granted = await capabilities.grantsFor(ctx.agentId, ctx.accountId!);
        if (!granted.has(type)) throw PipelineError.permanent('capability_not_granted', `This agent is not permitted to ${type} through this account.`);
        if (!job.dryRun) {
          const gate = await remoteActionsAllowed();
          if (!gate.allowed) throw PipelineError.retryable('paused', gate.reason, { retryAfterMs: 60_000 });
          const bundle = await loadJobBundle(job);
          const rate = await checkActionRate(ctx.agentId, bundle.policy, ctx.accountId, 'BROAD');
          if (!rate.allow) throw PipelineError.retryable(rate.reason, rate.message, { retryAfterMs: rate.retryAfterMs });
        }
        const result = await performCapabilityAction({ agentId: ctx.agentId, jobId: job.id, accountId: ctx.accountId!,
          capabilityId: id, type, targetRef: input.cast, text: '', jobIdempotencyKey: job.idempotencyKey, dryRun: job.dryRun });
        return { performed: result.performed, alreadyDone: result.alreadyDone, detail: result.detail };
      },
    }));
  }
}
