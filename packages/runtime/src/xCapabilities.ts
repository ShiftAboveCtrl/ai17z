import { z } from 'zod';
import { XPost, XProfile, XSearchResult } from '@xbam/shared/contracts';
import { accounts as accountsRepo, workers as workersRepo } from '@xbam/database';
import { readPost, readProfile, searchPosts } from '@xbam/channels';
import { defineCapability, registerCapability } from '@xbam/tools';
import { buildChannelContext } from './channelContext';

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

/** Registered at bootstrap, beside the built-ins. */
export function registerXCapabilities(): void {
  registerCapability(readPostCapability);
  registerCapability(readProfileCapability);
  registerCapability(searchCapability);
}
