import type { XPost, XProfile, XSearchResult, XThread } from '@xbam/shared/contracts';
import { PipelineError } from '@xbam/shared';
import type { ChannelContext } from '../contract';
import { SEL, X_URLS } from './selectors';
import { resolveBranch, type ArticleSnapshot } from './conversation';
import { MAX_ARTICLES_READ, goto, readArticle, refuseIfXBroke, selfHandles, settle, withSession } from './page';
import { extractStatusId } from './targets';
import { parseCount, readCounts } from './counts';
import { readAllArticles } from './monitors';

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
export async function readProfile(ctx: ChannelContext, handleInput: string): Promise<XProfile> {
  const handle = handleInput.trim().replace(/^@+/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    throw PipelineError.permanent('bad_handle', `"${handleInput}" is not an X handle.`);
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
      // A handle that does not exist, a suspended account, or a page that never
      // rendered. All three are the same answer to the caller: nothing to read.
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
