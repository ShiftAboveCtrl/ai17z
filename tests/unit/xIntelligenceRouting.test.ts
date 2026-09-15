import { beforeEach, describe, expect, it } from 'vitest';
import {
  STOP_ASKING,
  WORTH_ANOTHER_BACKEND,
  emptyResult,
  provenanceFor,
  forgetXReads,
  xIntelligence,
  type XIntelligenceBackend,
  type XPostRecord,
  type XReadOutcome,
  type XUser,
} from '@xbam/channels';

/**
 * Which backend answers, and what the caller is told about it.
 *
 * The point of this layer is that a feature asking for somebody's posts does
 * not know how they were obtained -- so the routing is the part that has to be
 * exactly right, and it is the part with no browser in it. Driven here with
 * backends that answer however a test needs, which is the only way to exercise
 * "X said you are rate limited" without waiting for X to say it.
 *
 * The rule being pinned, in one sentence: try another reader when a different
 * reader could plausibly do better, stop when it could not, and never let the
 * caller believe the second answer came from the first.
 */

const user = (handle: string, userId: string): XUser => ({
  userId,
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
  weFollow: null,
  followsUs: null,
  provenance: provenanceFor('fake'),
});

/** A backend that answers exactly as a test tells it to, and counts being asked. */
function fake(
  name: string,
  answers: Partial<{
    resolveUser: XReadOutcome;
    getUserPosts: XReadOutcome;
    can: XIntelligenceBackend extends never ? never : string[];
    state: 'READY' | 'DEGRADED' | 'UNAVAILABLE';
  }> = {},
) {
  const calls: string[] = [];
  const backend: XIntelligenceBackend = {
    name,
    async readiness() {
      return {
        state: answers.state ?? 'READY',
        detail: name,
        can: (answers.can as unknown as never[]) ?? ['resolveUser', 'getUserPosts'],
      };
    },
    async resolveUser(_ctx, handle) {
      calls.push('resolveUser');
      const outcome = answers.resolveUser ?? 'OK';
      if (outcome !== 'OK') return emptyResult(name, outcome, `${name} says ${outcome}`, null);
      return { outcome, detail: '', data: user(handle, `id-${name}`), provenance: provenanceFor(name) };
    },
    async getUserPosts(_ctx, request) {
      calls.push('getUserPosts');
      const outcome = answers.getUserPosts ?? 'OK';
      if (outcome !== 'OK') return emptyResult(name, outcome, `${name} says ${outcome}`, [] as XPostRecord[]);
      return {
        outcome,
        detail: '',
        data: [
          {
            postId: '1',
            authorId: null,
            authorHandle: request.handle,
            text: 'words',
            createdAt: null,
            url: 'https://x.com/a/status/1',
            conversationId: null,
            replyToPostId: null,
            replyToUserId: null,
            quotedPostId: null,
            repost: false,
            lang: null,
            metrics: null,
            media: [],
            links: [],
            provenance: provenanceFor(name),
          },
        ],
        provenance: provenanceFor(name),
      };
    },
  };
  return { backend, calls };
}

const posts = (handle: string) => ({ userId: 'u1', handle, limit: 10 });

/**
 * A held answer would make these tests read each other's results.
 *
 * `resolveUser` is cached in the module, on purpose and for production's
 * benefit, so a test that resolves `alice` successfully hands the next test a
 * cached success no matter what backend that test set up. The suite found this
 * itself: every case passed alone and eight failed together, which is exactly
 * the shape of shared state.
 */
beforeEach(() => {
  forgetXReads();
});

describe('choosing which reader answers', () => {
  it('prefers the first backend that can do the job', async () => {
    const first = fake('first');
    const second = fake('second');
    const result = await xIntelligence.resolveUser('alice', { backends: [first.backend, second.backend] });

    expect(result.outcome).toBe('OK');
    expect(result.data?.userId).toBe('id-first');
    expect(second.calls, 'the second reader was asked when the first could answer').toHaveLength(0);
  });

  it('moves on when a reader could not run at all', async () => {
    const broken = fake('broken', { resolveUser: 'UNAVAILABLE' });
    const working = fake('working');
    const result = await xIntelligence.resolveUser('alice', { backends: [broken.backend, working.backend] });

    expect(result.outcome).toBe('OK');
    expect(result.data?.userId).toBe('id-working');
  });

  it('moves on when X answered in a shape the reader did not understand', async () => {
    // The case the whole fallback exists for: X ships a change, the structured
    // read stops working, and the product keeps going on the rendered page.
    const stale = fake('stale', { getUserPosts: 'SCHEMA_CHANGED' });
    const dom = fake('dom');
    const result = await xIntelligence.getUserPosts(posts('alice'), { backends: [stale.backend, dom.backend] });

    expect(result.outcome).toBe('OK');
    expect(dom.calls).toContain('getUserPosts');
  });

  it('tells the caller the answer came from the second choice', async () => {
    // Not only in a log. A persona built from approximate data is a smaller
    // claim than one built from exact data, and the difference has to survive
    // the trip to whoever is deciding what to claim.
    const stale = fake('stale', { getUserPosts: 'SCHEMA_CHANGED' });
    const dom = fake('dom');
    const result = await xIntelligence.getUserPosts(posts('alice'), { backends: [stale.backend, dom.backend] });

    expect(result.provenance.gaps.join(' ')).toContain('stale');
    expect(result.provenance.gaps.join(' ')).toContain('dom');
  });

  it('says which backend answered, on every answer', async () => {
    const only = fake('only');
    const result = await xIntelligence.resolveUser('alice', { backends: [only.backend] });
    expect(result.provenance.backend).toBe('only');
    expect(result.provenance.collectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('when trying again would be the wrong thing', () => {
  it.each(STOP_ASKING)('stops on %s instead of asking another reader', async (outcome) => {
    // A protected account is protected however it is read; a challenge is a
    // person's to answer; a rate limit means stop. Asking a second reader is
    // how a read turns into hammering, and in the challenge case it is how a
    // tool starts arguing with a security check.
    const first = fake('first', { resolveUser: outcome });
    const second = fake('second');
    const result = await xIntelligence.resolveUser('alice', { backends: [first.backend, second.backend] });

    expect(result.outcome).toBe(outcome);
    expect(second.calls, `${outcome} was retried on another backend`).toHaveLength(0);
  });

  it('keeps the words of the refusal rather than a generic failure', async () => {
    const first = fake('first', { resolveUser: 'PROTECTED' });
    const result = await xIntelligence.resolveUser('alice', { backends: [first.backend] });
    expect(result.detail).toContain('PROTECTED');
  });

  it('only retries the outcomes that say another reader might do better', () => {
    // Stated as a property so the two lists cannot quietly overlap: an outcome
    // in both would be retried and stopped at the same time.
    for (const outcome of WORTH_ANOTHER_BACKEND) {
      expect(STOP_ASKING, `${outcome} is in both lists`).not.toContain(outcome);
    }
  });
});

describe('capability by capability, not backend by backend', () => {
  it('uses a backend for what it can do and skips it for what it cannot', async () => {
    // One backend losing search must not cost the product its profile reads,
    // which is why readiness reports capabilities rather than a single state.
    const partial = fake('partial', { can: ['resolveUser'] as never });
    const full = fake('full');

    const resolved = await xIntelligence.resolveUser('alice', { backends: [partial.backend, full.backend] });
    expect(resolved.data?.userId).toBe('id-partial');

    const timeline = await xIntelligence.getUserPosts(posts('alice'), { backends: [partial.backend, full.backend] });
    expect(timeline.outcome).toBe('OK');
    expect(partial.calls, 'a backend was asked for something it said it could not do').not.toContain('getUserPosts');
  });

  it('skips a backend that cannot run, without asking it anything', async () => {
    const down = fake('down', { state: 'UNAVAILABLE' });
    const up = fake('up');
    await xIntelligence.resolveUser('alice', { backends: [down.backend, up.backend] });
    expect(down.calls).toHaveLength(0);
  });

  it('says so plainly when nothing can read X', async () => {
    const down = fake('down', { state: 'UNAVAILABLE' });
    const result = await xIntelligence.resolveUser('alice', { backends: [down.backend] });
    expect(result.outcome).toBe('UNAVAILABLE');
    expect(result.data).toBeNull();
  });
});

describe('what the health screen can say', () => {
  it('reports each capability by who can serve it', async () => {
    const partial = fake('partial', { can: ['resolveUser'] as never });
    const full = fake('full');
    const health = await xIntelligence.health({ backends: [partial.backend, full.backend] });

    expect(health.capabilities.resolveUser.state).toBe('READY');
    expect(health.capabilities.resolveUser.by).toEqual(['partial', 'full']);
    expect(health.capabilities.getUserPosts.by).toEqual(['full']);
    // Nothing offers these, and saying "ready" would be a lie a screen repeats.
    expect(health.capabilities.searchPosts.state).toBe('UNAVAILABLE');
    expect(health.capabilities.searchPosts.by).toEqual([]);
  });

  it('reports a backend that cannot run as unavailable rather than omitting it', async () => {
    const down = fake('down', { state: 'UNAVAILABLE' });
    const health = await xIntelligence.health({ backends: [down.backend] });
    expect(health.backends.map((b) => b.backend)).toContain('down');
    expect(health.backends[0]!.state).toBe('UNAVAILABLE');
  });
});

describe('the boundary this layer must never cross', () => {
  it('has no way to act on X', async () => {
    // Read-only, permanently. Acting belongs to the engagement pipeline, behind
    // its policies, approvals and audit trail; a read layer that grew a write
    // would route around every one of them.
    //
    // Pinned as the exact surface rather than as a list of forbidden words,
    // because the words overlap: `getUserPosts` reads posts and `post()` would
    // publish one, and a substring check cannot tell a noun from a verb. This
    // way a new method is a failing test until somebody writes it down here,
    // which is the review this most needs.
    expect(Object.keys(xIntelligence).sort()).toEqual(
      ['getPost', 'getThread', 'getUser', 'getUserPosts', 'health', 'resolveUser', 'searchPosts'].sort(),
    );
    // And every one of them is a read: nothing here takes text to publish.
    for (const [name, fn] of Object.entries(xIntelligence)) {
      expect(typeof fn, `${name} is not callable`).toBe('function');
    }
  });
});
