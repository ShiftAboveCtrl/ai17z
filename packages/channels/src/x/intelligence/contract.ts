/**
 * What AI17Z knows how to read from X, and what it promises about the answer.
 *
 * One layer, several ways of getting the data, and **nothing downstream knows
 * which was used**. A screen asking for somebody's recent posts should not care
 * whether they came from X's own JSON, from articles rendered in a page, or
 * from something read ten minutes ago -- only that they are posts, that they
 * say where they came from, and that they say when.
 *
 * ## Why this exists at all
 *
 * "Learn from this account" was wired to twscrape: a Python library needing a
 * separate install, a place on PATH inside the worker, and X accounts of its
 * own in its own database. No packaged AI17Z has Python, so it reported
 * unavailable on every machine anybody ran, and the feature did nothing. The
 * lesson is not "twscrape was the wrong library" -- it is that a product
 * feature had a brittle scraper wired directly into it, so when the scraper
 * died the feature died with it and there was nowhere else for it to go.
 *
 * This is that nowhere-else-to-go, made somewhere.
 *
 * ## Read-only, deliberately and permanently
 *
 * There is no post, like, follow, repost or message anywhere in this contract
 * and there must never be. AI17Z already owns acting on X -- engagement
 * decisions, policy gates, approvals, the action queue, the composer, the audit
 * trail -- and every one of those exists because acting is the part that can
 * embarrass somebody. A read layer that grew a `follow()` would route around
 * all of it, and the fact that a third-party library happens to expose one is
 * not a reason to.
 *
 * ## Identity is the numeric id, never the handle
 *
 * Handles change. The same person is `@alice` today and `@alice_eth` next
 * month, and a cache, a relationship or a persona source keyed on the handle
 * quietly becomes a record of two different people -- or loses track of one.
 * Every user this layer returns carries `userId`, and the handle travels as an
 * observation of what they were called when it was read.
 *
 * ## Nothing here evades anything
 *
 * Bounded reads at ordinary speed, through a session somebody signed in to
 * themselves. No CAPTCHA solving, no challenge answering, no fingerprint
 * spoofing, no account rotation, no proxy rotation. When X asks for a person,
 * the answer is `NEEDS_SIGN_IN` or `CHALLENGE` and the work stops -- which is
 * the same stop the sign-in watcher makes, for the same reason.
 */

/** Ids are strings. A 19-digit X id is past what a JS number can hold. */
export type XId = string;

/**
 * How a read ended.
 *
 * Every one of these needs a different thing from the person who asked, which
 * is the whole reason they are separate values rather than a boolean and a
 * message. A private account is not a missing one; a rate limit is not a
 * failure; a changed page is not a signed-out browser.
 */
export type XReadOutcome =
  | 'OK'
  /** No such account, or it has been suspended. */
  | 'NOT_FOUND'
  /** It exists and its posts are not public. */
  | 'PROTECTED'
  /** It exists, is readable, and there was nothing to read. */
  | 'EMPTY'
  /** X wants somebody to sign in. Nothing here answers that. */
  | 'NEEDS_SIGN_IN'
  /** X is asking for a CAPTCHA, a code, a device check. Nothing here answers that either. */
  | 'CHALLENGE'
  /** X said to slow down. Honoured, not worked around. */
  | 'RATE_LIMITED'
  /** X answered in a shape this backend no longer understands. */
  | 'SCHEMA_CHANGED'
  /** The backend could not run at all. */
  | 'UNAVAILABLE';

/** Outcomes where trying a different backend is reasonable. */
export const WORTH_ANOTHER_BACKEND: readonly XReadOutcome[] = [
  'SCHEMA_CHANGED',
  'UNAVAILABLE',
  'EMPTY',
];

/**
 * Outcomes that mean stop asking, whatever the backend.
 *
 * A protected account is protected however it is read, and a challenge is a
 * person's to answer. Retrying these on another backend is how a read turns
 * into hammering, and in the challenge case it is how a tool starts arguing
 * with a security check.
 */
export const STOP_ASKING: readonly XReadOutcome[] = [
  'NOT_FOUND',
  'PROTECTED',
  'NEEDS_SIGN_IN',
  'CHALLENGE',
  'RATE_LIMITED',
];

/** Where an answer came from and when, carried with the answer itself. */
export interface XProvenance {
  /** Which backend produced it. Named so a trace can say. */
  backend: string;
  /** When it was read off X. Not when it was asked for. */
  collectedAt: string;
  /** Answered from cache rather than read now. */
  cached: boolean;
  /** The page or endpoint it came from, where there is a meaningful one. */
  url: string | null;
  /**
   * What the backend could not see.
   *
   * A DOM read cannot give exact engagement counts; a search cannot promise it
   * saw everything. Stating the gap is what stops a screen presenting a partial
   * answer as a complete one.
   */
  gaps: string[];
}

/** Somebody on X, as observed. */
export interface XUser {
  /** The immutable numeric id. This is the identity; everything else is an observation. */
  userId: XId;
  /** What they were called when this was read, without the @. */
  handle: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  location: string | null;
  website: string | null;
  followers: number | null;
  following: number | null;
  posts: number | null;
  createdAt: string | null;
  /** X's own badge, when the backend could see it. Null is "did not see", not "no". */
  verified: boolean | null;
  protected: boolean | null;
  provenance: XProvenance;
}

/** What somebody wrote, or passed on. */
export interface XPostRecord {
  postId: XId;
  /** The author's immutable id, when the backend could resolve it. */
  authorId: XId | null;
  authorHandle: string;
  text: string;
  createdAt: string | null;
  url: string;
  /** The thread this belongs to. X's own conversation id where available. */
  conversationId: XId | null;
  replyToPostId: XId | null;
  replyToUserId: XId | null;
  /** The post this quotes, when it quotes one. */
  quotedPostId: XId | null;
  /**
   * Somebody else's post, passed on without comment.
   *
   * Kept and marked rather than dropped here: whether a repost counts depends
   * on what is asking. A persona corpus excludes them because pressing repost
   * is not writing; a relationship observation includes them because passing
   * somebody's post on is a real interaction.
   */
  repost: boolean;
  lang: string | null;
  metrics: XPostMetrics | null;
  media: XMediaRef[];
  links: string[];
  provenance: XProvenance;
}

export interface XPostMetrics {
  replies: number | null;
  reposts: number | null;
  likes: number | null;
  quotes: number | null;
  views: number | null;
  bookmarks: number | null;
}

export interface XMediaRef {
  kind: 'photo' | 'video' | 'gif' | 'unknown';
  url: string | null;
  altText: string | null;
}

/** Anything this layer returns: an answer, how it ended, and where it came from. */
export interface XReadResult<T> {
  outcome: XReadOutcome;
  /** In the words somebody reading a screen needs. Empty for a plain OK. */
  detail: string;
  data: T;
  provenance: XProvenance;
}

/** How fresh an answer has to be for the thing asking. */
export type XFreshness =
  /** An engagement chance goes stale in minutes. */
  | 'LIVE'
  /** A radar sweep or a mention check. */
  | 'RECENT'
  /** A profile card, a follower count. */
  | 'MODERATE'
  /** A persona corpus: last month's posts describe a voice just as well. */
  | 'ARCHIVAL';

/** Seconds a cached answer stays good, per use. */
export const FRESHNESS_SECONDS: Record<XFreshness, number> = {
  LIVE: 60,
  RECENT: 10 * 60,
  MODERATE: 6 * 60 * 60,
  ARCHIVAL: 7 * 24 * 60 * 60,
};

export interface XPostsRequest {
  /** Resolved identity. Backends must not be handed a handle to guess from. */
  userId: XId;
  handle: string;
  /** How many authored posts are wanted. A ceiling, never a promise. */
  limit: number;
  /** Stop when this post is reached: everything above it is already held. */
  sincePostId?: XId | null;
  includeReplies?: boolean;
  includeReposts?: boolean;
  /** Called with the running count, so a screen can show a real number. */
  onProgress?: (collected: number) => void;
  /** Checked between pages, so a person can stop a long collection. */
  signal?: { aborted: boolean };
}

/**
 * What a backend can do.
 *
 * Every method is optional except `resolveUser` and `readiness`: a backend that
 * can only read profiles is worth having, and the layer above asks whoever can.
 * That is the whole of the fallback design -- capability by capability, not
 * backend by backend, so one backend losing search does not cost the product
 * its profile reads.
 */
export interface XIntelligenceBackend {
  /** Short, stable, and safe to show in diagnostics. */
  readonly name: string;
  /**
   * Whether this backend can run right now, and what it can do.
   *
   * Asked rather than assumed, because "installed" and "usable" are different
   * -- the lesson twscrape taught by answering every query with a message about
   * the handle when its real problem was an empty account pool.
   */
  readiness(ctx: XReadContext): Promise<XBackendReadiness>;

  resolveUser(ctx: XReadContext, handle: string): Promise<XReadResult<XUser | null>>;
  getUser?(ctx: XReadContext, userId: XId): Promise<XReadResult<XUser | null>>;
  getUserPosts?(ctx: XReadContext, request: XPostsRequest): Promise<XReadResult<XPostRecord[]>>;
  getPost?(ctx: XReadContext, postId: XId): Promise<XReadResult<XPostRecord | null>>;
  /** A post and the posts above it. Uses the conversation the channel already resolves. */
  getThread?(ctx: XReadContext, postId: XId): Promise<XReadResult<XPostRecord[]>>;
  searchPosts?(
    ctx: XReadContext,
    request: { query: string; limit: number; latest?: boolean },
  ): Promise<XReadResult<XPostRecord[]>>;
}

export type XBackendState =
  | 'READY'
  | 'DEGRADED'
  | 'UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'NEEDS_SIGN_IN'
  | 'CHALLENGE';

export interface XBackendReadiness {
  state: XBackendState;
  detail: string;
  /** Which of the contract's reads this backend can serve right now. */
  can: XCapability[];
}

export type XCapability =
  | 'resolveUser'
  | 'getUser'
  | 'getUserPosts'
  | 'getPost'
  | 'getThread'
  | 'searchPosts';

/**
 * What a backend is given to work with.
 *
 * Deliberately the channel's own context rather than anything new: a backend
 * that reads through the browser needs the session AI17Z already has, and one
 * that does not simply ignores it. Nothing here carries a cookie, a token or a
 * password -- a backend that needs the signed-in session works *inside* the
 * browser that holds it, so the credentials never reach this process, a log, or
 * a model.
 */
export interface XReadContext {
  /** The channel context, when the caller has a browser-capable one. */
  channel: unknown | null;
  /** Bounded by the caller, honoured by the backend. */
  budget: XReadBudget;
}

/**
 * How much reading one operation may do.
 *
 * Central and boring on purpose. Every backend takes the same bounds, so
 * "do not hammer X" is one decision rather than a habit each adapter has to
 * remember, and a change to it applies everywhere at once.
 */
export interface XReadBudget {
  /** Wall clock for the whole operation. */
  maxMs: number;
  /** Pages, scroll passes, requests -- whatever the backend's unit of more is. */
  maxPages: number;
  /** Consecutive pages producing nothing new before it gives up. */
  maxQuietPages: number;
}

export const DEFAULT_BUDGET: XReadBudget = { maxMs: 180_000, maxPages: 40, maxQuietPages: 3 };

/** Everything a backend needs to say where an answer came from. */
export function provenanceFor(
  backend: string,
  over: Partial<Omit<XProvenance, 'backend'>> = {},
): XProvenance {
  return {
    backend,
    collectedAt: over.collectedAt ?? new Date().toISOString(),
    cached: over.cached ?? false,
    url: over.url ?? null,
    gaps: over.gaps ?? [],
  };
}

/** A result carrying nothing, for a read that ended before it started. */
export function emptyResult<T>(
  backend: string,
  outcome: XReadOutcome,
  detail: string,
  data: T,
): XReadResult<T> {
  return { outcome, detail, data, provenance: provenanceFor(backend) };
}
