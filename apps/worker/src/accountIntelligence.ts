import { createLogger } from '@xbam/shared';
import {
  accounts as accountsRepo,
  relationships as relationshipsRepo,
  xAccountObservations,
  type XAccountObservationRow,
} from '@xbam/database';
import { xIntelligence, type XPostRecord, type XUser } from '@xbam/channels';
import { buildChannelContext, readAccount, type ReadPost } from '@xbam/runtime';

const log = createLogger('account-intelligence');

/**
 * Reading somebody's X account, so the owner can be shown who they are.
 *
 * The same shape as the persona collector and for the same reasons: identity
 * first, the canonical layer does the reading, and what comes back says which
 * reader answered and what it could not see. The difference is the purpose --
 * a persona learns a voice to write in, this describes somebody the agent has
 * been talking to.
 *
 * ### Why a screen cannot do this itself
 *
 * The API owns no browser. Every X read happens in the worker, so the People
 * screen records an intent and reads the row this writes. That is also what
 * makes the cost bounded: a card that read X on render would cost a browser
 * request per person on the screen, against the session the agent needs for its
 * actual work.
 *
 * ### Read-only, structurally
 *
 * Nothing here can follow, like, reply or message. It calls the X intelligence
 * layer, and there is no write anywhere in that contract. Acting on X belongs
 * to the engagement pipeline behind its policies, approvals and audit trail.
 */

/**
 * How much of somebody's writing is read to describe them.
 *
 * Far below the persona target of 240, deliberately. A persona has to imitate a
 * voice, which needs enough examples for the scorer to find the strongest ones.
 * This has to answer "what do they write about and how often", and the topic
 * counter's recurrence floor is satisfied long before sixty posts -- so the rest
 * would be pages of requests bought to move a number nobody reads.
 */
export const ACCOUNT_READ_POSTS = 60;
const MAX_ACCOUNT_READ_POSTS = 200;

export interface AccountIntelligenceResult {
  outcome: string;
  detail: string;
  row: XAccountObservationRow | null;
  /** How many of their posts the reading rests on. */
  postsRead: number;
  backend: string;
}

/**
 * Read an account and record what was found.
 *
 * A refusal is recorded too, and that is the point of recording the outcome
 * rather than only the data. "Nobody has looked yet" and "they made their
 * account private" are different answers, and a screen that cannot tell them
 * apart tells somebody their agent is broken when the truth is that the person
 * they asked about locked their account.
 */
export async function readXAccount(input: {
  ownerUserId: string;
  handle: string;
  /** The account whose browser does the reading. Not the account being read. */
  readerAccountId: string;
  posts?: number;
  /** Ignore anything held and read it again. For an owner who pressed refresh. */
  refresh?: boolean;
  /**
   * The agent this was asked about, when it was asked from an agent's screen.
   *
   * Only ever used to give an existing relationship the numeric id it is
   * missing. Nothing else about the relationship is touched.
   */
  agentId?: string | null;
}): Promise<AccountIntelligenceResult> {
  const handle = input.handle.trim().replace(/^@+/, '');
  const target = Math.min(Math.max(input.posts ?? ACCOUNT_READ_POSTS, 0), MAX_ACCOUNT_READ_POSTS);
  const account = await accountsRepo.requireAccount(input.readerAccountId);
  const channel = await buildChannelContext(account, null);

  const resolved = await xIntelligence.resolveUser(handle, {
    channel,
    // A profile card does not need a follower count read in the last minute,
    // and asking for one would make opening a screen a request to X.
    freshness: 'MODERATE',
    ...(input.refresh ? { refresh: true } : {}),
  });

  if (resolved.outcome !== 'OK' || !resolved.data) {
    // Recorded, not thrown. The refusal is the answer.
    const row = await xAccountObservations.record({
      ownerUserId: input.ownerUserId,
      userId: null,
      handle,
      outcome: resolved.outcome,
      detail: resolved.detail || `AI17Z could not read @${handle}.`,
      backend: resolved.provenance.backend,
      gaps: resolved.provenance.gaps,
    });
    return {
      outcome: resolved.outcome,
      detail: row.detail,
      row,
      postsRead: 0,
      backend: resolved.provenance.backend,
    };
  }

  const user = resolved.data;
  const timeline = target > 0 ? await readTheirPosts(channel, user, target) : null;
  const posts = timeline?.outcome === 'OK' ? timeline.data : [];
  const reading = readAccount(posts.map(toReadPost));

  const gaps = [
    ...resolved.provenance.gaps,
    ...(timeline ? timeline.provenance.gaps : []),
    ...reading.gaps,
    // Said plainly rather than left to be inferred from an empty list.
    ...(timeline && timeline.outcome !== 'OK' && posts.length === 0
      ? [`Their posts could not be read: ${timeline.detail}`]
      : []),
  ];

  const row = await xAccountObservations.record({
    ownerUserId: input.ownerUserId,
    userId: user.userId || null,
    handle: user.handle,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    bannerUrl: user.bannerUrl,
    location: user.location,
    website: user.website,
    followers: user.followers,
    following: user.following,
    posts: user.posts,
    joinedAt: user.createdAt,
    verified: user.verified,
    protected: user.protected,
    // Stored as read, nulls included. A null is X not having said, and the
    // bridge score distinguishes that from a stated no.
    weFollow: user.weFollow,
    followsUs: user.followsUs,
    observations: reading as unknown as Record<string, unknown>,
    outcome: 'OK',
    detail: posts.length > 0 ? `Read ${posts.length} of @${user.handle}'s posts.` : `Read @${user.handle}'s profile.`,
    backend: resolved.provenance.backend,
    gaps: [...new Set(gaps)],
    observedAt: resolved.provenance.collectedAt,
  });

  if (input.agentId) await noteIdentity(input.agentId, user).catch(() => undefined);

  log.info('read an X account', {
    handle: user.handle,
    userId: user.userId || null,
    posts: posts.length,
    backend: resolved.provenance.backend,
  });

  return { outcome: 'OK', detail: row.detail, row, postsRead: posts.length, backend: resolved.provenance.backend };
}

/**
 * Their recent writing, by id.
 *
 * Replies are kept because most of what an account produces is conversation,
 * and an account described only by its announcements is described as somebody
 * it is not. Reposts are dropped: passing somebody's post on says nothing about
 * what the person who pressed the button writes about.
 */
async function readTheirPosts(channel: unknown, user: XUser, limit: number) {
  if (!user.userId) {
    // The rendered-page reader can describe somebody without knowing who they
    // are, and a timeline read needs the id. Reported as a gap rather than
    // guessed at from the handle.
    return null;
  }
  return xIntelligence.getUserPosts(
    { userId: user.userId, handle: user.handle, limit, includeReplies: true, includeReposts: false },
    { channel },
  );
}

function toReadPost(post: XPostRecord): ReadPost {
  return {
    id: post.postId,
    text: post.text,
    createdAt: post.createdAt,
    url: post.url,
    reply: Boolean(post.replyToPostId),
    quote: Boolean(post.quotedPostId),
    // Only what was counted. `metrics` is null from a reader that could not see
    // exact numbers, and a null count must never arrive downstream as a zero.
    ...(post.metrics?.likes === null || post.metrics?.likes === undefined ? {} : { likes: post.metrics.likes }),
    ...(post.metrics?.replies === null || post.metrics?.replies === undefined ? {} : { replies: post.metrics.replies }),
    ...(post.metrics?.views === null || post.metrics?.views === undefined ? {} : { views: post.metrics.views }),
  };
}

/**
 * Give an existing relationship the numeric id, if there is one to give.
 *
 * The same deliberate limit the persona collector has, and worth restating
 * because the temptation here is larger: this function is holding a list of
 * everything the person posts about, and `relationships.topics` is right there.
 *
 * It must not go in. That field renders in a prompt as **"You have discussed:
 * ..."** -- a claim about conversations the agent actually had. Filling it from
 * somebody's public timeline would have an agent open by referring to a
 * discussion that never happened, which is a worse failure than knowing less.
 * What was observed about their account stays on the observation, labelled as
 * observed, and the screen shows the two side by side.
 *
 * Reading somebody's posts is also not an interaction with them, so nothing
 * here records one. Counting it would make "how well do we know them" partly a
 * function of how often somebody pressed a button.
 */
async function noteIdentity(agentId: string, user: XUser): Promise<void> {
  if (!user.userId) return;
  const existing = await relationshipsRepo.find({ agentId, channel: 'x', handle: user.handle });
  if (!existing || existing.remoteUserId) return;
  await relationshipsRepo.noteRemoteUserId(existing.id, user.userId, user.displayName);
  log.info('filled in a relationship identity from an account read', { handle: user.handle, userId: user.userId });
}
