import { describe, expect, it } from 'vitest';
import { SEL, ensureEngaged, xAdapter } from '@xbam/channels';


/**
 * LIKE and REPOST as desired states, never as toggles.
 *
 * The distinction is the entire design. An agent that clicks the like control
 * because it decided to like something will *unlike* a post it already liked --
 * and it will do that precisely on a retry, which is when it is least wanted.
 * So the state is read first, and the click only happens if the state is wrong.
 *
 * That is also why there is no separate reconciliation path: reading the state
 * before acting *is* the reconciliation. A worker that died after clicking
 * comes back, sees the post already liked, and touches nothing.
 */

interface Node {
  visible: boolean;
  /** Becomes visible once the control is clicked, as X swaps the test id. */
  appearsAfter?: string;
}

function fakePage(nodes: Record<string, Node>) {
  const clicks: string[] = [];
  const state = { ...nodes };

  const locatorFor = (selector: string) => ({
    first() {
      return this;
    },
    locator(inner: string) {
      return locatorFor(inner);
    },
    async isVisible() {
      return state[selector]?.visible ?? false;
    },
    async click() {
      clicks.push(selector);
      for (const [key, node] of Object.entries(state)) {
        if (node.appearsAfter === selector) state[key] = { ...node, visible: true };
      }
      // X swaps the control for its opposite, so the one just clicked goes.
      if (state[selector]) state[selector] = { ...state[selector]!, visible: false };
    },
    async waitFor() {
      if (!(state[selector]?.visible ?? false)) throw new Error(`${selector} not visible`);
    },
  });

  return { clicks, locator: locatorFor };
}

const article = (page: ReturnType<typeof fakePage>) => page.locator('article');

describe('LIKE means ensure-liked', () => {
  it('clicks once when the post is not yet liked, and proves the new state', async () => {
    const page = fakePage({
      [SEL.like]: { visible: true },
      [SEL.unlike]: { visible: false, appearsAfter: SEL.like },
    });

    const outcome = await ensureEngaged(page as never, article(page) as never, 'LIKE', '123');

    expect(outcome.evidence).toEqual({ alreadyInState: false, clicks: 1 });
    expect(page.clicks).toEqual([SEL.like]);
  });

  it('does nothing at all when the post is already liked', async () => {
    // The unlike guard. Clicking here would undo the like, which is the exact
    // opposite of the intent, and a retry is when it would happen.
    const page = fakePage({ [SEL.like]: { visible: false }, [SEL.unlike]: { visible: true } });

    const outcome = await ensureEngaged(page as never, article(page) as never, 'LIKE', '123');

    expect(outcome.evidence).toEqual({ alreadyInState: true, clicks: 0 });
    expect(page.clicks).toEqual([]);
    expect(outcome.detail).toMatch(/already liked/i);
  });

  it('reconciles on a retry rather than clicking again', async () => {
    // Model the ambiguous case: the first attempt clicked and then the worker
    // died before recording it. The second attempt must find the state already
    // right and stop.
    const first = fakePage({
      [SEL.like]: { visible: true },
      [SEL.unlike]: { visible: false, appearsAfter: SEL.like },
    });
    await ensureEngaged(first as never, article(first) as never, 'LIKE', '123');

    const retry = fakePage({ [SEL.like]: { visible: false }, [SEL.unlike]: { visible: true } });
    const outcome = await ensureEngaged(retry as never, article(retry) as never, 'LIKE', '123');

    expect(retry.clicks).toEqual([]);
    expect(outcome.evidence.clicks).toBe(0);
  });

  it('refuses rather than guessing when the control is not there', async () => {
    const page = fakePage({ [SEL.like]: { visible: false }, [SEL.unlike]: { visible: false } });
    await expect(ensureEngaged(page as never, article(page) as never, 'LIKE', '123')).rejects.toThrow(
      /control was not visible/i,
    );
    expect(page.clicks).toEqual([]);
  });
});

describe('REPOST means ensure-reposted, and never a quote', () => {
  it('takes the plain Repost entry from the menu, exactly once', async () => {
    const page = fakePage({
      [SEL.repost]: { visible: true },
      [SEL.repostConfirm]: { visible: false, appearsAfter: SEL.repost },
      [SEL.unrepost]: { visible: false, appearsAfter: SEL.repostConfirm },
    });

    const outcome = await ensureEngaged(page as never, article(page) as never, 'REPOST', '123');

    expect(outcome.evidence).toEqual({ alreadyInState: false, clicks: 1 });
    // The control, then the plain confirm. Nothing else was touched -- and
    // `quoteTweet` sits beside `retweetConfirm` in that same menu.
    expect(page.clicks).toEqual([SEL.repost, SEL.repostConfirm]);
    expect(page.clicks).not.toContain('[data-testid="quoteTweet"]');
  });

  it('does nothing at all when the post is already reposted', async () => {
    const page = fakePage({ [SEL.repost]: { visible: false }, [SEL.unrepost]: { visible: true } });

    const outcome = await ensureEngaged(page as never, article(page) as never, 'REPOST', '123');

    expect(outcome.evidence).toEqual({ alreadyInState: true, clicks: 0 });
    expect(page.clicks).toEqual([]);
  });

  it('stops when X does not offer the menu, rather than assuming it worked', async () => {
    const page = fakePage({
      [SEL.repost]: { visible: true },
      [SEL.repostConfirm]: { visible: false },
      [SEL.unrepost]: { visible: false },
    });
    await expect(ensureEngaged(page as never, article(page) as never, 'REPOST', '123')).rejects.toThrow(
      /repost menu/i,
    );
  });

  it('stops when the state did not change, rather than reporting success', async () => {
    const page = fakePage({
      [SEL.repost]: { visible: true },
      [SEL.repostConfirm]: { visible: false, appearsAfter: SEL.repost },
      [SEL.unrepost]: { visible: false },
    });
    await expect(ensureEngaged(page as never, article(page) as never, 'REPOST', '123')).rejects.toThrow(
      /does not read as reposted/i,
    );
  });
});

describe('the two states are distinguishable at all', () => {
  it('uses a different control for each direction', () => {
    // X swaps the test id rather than toggling an attribute, which is what
    // makes "already in the desired state" answerable without remembering
    // whether we clicked. If these ever became the same selector, every test
    // above would still pass and the feature would silently become a toggle.
    expect(SEL.like).not.toBe(SEL.unlike);
    expect(SEL.repost).not.toBe(SEL.unrepost);
    expect(SEL.repostConfirm).not.toBe(SEL.repost);
  });

  it('advertises only what it can actually perform', () => {
    // LIKE sat in this list for a long time with nothing behind it, so an agent
    // granted it queued work that always failed at execution.
    expect(xAdapter.capabilities).toContain('LIKE');
    expect(xAdapter.capabilities).toContain('REPOST');
  });
});
