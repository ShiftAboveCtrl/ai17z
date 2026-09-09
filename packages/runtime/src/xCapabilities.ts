import { z } from 'zod';
import { XPost, XProfile, XSearchResult, XThread } from '@xbam/shared/contracts';
import { jobs as jobsRepo } from '@xbam/database';
import { accounts as accountsRepo, workers as workersRepo } from '@xbam/database';
import { readPost, readProfile, readThread, searchPosts } from '@xbam/channels';
import { defineCapability, registerCapability } from '@xbam/tools';
import { buildChannelContext } from './channelContext';
import { performCapabilityAction } from './capabilityActions';

/**
 * X, as capabilities a model may choose.
 *
 * Registered from the runtime rather than from `packages/channels`, and that is
 * the point rather than an accident. A capability needs a `ChannelContext`,
 * which means the account row and its browser session -- database work the
 * channel package does not do and should not start doing. So the channel
 * exports functions that take a context and return normalised shapes, and this
 * module supplies the context. No selector, no DOM and no vendor payload
 * reaches anything above `packages/channels`, which is the rule that has held
 * since the adapter was written.
 *
 * These are reads. Writing through a capability is a different problem with a
 * different answer -- it has to land in the durable action machinery, with
 * exact-target verification, idempotency and remote read-back -- and wiring a
 * write to a browser call from here would be a second execution path beside the
 * one that took months to harden.
 */

/**
 * Which account these run as.
 *
 * A capability arrives with an account id when the job has one. Without it
 * there is nothing to read X as: `docs/ENGINEERING.md` is explicit that X's own
 * index is reachable only as the agent's own signed-in account, and guessing an
 * account would mean reading X as somebody the owner did not choose.
 */
async function contextFor(accountId: string | null, jobId: string | null) {
  if (!accountId) return null;
  const account = await accountsRepo.getAccount(accountId);
  if (!account || account.channel !== 'x') return null;
  return buildChannelContext(account, jobId);
}

/**
 * Whether anything could drive a browser right now.
 *
 * Asked before the permission model, because an owner told "you have not
 * enabled this" about something that could not have worked anyway learns the
 * wrong thing. The same heartbeat the interface reads, so the two cannot
 * disagree about whether a browser exists.
 */
async function browserReadiness(accountId: string | null) {
  if (!accountId) {
    return { status: 'UNAVAILABLE' as const, why: 'This agent has no X account to read as.' };
  }
  const present = await workersRepo.browserWorkerPresent().catch(() => false);
  if (!present) {
    return {
      status: 'UNAVAILABLE' as const,
      why: 'Nothing that can open a browser is running. This is AI17Z itself rather than anything about this agent.',
    };
  }
  return { status: 'AVAILABLE' as const };
}

const readPostCapability = defineCapability({
  id: 'x.read_post',
  name: 'Read a post on X',
  description:
    'Reads one post on X by its id or URL and returns its author, text, and when it was posted. ' +
    'Use it when a post is referred to and you do not already have its words.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    /**
     * An id or a full status URL.
     *
     * Shape-checked here rather than in the implementation, because the
     * mistake a model actually makes is passing the handle it was talking
     * about. `@someone` is a plausible-looking argument that would send a read
     * to a profile page and return nothing about any post, so it is refused
     * with the field named instead.
     */
    post: z
      .string()
      .min(5)
      .max(200)
      .refine((value) => /\/status\/\d{5,25}/.test(value) || /^\d{5,25}$/.test(value.trim()), {
        message: 'must be a post id or a post URL, not a handle',
      }),
  }),
  output: XPost,
  modelCallable: true,
  // Long enough for a status page on a slow connection, short enough that a
  // reply is not held open behind it.
  timeoutMs: 45_000,
  async readiness(ctx) {
    return browserReadiness(ctx.accountId);
  },
  async run(input, ctx) {
    const channel = await contextFor(ctx.accountId, ctx.jobId);
    if (!channel) throw new Error('This agent has no connected X account to read as.');
    return readPost(channel, input.post);
  },
});

const readProfileCapability = defineCapability({
  id: 'x.read_profile',
  name: 'Read an X profile',
  description:
    'Reads one account on X by handle and returns its bio, follower counts where visible, and a few recent posts. ' +
    'Use it when you need to know who somebody is before answering them.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    handle: z.string().min(1).max(20),
  }),
  output: XProfile,
  modelCallable: true,
  timeoutMs: 60_000,
  async readiness(ctx) {
    return browserReadiness(ctx.accountId);
  },
  async run(input, ctx) {
    const channel = await contextFor(ctx.accountId, ctx.jobId);
    if (!channel) throw new Error('This agent has no connected X account to read as.');
    return readProfile(channel, input.handle);
  },
});

const searchCapability = defineCapability({
  id: 'x.search',
  name: 'Search X',
  description:
    'Searches X for posts matching a query and returns what it found, newest first by default. ' +
    'Use it when the answer depends on what people are saying right now rather than on what you know.',
  category: 'DISCOVER',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    query: z.string().min(2).max(200),
    /** Newest first, or X's own ranking. */
    mode: z.enum(['LIVE', 'TOP']).default('LIVE'),
    limit: z.number().int().min(1).max(25).default(10),
  }),
  output: XSearchResult,
  modelCallable: true,
  // Scrolling a timeline is slower than reading one page, and this is the
  // capability most likely to be asked for on a slow connection.
  timeoutMs: 90_000,
  async readiness(ctx) {
    return browserReadiness(ctx.accountId);
  },
  async run(input, ctx) {
    const channel = await contextFor(ctx.accountId, ctx.jobId);
    if (!channel) throw new Error('This agent has no connected X account to search as.');
    return searchPosts(channel, input);
  },
});

const readThreadCapability = defineCapability({
  id: 'x.read_thread',
  name: 'Read a conversation on X',
  description:
    'Reads the whole conversation a post belongs to, root first, and returns every post on that branch. ' +
    'Use it when a post only makes sense in the context of what came before it.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    post: z
      .string()
      .min(5)
      .max(200)
      .refine((value) => /\/status\/\d{5,25}/.test(value) || /^\d{5,25}$/.test(value.trim()), {
        message: 'must be a post id or a post URL, not a handle',
      }),
  }),
  output: XThread,
  modelCallable: true,
  // A conversation is more articles than a single post, and each one is read.
  timeoutMs: 75_000,
  async readiness(ctx) {
    return browserReadiness(ctx.accountId);
  },
  async run(input, ctx) {
    const channel = await contextFor(ctx.accountId, ctx.jobId);
    if (!channel) throw new Error('This agent has no connected X account to read as.');
    return readThread(channel, input.post);
  },
});

/**
 * Liking a post, which is the first thing a model may do rather than read.
 *
 * A write, so it is DISABLED by default and an owner has to decide -- an agent
 * that looks things up unasked is useful, one that acts unasked is a decision
 * somebody makes. Chosen first because a like is the smallest real write there
 * is: no text, desired-state rather than a toggle, and `ensureEngaged` already
 * treats "already liked" as success rather than something to undo.
 *
 * It goes nowhere near the browser from here. `performCapabilityAction` claims
 * a durable action under an idempotency key derived from the job's, asks the
 * remote before retaking anything a dead worker left behind, and runs the same
 * verify-then-execute the reply path runs. A capability that called Chrome
 * directly would be a second execution path beside the one that took months to
 * harden.
 */
const likeCapability = defineCapability({
  id: 'x.like',
  name: 'Like a post on X',
  description:
    'Likes one post on X, by id or URL. Use it when something deserves acknowledging and a reply would add nothing.',
  category: 'ENGAGE',
  effect: 'WRITE',
  risk: 'MEDIUM',
  input: z.object({
    post: z
      .string()
      .min(5)
      .max(200)
      .refine((value) => /\/status\/\d{5,25}/.test(value) || /^\d{5,25}$/.test(value.trim()), {
        message: 'must be a post id or a post URL, not a handle',
      }),
  }),
  output: z.object({
    liked: z.boolean(),
    alreadyLiked: z.boolean(),
    post: z.string(),
    detail: z.string(),
  }),
  modelCallable: true,
  timeoutMs: 90_000,
  async readiness(ctx) {
    if (!ctx.jobId) {
      // Every remote action belongs to a durable job, because that is what
      // carries the idempotency key and what a crash is recovered against.
      return { status: 'UNAVAILABLE' as const, why: 'Acting on X only happens inside a job.' };
    }
    return browserReadiness(ctx.accountId);
  },
  async run(input, ctx) {
    const job = ctx.jobId ? await jobsRepo.getJob(ctx.jobId) : null;
    if (!job || !ctx.accountId) throw new Error('This action has no job to belong to.');
    const targetRef = normaliseStatus(input.post);
    const result = await performCapabilityAction({
      agentId: ctx.agentId,
      jobId: job.id,
      accountId: ctx.accountId,
      capabilityId: 'x.like',
      type: 'LIKE',
      targetRef,
      text: '',
      jobIdempotencyKey: job.idempotencyKey,
      // A dry-run job stays a dry run all the way down. Anything else would
      // make the safety net leak at exactly the point it matters.
      dryRun: job.dryRun,
    });
    return {
      liked: result.performed,
      alreadyLiked: result.alreadyDone,
      post: targetRef,
      detail: result.detail,
    };
  },
});

/**
 * Reposting, which is the other desired-state engagement.
 *
 * Same shape as liking and the same machinery underneath, but a higher risk on
 * purpose: a like is a private-ish acknowledgement and a repost puts somebody
 * else's words in front of the agent's own followers under its own name. The
 * default for both is off; the difference is what an owner is deciding about
 * when they turn one on.
 */
const repostCapability = defineCapability({
  id: 'x.repost',
  name: 'Repost on X',
  description:
    'Reposts one post on X, by id or URL. Use it when something is worth putting in front of the followers of this account as it stands.',
  category: 'ENGAGE',
  effect: 'WRITE',
  risk: 'HIGH',
  input: z.object({
    post: z
      .string()
      .min(5)
      .max(200)
      .refine((value) => /\/status\/\d{5,25}/.test(value) || /^\d{5,25}$/.test(value.trim()), {
        message: 'must be a post id or a post URL, not a handle',
      }),
  }),
  output: z.object({
    reposted: z.boolean(),
    alreadyReposted: z.boolean(),
    post: z.string(),
    detail: z.string(),
  }),
  modelCallable: true,
  timeoutMs: 90_000,
  async readiness(ctx) {
    if (!ctx.jobId) {
      return { status: 'UNAVAILABLE' as const, why: 'Acting on X only happens inside a job.' };
    }
    return browserReadiness(ctx.accountId);
  },
  async run(input, ctx) {
    const job = ctx.jobId ? await jobsRepo.getJob(ctx.jobId) : null;
    if (!job || !ctx.accountId) throw new Error('This action has no job to belong to.');
    const targetRef = normaliseStatus(input.post);
    const result = await performCapabilityAction({
      agentId: ctx.agentId,
      jobId: job.id,
      accountId: ctx.accountId,
      capabilityId: 'x.repost',
      type: 'REPOST',
      targetRef,
      text: '',
      jobIdempotencyKey: job.idempotencyKey,
      dryRun: job.dryRun,
    });
    return {
      reposted: result.performed,
      alreadyReposted: result.alreadyDone,
      post: targetRef,
      detail: result.detail,
    };
  },
});

/** A post reference the action path will accept: always a full status URL. */
function normaliseStatus(reference: string): string {
  const id = reference.match(/\/status\/(\d{5,25})/)?.[1] ?? reference.trim();
  return `https://x.com/i/web/status/${id}`;
}

/** Registered at bootstrap, beside the built-ins. */
export function registerXCapabilities(): void {
  registerCapability(readPostCapability);
  registerCapability(readProfileCapability);
  registerCapability(searchCapability);
  registerCapability(readThreadCapability);
  registerCapability(likeCapability);
  registerCapability(repostCapability);
}
