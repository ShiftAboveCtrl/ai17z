import { z } from 'zod';
import { XConnections, XInbox, XTimeline, XNotification } from '@xbam/shared/contracts';
import { postAnalytics } from '@xbam/database';
import {
  readConnections,
  readConversation,
  readInbox,
  readNotifications,
  readPostAnalytics,
  readTimeline,
} from '@xbam/channels';
import { defineCapability, registerCapability } from '@xbam/tools';
import { browserReadiness, contextFor, looksLikeAPost } from './xCapabilityContext';

/**
 * The rest of X, as things an agent can be asked to look at.
 *
 * `xCapabilities.ts` covers what a model reaches for mid-answer: a post, a
 * profile, a conversation, a search. These are the surfaces a person opens --
 * what has been happening to me, who follows this account, what is on my
 * timeline, has anyone written to me, how did that post do. They are reads and
 * they are separate for a reason beyond file length: several of them are things
 * an owner may reasonably not want a model choosing on its own, and putting
 * them together makes the permission conversation one conversation.
 *
 * Every one runs on the RESEARCH tab, like every other capability read. A read
 * the model asked for arrives at any moment and must not move a surface another
 * loop is part-way through -- the notifications poller keeps a cursor, and the
 * action tab may be sitting on a half-written post.
 */

const notificationsCapability = defineCapability({
  id: 'x.read_notifications',
  name: 'Read notifications on X',
  description:
    'Reads what X says has happened to this account recently -- replies, mentions, reposts, likes and follows. ' +
    'Use it when asked what has been going on, not to decide what to reply to.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    /** X's own two surfaces. Mentions is the narrower one. */
    surface: z.enum(['ALL', 'MENTIONS']).default('ALL'),
    limit: z.number().int().min(1).max(50).default(15),
  }),
  output: z.object({
    surface: z.enum(['ALL', 'MENTIONS']),
    notifications: z.array(XNotification),
    more: z.boolean(),
  }),
  modelCallable: true,
  timeoutMs: 60_000,
  async readiness(ctx) {
    return browserReadiness(ctx.accountId);
  },
  async run(input, ctx) {
    const channel = await contextFor(ctx.accountId, ctx.jobId);
    if (!channel) throw new Error('This agent has no connected X account to read as.');
    return readNotifications(channel, input);
  },
});

/**
 * Follower and following lists.
 *
 * MEDIUM rather than LOW, which under `defaultPermission` still means allowed:
 * the risk being named is cost, not danger. A large account's follower list is
 * effectively infinite and every screen of it is a request, so this is the one
 * read that can occupy the browser for a while. The hard ceiling is in the
 * channel; the risk level is what makes an owner see it as a choice.
 */
const connectionsCapability = defineCapability({
  id: 'x.read_connections',
  name: 'Read who follows an account',
  description:
    'Reads part of an account’s followers or the accounts it follows, with the "follows you" badge where X shows it. ' +
    'Use it to understand who is around somebody. It reads a window, not the whole list.',
  category: 'RELATIONSHIPS',
  effect: 'READ',
  risk: 'MEDIUM',
  input: z.object({
    handle: z.string().min(1).max(20),
    kind: z.enum(['FOLLOWERS', 'FOLLOWING', 'VERIFIED_FOLLOWERS']).default('FOLLOWERS'),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  output: XConnections,
  modelCallable: true,
  // Scrolling a virtualised list is the slowest read here.
  timeoutMs: 120_000,
  async readiness(ctx) {
    return browserReadiness(ctx.accountId);
  },
  async run(input, ctx) {
    const channel = await contextFor(ctx.accountId, ctx.jobId);
    if (!channel) throw new Error('This agent has no connected X account to read as.');
    return readConnections(channel, input);
  },
});

const timelineCapability = defineCapability({
  id: 'x.read_timeline',
  name: 'Read a timeline on X',
  description:
    'Reads what is on this account’s home timeline, its following feed, its bookmarks, or one of its lists. ' +
    'Use it when the question is what is going on rather than what one particular person said.',
  category: 'DISCOVER',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    surface: z.enum(['HOME', 'FOLLOWING', 'BOOKMARKS', 'LIST']).default('HOME'),
    /** Required for LIST and meaningless otherwise. */
    listId: z.string().regex(/^\d{5,25}$/).optional(),
    limit: z.number().int().min(1).max(50).default(15),
  }),
  output: XTimeline,
  modelCallable: true,
  timeoutMs: 90_000,
  async readiness(ctx) {
    return browserReadiness(ctx.accountId);
  },
  async run(input, ctx) {
    const channel = await contextFor(ctx.accountId, ctx.jobId);
    if (!channel) throw new Error('This agent has no connected X account to read as.');
    return readTimeline(channel, input);
  },
});

/**
 * The direct message inbox.
 *
 * HIGH risk, which under `defaultPermission` means the owner is asked rather
 * than it being allowed the way a public read is. That is the whole reason it
 * is HIGH: a timeline is public and an inbox is private correspondence between
 * two people, only one of whom is the owner. Nobody but the owner can say
 * whether that should end up in a prompt.
 *
 * There is no capability that sends one, and there is not meant to be.
 */
const inboxCapability = defineCapability({
  id: 'x.read_inbox',
  name: 'Read who has sent direct messages',
  description:
    'Lists the direct message conversations on this account: who, when, and the preview line X shows. ' +
    'It does not open any of them.',
  category: 'MESSAGING',
  effect: 'READ',
  risk: 'HIGH',
  input: z.object({
    limit: z.number().int().min(1).max(30).default(10),
  }),
  output: XInbox,
  modelCallable: true,
  timeoutMs: 60_000,
  async readiness(ctx) {
    return browserReadiness(ctx.accountId);
  },
  async run(input, ctx) {
    const channel = await contextFor(ctx.accountId, ctx.jobId);
    if (!channel) throw new Error('This agent has no connected X account to read as.');
    return readInbox(channel, input);
  },
});

/**
 * One conversation's messages.
 *
 * Deliberately a second capability rather than a flag on the first. Listing who
 * has been in touch is a much smaller claim on somebody's privacy than reading
 * what they said, and an owner who is happy with the one is not thereby happy
 * with the other.
 */
const conversationCapability = defineCapability({
  id: 'x.read_conversation',
  name: 'Read one direct message conversation',
  description:
    'Reads the recent messages in one direct message conversation, oldest first, marking which were sent by this account.',
  category: 'MESSAGING',
  effect: 'READ',
  risk: 'HIGH',
  input: z.object({
    conversationId: z.string().regex(/^[0-9-]{3,64}$/),
    limit: z.number().int().min(1).max(40).default(20),
  }),
  output: z.object({
    conversationId: z.string(),
    messages: z.array(
      z.object({
        text: z.string(),
        fromUs: z.boolean(),
        sentAt: z.string().optional(),
      }),
    ),
    truncated: z.boolean(),
  }),
  modelCallable: true,
  timeoutMs: 60_000,
  async readiness(ctx) {
    return browserReadiness(ctx.accountId);
  },
  async run(input, ctx) {
    const channel = await contextFor(ctx.accountId, ctx.jobId);
    if (!channel) throw new Error('This agent has no connected X account to read as.');
    return readConversation(channel, input);
  },
});

/**
 * The author's own figures for one of their posts.
 *
 * Records what it read, exactly as `x.read_post` does, and under a different
 * source: a like read off a timeline and one read off this page were measured
 * by different things and one must not suppress the other. The write is
 * swallowed on failure -- an agent that could not answer because a measurement
 * did not save would be trading the thing for the record of it.
 */
const analyticsCapability = defineCapability({
  id: 'x.read_post_analytics',
  name: 'Read how a post did',
  description:
    'Reads the figures X shows the author of a post: impressions, profile visits, link clicks and the public counts. ' +
    'Only works for posts this account wrote.',
  category: 'ANALYTICS',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    post: z
      .string()
      .min(5)
      .max(200)
      .refine(looksLikeAPost, { message: 'must be a post id or a post URL, not a handle' }),
  }),
  output: z.object({
    statusId: z.string(),
    impressions: z.number().int().nonnegative().optional(),
    likes: z.number().int().nonnegative().optional(),
    reposts: z.number().int().nonnegative().optional(),
    replies: z.number().int().nonnegative().optional(),
    quotes: z.number().int().nonnegative().optional(),
    bookmarks: z.number().int().nonnegative().optional(),
    profileVisits: z.number().int().nonnegative().optional(),
    linkClicks: z.number().int().nonnegative().optional(),
    /** Labels X showed that nothing here maps. Named rather than dropped. */
    unmapped: z.array(z.string()),
  }),
  modelCallable: true,
  timeoutMs: 60_000,
  async readiness(ctx) {
    return browserReadiness(ctx.accountId);
  },
  async run(input, ctx) {
    const channel = await contextFor(ctx.accountId, ctx.jobId);
    if (!channel) throw new Error('This agent has no connected X account to read as.');
    const { statusId, reading } = await readPostAnalytics(channel, input.post);

    if (ctx.accountId) {
      await postAnalytics
        .record({
          agentId: ctx.agentId,
          accountId: ctx.accountId,
          remotePostId: statusId,
          source: 'POST_ANALYTICS',
          impressions: reading.impressions ?? null,
          likes: reading.likes ?? null,
          reposts: reading.reposts ?? null,
          replies: reading.replies ?? null,
          quotes: reading.quotes ?? null,
          bookmarks: reading.bookmarks ?? null,
          profileVisits: reading.profileVisits ?? null,
          linkClicks: reading.linkClicks ?? null,
        })
        .catch(() => undefined);
    }

    return { statusId, ...reading };
  },
});

/** Registered from `registerXCapabilities`, so bootstrap still makes one call. */
export function registerXSurfaceCapabilities(): void {
  registerCapability(notificationsCapability);
  registerCapability(connectionsCapability);
  registerCapability(timelineCapability);
  registerCapability(inboxCapability);
  registerCapability(conversationCapability);
  registerCapability(analyticsCapability);
}
