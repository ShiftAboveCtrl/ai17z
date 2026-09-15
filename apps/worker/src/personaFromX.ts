import { createLogger } from '@xbam/shared';
import { accounts as accountsRepo, personaSources, relationships as relationshipsRepo } from '@xbam/database';
import { xIntelligence, type XPostRecord, type XUser } from '@xbam/channels';
import { buildChannelContext } from '@xbam/runtime';
import { syncPersonaSource } from '@xbam/persona';

const log = createLogger('persona-from-x');

/**
 * Learning a voice from an X account, once, for everything that asks.
 *
 * There were two ways to do this and they disagreed. "Learn from this account"
 * collected through the browser; the advanced persona screen's "sync now" went
 * through a twscrape adapter that no packaged installation can run. Same
 * feature, same table, two backends, one of them permanently broken -- so which
 * button somebody pressed decided whether the product worked.
 *
 * This is the one path. Both callers come here, it reads through the canonical
 * X intelligence layer, and the layer decides which reader answers.
 *
 * ## Identity is resolved first, and kept
 *
 * The handle is what somebody typed; the numeric id is who they are. Handles
 * change, and a persona source keyed on one quietly becomes a record of two
 * different people. So the id is resolved before anything is collected and
 * stored on the source, and a later refresh uses the id -- which means it still
 * works after a rename, and can notice one.
 */

/**
 * How much is worth collecting, and how little is worth using.
 *
 * Raised from the first implementation's 160 after looking at what the derived
 * traits actually rest on: `deriveProfile` selects examples and topics from the
 * scored corpus, and the selection stops improving somewhere above two hundred
 * because the scorer has already found the strongest items. Two hundred and
 * forty leaves room for the roughly half of a replies timeline that belongs to
 * somebody else, and for the reposts that are dropped.
 *
 * `MINIMUM` is the floor for claiming to have learned a voice at all. Below it
 * the sample is small enough that the traits are guesses, and the honest thing
 * is to say how small rather than to dress it up -- which the progress line
 * does, in words, rather than failing.
 */
export const PERSONA_CORPUS_TARGET = 240;
export const PERSONA_CORPUS_MINIMUM = 40;

export interface PersonaCollection {
  outcome: 'OK' | 'REFUSED';
  detail: string;
  /** Null when the read was refused before identity could be established. */
  user: XUser | null;
  collected: number;
  stored: number;
  traits: number;
  /** Which reader answered, for a trace and for the source row. */
  backend: string;
}

/**
 * Collect an account's writing and turn it into a persona.
 *
 * Bounded by the intelligence layer's own budget, cancellable, and honest about
 * what it got: an empty corpus never becomes a persona, and a small one says it
 * is small.
 */
export async function collectPersonaFromX(input: {
  sourceId: string;
  handle: string;
  /** The account whose browser does the reading. Not the account being read. */
  readerAccountId: string;
  target?: number;
  /** Only collect what is newer than this, for a refresh. */
  sincePostId?: string | null;
  signal?: { aborted: boolean };
}): Promise<PersonaCollection> {
  const target = input.target ?? PERSONA_CORPUS_TARGET;
  const account = await accountsRepo.requireAccount(input.readerAccountId);
  const channel = await buildChannelContext(account, null);

  const say = (progress: string) =>
    void personaSources.setSourceStatus(input.sourceId, 'SYNCING', { lastError: null, progress }).catch(() => undefined);

  // ---- who ---------------------------------------------------------------
  say(`Looking for @${input.handle.replace(/^@+/, '')}.`);
  const resolved = await xIntelligence.resolveUser(input.handle, { channel });
  if (resolved.outcome !== 'OK' || !resolved.data) {
    await personaSources.setSourceStatus(input.sourceId, 'UNAVAILABLE', {
      lastError: resolved.detail || `AI17Z could not find @${input.handle}.`,
    });
    return { outcome: 'REFUSED', detail: resolved.detail, user: null, collected: 0, stored: 0, traits: 0, backend: resolved.provenance.backend };
  }
  const user = resolved.data;

  // The id, kept on the source so a refresh survives a rename. Stored in the
  // config the source already has rather than in a column added for it.
  await personaSources
    .updateSourceConfig(input.sourceId, {
      userId: user.userId || null,
      handleAtLastSync: user.handle,
      displayName: user.displayName,
      bio: user.bio,
      followers: user.followers,
      resolvedBy: resolved.provenance.backend,
      resolvedAt: resolved.provenance.collectedAt,
    })
    .catch(() => undefined);

  // An account somebody is learning from may be one the agent already talks
  // to. Where it is, the identity just resolved is worth keeping: the
  // relationship store asks for a `remote_user_id` and fills it in the moment
  // anything can supply one, precisely so a handle change does not split one
  // person into two records. This is that moment.
  //
  // Nothing else about the relationship is touched. Reading somebody's posts is
  // not an interaction with them, and counting it as one would inflate a number
  // the engagement heuristics read.
  await noteIdentity(input.sourceId, user).catch(() => undefined);

  // ---- what they wrote ---------------------------------------------------
  say(`Found @${user.handle}. Reading posts.`);
  const timeline = await xIntelligence.getUserPosts(
    {
      userId: user.userId,
      handle: user.handle,
      limit: target,
      sincePostId: input.sincePostId ?? null,
      includeReplies: true,
      // Passing somebody else's post on is not writing, so it teaches nothing
      // about a voice. Dropped at the source rather than scored down later.
      includeReposts: false,
      onProgress: (collected) => say(`Read ${collected} post${collected === 1 ? '' : 's'} by @${user.handle}.`),
      ...(input.signal ? { signal: input.signal } : {}),
    },
    { channel },
  );

  if (timeline.outcome !== 'OK' || timeline.data.length === 0) {
    const detail =
      timeline.outcome === 'EMPTY'
        ? `@${user.handle} has no public posts AI17Z can read.`
        : timeline.detail || `AI17Z could not read @${user.handle}'s posts.`;
    // An empty corpus never becomes a persona. The source is marked so the
    // screen says what happened instead of spinning at a collection that
    // already stopped.
    await personaSources.setSourceStatus(input.sourceId, 'UNAVAILABLE', { lastError: detail });
    return { outcome: 'REFUSED', detail, user, collected: 0, stored: 0, traits: 0, backend: timeline.provenance.backend };
  }

  // ---- what it means -----------------------------------------------------
  say(`Understanding the voice in ${timeline.data.length} posts.`);
  const report = await syncPersonaSource({
    sourceId: input.sourceId,
    items: timeline.data.map(toCorpusItem),
  });

  log.info('learned a voice from X', {
    handle: user.handle,
    userId: user.userId || null,
    collected: timeline.data.length,
    stored: report.stored,
    traits: report.traits,
    backend: timeline.provenance.backend,
  });

  return {
    outcome: 'OK',
    detail:
      timeline.data.length >= PERSONA_CORPUS_MINIMUM
        ? `Read ${timeline.data.length} posts by @${user.handle}.`
        : `Only ${timeline.data.length} posts by @${user.handle} were available, which is a small sample.`,
    user,
    collected: timeline.data.length,
    stored: report.stored,
    traits: report.traits,
    backend: timeline.provenance.backend,
  };
}

/**
 * One post, as the corpus store wants it.
 *
 * `raw` keeps the normalised record rather than a vendor payload: the point of
 * the archive is provenance, and a shape every backend produces is worth more
 * later than one backend's JSON. Reply and quote ids travel with it so the
 * persona builder can ask the conversation architecture for context rather than
 * treating "exactly lol" as a standalone belief.
 */
function toCorpusItem(post: XPostRecord) {
  return {
    remoteId: post.postId,
    text: post.text,
    url: post.url,
    itemKind: post.replyToPostId ? ('reply' as const) : post.quotedPostId ? ('quote' as const) : ('post' as const),
    createdAt: post.createdAt,
    raw: {
      postId: post.postId,
      authorId: post.authorId,
      authorHandle: post.authorHandle,
      conversationId: post.conversationId,
      replyToPostId: post.replyToPostId,
      replyToUserId: post.replyToUserId,
      quotedPostId: post.quotedPostId,
      lang: post.lang,
      metrics: post.metrics,
      collectedAt: post.provenance.collectedAt,
      backend: post.provenance.backend,
    },
  };
}

/**
 * Give an existing relationship the numeric id, if there is one to give.
 *
 * Deliberately only an identity fill. A relationship's significance is derived
 * by the relationship subsystem from what actually happened between the agent
 * and the person -- replies, mentions, published posts -- and an observation
 * from a persona read is not one of those things. Feeding it in as an
 * interaction would make "how well do we know them" partly a function of how
 * often somebody pressed a learn button.
 */
async function noteIdentity(sourceId: string, user: XUser): Promise<void> {
  if (!user.userId) return;
  const source = await personaSources.getSource(sourceId);
  if (!source) return;

  const existing = await relationshipsRepo.find({
    agentId: source.agentId,
    channel: 'x',
    handle: user.handle,
  });
  if (!existing || existing.remoteUserId) return;

  await relationshipsRepo.noteRemoteUserId(existing.id, user.userId, user.displayName);
  log.info('filled in a relationship identity from X', { handle: user.handle, userId: user.userId });
}

/**
 * An X account of the owner's whose browser can do the reading.
 *
 * Reading X needs a session, and AI17Z reads as somebody. Any connected account
 * will do -- this reads public profiles, not anything belonging to that account
 * -- so the first is as good as a choice nobody has a reason to make.
 */
export async function readerAccountFor(ownerId: string): Promise<string | null> {
  const owned = await accountsRepo.listAccounts(ownerId);
  return owned.find((a) => a.channel === 'x' && a.enabled)?.id ?? null;
}
