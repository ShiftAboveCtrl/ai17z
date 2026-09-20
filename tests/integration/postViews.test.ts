import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { postAnalytics as repo, query } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * Views and impressions are different measurements and are stored as such.
 *
 * They were one column. The X reader mapped the word "views" onto the
 * impressions metric, on the strength of a label table rather than anything
 * establishing the two are the same figure, and the value was then written
 * under a name X had not used.
 *
 * Measured against a live signed-in session: X writes "288 replies, 155
 * reposts, 696 likes, 60 bookmarks, 58814 views" in the count group under a
 * post, and "Views" beside the figure. It never says impressions there. Its own
 * analytics view, where an account has one, does say impressions, and that is a
 * different number arrived at a different way.
 *
 * Migration 0084 separated them. Nothing was backfilled in either direction:
 * inventing a view count from an impressions column would be the same mistake
 * pointing the other way.
 */
const reading = async (remotePostId: string) =>
  (
    await query<{ views: number | null; impressions: number | null }>(
      'SELECT views, impressions FROM post_analytics WHERE remote_post_id = $1 ORDER BY observed_at DESC LIMIT 1',
      [remotePostId],
    )
  )[0]!;

describe('what a post was measured at', () => {
  it('keeps a view count under views and leaves impressions unmeasured', async () => {
    const fixture = await createFixture();
    const post = `views-${Date.now()}`;
    await repo.record({
      agentId: fixture.agentId,
      accountId: null,
      remotePostId: post,
      source: 'POST_ANALYTICS',
      views: 58814,
      likes: 696,
    });

    const row = await reading(post);
    expect(row.views).toBe(58814);
    // Absent, because X's analytics view was never read. Not zero: nobody
    // measured an impression, and a nought here would say somebody had.
    expect(row.impressions).toBeNull();
  });

  it('keeps an impressions reading under impressions and invents no view count', async () => {
    const fixture = await createFixture();
    const post = `impressions-${Date.now()}`;
    await repo.record({
      agentId: fixture.agentId,
      accountId: null,
      remotePostId: post,
      source: 'POST_ANALYTICS',
      impressions: 12405,
    });

    const row = await reading(post);
    expect(row.impressions).toBe(12405);
    expect(row.views).toBeNull();
  });

  it('can hold both when X gave both, without either standing in for the other', async () => {
    const fixture = await createFixture();
    const post = `both-${Date.now()}`;
    await repo.record({
      agentId: fixture.agentId,
      accountId: null,
      remotePostId: post,
      source: 'POST_ANALYTICS',
      views: 58814,
      impressions: 12405,
    });

    const row = await reading(post);
    expect(row.views).toBe(58814);
    expect(row.impressions).toBe(12405);
    expect(row.views).not.toBe(row.impressions);
  });

  it('reports growth in whichever figure was actually measured twice', async () => {
    // One point is not a trend, and a metric measured once stays out of the
    // answer rather than being reported as having moved by nothing.
    const fixture = await createFixture();
    const post = `growth-${Date.now()}`;
    await repo.record({ agentId: fixture.agentId, accountId: null, remotePostId: post, source: 'POST_ANALYTICS', views: 10 });
    await query("UPDATE post_analytics SET observed_at = now() - interval '1 hour' WHERE remote_post_id = $1", [post]);
    await repo.record({ agentId: fixture.agentId, accountId: null, remotePostId: post, source: 'POST_ANALYTICS', views: 35 });

    const moved = await repo.growth(post);
    expect(moved).not.toBeNull();
    const views = moved!.find((m) => m.metric === 'views');
    expect(views).toEqual({ metric: 'views', from: 10, to: 35 });
    // Impressions were never measured, so they are not in the answer at all.
    expect(moved!.some((m) => m.metric === 'impressions')).toBe(false);
  });
});

/**
 * The readings taken before views had a column of their own.
 *
 * 0084 backfilled nothing, because an impressions column could hold either
 * measurement and nothing in a row generally says which. For one source it does
 * say: `TIMELINE` is written by the radar, which reads the count group's own
 * label under a post and has never had access to X's analytics view. It cannot
 * have recorded an impression.
 *
 * Measured before writing 0085: 83 such rows on the test installation and 2513
 * on the live one, every one with an impressions value and none from any other
 * source. Left alone, the analytics screen would have labelled all of them
 * Impressions for ever.
 */
describe('readings taken before views had their own column', () => {
  it('moves a timeline reading and leaves an ambiguous one alone', async () => {
    const fixture = await createFixture();
    const stamp = Date.now();
    const fromTimeline = `tl-${stamp}`;
    const fromAnalytics = `an-${stamp}`;

    // Written the way the old code wrote them: a view count under impressions.
    for (const [post, source, value] of [
      [fromTimeline, 'TIMELINE', 58814],
      [fromAnalytics, 'POST_ANALYTICS', 12405],
    ] as [string, string, number][]) {
      await query(
        `INSERT INTO post_analytics (agent_id, remote_post_id, source, impressions)
         VALUES ($1, $2, $3, $4)`,
        [fixture.agentId, post, source, value],
      );
    }

    // The correction 0085 makes, applied the same way it applies it.
    await query(
      `UPDATE post_analytics SET views = impressions, impressions = NULL
        WHERE source = 'TIMELINE' AND impressions IS NOT NULL AND views IS NULL`,
    );

    const timeline = await reading(fromTimeline);
    expect(timeline.views).toBe(58814);
    expect(timeline.impressions).toBeNull();

    // The analytics reader could see either word on the page, so what it
    // recorded is genuinely ambiguous and is not reinterpreted.
    const analytics = await reading(fromAnalytics);
    expect(analytics.impressions).toBe(12405);
    expect(analytics.views).toBeNull();
  });

  it('is written so that it cannot overwrite a reading already split', async () => {
    // A row that already has both stays exactly as it is.
    const fixture = await createFixture();
    const post = `split-${Date.now()}`;
    await query(
      `INSERT INTO post_analytics (agent_id, remote_post_id, source, impressions, views)
       VALUES ($1, $2, 'TIMELINE', 999, 35)`,
      [fixture.agentId, post],
    );
    await query(
      `UPDATE post_analytics SET views = impressions, impressions = NULL
        WHERE source = 'TIMELINE' AND impressions IS NOT NULL AND views IS NULL`,
    );
    const row = await reading(post);
    expect(row.impressions).toBe(999);
    expect(row.views).toBe(35);
  });

  it('keeps the migration narrow, in the file itself', () => {
    const sql = readFileSync(resolve(__dirname, '../../migrations/0085_timeline_views.sql'), 'utf8');
    // Only the source whose provenance establishes the metric.
    expect(sql).toContain("source = 'TIMELINE'");
    // Never overwrites a value already there.
    expect(sql).toContain('views IS NULL');
    // And touches nothing else.
    expect(sql).not.toMatch(/DELETE|DROP|TRUNCATE/i);
  });
});
