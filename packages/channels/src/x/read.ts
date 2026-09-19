import type { XMediaItem, XPost, XProfile, XSearchResult, XThread } from '@xbam/shared/contracts';
import { PipelineError } from '@xbam/shared';
import { accounts as accountsRepo } from '@xbam/database';
import type { ChannelContext } from '../contract';
import { SEL, X_URLS } from './selectors';
import { resolveBranch, type ArticleSnapshot } from './conversation';
import { MAX_ARTICLES_READ, goto, readArticle, refuseIfXBroke, selfHandles, settle, withSession } from './page';
import { extractStatusId } from './targets';
import { parseCount, readCounts } from './counts';
import { readAllArticles } from './monitors';
import {
  xIntelligence,
  type XMediaRef,
  type XPostRecord,
  type XReadOutcome,
  type XReadResult,
  type XUser,
} from './intelligence';

// Re-exported so the public surface of the channel package is unchanged: these
// moved into `counts.ts` when the radar needed them too, and a file that both
// `read.ts` and `monitors.ts` import cannot be either of them.
export { parseCount, parseCounts, readCounts } from './counts';

/**
 * Reading X on purpose, rather than as a step in answering something.
 *
 * The pipeline already reads X: it resolves a status page into a
 * `ResolvedContext` because a job needs one. This is the other case -- an agent
 * part-way through an answer that needs one specific thing it does not have,
 * asking for it. Same browser, same session manager, same role discipline.
 *
 * Everything here runs on the RESEARCH tab. `docs/ENGINEERING.md` is explicit
 * that a monitor must never navigate the action tab, and a capability the model
 * chose is a monitor by that definition: it is reading, it can happen at any
 * moment, and a scheduled post sitting on `/compose/post` must not be moved out
 * from under itself. Different roles run concurrently, so a read costs the
 * reply path nothing.
 *
 * Nothing in this file returns a DOM shape. The adapter's whole job at this
 * boundary is that `XPost` and `XProfile` are what leave it.
 */

/** How many of an account's own posts a profile read brings back. */
const PROFILE_POSTS = 5;

/**
 * How long to wait for one optional field before deciding it is not there.
 *
 * Playwright's locator actions auto-wait for the whole default timeout, so
 * `.catch(() => '')` around a field the page simply does not have costs thirty
 * seconds before the catch ever runs -- and a profile reads five of them, one
 * after another. The first live run of this took minutes and looked like a
 * hang.
 *
 * Two seconds is longer than a rendered element needs and short enough that
 * five missing ones cost ten. Absence is an answer here, not a failure: a
 * profile with no website has no website.
 */
const FIELD_TIMEOUT_MS = 2_000;

/**
 * Asking the canonical layer first.
 *
 * Everything below this comment reads the rendered page, and that is the right
 * floor rather than the right first choice. X answers these four questions
 * itself -- a post, a conversation, a search, a profile -- with immutable ids,
 * exact counts, the real reply link and the conversation id, none of which a
 * drawn article carries. `XPost` has had `remoteUserId`, `inReplyToStatusId`
 * and four count fields since it was written, and the DOM path could fill two
 * of them approximately.
 *
 * So each public reader below asks `xIntelligence` first and keeps its existing
 * implementation underneath. **Nothing about the boundary changes**: what
 * leaves this package is still `XPost`, `XProfile`, `XThread` and
 * `XSearchResult`, and no capability, id, schema or caller moved.
 *
 * ### When the page is still the answer, and when it must not be
 *
 * `SCHEMA_CHANGED`, `UNAVAILABLE` and `EMPTY` fall through to the page, which
 * is what the page is for. Anything in `STOP_ASKING` does not: a protected
 * account is protected however it is read, a challenge is a person's to answer,
 * and loading the same page in a browser after a rate limit is how a read turns
 * into hammering. Those become the failure they are, classified so the job
 * machinery does the right thing with each -- a rate limit is worth retrying
 * later, a missing post never is, and a sign-in is somebody's to do.
 */

/** A refusal the canonical layer made, as a failure the pipeline understands. */
function refusal(outcome: XReadOutcome, detail: string, what: string): PipelineError | null {
  switch (outcome) {
    case 'NOT_FOUND':
      return PipelineError.permanent('x_not_found', detail || `${what} could not be found.`);
    case 'PROTECTED':
      return PipelineError.permanent('x_protected', detail || `${what} is not public.`);
    case 'NEEDS_SIGN_IN':
      // A person has to sign in. Retrying cannot produce a session, and a
      // browser that is signed out will go on being signed out.
      return PipelineError.review('x_needs_sign_in', detail || 'X asked for a sign-in before it would show this.');
    case 'CHALLENGE':
      // AI17Z never answers a security challenge. Nothing here is an exception.
      return PipelineError.review(
        'x_challenge',
        detail || 'X is asking for a security check, which only a person can answer.',
      );
    case 'RATE_LIMITED':
      return PipelineError.retryable('x_rate_limited', detail || 'X asked AI17Z to slow down, so nothing was read.');
    default:
      return null;
  }
}

/** X's media vocabulary, in the one the contract uses. */
const MEDIA_KINDS: Record<XMediaRef['kind'], XMediaItem['kind']> = {
  photo: 'IMAGE',
  video: 'VIDEO',
  gif: 'GIF',
  unknown: 'UNKNOWN',
};

/**
 * A normalised post as the shape that crosses this package's boundary.
 *
 * Every optional field is spread rather than defaulted, because absent means
 * "not visible" throughout these contracts and a zero would be a measurement.
 * That is the same rule the counts already had and the reason `XPost` has
 * optional counts at all.
 */
export function asXPost(post: XPostRecord): XPost {
  const metrics = post.metrics;
  return {
    statusId: post.postId,
    url: post.url,
    author: {
      handle: post.authorHandle.replace(/^@+/, ''),
      // The field has existed since `XPost` was written and nothing could ever
      // fill it: a rendered article carries no numeric id.
      ...(post.authorId ? { remoteUserId: post.authorId } : {}),
    },
    text: post.text,
    ...(post.createdAt ? { postedAt: post.createdAt } : {}),
    media: post.media.map((item) => ({
      kind: MEDIA_KINDS[item.kind],
      ...(item.url ? { url: item.url } : {}),
      ...(item.altText ? { altText: item.altText } : {}),
    })),
    ...(post.replyToPostId ? { inReplyToStatusId: post.replyToPostId } : {}),
    ...(post.quotedPostId ? { quotedStatusId: post.quotedPostId } : {}),
    ...(typeof metrics?.replies === 'number' ? { replyCount: metrics.replies } : {}),
    ...(typeof metrics?.reposts === 'number' ? { repostCount: metrics.reposts } : {}),
    ...(typeof metrics?.likes === 'number' ? { likeCount: metrics.likes } : {}),
    ...(typeof metrics?.views === 'number' ? { viewCount: metrics.views } : {}),
  };
}

/** A resolved user as the profile shape, minus the posts. */
export function asXProfile(user: XUser, recentPosts: XPost[]): XProfile {
  return {
    handle: user.handle.replace(/^@+/, ''),
    ...(user.displayName ? { displayName: user.displayName } : {}),
    ...(user.userId ? { remoteUserId: user.userId } : {}),
    ...(user.bio ? { bio: user.bio } : {}),
    ...(user.location ? { location: user.location } : {}),
    ...(user.website ? { website: user.website } : {}),
    ...(user.createdAt ? { joined: user.createdAt } : {}),
    ...(typeof user.verified === 'boolean' ? { verified: user.verified } : {}),
    ...(typeof user.followers === 'number' ? { followerCount: user.followers } : {}),
    ...(typeof user.following === 'number' ? { followingCount: user.following } : {}),
    ...(typeof user.weFollow === 'boolean' ? { followedByYou: user.weFollow } : {}),
    ...(typeof user.followsUs === 'boolean' ? { followsYou: user.followsUs } : {}),
    recentPosts,
  };
}

/**
 * Take the canonical answer, or say why there is not going to be one.
 *
 * Returns `null` for the outcomes where the rendered page is a reasonable next
 * attempt, and throws for the ones where asking again is the wrong thing to do.
 */
export function canonical<T>(result: XReadResult<T>, what: string, ctx?: ChannelContext): T | null {
  if (result.outcome === 'OK') return result.data;
  /*
    Somebody has to be told the session is gone.

    The reading layer names this outcome and stops asking, which is right, and
    for a long time that was the end of it: the account went on saying
    CONNECTED, the health row went on saying "X is read through the signed-in
    browser", and the only thing that could correct either was an owner
    pressing a health check by hand, because nothing schedules one. So an
    installation whose session had expired looked healthy while its radar
    monitors quietly returned nothing. Measured on ai17z-test, where both
    `x.read_profile` and `x.search` refused while every screen said fine.

    `SESSION_EXPIRED` already exists for exactly this and already drives the
    owner notification. Only from CONNECTED, which is the same rule the health
    task uses: an account that never had a session is NEEDS_AUTH and not this.
  */
  if (result.outcome === 'NEEDS_SIGN_IN' && ctx?.account && ctx.account.status === 'CONNECTED') {
    void accountsRepo
      .updateAccount(ctx.account.id, { status: 'SESSION_EXPIRED', lastError: result.detail })
      .catch(() => undefined);
  }
  const stop = refusal(result.outcome, result.detail, what);
  if (stop) throw stop;
  return null;
}

/** The status url for whatever the caller had: an id, a url, or a handle path. */
function statusUrl(reference: string): string {
  const id = extractStatusId(reference) ?? (/^\d{5,25}$/.test(reference.trim()) ? reference.trim() : null);
  if (!id) {
    throw PipelineError.permanent('bad_status_reference', `"${reference}" is not a post id or a post URL.`);
  }
  // `/i/status/<id>` is X's own canonical form and needs no author handle, so a
  // caller holding only an id never has to guess one -- and a guessed handle is
  // how a read ends up on somebody else's post.
  return `https://x.com/i/web/status/${id}`;
}

/** One post, read from its own page. */
export async function readPost(ctx: ChannelContext, reference: string): Promise<XPost> {
  const url = statusUrl(reference);
  const statusId = extractStatusId(url)!;

  // X's own data first: it carries the author's numeric id, the exact counts,
  // and the id of the post being replied to. None of the three survive being
  // read off a drawn article, and `XPost` has had fields for all of them since
  // it was written.
  const structured = canonical(
    await xIntelligence.getPost(statusId, { channel: ctx, freshness: 'LIVE' }),
    `The post ${statusId}`,
    ctx,
  );
  if (structured) return asXPost(structured);

  return withSession(ctx, 'RESEARCH', async (session) => {
    await goto(session.page, url);
    await settle();

    const id = extractStatusId(url)!;
    // Anchored on the article that links to this status id, exactly as the
    // action path does. There is no positional fallback: on a status page the
    // parent renders above the focal post, so "the first article" is reliably
    // somebody else's.
    const anchor = `${SEL.tweetArticle}:has(a[href*="/status/${id}"])`;
    const found = await session.page
      .locator(anchor)
      .first()
      .isVisible()
      .catch(() => false);
    if (!found) {
      throw PipelineError.permanent('focal_article_not_found', `The post ${id} is not on its own page any more.`);
    }

    const snapshot = await readArticle(session.page, anchor);
    const counts = await readCounts(session.page, anchor);
    return {
      ...toPost(id, url, snapshot),
      replyCount: counts.replies,
      repostCount: counts.reposts,
      likeCount: counts.likes,
      viewCount: counts.views,
    };
  });
}

/** One account, read from its profile page. */
export async function readProfile(
  ctx: ChannelContext,
  handleInput: string,
  options: { posts?: number } = {},
): Promise<XProfile> {
  const handle = handleInput.trim().replace(/^@+/, '');
  // A few by default, because the question a profile answers is "who is this"
  // rather than "what have they been saying". A caller that wants the second
  // asks for it.
  const wantedPosts = Math.min(Math.max(options.posts ?? PROFILE_POSTS, 0), 40);
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    throw PipelineError.permanent('bad_handle', `"${handleInput}" is not an X handle.`);
  }

  // X's own profile data, which carries the numeric id and -- because the query
  // goes out as the signed-in session -- whether either account follows the
  // other. `XProfile` has had `remoteUserId`, `followedByYou` and `followsYou`
  // since it was written and the rendered page could fill none of them
  // reliably.
  const structured = canonical(
    await xIntelligence.resolveUser(handle, { channel: ctx, freshness: 'MODERATE' }),
    `@${handle}`,
    ctx,
  );
  if (structured && structured.userId) {
    // Nothing asked for means nothing read. The radar reads its own profile
    // every few hours purely for a follower count, and a timeline fetched and
    // thrown away is a request to X that bought nobody anything.
    if (wantedPosts === 0) return asXProfile(structured, []);

    const recent = await xIntelligence.getUserPosts(
      {
        userId: structured.userId,
        handle: structured.handle,
        limit: wantedPosts,
        includeReplies: false,
        includeReposts: false,
      },
      { channel: ctx, freshness: 'RECENT' },
    );
    // A profile whose posts could not be read is still a profile. The absence
    // travels as an empty list exactly as it did before, because the field is
    // "what was visible" rather than "what they have written".
    return asXProfile(structured, recent.outcome === 'OK' ? recent.data.map(asXPost) : []);
  }

  return withSession(ctx, 'RESEARCH', async (session) => {
    await goto(session.page, X_URLS.profile(handle));
    await settle();

    const header = await session.page
      .locator(SEL.profileHeader)
      .first()
      .innerText({ timeout: FIELD_TIMEOUT_MS })
      .catch(() => '');
    if (!header) {
      // Three things arrive here and only two of them are permanent: a handle
      // that does not exist, a suspended account, and a page that never
      // rendered. Answering the third with a permanent failure gives up on a
      // profile that is there, over a blip.
      //
      // Ask X first, because when it has failed in the ordinary way it says so.
      await refuseIfXBroke(session.page, `@${handle}'s profile`);

      // And when it has not said so, ask whether it rendered anything at all.
      // Throttled profile views arrive as the application shell and nothing
      // else: no header, no column, no error, 179 characters of navigation.
      // A handle that genuinely does not exist renders the column and says so
      // inside it -- so the column is what tells the two apart, and without
      // this the account series stops for good the first time X throttles.
      //
      // Watched live: every other route was serving this session normally
      // while both profiles came back as that empty shell, and both were
      // rendering again a few minutes later.
      if ((await session.page.locator(SEL.primaryColumn).count().catch(() => 0)) === 0) {
        throw PipelineError.retryable(
          'profile_not_rendered',
          `X returned an empty page for @${handle} rather than a profile. Nothing was read, ` +
            'which is not the same as there being nothing there.',
        );
      }
      throw PipelineError.permanent('profile_not_readable', `Nothing readable on @${handle}'s profile.`);
    }

    const bio = await session.page
      .locator(SEL.profileBio)
      .first()
      .innerText({ timeout: FIELD_TIMEOUT_MS })
      .catch(() => '');
    const joined = await session.page
      .locator(SEL.profileJoinDate)
      .first()
      .innerText({ timeout: FIELD_TIMEOUT_MS })
      .catch(() => '');
    // Matched on the end of the href rather than the whole of it: the handle
    // X puts there is its own canonical casing, which is not necessarily what
    // the caller typed.
    const followers = await countBeside(session.page, 'a[href$="/verified_followers"], a[href$="/followers"]');
    const following = await countBeside(session.page, 'a[href$="/following"]');
    const website = await session.page
      .locator(SEL.profileWebsite)
      .first()
      .getAttribute('href', { timeout: FIELD_TIMEOUT_MS })
      .catch(() => null);

    const recent: XPost[] = [];
    const articles = session.page.locator(SEL.tweetArticle);
    const count = Math.min(await articles.count().catch(() => 0), PROFILE_POSTS);
    for (let i = 0; i < count; i += 1) {
      // `>> nth=` is how every other caller picks an article. The third
      // argument is the snapshot's own index, not a selector -- passing it
      // and expecting it to choose read the first article five times.
      const snapshot = await readArticle(session.page, `${SEL.tweetArticle} >> nth=${i}`, i).catch(() => null);
      if (!snapshot?.url) continue;
      const id = extractStatusId(snapshot.url);
      if (id) recent.push(toPost(id, snapshot.url, snapshot));
    }

    return {
      handle,
      displayName: header.split('\n')[0]?.trim() || undefined,
      bio: bio.trim() || undefined,
      website: website ?? undefined,
      joined: joined.replace(/^Joined\s+/i, '').trim() || undefined,
      followerCount: followers,
      followingCount: following,
      recentPosts: recent,
    };
  });
}

/** The number X renders next to a followers or following link. */
async function countBeside(page: Parameters<typeof readArticle>[0], selector: string): Promise<number | undefined> {
  const text = await page
    .locator(selector)
    .first()
    .innerText({ timeout: FIELD_TIMEOUT_MS })
    .catch(() => '');
  return parseCount(text);
}

function toPost(
  statusId: string,
  url: string,
  snapshot: ArticleSnapshot,
): XPost {
  return {
    statusId,
    url,
    author: {
      handle: (snapshot.authorHandle ?? '').replace(/^@+/, ''),
      displayName: snapshot.authorDisplayName ?? undefined,
      verified: snapshot.authorVerified ?? undefined,
    },
    text: snapshot.text,
    postedAt: snapshot.createdAt ?? undefined,
    media: [],
  };
}

/**
 * Searching X as the signed-in account.
 *
 * The same page a person uses, read by the same harvester the radar monitors
 * use -- one implementation of "scroll a timeline and collect what is on it",
 * so search and discovery cannot drift in how much they see or how they
 * deduplicate. A second copy of that loop would be a second set of bounds on
 * what an agent can find.
 *
 * `live` is newest-first and `top` is X's own ranking. The default is live
 * because a capability is usually asked because something just happened, and
 * ranked results answer a different question.
 */
export async function searchPosts(
  ctx: ChannelContext,
  request: { query: string; mode?: 'LIVE' | 'TOP'; limit?: number },
): Promise<XSearchResult> {
  const query = request.query.trim();
  if (!query) throw PipelineError.permanent('empty_query', 'A search needs something to search for.');
  const mode = request.mode ?? 'LIVE';
  const limit = Math.min(Math.max(request.limit ?? 10, 1), 25);

  // X's own search index, which is the same index the rendered search page
  // draws from -- but answered with ids, counts and reply links rather than
  // with articles that have had all three rendered out of them.
  const structured = canonical(
    await xIntelligence.searchPosts({ query, limit, latest: mode === 'LIVE' }, { channel: ctx, freshness: 'LIVE' }),
    `Results for "${query}"`,
    ctx,
  );
  if (structured) {
    return {
      query,
      mode,
      posts: structured.map(asXPost),
      // A single page of X's search, which is all it offers in one answer. It
      // says `more` when it filled the request exactly, because a full page is
      // the only evidence available that something was left behind.
      more: structured.length >= limit,
    };
  }

  return withSession(ctx, 'RESEARCH', async (session) => {
    const url = `https://x.com/search?q=${encodeURIComponent(query)}${mode === 'LIVE' ? '&f=live' : ''}`;
    await goto(session.page, url);
    await settle();

    // Scroll only as far as the answer needs. Reading three times the limit
    // leaves room for the things a timeline interleaves that are not results.
    const wanted = limit * 3;
    let seen = await readAllArticles(session.page, wanted);
    for (let pass = 0; pass < 4 && seen.length < wanted; pass += 1) {
      const before = seen.length;
      await session.page.mouse.wheel(0, 1_400).catch(() => undefined);
      await session.page.waitForTimeout(800);
      seen = await readAllArticles(session.page, wanted);
      if (seen.length <= before) break;
    }

    const posts: XPost[] = [];
    const ids = new Set<string>();
    for (const item of seen) {
      if (posts.length >= limit) break;
      if (!item.statusId || ids.has(item.statusId) || !item.text) continue;
      ids.add(item.statusId);
      posts.push({
        statusId: item.statusId,
        url: item.url ?? `https://x.com/i/web/status/${item.statusId}`,
        author: { handle: (item.authorHandle ?? '').replace(/^@+/, '') },
        text: item.text,
        postedAt: item.createdAt ?? undefined,
        media: [],
      });
    }

    // An empty search is an answer only when X did not say it failed. Its own
    // error page renders no articles, and returning nought from one is how "X
    // errored" reaches an agent as "nobody is talking about that".
    if (posts.length === 0) await refuseIfXBroke(session.page, `results for "${query}"`);

    // Honest about what it did not read. A caller told there are ten results
    // when the page had four hundred is being told the wrong thing.
    return { query, mode, posts, more: seen.length > posts.length };
  });
}

/**
 * A whole conversation, root first, with the post that was asked about marked.
 *
 * Uses the same walker the reply pipeline uses. On a status page X has already
 * resolved the reply chain and renders the path from root to focal above it, so
 * the ancestors are the articles before the focal one and sibling branches are
 * excluded structurally rather than filtered afterwards. There is no positional
 * fallback here either: a focal post that cannot be found is a stop, because the
 * alternative is picking a neighbour and reading the wrong conversation.
 */
export async function readThread(ctx: ChannelContext, reference: string): Promise<XThread> {
  const url = statusUrl(reference);
  const focalStatusId = extractStatusId(url)!;

  // The structured read follows the reply-to links rather than the order of
  // the page, so a sibling branch cannot become part of the conversation. The
  // walker below reaches the same conclusion from what X rendered; this reaches
  // it from what X actually said.
  const structured = canonical(
    await xIntelligence.getThread(focalStatusId, { channel: ctx, freshness: 'LIVE' }),
    `The conversation around ${focalStatusId}`,
    ctx,
  );
  if (structured && structured.length > 0) {
    const root = structured[0]!;
    return {
      focalStatusId,
      posts: structured.map(asXPost),
      // True when the chain stopped at a post that is itself an answer: X did
      // not return its parent, so this is not the start of the conversation.
      truncated: root.replyToPostId !== null,
    };
  }

  return withSession(ctx, 'RESEARCH', async (session) => {
    await goto(session.page, url);
    await settle();

    const snapshots: ArticleSnapshot[] = [];
    const articles = session.page.locator(SEL.tweetArticle);
    const count = Math.min(await articles.count().catch(() => 0), MAX_ARTICLES_READ);
    for (let i = 0; i < count; i += 1) {
      const snapshot = await readArticle(session.page, `${SEL.tweetArticle} >> nth=${i}`, i).catch(() => null);
      if (snapshot) snapshots.push(snapshot);
    }

    const branch = resolveBranch({ articles: snapshots, focalStatusId, selfHandles: selfHandles(ctx) });
    if (!branch.ok) throw PipelineError.permanent(branch.reason, branch.detail);

    // The path the walker kept, root first, with the focal post last. Sibling
    // branches are on the page and are not part of this conversation -- the
    // walker excluded them structurally, so they never reach this list.
    const branchIds = new Set(
      [...branch.conversation.ancestors, branch.conversation.incoming]
        .map((post) => post.remoteId)
        .filter((id): id is string => Boolean(id)),
    );
    const posts: XPost[] = [];
    const byId = new Map(snapshots.filter((s) => s.statusId).map((s) => [s.statusId!, s]));
    for (const id of branchIds) {
      const snapshot = byId.get(id);
      if (!snapshot) continue;
      posts.push(toPost(id, snapshot.url ?? `https://x.com/i/web/status/${id}`, snapshot));
    }

    return {
      focalStatusId,
      posts,
      // Honest about the ceiling: a conversation longer than the walk is a
      // conversation this did not finish reading.
      truncated: snapshots.length >= MAX_ARTICLES_READ,
    };
  });
}
