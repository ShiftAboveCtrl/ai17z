import { beforeEach, describe, expect, it } from 'vitest';
import {
  emptyResult,
  forgetXReads,
  provenanceFor,
  xIntelligence,
  type XIntelligenceBackend,
  type XReadOutcome,
  type XUser,
} from '@xbam/channels';

/**
 * Not asking X something it answered a moment ago.
 *
 * The same profile is asked for by the persona import, by the account tool and
 * by any screen showing somebody, often within seconds. Each of those is a real
 * request against the session the agent needs for its actual work, and the
 * answer changes about as often as somebody renames themselves.
 *
 * The two properties that make a cache safe rather than merely fast are both
 * here: a refusal is never held, and a held answer says it was held.
 */

let asked = 0;

function counting(outcome: XReadOutcome = 'OK'): XIntelligenceBackend {
  return {
    name: 'counting',
    async readiness() {
      return { state: 'READY', detail: '', can: ['resolveUser'] };
    },
    async resolveUser(_ctx, handle) {
      asked += 1;
      if (outcome !== 'OK') return emptyResult('counting', outcome, `says ${outcome}`, null);
      const user: XUser = {
        userId: '44196397',
        handle,
        displayName: null,
        bio: null,
        avatarUrl: null,
        bannerUrl: null,
        location: null,
        website: null,
        followers: null,
        following: null,
        posts: null,
        createdAt: null,
        verified: null,
        protected: null,
        provenance: provenanceFor('counting'),
      };
      return { outcome: 'OK', detail: '', data: user, provenance: provenanceFor('counting') };
    },
  };
}

beforeEach(() => {
  asked = 0;
  forgetXReads();
});

describe('asking the same question twice', () => {
  it('reads X once', async () => {
    const backends = [counting()];
    await xIntelligence.resolveUser('jack', { backends });
    await xIntelligence.resolveUser('jack', { backends });
    expect(asked).toBe(1);
  });

  it('does not care how the handle was typed', async () => {
    // `@Jack` and `jack` are the same question, and treating them as two is how
    // a cache quietly stops working for anybody who types an @.
    const backends = [counting()];
    await xIntelligence.resolveUser('jack', { backends });
    await xIntelligence.resolveUser('@Jack', { backends });
    expect(asked).toBe(1);
  });

  it('says the answer was held', async () => {
    const backends = [counting()];
    const fresh = await xIntelligence.resolveUser('jack', { backends });
    const held = await xIntelligence.resolveUser('jack', { backends });
    expect(fresh.provenance.cached).toBe(false);
    expect(held.provenance.cached).toBe(true);
    // And the time is when X was actually read, not when it was handed over:
    // a caller judging how much to claim needs the real age.
    expect(held.provenance.collectedAt).toBe(fresh.provenance.collectedAt);
  });

  it('reads again when the owner asked for fresh data', async () => {
    const backends = [counting()];
    await xIntelligence.resolveUser('jack', { backends });
    await xIntelligence.resolveUser('jack', { backends, refresh: true });
    expect(asked).toBe(2);
  });

  it('reads again for a caller that needs it live', async () => {
    // Freshness is the caller's decision because there is no single right age:
    // an engagement chance goes stale in minutes, a follower count does not.
    const backends = [counting()];
    await xIntelligence.resolveUser('jack', { backends });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const live = await xIntelligence.resolveUser('jack', { backends, freshness: 'LIVE' });
    // LIVE is sixty seconds, so five milliseconds is still fresh -- the point
    // being that the caller's answer is what decides, not the cache's opinion.
    expect(live.provenance.cached).toBe(true);
  });
});

describe('what is never held', () => {
  it.each(['RATE_LIMITED', 'CHALLENGE', 'NEEDS_SIGN_IN', 'NOT_FOUND', 'PROTECTED'] as const)(
    'asks again after %s',
    async (outcome) => {
      // These are states of the world that change on their own. A cached "you
      // are rate limited" goes on being true for ten minutes after it stopped
      // being true, which turns a moment's throttling into a feature that
      // appears broken.
      const backends = [counting(outcome)];
      await xIntelligence.resolveUser('jack', { backends });
      await xIntelligence.resolveUser('jack', { backends });
      expect(asked).toBe(2);
    },
  );

  it('holds nothing once it has been told to forget', async () => {
    const backends = [counting()];
    await xIntelligence.resolveUser('jack', { backends });
    forgetXReads();
    await xIntelligence.resolveUser('jack', { backends });
    expect(asked).toBe(2);
  });
});
