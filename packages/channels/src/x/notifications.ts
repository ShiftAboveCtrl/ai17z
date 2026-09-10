import type { XAuthor, XNotification } from '@xbam/shared/contracts';
import type { ChannelContext } from '../contract';
import { SEL, X_URLS } from './selectors';
import { goto, refuseIfXBroke, settle, withSession, type Page } from './page';
import { extractStatusId } from './targets';

/**
 * X's own notifications, read as an answer rather than as a poll.
 *
 * The radar already reads this surface, for a different purpose: it is looking
 * for things to queue work about, it keeps a cursor, and it turns what it finds
 * into candidates. This is the other question -- "what has been happening to
 * me" -- asked by an agent part-way through an answer, or by an owner-facing
 * screen. It resolves nothing, queues nothing, and advances no cursor.
 *
 * On the RESEARCH tab rather than the NOTIFICATIONS one, for the same reason
 * every other capability read is: a read the model asked for arrives at any
 * moment, and it must not move a surface another loop is part-way through. The
 * poller would silently lose its place.
 */

/** How far the reader will scroll for more. Bounded; a feed has no end. */
const MAX_SCROLL_PASSES = 6;
const SCROLL_PIXELS = 1_800;

/**
 * What X said happened, from the sentence it wrote.
 *
 * Pure, and tested against the sentences X actually renders, because this is
 * the whole of the classification: there is no per-kind test id to read. The
 * order is deliberate rather than alphabetical -- a quote post is also a
 * repost in X's vocabulary, and "liked your reply" contains both a like and a
 * reply -- so the more specific claim is checked first.
 *
 * Anything unrecognised is OTHER rather than a guess. X adds notification kinds
 * without warning, and a new one quietly classified as a LIKE is a wrong fact
 * an agent will repeat as its own.
 */
export function classifyNotification(text: string): XNotification['kind'] {
  const t = text.toLowerCase();
  if (/\bfollowed you\b/.test(t)) return 'FOLLOW';
  if (/\bquoted\b/.test(t)) return 'QUOTE';
  if (/\breposted\b|\bretweeted\b/.test(t)) return 'REPOST';
  if (/\bliked\b/.test(t)) return 'LIKE';
  if (/\breplied\b|\breplying to\b/.test(t)) return 'REPLY';
  if (/\bmentioned you\b/.test(t)) return 'MENTION';
  return 'OTHER';
}

/**
 * How many accounts a notification says were involved beyond the ones it names.
 *
 * "and 4 others" is four; "and another" is one. Absent when the sentence names
 * everybody it is about.
 *
 * This exists because X aggregates and only links the first account: reporting
 * five actors for "alice and 4 others liked your post" would mean inventing
 * four people, and reporting one would mean losing four. The count is the
 * honest form of what the page said.
 */
export function othersCount(text: string): number | undefined {
  const many = text.match(/\band (\d[\d,]*) others?\b/i);
  if (many) return Number.parseInt(many[1]!.replace(/,/g, ''), 10);
  if (/\band another\b/i.test(text)) return 1;
  return undefined;
}

/** The accounts a cell actually linked, in the order it linked them. */
function actorsFrom(handles: string[], names: string[]): XAuthor[] {
  const seen = new Set<string>();
  const actors: XAuthor[] = [];
  handles.forEach((handle, index) => {
    const clean = handle.replace(/^@+/, '');
    if (!clean || seen.has(clean.toLowerCase())) return;
    seen.add(clean.toLowerCase());
    const displayName = names[index]?.split('\n')[0]?.trim();
    actors.push({ handle: clean, ...(displayName ? { displayName } : {}) });
  });
  return actors;
}

/** One notification cell, as the page rendered it. */
export interface NotificationCell {
  text: string;
  handles: string[];
  names: string[];
  statusHref: string | null;
  occurredAt: string | null;
}

/**
 * Turns the cells X rendered into notifications.
 *
 * Split from the reading so fixtures can pin it, the same arrangement
 * `resolveBranch` has and for the same reason: the interesting behaviour is the
 * classification, and a live browser proves nothing about it.
 */
export function toNotifications(cells: NotificationCell[]): XNotification[] {
  const out: XNotification[] = [];
  for (const cell of cells) {
    const text = cell.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const others = othersCount(text);
    const statusId = extractStatusId(cell.statusHref ? `https://x.com${cell.statusHref}` : null);
    out.push({
      kind: classifyNotification(text),
      actors: actorsFrom(cell.handles, cell.names),
      ...(statusId ? { statusId } : {}),
      text,
      ...(cell.occurredAt ? { occurredAt: cell.occurredAt } : {}),
      ...(others === undefined ? {} : { others }),
    });
  }
  return out;
}

/** What the owner's notifications currently say. */
export async function readNotifications(
  ctx: ChannelContext,
  request: { surface?: 'ALL' | 'MENTIONS'; limit?: number } = {},
): Promise<{ surface: 'ALL' | 'MENTIONS'; notifications: XNotification[]; more: boolean }> {
  const surface = request.surface ?? 'ALL';
  const limit = Math.min(Math.max(request.limit ?? 15, 1), 50);

  return withSession(ctx, 'RESEARCH', async (session) => {
    await goto(session.page, surface === 'MENTIONS' ? X_URLS.mentions : X_URLS.notifications);
    await settle();

    let cells = await readCells(session.page, limit * 2);
    for (let pass = 0; pass < MAX_SCROLL_PASSES && cells.length < limit; pass += 1) {
      const before = cells.length;
      await session.page.mouse.wheel(0, SCROLL_PIXELS).catch(() => undefined);
      await session.page.waitForTimeout(700);
      cells = await readCells(session.page, limit * 2);
      if (cells.length <= before) break;
    }

    const notifications = toNotifications(cells);
    if (notifications.length === 0) await refuseIfXBroke(session.page, 'notifications');
    return {
      surface,
      notifications: notifications.slice(0, limit),
      // Honest about the ceiling, exactly as search is. A caller told there are
      // fifteen when the page had two hundred is being told the wrong thing.
      more: notifications.length > limit,
    };
  });
}

/**
 * Every notification cell in one evaluation.
 *
 * One round trip rather than five per cell, for the reason `readAllArticles`
 * gives: a locator call per field across sixty cells and six scroll passes is a
 * browser that is never idle, and this one is shared with the tab that has to
 * answer somebody.
 */
async function readCells(page: Page, max: number): Promise<NotificationCell[]> {
  return page
    .locator(SEL.notificationCell)
    .evaluateAll(
      (nodes, limit) =>
        nodes.slice(0, limit).map((node) => {
          const el = node as HTMLElement;
          const links = Array.from(el.querySelectorAll('a[role="link"]')) as HTMLAnchorElement[];
          const handles: string[] = [];
          const names: string[] = [];
          for (const link of links) {
            const href = link.getAttribute('href') ?? '';
            // A profile link is exactly `/handle`. Anything with a second
            // segment is a status, a photo, or one of X's own routes.
            const match = /^\/([A-Za-z0-9_]{1,15})$/.exec(href);
            if (!match) continue;
            handles.push(match[1]!);
            names.push(link.innerText ?? '');
          }
          const status = el.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null;
          return {
            text: el.innerText ?? '',
            handles,
            names,
            statusHref: status?.getAttribute('href') ?? null,
            occurredAt: el.querySelector('time')?.getAttribute('datetime') ?? null,
          };
        }),
      max,
    )
    .catch(() => [] as NotificationCell[]);
}
