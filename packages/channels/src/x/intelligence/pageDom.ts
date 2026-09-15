import { createLogger } from '@xbam/shared';
import type { ChannelContext } from '../../contract';
import { collectPersonaCorpus, normaliseHandle, type CorpusOutcome } from '../personaCorpus';
import {
  emptyResult,
  provenanceFor,
  type XBackendReadiness,
  type XIntelligenceBackend,
  type XPostRecord,
  type XPostsRequest,
  type XReadContext,
  type XReadOutcome,
  type XReadResult,
  type XUser,
} from './contract';

const log = createLogger('x-dom');

/**
 * Reading the page as it is drawn, when the JSON is not available.
 *
 * The floor under everything else. `pageGraphql` gives better data in every
 * respect -- immutable ids, exact counts, conversation ids, long-form text --
 * and it is also the part that breaks when X ships a change to its own API
 * surface. This does not: articles on a timeline have looked broadly the same
 * for years, and this reader has been driving the product's monitors through
 * several X redesigns already.
 *
 * So it is deliberately the less capable backend, and deliberately the one that
 * is hard to kill. When the structured read stops understanding what it is
 * given, the answer is a smaller answer rather than no answer -- and the layer
 * above records which one it got, because a persona built from approximate data
 * should be labelled as such rather than quietly mixed in with exact data.
 *
 * ## What it cannot do, stated rather than faked
 *
 * A rendered article does not carry the author's numeric id, so this cannot
 * resolve identity on its own -- it reports the handle it was asked about and
 * leaves `userId` to a backend that can see one. Engagement counts are rendered
 * abbreviated ("1.2K"), so they are not reported at all rather than reported
 * wrongly. Both absences travel in `gaps`.
 */

const NAME = 'x-dom';

/** How a corpus read's ending maps onto the vocabulary every backend shares. */
const OUTCOMES: Record<CorpusOutcome, XReadOutcome> = {
  OK: 'OK',
  NOT_FOUND: 'NOT_FOUND',
  PROTECTED: 'PROTECTED',
  EMPTY: 'EMPTY',
  SIGNED_OUT: 'NEEDS_SIGN_IN',
  CHALLENGE: 'CHALLENGE',
};

/** What this reader can never see, carried with every answer it gives. */
const GAPS = [
  'engagement counts are rendered abbreviated and are not reported',
  'the author id is not present in a rendered article',
];

export const pageDomBackend: XIntelligenceBackend = {
  name: NAME,

  async readiness(ctx: XReadContext): Promise<XBackendReadiness> {
    const channel = ctx.channel as ChannelContext | null;
    if (!channel) return { state: 'UNAVAILABLE', detail: 'No browser session to read through.', can: [] };
    // Nothing to probe: if there is a browser, this works, which is the whole
    // point of keeping it. Reporting READY without asking X anything also means
    // readiness costs no requests.
    return {
      state: 'READY',
      detail: 'Reading the rendered page in the signed-in browser.',
      can: ['resolveUser', 'getUserPosts'],
    };
  },

  /**
   * A profile, as far as a drawn page shows one.
   *
   * No numeric id, because the page does not carry one. Returned anyway rather
   * than refused: a screen that wants a bio and an avatar should get them, and
   * the caller decides whether an identity without an id is enough for what it
   * is doing. Persona sources are not -- they key on the id -- which is why the
   * layer above prefers a backend that can resolve one.
   */
  async resolveUser(ctx: XReadContext, handle: string): Promise<XReadResult<XUser | null>> {
    const channel = ctx.channel as ChannelContext | null;
    const clean = normaliseHandle(handle);
    if (!channel) return emptyResult(NAME, 'UNAVAILABLE', 'No browser session to read through.', null);
    if (!clean) return emptyResult(NAME, 'NOT_FOUND', `"${handle}" is not an X handle.`, null);

    // One pass of the corpus collector, which already reads the profile header
    // and already reports every refusal correctly. Asking it for a single post
    // makes this a profile read rather than a collection.
    const corpus = await collectPersonaCorpus(channel, { handle: clean, target: 1 });
    const outcome = OUTCOMES[corpus.outcome];
    if (outcome !== 'OK' && corpus.outcome !== 'EMPTY') {
      return emptyResult(NAME, outcome, corpus.detail, null);
    }

    return {
      outcome: 'OK',
      detail: '',
      data: {
        // The handle stands in for identity here, and the caller is told so by
        // the gap rather than by a null nobody notices.
        userId: '',
        handle: corpus.handle,
        displayName: corpus.displayName,
        bio: corpus.bio,
        avatarUrl: null,
        bannerUrl: null,
        location: null,
        website: null,
        followers: null,
        following: null,
        posts: null,
        createdAt: null,
        verified: null,
        protected: corpus.outcome === 'PROTECTED' ? true : null,
        provenance: provenanceFor(NAME, {
          url: `https://x.com/${corpus.handle}`,
          gaps: ['no numeric user id: a rendered profile does not carry one', ...GAPS],
        }),
      },
      provenance: provenanceFor(NAME, { url: `https://x.com/${corpus.handle}` }),
    };
  },

  async getUserPosts(ctx: XReadContext, request: XPostsRequest): Promise<XReadResult<XPostRecord[]>> {
    const channel = ctx.channel as ChannelContext | null;
    if (!channel) return emptyResult(NAME, 'UNAVAILABLE', 'No browser session to read through.', []);

    const corpus = await collectPersonaCorpus(channel, {
      handle: request.handle,
      target: request.limit,
      ...(request.onProgress ? { onProgress: (collected: number) => request.onProgress?.(collected) } : {}),
    });

    const outcome = OUTCOMES[corpus.outcome];
    if (outcome !== 'OK') return emptyResult(NAME, outcome, corpus.detail, []);

    const collectedAt = new Date().toISOString();
    const posts: XPostRecord[] = corpus.posts.map((post) => ({
      postId: post.statusId,
      // Not knowable from a drawn article. Left null rather than filled with
      // the handle, which would put a name where every other reader expects an
      // id and quietly break identity everywhere downstream.
      authorId: null,
      authorHandle: corpus.handle,
      text: post.text,
      createdAt: post.createdAt,
      url: post.url,
      conversationId: null,
      replyToPostId: null,
      replyToUserId: null,
      quotedPostId: null,
      repost: false,
      lang: null,
      metrics: null,
      media: [],
      links: [],
      provenance: provenanceFor(NAME, { collectedAt, url: post.url, gaps: GAPS }),
    }));

    log.info('read a timeline from the rendered page', { handle: corpus.handle, posts: posts.length });
    return {
      outcome: 'OK',
      detail: corpus.detail,
      data: posts,
      provenance: provenanceFor(NAME, {
        collectedAt,
        url: `https://x.com/${corpus.handle}`,
        gaps: [...GAPS, ...(corpus.stoppedEarly ? ['stopped on a bound rather than at the end of the timeline'] : [])],
      }),
    };
  },
};
