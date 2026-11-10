import { z } from 'zod';
import { BlueskyPost, BlueskyProfile, BlueskyThread } from '@xbam/shared/contracts';
import { PipelineError } from '@xbam/shared';
import { accounts as accountsRepo, jobs as jobsRepo } from '@xbam/database';
import { blueskyReads, isBlueskyPostUri, parseBlueskyPostReference } from '@xbam/channels';
import { defineCapability, registerCapability } from '@xbam/tools';
import { performCapabilityAction } from './capabilityActions';
import { checkReadCapacity, noteXFailure, noteXRead } from './capacity';
import { buildChannelContext } from './channelContext';

/**
 * Bluesky, as capabilities a model may choose.
 *
 * The same arrangement as X's (`xCapabilities.ts`): registered from the runtime
 * because a capability needs a `ChannelContext`, which means the account row,
 * and the channel package does not do database work. Nothing about records,
 * CIDs or XRPC reaches this file; the reads return the normalised contracts.
 *
 * ### What is here and what is deliberately not
 *
 * Three reads and one write. **Posting and replying are not model-callable.**
 * They are the `POST` and `REPLY` grants on the account, performed by the
 * pipeline behind the validator, cadence, rate limits, idempotency and exact
 * target verification, and checked at ingest and again before execution. A
 * capability that published directly would be a second execution path beside
 * the one that took months to harden, and X has no `x.post` for the same reason.
 * Revoking `POST` is what stops `bluesky.post`; the vocabulary shares names with
 * `ActionType` on purpose (see docs/architecture/CAPABILITIES.md).
 *
 * The one write a model may choose is a like, which is the smallest real write
 * there is, desired-state rather than a toggle, and off until an owner turns it on.
 *
 * ### Reads spend from the one budget
 *
 * Every call here is a read of Bluesky on an account's behalf. It goes through
 * `checkReadCapacity` and `noteXRead` like every other read, as BROAD work,
 * which yields first: a model looking something up unasked must never be what
 * pushes an account into a cooldown that stops it answering people.
 */

const postReference = z
  .string()
  .min(10)
  .max(300)
  .refine((value) => parseBlueskyPostReference(value) !== null, {
    message: 'must be an at:// post URI or a bsky.app post address, not a handle',
  });

/** The account a Bluesky capability acts as, or null with nothing to act as. */
async function blueskyContext(accountId: string | null, jobId: string | null) {
  if (!accountId) return null;
  const account = await accountsRepo.getAccount(accountId);
  if (!account || account.channel !== 'bluesky') return null;
  return buildChannelContext(account, jobId);
}

async function readiness(accountId: string | null) {
  if (!accountId) {
    return {
      status: 'UNAVAILABLE' as const,
      why:
        'Nothing here is attached to a Bluesky account, so Bluesky cannot be read as anybody. ' +
        'A typed rehearsal runs on the mock channel by design.',
    };
  }
  const account = await accountsRepo.getAccount(accountId);
  if (!account || account.channel !== 'bluesky') {
    return { status: 'UNAVAILABLE' as const, why: 'This job is not on a Bluesky account.' };
  }
  if (account.status !== 'CONNECTED') {
    return {
      status: 'UNAVAILABLE' as const,
      why: 'The Bluesky account is not connected. Store its app password and connect it again.',
    };
  }
  return { status: 'AVAILABLE' as const };
}

/** One read, counted, and held back while the account needs a rest. */
async function spend<T>(accountId: string, read: () => Promise<T>): Promise<T> {
  const capacity = await checkReadCapacity(accountId, 'BROAD').catch(() => null);
  if (capacity && !capacity.allowed) {
    throw PipelineError.retryable('account_capacity', capacity.message, {
      retryAfterMs: capacity.retryAfterMs ?? 10 * 60_000,
    });
  }
  try {
    const result = await read();
    await noteXRead(accountId, 'BROAD');
    return result;
  } catch (error) {
    await noteXRead(accountId, 'BROAD');
    await noteXFailure(accountId, 'BROAD', error instanceof Error ? error.message : String(error));
    throw error;
  }
}

const readPostCapability = defineCapability({
  id: 'bluesky.read_post',
  name: 'Read a post on Bluesky',
  description:
    'Reads one post on Bluesky by its at:// URI or bsky.app address and returns its author, text and when it was posted. ' +
    'Use it when a post is referred to and you do not already have its words.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ post: postReference }),
  output: BlueskyPost,
  modelCallable: true,
  timeoutMs: 30_000,
  async readiness(ctx) {
    return readiness(ctx.accountId);
  },
  async run(input, ctx) {
    const channel = await blueskyContext(ctx.accountId, ctx.jobId);
    if (!channel) throw new Error('This agent has no connected Bluesky account to read as.');
    return spend(channel.account.id, () => blueskyReads.readPost(channel, input.post));
  },
});

const readThreadCapability = defineCapability({
  id: 'bluesky.read_thread',
  name: 'Read a conversation on Bluesky',
  description:
    'Reads the conversation a Bluesky post belongs to, root first, and returns every post above it on that branch. ' +
    'Use it when a post only makes sense in the context of what came before it.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ post: postReference }),
  output: BlueskyThread,
  modelCallable: true,
  timeoutMs: 45_000,
  async readiness(ctx) {
    return readiness(ctx.accountId);
  },
  async run(input, ctx) {
    const channel = await blueskyContext(ctx.accountId, ctx.jobId);
    if (!channel) throw new Error('This agent has no connected Bluesky account to read as.');
    return spend(channel.account.id, () => blueskyReads.readThread(channel, input.post));
  },
});

const readProfileCapability = defineCapability({
  id: 'bluesky.read_profile',
  name: 'Read a Bluesky profile',
  description:
    'Reads one account on Bluesky by handle and returns its bio and follower counts where Bluesky shows them. ' +
    'Use it when you need to know who somebody is before answering them.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ handle: z.string().min(3).max(253) }),
  output: BlueskyProfile,
  modelCallable: true,
  timeoutMs: 30_000,
  async readiness(ctx) {
    return readiness(ctx.accountId);
  },
  async run(input, ctx) {
    const channel = await blueskyContext(ctx.accountId, ctx.jobId);
    if (!channel) throw new Error('This agent has no connected Bluesky account to read as.');
    return spend(channel.account.id, () => blueskyReads.readProfile(channel, input.handle));
  },
});

/**
 * Liking a post. A write, so it is off until an owner decides.
 *
 * It lands in the durable action machinery, never a direct call: a claimed
 * action under an idempotency key derived from the job's, the remote asked
 * before anything a dead worker left behind is retaken, and the same
 * verify-then-execute every reply runs.
 */
const likeCapability = defineCapability({
  id: 'bluesky.like',
  name: 'Like a post on Bluesky',
  description:
    'Likes one post on Bluesky, by its at:// URI or bsky.app address. Use it when something deserves acknowledging and a reply would add nothing.',
  category: 'ENGAGE',
  effect: 'WRITE',
  risk: 'MEDIUM',
  input: z.object({ post: postReference }),
  output: z.object({
    liked: z.boolean(),
    alreadyLiked: z.boolean(),
    post: z.string(),
    detail: z.string(),
  }),
  modelCallable: true,
  timeoutMs: 60_000,
  async readiness(ctx) {
    if (!ctx.jobId) return { status: 'UNAVAILABLE' as const, why: 'Acting on Bluesky only happens inside a job.' };
    return readiness(ctx.accountId);
  },
  async run(input, ctx) {
    const job = ctx.jobId ? await jobsRepo.getJob(ctx.jobId) : null;
    if (!job || !ctx.accountId) throw new Error('This action has no job to belong to.');
    const channel = await blueskyContext(ctx.accountId, ctx.jobId);
    if (!channel) throw new Error('This agent has no connected Bluesky account to act as.');

    // A web address names its author by handle; the action path wants the URI.
    const reference = parseBlueskyPostReference(input.post);
    const targetRef =
      reference?.kind === 'uri' && isBlueskyPostUri(reference.uri)
        ? reference.uri
        : await blueskyReads.resolvePostUri(channel, input.post);

    const result = await performCapabilityAction({
      agentId: ctx.agentId,
      jobId: job.id,
      accountId: ctx.accountId,
      capabilityId: 'bluesky.like',
      type: 'LIKE',
      targetRef,
      text: '',
      jobIdempotencyKey: job.idempotencyKey,
      // A dry-run job stays a dry run all the way down.
      dryRun: job.dryRun,
    });
    return { liked: result.performed, alreadyLiked: result.alreadyDone, post: targetRef, detail: result.detail };
  },
});

/** Registered at bootstrap, beside X's. */
export function registerBlueskyCapabilities(): void {
  registerCapability(readPostCapability);
  registerCapability(readThreadCapability);
  registerCapability(readProfileCapability);
  registerCapability(likeCapability);
}
