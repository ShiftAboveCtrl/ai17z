import type { XConnections } from '@xbam/shared/contracts';
import { PipelineError } from '@xbam/shared';
import type { ChannelContext } from '../contract';
import { SEL } from './selectors';
import { goto, settle, withSession, type Page } from './page';

/**
 * Who follows an account, and who it follows.
 *
 * This is the raw material the relationship graph is built from, and it is the
 * one X surface where reading too eagerly is a real cost: a large account's
 * follower list is effectively infinite, and scrolling it is a request per
 * screen against a session that has to stay usable. So it is bounded hard, it
 * says when it stopped early, and it is a capability an owner can switch off
 * rather than a poll that runs on its own.
 *
 * Nothing here decides what a connection means. `docs/ENGINEERING.md` is clear
 * that the entity graph records that two things were named together and makes
 * no other claim; a follower list is the same kind of observation, and strength
 * and stage are the relationship system's business.
 */

/** How far the reader will scroll. A follower list has no end to reach. */
const MAX_SCROLL_PASSES = 10;
const SCROLL_PIXELS = 2_000;

/** The hard ceiling on one read, whatever was asked for. */
const MAX_ACCOUNTS = 100;

const PATHS: Record<XConnections['kind'], string> = {
  FOLLOWERS: 'followers',
  FOLLOWING: 'following',
  // X's own list of the followers it considers verified. A different page, not
  // a filter applied afterwards, so it is a different answer.
  VERIFIED_FOLLOWERS: 'verified_followers',
};

/** One account as a user cell presents it. */
export interface UserCell {
  handle: string;
  displayName: string | null;
  bio: string | null;
  /** X's own badge, which is the only place this fact is stated. */
  followsYou: boolean;
}

/**
 * Turns the cells X rendered into a list, keeping the order and dropping repeats.
 *
 * Split from the reading so fixtures can pin it: the interesting behaviour is
 * that a virtualised list re-renders the same rows as it scrolls, and reading
 * it twice must not report an account twice.
 */
export function toConnections(cells: UserCell[], limit: number): { accounts: XConnections['accounts']; more: boolean } {
  const seen = new Set<string>();
  const accounts: XConnections['accounts'] = [];
  for (const cell of cells) {
    const handle = cell.handle.replace(/^@+/, '').trim();
    if (!handle || seen.has(handle.toLowerCase())) continue;
    seen.add(handle.toLowerCase());
    if (accounts.length >= limit) continue;
    accounts.push({
      handle,
      ...(cell.displayName?.trim() ? { displayName: cell.displayName.trim() } : {}),
      ...(cell.bio?.trim() ? { bio: cell.bio.trim().replace(/\s+/g, ' ') } : {}),
      // Only ever true. The badge's absence is X not saying so, which on a
      // virtualised row that has not finished rendering is not the same as no.
      ...(cell.followsYou ? { followsYou: true } : {}),
    });
  }
  return { accounts, more: seen.size > accounts.length };
}

/** Who follows an account, or who it follows. */
export async function readConnections(
  ctx: ChannelContext,
  request: { handle: string; kind?: XConnections['kind']; limit?: number },
): Promise<XConnections> {
  const handle = request.handle.trim().replace(/^@+/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    throw PipelineError.permanent('bad_handle', `"${request.handle}" is not an X handle.`);
  }
  const kind = request.kind ?? 'FOLLOWERS';
  const limit = Math.min(Math.max(request.limit ?? 25, 1), MAX_ACCOUNTS);

  return withSession(ctx, 'RESEARCH', async (session) => {
    await goto(session.page, `https://x.com/${handle}/${PATHS[kind]}`);
    await settle();

    let cells = await readUserCells(session.page, limit * 2);
    if (cells.length === 0) {
      // An empty list and a page that refused to show one look identical from
      // here, and they are different answers. A protected account, a suspended
      // one, or a list X will not show a stranger all land here.
      const visible = await session.page
        .locator(SEL.userCell)
        .first()
        .isVisible()
        .catch(() => false);
      if (!visible) {
        throw PipelineError.permanent(
          'connections_not_readable',
          `X did not show @${handle}'s ${kind.toLowerCase().replace(/_/g, ' ')}.`,
        );
      }
    }

    for (let pass = 0; pass < MAX_SCROLL_PASSES && cells.length < limit; pass += 1) {
      const before = cells.length;
      await session.page.mouse.wheel(0, SCROLL_PIXELS).catch(() => undefined);
      await session.page.waitForTimeout(700);
      const next = await readUserCells(session.page, limit * 2);
      // The list is virtualised: rows scrolled past are removed from the DOM,
      // so each pass is a window rather than the whole list, and they have to
      // be accumulated. Reading only the current window caps the answer at a
      // screenful however far it scrolls.
      cells = [...cells, ...next];
      if (cells.length <= before) break;
    }

    const { accounts, more } = toConnections(cells, limit);
    return { handle, kind, accounts, more };
  });
}

/** Every user cell currently in the DOM, in one evaluation. */
async function readUserCells(page: Page, max: number): Promise<UserCell[]> {
  return page
    .locator(SEL.userCell)
    .evaluateAll(
      (nodes, limit) =>
        nodes.slice(0, limit).map((node) => {
          const el = node as HTMLElement;
          const links = Array.from(el.querySelectorAll('a[role="link"]')) as HTMLAnchorElement[];
          let handle = '';
          for (const link of links) {
            const match = /^\/([A-Za-z0-9_]{1,15})$/.exec(link.getAttribute('href') ?? '');
            if (match) {
              handle = match[1]!;
              break;
            }
          }
          const nameBlock = (el.querySelector('[data-testid="UserName"], [data-testid="User-Name"]') as HTMLElement | null)
            ?.innerText;
          const description = (el.querySelector('[data-testid="UserDescription"]') as HTMLElement | null)?.innerText;
          const text = el.innerText ?? '';
          return {
            handle,
            displayName: nameBlock?.split('\n')[0] ?? null,
            bio: description ?? null,
            followsYou: /(^|\n)\s*Follows you\s*(\n|$)/i.test(text),
          };
        }),
      max,
    )
    .catch(() => [] as UserCell[]);
}
