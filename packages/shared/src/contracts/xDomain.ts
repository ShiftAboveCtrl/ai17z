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
});
export type XNotification = z.infer<typeof XNotification>;

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
