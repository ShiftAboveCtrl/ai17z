import { z } from 'zod';

/**
 * What Bluesky looks like to everything above the adapter.
 *
 * The same promise `xDomain.ts` makes: no AT Protocol payload leaves
 * `packages/channels`. A model asking to read a post or a profile gets these
 * shapes, with no trace of the record, lexicon or XRPC call they came from.
 *
 * Optional means the network did not say, never that the adapter could not be
 * bothered, and absent is not zero: a post whose reply count the AppView left
 * out has an unknown number of replies, not none.
 */

/** Who wrote something. The DID is the identity; a handle can be changed. */
export const BlueskyAuthor = z.object({
  handle: z.string(),
  did: z.string(),
  displayName: z.string().optional(),
  /** True or false when Bluesky says; absent when it did not. */
  verified: z.boolean().optional(),
});
export type BlueskyAuthor = z.infer<typeof BlueskyAuthor>;

/**
 * A post, keyed on its at:// URI.
 *
 * The URI is the identity: it names the author's repository, the collection and
 * the record. The CID is the version of it, which a reply must quote, and is
 * carried so the action path can show what it replied to.
 */
export const BlueskyPost = z.object({
  uri: z.string(),
  cid: z.string(),
  url: z.string(),
  author: BlueskyAuthor,
  text: z.string(),
  postedAt: z.string().optional(),
  /** The post this one replies to, when it is a reply. */
  replyToUri: z.string().optional(),
  /** The first post of the thread, when this one is a reply. */
  rootUri: z.string().optional(),
  likeCount: z.number().int().min(0).optional(),
  repostCount: z.number().int().min(0).optional(),
  replyCount: z.number().int().min(0).optional(),
  quoteCount: z.number().int().min(0).optional(),
  /** How many pictures are attached. Their content is not read here. */
  imageCount: z.number().int().min(0).optional(),
});
export type BlueskyPost = z.infer<typeof BlueskyPost>;

export const BlueskyProfile = z.object({
  handle: z.string(),
  did: z.string(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  followerCount: z.number().int().min(0).optional(),
  followingCount: z.number().int().min(0).optional(),
  postCount: z.number().int().min(0).optional(),
  verified: z.boolean().optional(),
});
export type BlueskyProfile = z.infer<typeof BlueskyProfile>;

/** A conversation, root first, ending at the post that was asked about. */
export const BlueskyThread = z.object({
  /** The post the read was about. */
  focal: BlueskyPost,
  /** Root first, direct parent last. Empty when the focal post is a root. */
  ancestors: z.array(BlueskyPost).default([]),
  /** Said in a sentence when the branch is incomplete, so a gap is not silence. */
  note: z.string().optional(),
});
export type BlueskyThread = z.infer<typeof BlueskyThread>;
