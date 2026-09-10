import { z } from 'zod';

/**
 * What X looks like to everything above the adapter.
 *
 * `docs/ENGINEERING.md` is explicit: nothing downstream of a channel adapter
 * may know what X looks like -- no selector, no cookie, no vendor payload
 * leaves `packages/channels`. That rule already held for the reply pipeline
 * because the only shapes crossing the boundary were the normalised contracts.
 *
 * Capabilities put new pressure on it. A model asking to read a profile means
 * a profile has to cross the same boundary, and the lazy version of that is a
 * blob of scraped text with the DOM's shape still visible in it. These are the
 * shapes instead: what a person would say is on the page, with no trace of how
 * it was obtained.
 *
 * Everything optional is optional because X does not always show it, not
 * because the adapter sometimes cannot be bothered. A field that is absent
 * means "not visible", and the difference between that and zero matters --
 * `docs/ENGINEERING.md` says an unread image is an explicit gap rather than
 * silence, and the same is true of a follower count behind a login wall.
 */

/** Who wrote something. The handle is the identity; the rest is decoration. */
export const XAuthor = z.object({
  handle: z.string(),
  displayName: z.string().optional(),
  /** X's own numeric id where the page exposed it. Immutable; a handle is not. */
  remoteUserId: z.string().optional(),
  verified: z.boolean().optional(),
});
export type XAuthor = z.infer<typeof XAuthor>;

/** One attached item, described rather than fetched. */
export const XMediaItem = z.object({
  kind: z.enum(['IMAGE', 'VIDEO', 'GIF', 'UNKNOWN']),
  url: z.string().optional(),
  altText: z.string().optional(),
});
export type XMediaItem = z.infer<typeof XMediaItem>;

/**
 * A post, keyed on the status id.
 *
 * The status id is the whole identity: `docs/ENGINEERING.md` says identity is
 * the post and not where it was found, and several radar monitors seeing one
 * post must reconcile to one thing. Anything built on the URL or the author
 * instead would produce duplicates the moment a post is quoted.
 */
export const XPost = z.object({
  statusId: z.string(),
  url: z.string(),
  author: XAuthor,
  text: z.string(),
  postedAt: z.string().optional(),
  media: z.array(XMediaItem).default([]),
  /** Present when this post is itself a reply. */
  inReplyToStatusId: z.string().optional(),
  /** Present when this post quotes another. */
  quotedStatusId: z.string().optional(),
  /** Public counts, where the page showed them. Absent is not zero. */
  replyCount: z.number().int().nonnegative().optional(),
  repostCount: z.number().int().nonnegative().optional(),
  likeCount: z.number().int().nonnegative().optional(),
  viewCount: z.number().int().nonnegative().optional(),
});
export type XPost = z.infer<typeof XPost>;

/**
 * A conversation, root first, with the post that was asked about marked.
 *
 * Not a tree. On a status page X has already resolved the reply chain and
 * renders the path from root to focal, so the ancestors are the articles before
 * the focal one and sibling branches are excluded structurally. Returning a
 * tree would mean inventing branches the page never showed.
 */
export const XThread = z.object({
  focalStatusId: z.string(),
  posts: z.array(XPost),
  /** True when the walk stopped at a limit rather than at the root. */
  truncated: z.boolean().default(false),
});
export type XThread = z.infer<typeof XThread>;

/** An account, as its profile page presents it. */
export const XProfile = z.object({
  handle: z.string(),
  displayName: z.string().optional(),
  remoteUserId: z.string().optional(),
  bio: z.string().optional(),
  location: z.string().optional(),
  website: z.string().optional(),
  joined: z.string().optional(),
  verified: z.boolean().optional(),
  followerCount: z.number().int().nonnegative().optional(),
  followingCount: z.number().int().nonnegative().optional(),
  /** Whether the signed-in account follows them, where the page said. */
  followedByYou: z.boolean().optional(),
  /** Whether they follow the signed-in account, where the page said. */
  followsYou: z.boolean().optional(),
  pinnedStatusId: z.string().optional(),
  recentPosts: z.array(XPost).default([]),
});
export type XProfile = z.infer<typeof XProfile>;

/**
 * What a search returned, and what it was.
 *
 * The query travels with the results because evidence without its question is
 * not evidence: `docs/ENGINEERING.md` requires a finding to keep the name of
 * its source, and for a search the query is most of the source.
 */
export const XSearchResult = z.object({
  query: z.string(),
  mode: z.enum(['LIVE', 'TOP']),
  posts: z.array(XPost),
  /** True when more existed than were read. */
  more: z.boolean().default(false),
});
export type XSearchResult = z.infer<typeof XSearchResult>;

/** One thing X told the owner had happened. */
export const XNotification = z.object({
  kind: z.enum(['REPLY', 'MENTION', 'REPOST', 'QUOTE', 'LIKE', 'FOLLOW', 'OTHER']),
  actors: z.array(XAuthor).default([]),
  statusId: z.string().optional(),
  text: z.string().optional(),
  occurredAt: z.string().optional(),
  /**
   * How many accounts the notification says were involved beyond those named.
   *
   * X aggregates and links only the first: "alice and 4 others liked your
   * post". Listing five actors would mean inventing four people and listing one
   * would mean losing four, so the count is the only honest form of it.
   */
  others: z.number().int().nonnegative().optional(),
});
export type XNotification = z.infer<typeof XNotification>;

/**
 * Who follows an account, or who it follows.
 *
 * The raw material of the relationship graph, and the one X surface where
 * reading eagerly costs something real -- a large account's follower list is
 * effectively infinite. So a reading is a bounded window that says when it
 * stopped early, never a list that implies it is the whole one.
 */
export const XConnections = z.object({
  /** Whose list this is. */
  handle: z.string(),
  kind: z.enum(['FOLLOWERS', 'FOLLOWING', 'VERIFIED_FOLLOWERS']),
  accounts: z
    .array(
      z.object({
        handle: z.string(),
        displayName: z.string().optional(),
        bio: z.string().optional(),
        /** X's own badge. Only ever true; its absence is X not saying. */
        followsYou: z.boolean().optional(),
      }),
    )
    .default([]),
  more: z.boolean().default(false),
});
export type XConnections = z.infer<typeof XConnections>;

/**
 * One of the timelines the account can already see.
 *
 * The surface travels with the result because these are four different claims
 * about relevance and none of them substitutes for another: Home is what X
 * decided to show, Following is what the account chose, Bookmarks is what it
 * saved, a List is what somebody curated.
 */
export const XTimeline = z.object({
  surface: z.enum(['HOME', 'FOLLOWING', 'BOOKMARKS', 'LIST']),
  listId: z.string().optional(),
  posts: z.array(XPost).default([]),
  more: z.boolean().default(false),
});
export type XTimeline = z.infer<typeof XTimeline>;

/**
 * One direct message conversation, as the inbox lists it.
 *
 * Who has been in touch, and the line X shows as a preview. What was actually
 * said is a separate read, because listing who wrote is a much smaller claim on
 * somebody's privacy than reading what they wrote.
 */
export const XDirectMessageThread = z.object({
  conversationId: z.string(),
  participants: z.array(XAuthor).default([]),
  lastMessage: z.string().optional(),
  lastAt: z.string().optional(),
});
export type XDirectMessageThread = z.infer<typeof XDirectMessageThread>;

/** The direct message inbox. Read only; nothing in AI17Z sends one. */
export const XInbox = z.object({
  threads: z.array(XDirectMessageThread).default([]),
  more: z.boolean().default(false),
});
export type XInbox = z.infer<typeof XInbox>;

/**
 * That two accounts were seen in the same place.
 *
 * Deliberately thin. This records what was observed, never what it means --
 * `docs/ENGINEERING.md` is clear that the entity graph records that two things
 * were named together and makes no other claim, and the same restraint belongs
 * here. Strength, stage and fatigue are the relationship system's business.
 */
export const XRelationshipObservation = z.object({
  handle: z.string(),
  remoteUserId: z.string().optional(),
  kind: z.enum(['REPLIED_TO_US', 'WE_REPLIED', 'QUOTED_US', 'REPOSTED_US', 'MENTIONED_US', 'APPEARED_WITH', 'FOLLOWS_US', 'WE_FOLLOW']),
  statusId: z.string().optional(),
  observedAt: z.string(),
});
export type XRelationshipObservation = z.infer<typeof XRelationshipObservation>;
