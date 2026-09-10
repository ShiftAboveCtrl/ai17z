import type { XPost, XTimeline } from '@xbam/shared/contracts';
import { PipelineError } from '@xbam/shared';
import type { ChannelContext } from '../contract';
import { goto, settle, withSession } from './page';
import { readAllArticles, type Seen } from './monitors';

/**
 * The timelines an account can already see, read on purpose.
 *
 * Home is what X decided to show; Following is what the account chose to see;
 * Bookmarks is what it saved; a List is a set somebody curated. They are four
 * different claims about relevance and none of them substitutes for another,
 * which is why the surface travels with the result -- a finding without the
 * name of its source is not a finding.
 *
 * None of these is a discovery source. The radar decides what to queue work
 * about and keeps cursors for it; this reads, returns and forgets. Adding a
 * second thing that ingests would be a second event store, and identity is the
 * post.
 */

/** How far to scroll before deciding the timeline has shown what it will. */
const MAX_SCROLL_PASSES = 6;
const SCROLL_PIXELS = 2_000;

/** The hard ceiling on one read. An infinite feed needs one that is not. */
const MAX_POSTS = 50;

function urlFor(surface: XTimeline['surface'], listId: string | undefined): string {
  switch (surface) {
    case 'HOME':
      return 'https://x.com/home';
    case 'FOLLOWING':
      // X's own second column, which is the chronological one. `?f=following`
      // is not a route; the column is remembered per account, so this asks for
      // it explicitly rather than trusting where the tab was left.
      return 'https://x.com/home?column=following';
    case 'BOOKMARKS':
      return 'https://x.com/i/bookmarks';
    case 'LIST': {
      if (!listId || !/^\d{5,25}$/.test(listId)) {
        throw PipelineError.permanent('bad_list_id', `"${listId ?? ''}" is not an X list id.`);
      }
      return `https://x.com/i/lists/${listId}`;
    }
  }
}

/** Turns what was on the timeline into posts, keeping order and dropping repeats. */
export function toTimelinePosts(seen: Seen[], limit: number): { posts: XPost[]; more: boolean } {
  const ids = new Set<string>();
  const posts: XPost[] = [];
  for (const item of seen) {
    if (!item.statusId || !item.text || ids.has(item.statusId)) continue;
    ids.add(item.statusId);
    if (posts.length >= limit) continue;
    posts.push({
      statusId: item.statusId,
      url: item.url ?? `https://x.com/i/web/status/${item.statusId}`,
      author: { handle: (item.authorHandle ?? '').replace(/^@+/, '') },
      text: item.text,
      ...(item.createdAt ? { postedAt: item.createdAt } : {}),
      media: [],
    });
  }
  return { posts, more: ids.size > posts.length };
}

/** One timeline, as the signed-in account sees it. */
export async function readTimeline(
  ctx: ChannelContext,
  request: { surface?: XTimeline['surface']; listId?: string; limit?: number } = {},
): Promise<XTimeline> {
  const surface = request.surface ?? 'HOME';
  const limit = Math.min(Math.max(request.limit ?? 15, 1), MAX_POSTS);
  const url = urlFor(surface, request.listId);

  return withSession(ctx, 'RESEARCH', async (session) => {
    await goto(session.page, url);
    await settle();

    // Read further than the limit: a timeline interleaves things that are not
    // posts at all -- promoted content, "who to follow", empty cards -- and
    // reading exactly the limit returns fewer than asked for on a good day.
    const wanted = limit * 3;
    let seen = await readAllArticles(session.page, wanted);
    for (let pass = 0; pass < MAX_SCROLL_PASSES && seen.length < wanted; pass += 1) {
      const before = seen.length;
      await session.page.mouse.wheel(0, SCROLL_PIXELS).catch(() => undefined);
      await session.page.waitForTimeout(800);
      seen = await readAllArticles(session.page, wanted);
      if (seen.length <= before) break;
    }

    const { posts, more } = toTimelinePosts(seen, limit);
    return {
      surface,
      ...(request.listId ? { listId: request.listId } : {}),
      posts,
      more,
    };
  });
}
