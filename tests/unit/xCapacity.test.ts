import { describe, expect, it } from 'vitest';
import { CapacityCadence, DEFAULT_POLICY, OutreachPolicy } from '@xbam/shared/contracts';
import {
  audienceOf,
  capacityClassForEvent,
  capacityClassForSource,
  classifyXSignal,
  cooldownMsFor,
  decideEngagement,
  readAllowance,
  settleCapacity,
  writeAllowance,
  type CapacitySince,
  type CapacityState,
} from '@xbam/runtime';
import { looksLikeXSaidEmpty, looksLikeXStalled } from '@xbam/channels';

/**
 * One account, one budget for asking X anything, and a breaker that holds.
 *
 * Measured on a live account before any of this: seven discovery sources and
 * a poller, each on a reasonable schedule of its own, came to about six page
 * loads a minute. X began refusing two search surfaces while the rest carried
 * on at full speed, and the owner watched the browser settle on a dark screen
 * with the X logo. Nothing added the surfaces up and nothing heard X say no.
 */

const config = CapacityCadence.parse({});
const at = (minute: number) => new Date(Date.UTC(2026, 8, 26, 12, minute, 0));

const state = (over: Partial<CapacityState> = {}): CapacityState => ({
  health: 'HEALTHY',
  reason: null,
  until: null,
  strikes: 0,
  ...over,
});

const since = (over: Partial<CapacitySince> = {}): CapacitySince => ({
  status: 'CONNECTED',
  rateLimits: 0,
  stalled: 0,
  failedWrites: 0,
  failingSources: 0,
  ...over,
});

describe('who a read is for', () => {
  it('protects what people sent, then watched accounts, then its own looking', () => {
    for (const kind of ['notifications', 'mention_search', 'reply_search', 'own_threads'] as const) {
      expect(capacityClassForSource(kind), kind).toBe('DIRECT');
    }
    expect(capacityClassForSource('tracked_account')).toBe('TARGET');
    expect(capacityClassForSource('tracked_keyword')).toBe('BROAD');

    expect(capacityClassForEvent('MENTION')).toBe('DIRECT');
    expect(capacityClassForEvent('REPLY')).toBe('DIRECT');
    expect(capacityClassForEvent('TARGET_ACCOUNT_ACTIVITY')).toBe('TARGET');
    expect(capacityClassForEvent('KEYWORD_MATCH')).toBe('BROAD');
    // A post the agent originates is the agent speaking unasked.
    expect(capacityClassForEvent('SCHEDULED_TRIGGER')).toBe('BROAD');
  });
});

describe('recognising pushback', () => {
  it('reads the sentences every reader already writes', () => {
    expect(classifyXSignal('X asked AI17Z to slow down. It stopped rather than pushing.')).toBe('RATE_LIMITED');
    expect(classifyXSignal('X never finished drawing the search: it showed its loading screen')).toBe('STALLED');
    expect(
      classifyXSignal('This source stopped answering part-way through and was given up on after 180 seconds.'),
    ).toBe('STALLED');
    expect(classifyXSignal('X could not show mentions: its own page says something went wrong.')).toBe('BROKEN');
  });

  it('does not count refusals that say nothing about load', () => {
    // A protected account is protected however gently it is asked.
    expect(classifyXSignal('@someone is not public.')).toBeNull();
    expect(classifyXSignal('X asked for a sign-in, so nothing was read.')).toBeNull();
    expect(classifyXSignal('@gone could not be found.')).toBeNull();
    expect(classifyXSignal(null)).toBeNull();
  });
});

describe('a page X never drew is not a quiet feed', () => {
  it('calls the logo screen a stall', () => {
    // What the renderer holds while X has not produced a page: the logo, no text.
    expect(looksLikeXStalled('', false)).toBe(true);
    expect(looksLikeXStalled('   \n  ', false)).toBe(true);
    // The frame of the site with a spinner still turning where the timeline goes.
    expect(looksLikeXStalled('Home Explore Notifications Messages Grok Profile More Post', true)).toBe(true);
  });

  it('still calls a genuinely quiet surface quiet', () => {
    // The distinction is the point. X saying there is nothing is an answer.
    expect(looksLikeXStalled('Nothing to see here — yet', false)).toBe(false);
    expect(looksLikeXStalled('No results for "pons launchpad"', false)).toBe(false);
    expect(looksLikeXStalled('@quiet hasn’t posted', false)).toBe(false);
    expect(looksLikeXSaidEmpty('Nothing to see here — yet')).toBe(true);
    // A drawn page with no articles and no spinner is left alone.
    expect(looksLikeXStalled('Home Explore Notifications Messages Profile Search', false)).toBe(false);
  });
});

describe('the breaker', () => {
  it('slows down at the first sign and does not wait for three', () => {
    const next = settleCapacity(state(), since({ rateLimits: 1 }), config, at(0));
    expect(next.health).toBe('DEGRADED');
    expect(next.until!.getTime()).toBeGreaterThan(at(0).getTime());
    expect(next.strikes).toBe(0);
  });

  it('trips on pushback that arrives while already reading less', () => {
    const slowed = settleCapacity(state(), since({ rateLimits: 1 }), config, at(0));
    // Counts are since the breaker last moved, so this is one more signal.
    const tripped = settleCapacity(slowed, since({ rateLimits: 1 }), config, at(2));
    expect(tripped.health).toBe('COOLDOWN');
    expect(tripped.strikes).toBe(1);
    expect(tripped.until!.getTime() - at(2).getTime()).toBe(15 * 60_000);
  });

  it('keeps each cooldown bounded, doubling to a ceiling', () => {
    expect(cooldownMsFor(1, config)).toBe(15 * 60_000);
    expect(cooldownMsFor(2, config)).toBe(30 * 60_000);
    expect(cooldownMsFor(3, config)).toBe(60 * 60_000);
    expect(cooldownMsFor(4, config)).toBe(120 * 60_000);
    // However many times it trips, never longer than the owner's ceiling.
    expect(cooldownMsFor(40, config)).toBe(120 * 60_000);
  });

  it('holds for the whole cooldown however quiet X becomes', () => {
    const cooling = state({ health: 'COOLDOWN', until: new Date(at(15).getTime()), strikes: 1, reason: 'X said no.' });
    expect(settleCapacity(cooling, since(), config, at(5))).toBe(cooling);
  });

  it('recovers gradually, never straight back to full speed', () => {
    const cooling = state({ health: 'COOLDOWN', until: at(15), strikes: 1, reason: 'X said no.' });
    const recovering = settleCapacity(cooling, since(), config, at(16));
    expect(recovering.health).toBe('DEGRADED');
    expect(recovering.reason).toMatch(/recovering/i);
    // Recovery lasts as long as the cooldown did.
    expect(recovering.until!.getTime() - at(16).getTime()).toBe(15 * 60_000);

    // Still recovering a minute later.
    expect(settleCapacity(recovering, since(), config, at(17)).health).toBe('DEGRADED');
    // Clean to the end: healthy, and one strike forgiven.
    const healthy = settleCapacity(recovering, since(), config, at(32));
    expect(healthy.health).toBe('HEALTHY');
    expect(healthy.strikes).toBe(0);
  });

  it('makes a relapse during recovery longer than the first cooldown', () => {
    const recovering = state({ health: 'DEGRADED', until: at(31), strikes: 1, reason: 'Recovering from a cooldown.' });
    const relapse = settleCapacity(recovering, since({ stalled: 1 }), config, at(20));
    expect(relapse.health).toBe('COOLDOWN');
    expect(relapse.strikes).toBe(2);
    expect(relapse.until!.getTime() - at(20).getTime()).toBe(30 * 60_000);
  });

  it('stops for a person and comes back gently once they have acted', () => {
    const challenged = settleCapacity(state(), since({ status: 'CHALLENGE_REQUIRES_USER' }), config, at(0));
    expect(challenged.health).toBe('HUMAN_ACTION_REQUIRED');
    const back = settleCapacity(challenged, since(), config, at(30));
    expect(back.health).toBe('DEGRADED');
  });
});

describe('reading, in order', () => {
  const read = (
    health: CapacityState['health'],
    klass: 'DIRECT' | 'TARGET' | 'BROAD',
    total: number,
    own = 0,
  ) =>
    readAllowance({
      state: state({ health, until: health === 'COOLDOWN' ? at(30) : null }),
      klass,
      readsLast10Minutes: total,
      readsByClass: { [klass]: own },
      config,
      now: at(0),
    });

  it('lets the agent go looking while the account is busy answering people', () => {
    // The live case: direct and watched reads came to 27 of 36 on their own.
    // A cap on the total alone meant the agent's own search never ran.
    expect(read('HEALTHY', 'BROAD', 27, 0).allowed).toBe(true);
  });

  it('caps its own looking, and keeps the last of the budget for people who wrote in', () => {
    // 36 a ten minutes; broad may spend 12 of them itself.
    expect(read('HEALTHY', 'BROAD', 20, 11).allowed).toBe(true);
    const capped = read('HEALTHY', 'BROAD', 20, 12);
    expect(capped.allowed).toBe(false);
    expect(capped.message).toMatch(/used 12 of its 12/);
    // Past 30 of 36, only direct reads continue.
    const reserved = read('HEALTHY', 'BROAD', 30, 0);
    expect(reserved.allowed).toBe(false);
    expect(reserved.message).toMatch(/stay free for people who wrote in/);
    expect(read('HEALTHY', 'TARGET', 30, 0).allowed).toBe(false);
    expect(read('HEALTHY', 'TARGET', 29, 17).allowed).toBe(true);
    expect(read('HEALTHY', 'TARGET', 29, 18).allowed).toBe(false);
    expect(read('HEALTHY', 'DIRECT', 35).allowed).toBe(true);
    expect(read('HEALTHY', 'DIRECT', 36).allowed).toBe(false);
  });

  it('slows optional work on early pressure before anything else', () => {
    // Early pressure takes the budget to 60 per cent, 21 reads, and broad work
    // may spend seven of them rather than twelve.
    expect(read('DEGRADED', 'BROAD', 7, 7).allowed).toBe(false);
    expect(read('HEALTHY', 'BROAD', 7, 7).allowed).toBe(true);
    expect(read('DEGRADED', 'DIRECT', 20).allowed).toBe(true);
  });

  it('pauses broad and watched reads in a cooldown and still reads what people sent', () => {
    const broad = read('COOLDOWN', 'BROAD', 0);
    expect(broad.allowed).toBe(false);
    expect(broad.message).toMatch(/cooling down/i);
    // Held until the cooldown ends, not retried in a loop.
    expect(broad.retryAfterMs).toBe(30 * 60_000);
    // A watched account does not outrank the account's own health.
    expect(read('COOLDOWN', 'TARGET', 0).allowed).toBe(false);
    expect(read('COOLDOWN', 'DIRECT', 0).allowed).toBe(true);
    // At a reduced budget even so.
    expect(read('COOLDOWN', 'DIRECT', 12).allowed).toBe(false);
  });

  it('never asks again within the minute, which is what a retry storm is made of', () => {
    for (const klass of ['DIRECT', 'TARGET', 'BROAD'] as const) {
      const held = read('HEALTHY', klass, 1_000, 1_000);
      expect(held.allowed).toBe(false);
      expect(held.retryAfterMs!, klass).toBeGreaterThanOrEqual(60_000);
    }
  });

  it('stops everything for a person', () => {
    for (const klass of ['DIRECT', 'TARGET', 'BROAD'] as const) {
      expect(read('HUMAN_ACTION_REQUIRED', klass, 0).allowed, klass).toBe(false);
    }
  });
});

describe('acting, in order', () => {
  it('holds what the agent would start on its own through a cooldown, and still answers people', () => {
    const cooling = state({ health: 'COOLDOWN', until: at(20), reason: 'X said no.' });
    for (const klass of ['TARGET', 'BROAD'] as const) {
      const verdict = writeAllowance(cooling, klass, at(0));
      expect(verdict.allowed, klass).toBe(false);
      expect(verdict.retryAfterMs, klass).toBe(20 * 60_000);
    }
    // Measured: a reply to a person was held sixty-seven minutes by a cooldown
    // earned from searches. The account's own spacing still applies to it.
    expect(writeAllowance(cooling, 'DIRECT', at(0)).allowed).toBe(true);
  });

  it('never makes the thread of a reply wait behind polling', () => {
    const verdict = readAllowance({
      state: state({ health: 'COOLDOWN', until: at(30) }),
      klass: 'DIRECT',
      readsLast10Minutes: 500,
      config,
      now: at(0),
      forReply: true,
    });
    expect(verdict.allowed).toBe(true);
    expect(
      readAllowance({ state: state({ health: 'HUMAN_ACTION_REQUIRED' }), klass: 'DIRECT', readsLast10Minutes: 0, config, now: at(0), forReply: true }).allowed,
    ).toBe(false);
  });

  it('stops approaching strangers on early pressure and keeps answering', () => {
    const slowed = state({ health: 'DEGRADED', until: at(15), reason: 'X asked once.' });
    expect(writeAllowance(slowed, 'BROAD', at(0)).allowed).toBe(false);
    expect(writeAllowance(slowed, 'TARGET', at(0)).allowed).toBe(true);
    expect(writeAllowance(slowed, 'DIRECT', at(0)).allowed).toBe(true);
  });
});

describe('audience, for speaking first only', () => {
  const outreach = (over: Partial<OutreachPolicy> = {}) =>
    OutreachPolicy.parse({ enabled: true, mode: 'AUTONOMOUS', requireTopicMatch: false, minimumValue: 40, ...over });
  const base = {
    text: 'Robinhood Chain fees came in under what most people expected this week, worth watching',
    directlyAddressed: false,
    relationship: null,
    threadDepth: 0,
    recentRepliesToPerson: 0,
    alreadyRepliedInThread: false,
    hasParent: true,
    topics: ['Robinhood Chain'],
    policy: DEFAULT_POLICY.engagement,
  };

  it('ranks an author people read above one nobody does', () => {
    const big = decideEngagement({ ...base, unprompted: true, outreach: outreach(), authorFollowers: 250_000 });
    const small = decideEngagement({ ...base, unprompted: true, outreach: outreach(), authorFollowers: 40 });
    const unknown = decideEngagement({ ...base, unprompted: true, outreach: outreach(), authorFollowers: null });
    expect(big.value).toBeGreaterThan(unknown.value);
    expect(small.value).toBeLessThan(unknown.value);
    expect(big.factors.map((f) => f.label)).toContain('a large audience reads this author');
    // Absent is not zero: an unreported count earns and costs nothing.
    expect(unknown.factors.some((f) => /audience|follows the author/.test(f.label))).toBe(false);
  });

  it('applies an owner floor only when X reported a count', () => {
    const floored = outreach({ minAuthorFollowers: 500 });
    const below = decideEngagement({ ...base, unprompted: true, outreach: floored, authorFollowers: 120 });
    expect(below.decision).toBe('IGNORE');
    expect(below.reason).toMatch(/120 followers, below this agent's floor of 500/);
    const unknown = decideEngagement({ ...base, unprompted: true, outreach: floored, authorFollowers: null });
    expect(unknown.decision).not.toBe('IGNORE');
  });

  it('never weighs the audience of somebody who wrote to the agent', () => {
    /*
      Somebody with five followers who asks the agent a question is answered
      exactly as somebody with five hundred thousand would be. The audience
      signal exists for choosing whom to approach, never for choosing whom to
      ignore when they speak first.
    */
    const input = { ...base, text: '@agent what do you make of the Robinhood Chain fee numbers?', directlyAddressed: true };
    const tiny = decideEngagement({ ...input, unprompted: false, authorFollowers: 5 });
    const huge = decideEngagement({ ...input, unprompted: false, authorFollowers: 500_000 });
    expect(tiny.value).toBe(huge.value);
    expect(tiny.decision).toBe(huge.decision);
  });

  it('reads the audience off the payload the radar stored, and nothing else', () => {
    expect(audienceOf({ author: { followers: 1234 }, metrics: { replies: 3, likes: 20 } })).toEqual({
      authorFollowers: 1234,
      postEngagement: 23,
    });
    expect(audienceOf({})).toEqual({ authorFollowers: null, postEngagement: null });
    expect(audienceOf(null)).toEqual({ authorFollowers: null, postEngagement: null });
  });
});
