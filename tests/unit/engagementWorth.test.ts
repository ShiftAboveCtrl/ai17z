import { describe, expect, it } from 'vitest';
import { LIKE_FLOOR, REPOST_FLOOR, worthEngaging, type EngagementCandidate, type EngagementContext } from '@xbam/runtime';

/**
 * Whether a post is worth acknowledging, and whether it is worth passing on.
 *
 * Two decisions rather than one. A like says "I read this and it was worth
 * reading" and costs the reader nothing. A repost says "my audience should read
 * this", spends the attention of everybody following the agent, on somebody
 * else's words, with the agent's name on it.
 *
 * The declines are the product. An agent that likes everything it scored above
 * zero is an engagement-farming bot, which is the single easiest way to make an
 * account worthless, so most of these assert that nothing happens.
 */

function context(over: Partial<EngagementContext> = {}): EngagementContext {
  return {
    topics: ['autonomous agents', 'agent memory', 'browser automation'],
    selfHandles: ['ai17zos'],
    people: new Map(),
    alreadyEngaged: new Set(),
    ...over,
  };
}

function post(over: Partial<EngagementCandidate> = {}): EngagementCandidate {
  return {
    remoteId: '1234567890',
    url: 'https://x.com/somebody/status/1234567890',
    authorHandle: 'somebody',
    text: 'The hard part of autonomous agents was never the model. It is agent memory that survives a restart, and almost nothing does that properly yet.',
    ageHours: 2,
    metrics: { replies: 6 },
    ...over,
  };
}

describe('what is worth a like', () => {
  it('likes something on its subject from somebody it knows', () => {
    const got = worthEngaging(post(), context({ people: new Map([['somebody', { inboundCount: 3, disposition: 'NEUTRAL' }]]) }));
    expect(got.kind).toBe('LIKE');
    expect(got.score).toBeGreaterThanOrEqual(LIKE_FLOOR);
    // Every point carries a sentence, because this judgement shows up in public
    // under the owner's name.
    for (const factor of got.factors) expect(factor.detail.length).toBeGreaterThan(0);
  });

  it('declines something with nothing to do with this agent', () => {
    const got = worthEngaging(post({ text: 'my flight to Lisbon is delayed again and the coffee here is genuinely terrible' }), context());
    expect(got.kind).toBeNull();
    expect(got.declined?.reason).toBe('too_faint');
  });

  it('says how far short it fell', () => {
    const got = worthEngaging(post({ text: 'just landed, what a week that was honestly' }), context());
    expect(got.declined?.detail).toMatch(/below the floor/);
  });
});

describe('what it refuses outright', () => {
  const declined = (over: Partial<EngagementCandidate>, ctx?: Partial<EngagementContext>) =>
    worthEngaging(post(over), context(ctx)).declined;

  it('never acts on its own post', () => {
    // An account liking itself is the loop that makes every metric meaningless.
    expect(declined({ authorHandle: 'AI17ZOS' })?.reason).toBe('its_own');
  });

  it('never acts twice on the same post', () => {
    expect(declined({}, { alreadyEngaged: new Set(['1234567890']) })?.reason).toBe('already_engaged');
  });

  it.each([
    'Like and retweet to enter, we are giving one away this week to somebody',
    'Drop your wallet below and we will sort the airdrop out for the first 100 people',
    'comment "agent" and I will send you the guide, first 50 people only please',
  ])('refuses engagement bait: %s', (text) => {
    // Amplifying a post whose purpose is to be amplified is the definition of
    // engagement farming, and it is declined rather than scored low.
    expect(declined({ text })?.reason).toBe('bait');
  });

  it('refuses to amplify a high-stakes subject', () => {
    // A like is a public position. Quietly endorsing somebody else's post about
    // an election is raising the subject with extra steps.
    const got = declined({ text: 'The election result says far more about turnout than it does about any of the arguments anybody actually made' });
    expect(got?.reason).toBe('not_ours_to_amplify');
  });

  it('refuses somebody the owner asked it to leave alone', () => {
    expect(declined({}, { people: new Map([['somebody', { inboundCount: 9, disposition: 'BLOCKED' }]]) })?.reason).toBe('blocked');
  });

  it('refuses an old post, however good', () => {
    expect(declined({ ageHours: 200 })?.reason).toBe('too_old');
  });

  it('refuses a post too short to have said anything', () => {
    expect(declined({ text: 'agreed' })?.reason).toBe('nothing_said');
  });

  it('refuses a post with no id to act on', () => {
    expect(declined({ remoteId: '' })?.reason).toBe('no_target');
  });
});

describe('what is worth a repost, which is much less', () => {
  /** On subject, substantial, fresh, from somebody well known. */
  const excellent = () =>
    worthEngaging(
      post({
        text:
          'Agent memory that survives a restart is the whole problem with autonomous agents, and the reason almost nobody solves it is that browser automation makes the restart the normal case rather than the exception. Worth reading properly.',
        ageHours: 1,
        metrics: { replies: 30 },
      }),
      context({ people: new Map([['somebody', { inboundCount: 6, disposition: 'FRIENDLY' }]]) }),
    );

  it('reposts something genuinely worth passing on', () => {
    const got = excellent();
    expect(got.kind).toBe('REPOST');
    expect(got.score).toBeGreaterThanOrEqual(REPOST_FLOOR);
  });

  it('will not repost on relationship and freshness alone', () => {
    // Without this an account becomes somebody's amplifier rather than a
    // reader: a friend posting anything, recently, would clear a bare total.
    const got = worthEngaging(
      post({ text: 'Morning all. Long day ahead of me but the weather looks like it might hold for once.', ageHours: 0.2, metrics: { replies: 40 } }),
      context({ people: new Map([['somebody', { inboundCount: 20, disposition: 'FRIENDLY' }]]) }),
    );
    expect(got.kind).not.toBe('REPOST');
  });

  it('will not repost a remark, however on-subject', () => {
    // Long enough to have made a remark is not long enough to have made an
    // argument.
    const got = worthEngaging(
      post({ text: 'agent memory is the hard part of autonomous agents, obviously', ageHours: 0.5 }),
      context({ people: new Map([['somebody', { inboundCount: 12, disposition: 'FRIENDLY' }]]) }),
    );
    expect(got.kind).not.toBe('REPOST');
  });

  it('keeps the repost bar far above the like bar', () => {
    expect(REPOST_FLOOR).toBeGreaterThan(LIKE_FLOOR + 25);
  });
});

describe('what it does not treat as a measurement', () => {
  it('does not read an absent reply count as zero', () => {
    // Absent is never zero anywhere in this codebase, and treating it as one
    // would make every unmeasured post look ignored.
    const withCount = worthEngaging(post({ metrics: { replies: 6 } }), context());
    const without = worthEngaging(post({ metrics: null }), context());
    expect(without.factors.some((f) => f.name === 'discussed')).toBe(false);
    expect(withCount.score).toBeGreaterThan(without.score);
  });

  it('weights what is already loud only modestly', () => {
    const quiet = worthEngaging(post({ metrics: { replies: 5 } }), context());
    const roaring = worthEngaging(post({ metrics: { replies: 5000 } }), context());
    // Amplifying whatever is already loud is useless to an audience and is what
    // makes an automated account obvious.
    expect(roaring.score - quiet.score).toBeLessThanOrEqual(10);
  });
});
