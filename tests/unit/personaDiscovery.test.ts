import { describe, expect, it } from 'vitest';
import type { RadarCandidate } from '@xbam/shared/contracts';
import { discoveryQuery, discoveryTerms, rankDiscovered } from '@xbam/runtime';

/**
 * An agent going looking on its own, from what it is actually about.
 *
 * Measured on a live agent before this existed: every public reply it made in
 * two days traced back to being mentioned, being replied to, an account its
 * owner typed in, or a search its owner wrote. Its growth sessions opened,
 * found nothing, and closed. These tests pin the discipline that stops the fix
 * becoming a keyword firehose, which is what the owner-written searches became
 * the one afternoon they were tried.
 */

// The live agent's own persona topics, verbatim.
const MEADGOD_TOPICS = [
  'Pons', '$PONS', 'Pons launchpad', 'Robinhood Chain', 'Pons community', 'builders', 'creators',
  'shipping product', 'onchain markets', 'fair launches', 'organic communities', 'Uniswap', 'liquidity',
  'bonding curves', 'creator fees', 'protocol revenue', 'token burns', 'product support',
  'anti-scam and spoofing', 'onchain verification', 'tokenized equities', 'Robinhood ecosystem',
  'Chinese crypto community', 'founder life', 'health', 'family', 'God and faith', 'gratitude',
  'conviction', 'bagworking', 'friends and team',
];

describe('what it searches for', () => {
  it('uses the specific parts of its persona and leaves the personal ones alone', () => {
    const terms = discoveryTerms({ topics: MEADGOD_TOPICS });
    expect(terms).toEqual(
      expect.arrayContaining(['Pons', '$PONS', 'Pons launchpad', 'Robinhood Chain', 'Uniswap', 'Robinhood ecosystem']),
    );
    // Words that match half of X say nothing about why this agent is there.
    for (const vague of ['builders', 'liquidity', 'conviction', 'creators']) expect(terms).not.toContain(vague);
    // Who the agent is, never where it goes to find strangers.
    for (const personal of ['God and faith', 'health', 'family', 'gratitude', 'friends and team']) {
      expect(terms).not.toContain(personal);
    }
  });

  it('never goes looking for a subject it may not raise unasked', () => {
    expect(discoveryTerms({ topics: ['Robinhood Chain', 'Abortion Policy', 'Vaccine Mandates'] })).toEqual([
      'Robinhood Chain',
    ]);
  });

  it('uses exactly what the owner pinned, in order, when they pinned something', () => {
    expect(discoveryTerms({ pinned: ['tokenized stocks', '$PONS'], topics: MEADGOD_TOPICS })).toEqual([
      'tokenized stocks',
      '$PONS',
    ]);
  });

  it('collapses duplicates', () => {
    expect(discoveryTerms({ topics: ['Pons', 'pons', 'PONS'] })).toEqual(['Pons']);
  });
});

describe('the search it runs', () => {
  it('asks X for posts people are already responding to, originals only', () => {
    expect(discoveryQuery('Robinhood Chain', 20)).toBe('"Robinhood Chain" min_faves:20 lang:en -filter:replies -filter:retweets');
    // A cashtag goes bare, because quoting it changes what X matches.
    expect(discoveryQuery('$PONS', 10)).toBe('$PONS min_faves:10 lang:en -filter:replies -filter:retweets');
    // An owner's own query is left as written.
    expect(discoveryQuery('(pons OR $PONS) from:someone', 0)).toBe('(pons OR $PONS) from:someone lang:en -filter:replies -filter:retweets');
  });
});

describe('what it keeps', () => {
  const found = (id: string, followers: number | null, likes: number | null): RadarCandidate => ({
    remoteId: id,
    remoteUrl: null,
    authorHandle: `a${id}`,
    authorId: null,
    authorDisplayName: null,
    text: 'post',
    parentRemoteId: null,
    conversationRemoteId: id,
    occurredAt: null,
    eventType: 'POST',
    raw: {
      ...(followers === null ? {} : { author: { followers } }),
      ...(likes === null ? {} : { metrics: { likes } }),
    },
  });

  it('keeps the few with a real audience and real engagement, best first', () => {
    const kept = rankDiscovered(
      [found('1', 40, 2), found('2', 250_000, 300), found('3', 8_000, 40), found('4', null, null), found('5', 1_200, 15)],
      3,
    );
    expect(kept.map((c) => c.remoteId)).toEqual(['2', '3', '5']);
  });

  it('does not discard a result X answered without counts, only ranks it last', () => {
    const kept = rankDiscovered([found('1', null, null), found('2', null, null)], 5);
    expect(kept.map((c) => c.remoteId)).toEqual(['1', '2']);
  });
});
