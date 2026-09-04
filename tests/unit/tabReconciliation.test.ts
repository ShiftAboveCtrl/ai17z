import { describe, expect, it } from 'vitest';
import { expectedPageCount, reconcileTabs, RECONCILE_ROLES, type OpenPage } from '@xbam/browser';

let nextId = 0;
const page = (url: string, tag: OpenPage['tag'] = null): OpenPage => ({ id: `p${(nextId += 1)}`, tag, url });

/**
 * A real profile was found holding fifteen pages, twelve of them x.com/home,
 * in a runtime designed to keep four. That is one abandoned tab per unclean
 * restart, accumulating until Chrome is killed for memory. Which it was.
 *
 * The cause is that `window.name` is the only identity and it does not survive
 * a cross-origin navigation. `retagIfLost` re-asserts it afterwards, but a
 * worker that dies in the gap leaves a tab that is perfectly good and
 * permanently anonymous: the next worker cannot claim it, opens its own, and
 * the old one stays for ever.
 */
describe('claiming the tabs a previous worker left', () => {
  it('adopts every role when the tags survived', () => {
    const pages = [
      page('https://x.com/home', 'ACTION'),
      page('https://x.com/search?q=x', 'MENTIONS'),
      page('https://x.com/notifications', 'NOTIFICATIONS'),
      page('https://search.brave.com/', 'RESEARCH'),
    ];
    const result = reconcileTabs(pages);
    expect(result.create).toEqual([]);
    expect(result.close).toEqual([]);
    expect(Object.keys(result.adopt).sort()).toEqual([...RECONCILE_ROLES].sort());
  });

  it('claims a tab whose tag a cross-origin navigation cleared', () => {
    // The whole point. Without this the tab is unrecognisable and a new one is
    // opened beside it.
    const pages = [
      page('https://x.com/notifications'),
      page('https://x.com/search?q=%40me%20-from%3Ame'),
      page('https://duckduckgo.com/?q=weather'),
    ];
    const result = reconcileTabs(pages);
    expect(result.adopt.NOTIFICATIONS).toBe(pages[0]!.id);
    expect(result.adopt.MENTIONS).toBe(pages[1]!.id);
    expect(result.adopt.RESEARCH).toBe(pages[2]!.id);
    expect(result.close).toEqual([]);
  });

  it('never guesses the action tab from a page it cannot identify', () => {
    // ACTION's page is whichever status is being replied to, which matches
    // nothing distinctive. Guessing there would claim a stranger's tab.
    const pages = [page('https://x.com/someone/status/123')];
    const result = reconcileTabs(pages);
    // It may be adopted as the one spare x.com page, but never by shape.
    expect(result.adopt.MENTIONS).toBeUndefined();
    expect(result.adopt.NOTIFICATIONS).toBeUndefined();
  });

  it('closes the tabs nothing claimed', () => {
    const pages = [
      page('https://x.com/home', 'ACTION'),
      page('https://x.com/home'),
      page('https://x.com/home'),
      page('https://x.com/home'),
    ];
    const result = reconcileTabs(pages);
    expect(result.close.length).toBeGreaterThan(0);
  });

  it('never claims or closes a sign-in', () => {
    // Closing one costs somebody their session and there is no way to give it
    // back. Sign-in is always the person's job.
    const pages = [
      page('https://x.com/i/flow/login'),
      page('https://x.com/account/access'),
      page('https://x.com/home'),
      page('https://x.com/home'),
    ];
    const result = reconcileTabs(pages);
    expect(result.close).not.toContain(pages[0]!.id);
    expect(result.close).not.toContain(pages[1]!.id);
    expect(Object.values(result.adopt)).not.toContain(pages[0]!.id);
    expect(result.keep.map((k) => k.id)).toEqual(expect.arrayContaining([pages[0]!.id, pages[1]!.id]));
  });

  it('never closes a composer holding unsent text', () => {
    const pages = [page('https://x.com/compose/post'), page('https://x.com/home'), page('https://x.com/home')];
    expect(reconcileTabs(pages).close).not.toContain(pages[0]!.id);
  });

  it('leaves a blank tab alone rather than treating it as rubbish', () => {
    const pages = [page('about:blank'), page('https://x.com/home', 'ACTION')];
    const result = reconcileTabs(pages);
    expect(result.close).not.toContain(pages[0]!.id);
  });
});

describe('restarting the worker again and again', () => {
  /** One unclean restart: tags are lost, then the new worker reconciles. */
  function restart(pages: OpenPage[], { loseTags }: { loseTags: boolean }): OpenPage[] {
    const carried = pages.map((p) => ({ ...p, tag: loseTags ? null : p.tag }));
    const result = reconcileTabs(carried);

    const survivors = carried.filter((p) => !result.close.includes(p.id));
    // Whatever was adopted is re-tagged by the new worker.
    for (const [role, id] of Object.entries(result.adopt)) {
      const found = survivors.find((p) => p.id === id);
      if (found) found.tag = role as OpenPage['tag'];
    }
    // And whatever it could not adopt, it opens.
    const opened = result.create.map((role) =>
      page(role === 'RESEARCH' ? 'https://search.brave.com/' : role === 'MENTIONS' ? 'https://x.com/search?q=me' : role === 'NOTIFICATIONS' ? 'https://x.com/notifications' : 'https://x.com/home', role),
    );
    return [...survivors, ...opened];
  }

  it('keeps the tab count flat across twenty unclean restarts', () => {
    // This is the property that was broken. Before reconciliation the count
    // grew by one to three every restart until Chrome was killed.
    let pages: OpenPage[] = [];
    const counts: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      pages = restart(pages, { loseTags: true });
      counts.push(pages.length);
    }
    expect(Math.max(...counts)).toBeLessThanOrEqual(RECONCILE_ROLES.length + 1);
    expect(counts[19]).toBe(counts[4]);
  });

  it('keeps it flat when tags do survive', () => {
    let pages: OpenPage[] = [];
    for (let i = 0; i < 20; i += 1) pages = restart(pages, { loseTags: false });
    expect(pages.length).toBe(RECONCILE_ROLES.length);
  });

  it('recovers from the fifteen-tab profile that was actually found', () => {
    // Twelve timelines, a mentions search, a notifications page and a status
    // page, none of them tagged, exactly as the live browser had them.
    const found: OpenPage[] = [
      ...Array.from({ length: 12 }, () => page('https://x.com/home')),
      page('https://x.com/notifications/mentions'),
      page('https://x.com/search?q=%40ai17zos%20-from%3Aai17zos'),
      page('https://x.com/ai17zOS/status/2095195986368831636'),
    ];
    const result = reconcileTabs(found);
    expect(expectedPageCount(result, found)).toBeLessThanOrEqual(RECONCILE_ROLES.length + 1);
    // And it kept the useful ones rather than closing everything and starting over.
    expect(result.adopt.NOTIFICATIONS).toBeTruthy();
    expect(result.adopt.MENTIONS).toBeTruthy();
  });

  it('does not grow even when a sign-in is sitting there every time', () => {
    // The protected page is kept on every pass, and must not be counted as a
    // reason to keep opening more.
    let pages: OpenPage[] = [page('https://x.com/i/flow/login')];
    for (let i = 0; i < 10; i += 1) pages = restart(pages, { loseTags: true });
    expect(pages.length).toBeLessThanOrEqual(RECONCILE_ROLES.length + 2);
  });
});
