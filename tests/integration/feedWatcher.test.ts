import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installHarness } from '../support/harness';
import { uniqueSuffix } from '../support/db';

/**
 * The one invariant: a restart must not replay history as new work.
 *
 * A feed republishes its whole visible list every time it is fetched, so the
 * difference between "thirty articles" and "one new article" exists only in what
 * this installation remembers. If that memory lives in a process it is gone the
 * moment the worker restarts, and the agent announces a month of old posts as
 * though they had just happened -- with real entries, real dates, and nothing
 * anywhere reporting an error.
 *
 * These run against a real database because the cursor is a database row, and a
 * mock of the thing under test proves the mock works.
 */

let responses: Record<string, { status: number; body?: string; headers?: Record<string, string> }> = {};
let requests: { url: string; headers: Record<string, string> }[] = [];

vi.mock('undici', () => ({
  Agent: class {
    async close() {}
  },
  async fetch(input: unknown, init?: { headers?: Record<string, string> }) {
    const url = String(input);
    requests.push({ url, headers: init?.headers ?? {} });
    const match = Object.keys(responses).find((key) => url.includes(key));
    const answer = match ? responses[match]! : { status: 404, body: 'not found' };
    const headers = new Headers({ 'content-type': 'application/xml', ...(answer.headers ?? {}) });
    return new Response(answer.status === 304 ? null : (answer.body ?? ''), { status: answer.status, headers });
  },
}));

installHarness();

const { feedSubscriptions } = await import('@xbam/database');
const { registerFeedUpstreams, resetBreakerForTest, resetCacheForTest, resetLimiterForTest, resetUpstreamsForTest } =
  await import('@xbam/upstream');
const { pollDueFeeds, freshEntries } = await import('@xbam/runtime');

/** A feed with the given entry ids, newest first. */
function feedWith(ids: string[], titlePrefix = 'Post'): string {
  const items = ids
    .map(
      (id) =>
        `<item><title>${titlePrefix} ${id}</title><link>https://example.com/${id}</link>` +
        `<guid isPermaLink="false">${id}</guid></item>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
    <title>A Blog</title><link>https://example.com/</link>${items}</channel></rss>`;
}

function serve(body: string, headers: Record<string, string> = {}, status = 200): void {
  responses = { 'example.com': { status, body, headers } };
}

async function subscribeTo(url: string) {
  return feedSubscriptions.subscribe({ url, label: 'test feed', intervalSeconds: 60 });
}

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
  registerFeedUpstreams();
  responses = {};
  requests = [];
});
afterEach(() => {
  resetUpstreamsForTest();
});

describe('deciding what is new', () => {
  it('is only the entries not already seen', () => {
    const entries = [{ id: 'c' }, { id: 'b' }, { id: 'a' }] as never[];
    expect(freshEntries(entries, ['a', 'b']).map((entry) => (entry as { id: string }).id)).toEqual(['c']);
  });

  it('is nothing when everything is known, however the feed ordered it', () => {
    const entries = [{ id: 'b' }, { id: 'a' }, { id: 'c' }] as never[];
    expect(freshEntries(entries, ['c', 'a', 'b'])).toEqual([]);
  });
});

describe('the cursor', () => {
  it('keeps the newest ids and drops the oldest past the window', () => {
    const many = Array.from({ length: 600 }, (_, index) => `new-${index}`);
    const merged = feedSubscriptions.mergeSeen(many, ['ancient']);
    expect(merged).toHaveLength(feedSubscriptions.SEEN_WINDOW);
    expect(merged[0]).toBe('new-0');
    // An entry that has fallen off the end of a feed cannot reappear, so
    // remembering it forever buys nothing.
    expect(merged).not.toContain('ancient');
  });

  it('does not duplicate an id that was already known', () => {
    expect(feedSubscriptions.mergeSeen(['b', 'a'], ['a', 'z'])).toEqual(['b', 'a', 'z']);
  });
});

describe('a feed being watched', () => {
  it('records the first poll and announces nothing', async () => {
    // Subscribing is not news. Without this, adding a feed announces its entire
    // visible history at once.
    const url = `https://example.com/${uniqueSuffix()}.xml`;
    serve(feedWith(['a', 'b', 'c']));
    await subscribeTo(url);

    const [outcome] = await pollDueFeeds();
    expect(outcome!.primed).toBe(true);
    expect(outcome!.fresh).toEqual([]);

    const after = (await feedSubscriptions.listSubscriptions()).find((row) => row.url === url)!;
    expect(after.primed).toBe(true);
    expect(after.seenEntryIds).toEqual(['a', 'b', 'c']);
  });

  it('announces only what appeared since', async () => {
    const url = `https://example.com/${uniqueSuffix()}.xml`;
    serve(feedWith(['a', 'b']));
    const subscription = await subscribeTo(url);
    await pollDueFeeds();

    // Make it due again, as the next tick would find it.
    await feedSubscriptions.recordPoll({
      id: subscription.id,
      etag: null,
      lastModified: null,
      seenEntryIds: ['a', 'b'],
      intervalSeconds: 0,
      status: 'OK',
      entriesSeen: 2,
    });
    resetCacheForTest();
    serve(feedWith(['c', 'a', 'b']));

    const [outcome] = await pollDueFeeds();
    expect(outcome!.fresh.map((entry) => entry.id)).toEqual(['c']);
  });

  /**
   * The test this whole feature exists for.
   *
   * Everything in the process is thrown away and rebuilt, exactly as a restart
   * does. The only thing that survives is the database row.
   */
  it('does not replay history after a restart', async () => {
    const url = `https://example.com/${uniqueSuffix()}.xml`;
    const ids = Array.from({ length: 30 }, (_, index) => `entry-${index}`);
    serve(feedWith(ids));
    const subscription = await subscribeTo(url);

    await pollDueFeeds();
    await feedSubscriptions.recordPoll({
      id: subscription.id,
      etag: null,
      lastModified: null,
      seenEntryIds: ids,
      intervalSeconds: 0,
      status: 'OK',
      entriesSeen: ids.length,
    });

    // The restart: every in-memory structure the upstream layer holds is
    // discarded and registered again from nothing.
    resetUpstreamsForTest();
    resetBreakerForTest();
    resetCacheForTest();
    resetLimiterForTest();
    registerFeedUpstreams();

    serve(feedWith(ids));
    const [outcome] = await pollDueFeeds();

    // Thirty real entries, all of them already seen, none of them news.
    expect(outcome!.fresh).toEqual([]);
    expect(outcome!.failed).toBe(false);
  });

  it('sends the validators it stored, and treats 304 as nothing new', async () => {
    const url = `https://example.com/${uniqueSuffix()}.xml`;
    serve(feedWith(['a']), { etag: 'W/"v1"' });
    const subscription = await subscribeTo(url);
    await pollDueFeeds();

    const stored = (await feedSubscriptions.getSubscription(subscription.id))!;
    expect(stored.etag).toBe('W/"v1"');

    await feedSubscriptions.recordPoll({
      id: subscription.id,
      etag: stored.etag,
      lastModified: stored.lastModified,
      seenEntryIds: stored.seenEntryIds,
      intervalSeconds: 0,
      status: 'OK',
      entriesSeen: 1,
    });
    resetCacheForTest();
    requests = [];
    responses = { 'example.com': { status: 304 } };

    const [outcome] = await pollDueFeeds();
    expect(requests[0]!.headers['if-none-match']).toBe('W/"v1"');
    expect(outcome!.notModified).toBe(true);
    expect(outcome!.fresh).toEqual([]);

    // And the cursor survived a poll that fetched nothing.
    const after = (await feedSubscriptions.getSubscription(subscription.id))!;
    expect(after.seenEntryIds).toEqual(['a']);
  });

  it('keeps the cursor when a poll fails, so an outage is not a replay', async () => {
    const url = `https://example.com/${uniqueSuffix()}.xml`;
    serve(feedWith(['a', 'b']));
    const subscription = await subscribeTo(url);
    await pollDueFeeds();
    await feedSubscriptions.recordPoll({
      id: subscription.id,
      etag: null,
      lastModified: null,
      seenEntryIds: ['a', 'b'],
      intervalSeconds: 0,
      status: 'OK',
      entriesSeen: 2,
    });

    resetCacheForTest();
    resetBreakerForTest();
    responses = { 'example.com': { status: 500, body: 'the site is unwell' } };
    const [failed] = await pollDueFeeds();
    expect(failed!.failed).toBe(true);

    const after = (await feedSubscriptions.getSubscription(subscription.id))!;
    // Clearing the cursor here is how a transient outage becomes a replay of
    // everything once the feed comes back.
    expect(after.seenEntryIds).toEqual(['a', 'b']);
    expect(after.consecutiveFailures).toBe(1);
    expect(after.lastStatus).toBe('FAILED');
  });

  it('backs off a feed that keeps failing rather than asking every minute for ever', async () => {
    const url = `https://example.com/${uniqueSuffix()}.xml`;
    const subscription = await subscribeTo(url);
    responses = { 'example.com': { status: 500, body: 'still unwell' } };

    // Measured as the wait from the poll, not as two absolute times. Comparing
    // the absolute times passes even with a flat interval, because the second
    // failure is simply recorded later -- which is how the first version of
    // this test confirmed a backoff that was not happening.
    const waitAfter = async (attempt: string): Promise<number> => {
      await feedSubscriptions.recordFailure({ id: subscription.id, error: attempt, intervalSeconds: 60 });
      const row = (await feedSubscriptions.getSubscription(subscription.id))!;
      return new Date(row.nextPollAt).getTime() - new Date(row.lastPolledAt!).getTime();
    };

    const first = await waitAfter('first');
    const second = await waitAfter('second');
    const third = await waitAfter('third');

    // 60s doubling: two minutes, then four, then eight.
    expect(first).toBeGreaterThanOrEqual(110_000);
    expect(second).toBeGreaterThanOrEqual(first * 1.8);
    expect(third).toBeGreaterThanOrEqual(second * 1.8);

    const row = (await feedSubscriptions.getSubscription(subscription.id))!;
    expect(row.consecutiveFailures).toBe(3);
  });
});

describe('subscribing', () => {
  it('refuses to create a second row for one URL', async () => {
    // Two subscriptions to one feed would poll it twice and emit everything
    // twice.
    const url = `https://example.com/${uniqueSuffix()}.xml`;
    const first = await subscribeTo(url);
    const second = await subscribeTo(url);
    expect(second.id).toBe(first.id);
    expect((await feedSubscriptions.listSubscriptions()).filter((row) => row.url === url)).toHaveLength(1);
  });

  it('claims a due feed once, so two workers cannot both take it', async () => {
    const url = `https://example.com/${uniqueSuffix()}.xml`;
    await subscribeTo(url);
    const first = await feedSubscriptions.claimDueFeeds(10, 120);
    const second = await feedSubscriptions.claimDueFeeds(10, 120);
    expect(first.some((row) => row.url === url)).toBe(true);
    // The claim moved the due time forward in the same statement that selected
    // it, so the second caller sees nothing.
    expect(second.some((row) => row.url === url)).toBe(false);
  });

  it('keeps the cursor when the same feed is subscribed again', async () => {
    // The third route to the same replay. Re-adding a feed -- to rename it, or
    // to turn it back on -- must not forget what has been seen, or the agent
    // announces the whole visible history again with nothing having gone wrong.
    const url = `https://example.com/${uniqueSuffix()}.xml`;
    serve(feedWith(['a', 'b', 'c']));
    const first = await subscribeTo(url);
    await pollDueFeeds();

    const primed = (await feedSubscriptions.getSubscription(first.id))!;
    expect(primed.seenEntryIds).toEqual(['a', 'b', 'c']);

    // Subscribe again, as somebody renaming it would.
    const again = await feedSubscriptions.subscribe({ url, label: 'renamed' });
    expect(again.id).toBe(first.id);
    expect(again.seenEntryIds).toEqual(['a', 'b', 'c']);
    expect(again.primed).toBe(true);
    expect(again.label).toBe('renamed');

    // And a poll right after still finds nothing new.
    await feedSubscriptions.recordPoll({
      id: first.id,
      etag: null,
      lastModified: null,
      seenEntryIds: ['a', 'b', 'c'],
      intervalSeconds: 0,
      status: 'OK',
      entriesSeen: 3,
    });
    resetCacheForTest();
    serve(feedWith(['a', 'b', 'c']));
    const [outcome] = await pollDueFeeds();
    expect(outcome!.fresh).toEqual([]);
  });

  it('turning a feed back on does not forget what it had seen', async () => {
    const url = `https://example.com/${uniqueSuffix()}.xml`;
    serve(feedWith(['x', 'y']));
    const subscription = await subscribeTo(url);
    await pollDueFeeds();

    await feedSubscriptions.setEnabled(subscription.id, false);
    const off = (await feedSubscriptions.getSubscription(subscription.id))!;
    expect(off.seenEntryIds).toEqual(['x', 'y']);

    await feedSubscriptions.setEnabled(subscription.id, true);
    const on = (await feedSubscriptions.getSubscription(subscription.id))!;
    expect(on.seenEntryIds).toEqual(['x', 'y']);
    expect(on.primed).toBe(true);
  });

  it('leaves a disabled feed alone', async () => {
    const url = `https://example.com/${uniqueSuffix()}.xml`;
    const subscription = await subscribeTo(url);
    await feedSubscriptions.setEnabled(subscription.id, false);
    const due = await feedSubscriptions.claimDueFeeds(10, 120);
    expect(due.some((row) => row.url === url)).toBe(false);
  });
});
