import { z } from 'zod';
import { TelegramChatId, TelegramChatInfo, TelegramMessageRef, TelegramReaction } from '@xbam/shared/contracts';
import { PipelineError } from '@xbam/shared';
import { accounts, capabilities, jobs } from '@xbam/database';
import { readTelegramChat } from '@xbam/channels';
import { defineCapability, registerCapability } from '@xbam/tools';
import type { CapabilityContext } from '@xbam/tools';
import { buildChannelContext } from './channelContext';
import { performCapabilityAction } from './capabilityActions';
import { loadJobBundle } from './loadJob';
import { checkActionRate } from './policyGate';
import { remoteActionsAllowed } from './killSwitch';

async function channel(ctx: Pick<CapabilityContext, 'accountId' | 'agentId' | 'jobId'>) {
  const account = ctx.accountId ? await accounts.getAccount(ctx.accountId) : null;
  if (!account || account.channel !== 'telegram' || account.status !== 'CONNECTED' || !account.enabled) {
    throw PipelineError.permanent('telegram_unavailable', 'This job needs a connected Telegram account.');
  }
  const grants = await capabilities.grantsFor(ctx.agentId, account.id);
  if (!grants.has('READ')) {
    throw PipelineError.permanent('capability_not_granted', 'This agent is not permitted to read through this Telegram account.');
  }
  return buildChannelContext(account, ctx.jobId);
}

async function readiness(ctx: Omit<CapabilityContext, 'signal'>) {
  try {
    await channel(ctx);
    return { status: 'AVAILABLE' as const };
  } catch {
    return { status: 'UNAVAILABLE' as const, why: 'Link a connected Telegram bot and grant reading first.' };
  }
}

/**
 * The `telegram.` family, kept small on purpose.
 *
 * The Bot API cannot read a group's history or look a message up, so there is
 * no `read_message` or `read_thread` to offer: what an agent knows of a
 * conversation is what the update that woke it carried. Replying is not a
 * capability here either. It is a pipeline action behind the REPLY grant on the
 * account, like every other channel's, and it has no `telegram.reply` for a
 * model to call on its own initiative.
 */
export function registerTelegramCapabilities(): void {
  registerCapability(
    defineCapability({
      id: 'telegram.read_chat',
      name: 'Read a Telegram group',
      description:
        'Read the title, description and member count of one of the Telegram groups this agent was allowed into, by its chat id.',
      category: 'READ',
      effect: 'READ',
      risk: 'LOW',
      modelCallable: true,
      timeoutMs: 30_000,
      input: z.object({ chat: TelegramChatId }),
      output: TelegramChatInfo,
      readiness,
      async run(input, ctx) {
        return readTelegramChat(await channel(ctx), input.chat);
      },
    }),
  );

  registerCapability(
    defineCapability({
      id: 'telegram.react',
      name: 'React to a Telegram message',
      description:
        'Put one emoji reaction on a message in an allowed Telegram group, written telegram:<chat id>:<message id>. Setting the same reaction twice leaves one.',
      category: 'ENGAGE',
      effect: 'WRITE',
      risk: 'MEDIUM',
      unsetPermission: 'DISABLED',
      modelCallable: true,
      timeoutMs: 60_000,
      input: z.object({ message: TelegramMessageRef, reaction: TelegramReaction }),
      output: z.object({ performed: z.boolean(), alreadyDone: z.boolean(), detail: z.string() }),
      async readiness(ctx) {
        if (!ctx.jobId) return { status: 'UNAVAILABLE' as const, why: 'Telegram actions must run inside a job.' };
        return readiness(ctx);
      },
      async run(input, ctx) {
        await channel(ctx);
        const job = ctx.jobId ? await jobs.getJob(ctx.jobId) : null;
        // The action belongs to this agent's own Telegram job and nobody else's.
        if (!job || job.agentId !== ctx.agentId || job.accountId !== ctx.accountId || job.channel !== 'telegram') {
          throw PipelineError.permanent('telegram_wrong_job', 'This action must belong to this agent\'s Telegram job.');
        }
        // Checked again here, as the pipeline checks again before it executes: a
        // grant revoked while the job waited has to stop it.
        const granted = await capabilities.grantsFor(ctx.agentId, ctx.accountId!);
        if (!granted.has('REACT')) {
          throw PipelineError.permanent('capability_not_granted', 'This agent is not permitted to react through this account.');
        }
        if (!job.dryRun) {
          const gate = await remoteActionsAllowed();
          if (!gate.allowed) throw PipelineError.retryable('paused', gate.reason, { retryAfterMs: 60_000 });
          const bundle = await loadJobBundle(job);
          const rate = await checkActionRate(ctx.agentId, bundle.policy, ctx.accountId, 'BROAD');
          if (!rate.allow) throw PipelineError.retryable(rate.reason, rate.message, { retryAfterMs: rate.retryAfterMs });
        }
        const result = await performCapabilityAction({
          agentId: ctx.agentId,
          jobId: job.id,
          accountId: ctx.accountId!,
          capabilityId: 'telegram.react',
          type: 'REACT',
          targetRef: input.message,
          text: input.reaction,
          jobIdempotencyKey: job.idempotencyKey,
          dryRun: job.dryRun,
        });
        return { performed: result.performed, alreadyDone: result.alreadyDone, detail: result.detail };
      },
    }),
  );
}
