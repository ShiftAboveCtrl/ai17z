import { describe, expect, it } from 'vitest';
import { findOpportunities, topicsIn, scoreBridge, type OpportunityCandidate } from '@xbam/runtime';

/**
 * Deciding what is worth speaking into, which is mostly deciding what is not.
 *
 * The failure this file exists to prevent is the easy version of the feature:
 * score every post on a timeline, take the top ten, reply to them. That is an
 * agent that answers strangers about subjects it knows nothing about, and every
 * one of those replies is sent under somebody's own name.
 *
 * So the declines are the interesting assertions here, and each one carries a
 * sentence -- `docs/ENGINEERING.md` requires the reasons to reach the interface,
 * and "we looked at forty posts and found nothing" is a thing an owner should
 * be able to read.
 */

const now = new Date('2026-09-09T12:00:00.000Z');
const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000).toISOString();

const post = (over: Partial<OpportunityCandidate>): OpportunityCandidate => ({
  statusId: '1',
  handle: 'stranger',
  text: 'A long enough sentence about rollups and their sequencer economics.',
  postedAt: minutesAgo(30),
  ...over,
});

const context = {
  selfHandles: ['ouragent'],
  topics: ['rollups', 'sequencer', 'restaking'],
  recentlyEngaged: [] as string[],
  now,
};

describe('finding which topics a post is about', () => {
  it('matches whole words, not fragments', () => {
    // "ai" inside "said" is how an agent replies to a post about the weather
    // with an opinion about machine learning.
    expect(topicsIn('he said whether it would rain', ['ai', 'eth'])).toEqual([]);
    expect(topicsIn('thoughts on ETH today', ['eth'])).toEqual(['eth']);
  });

  it('matches a multi-word topic as a phrase', () => {
    expect(topicsIn('the sequencer economics are the whole story', ['sequencer economics'])).toEqual([
      'sequencer economics',
    ]);
    expect(topicsIn('economics of the sequencer', ['sequencer economics'])).toEqual([]);
  });
});

describe('finding opportunities', () => {
  it('declines a post with nothing the agent has anything to say about', () => {
    // The rule that keeps this from being a stranger-engagement machine.
    const { opportunities, declined } = findOpportunities(
      [post({ text: 'Woke up early and made a genuinely excellent omelette this morning.' })],
      context,
    );
    expect(opportunities).toHaveLength(0);
    expect(declined[0]!.reason).toBe('off_topic');
    expect(declined[0]!.detail).toMatch(/anything to say/i);
  });

  it('declines the agent’s own posts', () => {
    const { declined } = findOpportunities([post({ handle: 'OurAgent' })], context);
    expect(declined[0]!.reason).toBe('own_post');
  });

  it('declines somebody the agent has just spoken to', () => {
    // Turning up under three of somebody's posts in an afternoon reads as
    // being followed around, whatever each reply says.
    const { declined } = findOpportunities([post({ handle: 'alice' })], {
      ...context,
      recentlyEngaged: ['@Alice'],
    });
    expect(declined[0]!.reason).toBe('already_engaged');
  });

  it('declines a conversation that has moved on', () => {
    const { declined } = findOpportunities([post({ postedAt: minutesAgo(60 * 40) })], context);
    expect(declined[0]!.reason).toBe('too_old');
    expect(declined[0]!.detail).toMatch(/hours ago/);
  });

  it('declines a post whose age it could not tell', () => {
    // Absent is not fresh. A timeline that did not render a timestamp may be
    // showing something from last week.
    const { declined } = findOpportunities([post({ postedAt: undefined })], context);
    expect(declined[0]!.reason).toBe('age_unknown');
  });

  it('declines an account the owner said not to engage', () => {
    const blocked = scoreBridge({ handle: 'alice', disposition: 'BLOCKED' }, now);
    const { declined } = findOpportunities([post({ handle: 'alice' })], {
      ...context,
      bridges: { alice: blocked },
    });
    expect(declined[0]!.reason).toBe('blocked');
  });

  it('prefers a live conversation to a crowded one', () => {
    const { opportunities } = findOpportunities(
      [
        post({ statusId: 'quiet', replyCount: 1 }),
        post({ statusId: 'mobbed', replyCount: 900 }),
      ],
      context,
    );
    expect(opportunities.map((o) => o.statusId)).toEqual(['quiet', 'mobbed']);
    expect(opportunities[1]!.reasons.find((r) => r.name === 'crowded')!.points).toBeLessThan(0);
  });

  it('prefers fresh to merely recent', () => {
    const { opportunities } = findOpportunities(
      [post({ statusId: 'older', postedAt: minutesAgo(600) }), post({ statusId: 'newer', postedAt: minutesAgo(10) })],
      context,
    );
    expect(opportunities[0]!.statusId).toBe('newer');
  });

  it('lets who they are inform the decision without deciding it', () => {
    // What was said is the larger half on purpose. A strong bridge under an
    // off-topic post is still declined.
    const strong = scoreBridge(
      { handle: 'alice', followerCount: 90_000, ourFollowerCount: 900, neighbours: 30, neighboursWeKnow: 0, followsUs: true, weFollow: true },
      now,
    );
    const { declined } = findOpportunities([post({ handle: 'alice', text: 'Beautiful morning for a long walk here' })], {
      ...context,
      bridges: { alice: strong },
    });
    expect(declined[0]!.reason).toBe('off_topic');

    const { opportunities } = findOpportunities(
      [post({ statusId: 'known', handle: 'alice' }), post({ statusId: 'unknown', handle: 'nobody' })],
      { ...context, bridges: { alice: strong } },
    );
    expect(opportunities[0]!.statusId).toBe('known');
  });

  it('carries a sentence for every reason it gives', () => {
    const { opportunities } = findOpportunities([post({ replyCount: 0 })], context);
    expect(opportunities[0]!.reasons.length).toBeGreaterThan(1);
    for (const reason of opportunities[0]!.reasons) expect(reason.detail).toMatch(/[a-z]/i);
  });

  it('looks at one post once, however many times a timeline showed it', () => {
    const { opportunities, declined } = findOpportunities([post({}), post({})], context);
    expect(opportunities.length + declined.length).toBe(1);
  });
});
