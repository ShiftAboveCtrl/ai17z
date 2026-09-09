import type { XPost, XProfile } from '@xbam/shared/contracts';
import { PipelineError } from '@xbam/shared';
import type { ChannelContext } from '../contract';
import { SEL, X_URLS } from './selectors';
import type { ArticleSnapshot } from './conversation';
import { goto, readArticle, settle, withSession } from './page';
import { extractStatusId } from './targets';

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
 * Turns X's abbreviated counts into numbers, or into nothing.
 *
 * "1,234" is 1234 and "12.3K" is 12300, but the important case is the third
 * one: a count the page did not show comes back undefined rather than zero.
 * `docs/ENGINEERING.md` treats an unread image as an explicit gap instead of
 * silence, and a follower count behind a login wall is the same kind of gap --
 * an agent told an account has zero followers will say so.
 */
export function parseCount(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const text = raw.replace(/,/g, '').trim();
  const match = text.match(/^(\d+(?:\.\d+)?)\s*([KMB])?/i);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]!);
  if (!Number.isFinite(value)) return undefined;
  const scale = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[(match[2] ?? '').toLowerCase()] ?? 1;
  return Math.round(value * scale);
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
    return toPost(id, url, snapshot);
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
      .innerText()
      .catch(() => '');
    if (!header) {
      // A handle that does not exist, a suspended account, or a page that never
      // rendered. All three are the same answer to the caller: nothing to read.
      throw PipelineError.permanent('profile_not_readable', `Nothing readable on @${handle}'s profile.`);
    }

    const bio = await session.page
      .locator(SEL.profileBio)
      .first()
      .innerText()
      .catch(() => '');
    const joined = await session.page
      .locator(SEL.profileJoinDate)
      .first()
      .innerText()
      .catch(() => '');
    const followers = await countBeside(session.page, `a[href="/${handle}/verified_followers"], a[href="/${handle}/followers"]`);
    const following = await countBeside(session.page, `a[href="/${handle}/following"]`);
    const website = await session.page
      .locator(SEL.profileWebsite)
      .first()
      .getAttribute('href')
      .catch(() => null);

    const recent: XPost[] = [];
    const articles = session.page.locator(SEL.tweetArticle);
    const count = Math.min(await articles.count().catch(() => 0), PROFILE_POSTS);
    for (let i = 0; i < count; i += 1) {
      const snapshot = await readArticle(session.page, SEL.tweetArticle, i).catch(() => null);
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
    .innerText()
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
