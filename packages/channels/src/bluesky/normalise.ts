import { z } from 'zod';
import type {
  BlueskyAuthor,
  BlueskyPost,
  BlueskyProfile,
  ContextPost,
  ConversationContext,
  NormalizedEvent,
} from '@xbam/shared/contracts';
import { parseAtUri, postPermalink, POST_COLLECTION } from './uri';

/**
 * Bluesky's payloads, turned into the shapes the rest of AI17Z understands.
 *
 * Pure on purpose, so every case below is a fixture and not a network call. This
 * file and `client.ts` are the only places that know a notification has a
 * `reason` and a post has a `record`; everything above them reads the
 * normalised contracts.
 *
 * Foreign payloads are parsed loosely. A field the AppView adds tomorrow must
 * not break a poll today, so unknown keys pass through and only what is used is
 * required. What is required is required for a reason: a post without a URI or
 * a CID cannot be replied to, so it is refused here rather than half-handled.
 */

const Ref = z.object({ uri: z.string(), cid: z.string() }).loose();

const Author = z
  .object({
    did: z.string(),
    handle: z.string(),
    displayName: z.string().optional(),
    // Newer AppViews report verification; older ones omit it entirely.
    verification: z.object({ verifiedStatus: z.string().optional() }).loose().optional(),
    // What the signed-in account's relationship to this author is. Only read to
    // know whether a reply would be refused.
    viewer: z.object({ blockedBy: z.boolean().optional(), blocking: z.string().optional() }).loose().optional(),
  })
  .loose();

const PostRecord = z
  .object({
    $type: z.string().optional(),
    text: z.string().default(''),
    createdAt: z.string().optional(),
    reply: z.object({ root: Ref, parent: Ref }).loose().optional(),
  })
  .loose();

const PostView = z
  .object({
    uri: z.string(),
    cid: z.string(),
    author: Author,
    record: PostRecord,
    indexedAt: z.string().optional(),
    likeCount: z.number().optional(),
    repostCount: z.number().optional(),
    replyCount: z.number().optional(),
    quoteCount: z.number().optional(),
    embed: z.object({ $type: z.string().optional(), images: z.array(z.unknown()).optional() }).loose().optional(),
    viewer: z
      .object({
        like: z.string().optional(),
        repost: z.string().optional(),
        replyDisabled: z.boolean().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();
export type PostView = z.infer<typeof PostView>;

export function parsePostViews(body: unknown): PostView[] {
  const posts = (body as { posts?: unknown } | null)?.posts;
  if (!Array.isArray(posts)) return [];
  const out: PostView[] = [];
  for (const entry of posts) {
    const parsed = PostView.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

const Notification = z
  .object({
    uri: z.string(),
    cid: z.string(),
    author: Author,
    reason: z.string(),
    reasonSubject: z.string().optional(),
    record: PostRecord,
    isRead: z.boolean().optional(),
    indexedAt: z.string(),
  })
  .loose();
export type BlueskyNotification = z.infer<typeof Notification>;

export function parseNotifications(body: unknown): { items: BlueskyNotification[]; skipped: number } {
  const list = (body as { notifications?: unknown } | null)?.notifications;
  if (!Array.isArray(list)) return { items: [], skipped: 0 };
  const items: BlueskyNotification[] = [];
  let skipped = 0;
  for (const entry of list) {
    const parsed = Notification.safeParse(entry);
    if (parsed.success) items.push(parsed.data);
    else skipped += 1;
  }
  return { items, skipped };
}

// -- Authors ----------------------------------------------------------------

/** True, false, or null for "the network did not say". Three states on purpose. */
export function verifiedOf(author: z.infer<typeof Author>): boolean | null {
  const status = author.verification?.verifiedStatus;
  if (status === undefined) return null;
  if (status === 'valid') return true;
  if (status === 'none' || status === 'invalid') return false;
  return null;
}

function authorOf(author: z.infer<typeof Author>): BlueskyAuthor {
  const verified = verifiedOf(author);
  return {
    handle: author.handle,
    did: author.did,
    ...(author.displayName ? { displayName: author.displayName } : {}),
    ...(verified === null ? {} : { verified }),
  };
}

// -- Posts -------------------------------------------------------------------

export function toBlueskyPost(view: PostView): BlueskyPost {
  const reply = view.record.reply;
  const images = view.embed?.images?.length;
  return {
    uri: view.uri,
    cid: view.cid,
    url: postPermalink(view.author.handle, view.uri) ?? view.uri,
    author: authorOf(view.author),
    text: view.record.text,
    ...(view.record.createdAt ? { postedAt: view.record.createdAt } : {}),
    ...(reply ? { replyToUri: reply.parent.uri, rootUri: reply.root.uri } : {}),
    // Counts the network left out stay out. Absent is not zero.
    ...(view.likeCount === undefined ? {} : { likeCount: view.likeCount }),
    ...(view.repostCount === undefined ? {} : { repostCount: view.repostCount }),
    ...(view.replyCount === undefined ? {} : { replyCount: view.replyCount }),
    ...(view.quoteCount === undefined ? {} : { quoteCount: view.quoteCount }),
    ...(images === undefined ? {} : { imageCount: images }),
  };
}

export function toContextPost(view: PostView, selfDid: string | null): ContextPost {
  return {
    remoteId: view.uri,
    remoteUrl: postPermalink(view.author.handle, view.uri),
    authorHandle: view.author.handle,
    authorDisplayName: view.author.displayName ?? null,
    text: view.record.text,
    createdAt: view.record.createdAt ?? view.indexedAt ?? null,
    isSelf: selfDid !== null && view.author.did === selfDid,
    authorVerified: verifiedOf(view.author),
  };
}

export function toBlueskyProfile(body: unknown): BlueskyProfile | null {
  const parsed = z
    .object({
      did: z.string(),
      handle: z.string(),
      displayName: z.string().optional(),
      description: z.string().optional(),
      followersCount: z.number().optional(),
      followsCount: z.number().optional(),
      postsCount: z.number().optional(),
      verification: z.object({ verifiedStatus: z.string().optional() }).loose().optional(),
    })
    .loose()
    .safeParse(body);
  if (!parsed.success) return null;
  const p = parsed.data;
  const verified = verifiedOf({ did: p.did, handle: p.handle, ...(p.verification ? { verification: p.verification } : {}) });
  return {
    handle: p.handle,
    did: p.did,
    ...(p.displayName ? { displayName: p.displayName } : {}),
    ...(p.description ? { description: p.description } : {}),
    ...(p.followersCount === undefined ? {} : { followerCount: p.followersCount }),
    ...(p.followsCount === undefined ? {} : { followingCount: p.followsCount }),
    ...(p.postsCount === undefined ? {} : { postCount: p.postsCount }),
    ...(verified === null ? {} : { verified }),
  };
}

// -- Notifications -> events --------------------------------------------------

/**
 * Which notification reasons are somebody writing to the agent.
 *
 * A like, a repost and a follow are not a message and are not events: there is
 * nothing to answer. A quote is somebody putting their own words around the
 * agent's post, which is addressed to it as much as a mention is.
 */
const REASON_TO_EVENT: Record<string, NormalizedEvent['type']> = {
  mention: 'MENTION',
  reply: 'REPLY',
  quote: 'MENTION',
};

export function eventTypeForReason(reason: string): NormalizedEvent['type'] | null {
  return REASON_TO_EVENT[reason] ?? null;
}

/**
 * One notification as an event, or null when it is not one to act on.
 *
 * The post's at:// URI is the idempotency anchor, so the same mention seen on
 * two polls is one row under `events (channel, account, remote_event_id)`, and a
 * reply and a mention in the same post are one event rather than two.
 */
export function notificationToEvent(
  notification: BlueskyNotification,
  self: { did: string; handle: string },
): NormalizedEvent | null {
  const type = eventTypeForReason(notification.reason);
  if (!type) return null;
  // Only a post can be answered. A notification about a list or a starter pack
  // is not a message.
  const record = notification.record;
  if (record.$type !== undefined && record.$type !== POST_COLLECTION) return null;
  if (!parseAtUri(notification.uri)) return null;
  // The agent's own words, notified back to it by a thread it is in.
  if (notification.author.did === self.did) return null;

  const reply = record.reply;
  return {
    channel: 'bluesky',
    type,
    remoteEventId: notification.uri,
    remoteMessageId: notification.uri,
    remoteAuthorId: notification.author.did,
    remoteAuthorHandle: notification.author.handle,
    remoteAuthorDisplayName: notification.author.displayName ?? null,
    remoteConversationId: reply?.root.uri ?? notification.uri,
    parentRemoteMessageId: reply?.parent.uri ?? null,
    remoteUrl: postPermalink(notification.author.handle, notification.uri),
    text: record.text,
    occurredAt: record.createdAt ?? notification.indexedAt,
    raw: {
      // A mention, a reply or a quote is by definition addressed to the agent.
      // The engagement heuristic reads this rather than guessing from text.
      addressedToAgent: true,
      reason: notification.reason,
      cid: notification.cid,
      indexedAt: notification.indexedAt,
      author: {
        did: notification.author.did,
        handle: notification.author.handle,
        verified: verifiedOf(notification.author),
      },
    },
  };
}

// -- Threads -----------------------------------------------------------------

interface ThreadNodeShape {
  $type?: string;
  post?: unknown;
  parent?: unknown;
}

/** A thread node is an object; whatever else it holds is read when it is used. */
function asNode(value: unknown): ThreadNodeShape | null {
  return value !== null && typeof value === 'object' ? (value as ThreadNodeShape) : null;
}

export type ThreadBranch =
  | { found: false; reason: 'NOT_FOUND' | 'BLOCKED' | 'UNREADABLE' }
  | {
      found: true;
      focal: PostView;
      /** Root first, direct parent last. */
      ancestors: PostView[];
      /** Why the chain stops short of the root, when it does. */
      truncated: 'BLOCKED' | 'NOT_FOUND' | 'DEPTH' | null;
    };

/**
 * Reads a `getPostThread` answer as the branch leading to the focal post.
 *
 * The AppView has already resolved the reply chain, so ancestors are the
 * `parent` links of the focal node and sibling branches are never in the answer:
 * excluded structurally, not filtered afterwards. A parent that is blocked or
 * deleted ends the chain there, and the answer says so rather than pretending
 * the thread starts at the post above the gap.
 */
export function branchFromThread(body: unknown, maxAncestors: number): ThreadBranch {
  const node = asNode((body as { thread?: unknown } | null)?.thread);
  if (!node) return { found: false, reason: 'UNREADABLE' };
  if (node.$type?.endsWith('#notFoundPost')) return { found: false, reason: 'NOT_FOUND' };
  if (node.$type?.endsWith('#blockedPost')) return { found: false, reason: 'BLOCKED' };
  const focal = PostView.safeParse(node.post);
  if (!focal.success) return { found: false, reason: 'UNREADABLE' };

  const chain: PostView[] = [];
  let truncated: 'BLOCKED' | 'NOT_FOUND' | 'DEPTH' | null = null;
  let cursor = asNode(node.parent);
  while (cursor) {
    if (cursor.$type?.endsWith('#blockedPost')) {
      truncated = 'BLOCKED';
      break;
    }
    if (cursor.$type?.endsWith('#notFoundPost')) {
      truncated = 'NOT_FOUND';
      break;
    }
    const view = PostView.safeParse(cursor.post);
    if (!view.success) break;
    chain.push(view.data);
    const above = asNode(cursor.parent);
    if (chain.length >= maxAncestors && above) {
      truncated = 'DEPTH';
      break;
    }
    cursor = above;
  }

  return { found: true, focal: focal.data, ancestors: chain.reverse(), truncated };
}

export function conversationFromBranch(
  branch: Extract<ThreadBranch, { found: true }>,
  selfDid: string | null,
): ConversationContext {
  const incoming = toContextPost(branch.focal, selfDid);
  const ancestors = branch.ancestors.map((view) => toContextPost(view, selfDid));
  const parent = ancestors.length > 0 ? ancestors[ancestors.length - 1]! : null;
  const root = ancestors.length > 0 ? ancestors[0]! : null;

  const participants: string[] = [];
  for (const post of [...ancestors, incoming]) {
    if (post.authorHandle && !participants.includes(post.authorHandle)) participants.push(post.authorHandle);
  }

  return {
    incoming,
    parent,
    ancestors,
    root,
    quote: null,
    participants,
    excludedCount: 0,
    // Bluesky resolved the chain itself, from the focal post's own URI.
    method: 'STATUS_ANCHORED',
    branchConfirmed: true,
    note: branch.truncated ? THREAD_GAP_NOTES[branch.truncated] : '',
  };
}

/** What to say when a thread stops short of its root, so a gap is not silence. */
export const THREAD_GAP_NOTES = {
  BLOCKED: 'A post above this one is blocked or hidden, so the thread starts later than it really does.',
  NOT_FOUND: 'A post above this one was deleted, so the thread starts later than it really does.',
  DEPTH: 'The thread is longer than is read, so only the nearest posts above this one are included.',
} as const;
