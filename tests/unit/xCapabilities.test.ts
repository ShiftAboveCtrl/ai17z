import { describe, expect, it } from 'vitest';
import { XPost, XProfile } from '@xbam/shared/contracts';
import { parseCount } from '@xbam/channels';
import { registerXCapabilities } from '@xbam/runtime';
import { getCapability, listModelCallable, resetCapabilitiesForTest } from '@xbam/tools';

/**
 * X's first capabilities: what they declare, and what they refuse.
 *
 * The browser work itself is proved against real Chrome and a real account, not
 * here. What this pins is everything a mistake would be silent in: that the
 * capabilities are registered and model-callable, that their schemas refuse the
 * arguments a model actually gets wrong, and that reading is declared as
 * reading -- because the permission default keys off `effect`, and a read
 * mislabelled as a write would be switched off for every agent by default while
 * looking correct in every list.
 */
describe('the X read capabilities', () => {
  resetCapabilitiesForTest();
  registerXCapabilities();

  it('offers every registered X capability to the model', () => {
    expect(listModelCallable().map((c) => c.id)).toEqual(['x.like', 'x.read_post', 'x.read_profile', 'x.search']);
  });

  it('declares reading as reading', () => {
    // Not cosmetic: `defaultPermission` allows a low-risk read and disables a
    // write, so this is what decides whether they work out of the box.
    for (const id of ['x.read_post', 'x.read_profile', 'x.search']) {
      const capability = getCapability(id)!;
      expect(capability.effect, id).toBe('READ');
      expect(capability.risk, id).toBe('LOW');
    }
  });

  it('takes a post reference that is a post, and refuses a handle', () => {
    const input = getCapability('x.read_post')!.input;
    expect(input.safeParse({ post: 'https://x.com/007Ledger/status/2094843814082924574' }).success).toBe(true);
    expect(input.safeParse({ post: '2094843814082924574' }).success).toBe(true);
    // The model's most likely mistake, and one that would otherwise send a read
    // to a profile page and return nothing useful.
    expect(input.safeParse({ post: '@007Ledger' }).success).toBe(false);
    expect(input.safeParse({}).success).toBe(false);
  });

  it('takes a handle for a profile', () => {
    const input = getCapability('x.read_profile')!.input;
    expect(input.safeParse({ handle: '007Ledger' }).success).toBe(true);
    expect(input.safeParse({ handle: '@007Ledger' }).success).toBe(true);
    expect(input.safeParse({ handle: '' }).success).toBe(false);
  });

  it('bounds what a search may ask for', () => {
    // The ceiling is the bound on how long one capability can hold a job open,
    // and a model asked for "everything" would otherwise scroll until X stopped.
    const input = getCapability('x.search')!.input;
    expect(input.safeParse({ query: 'ai17z' }).success).toBe(true);
    expect(input.parse({ query: 'ai17z' })).toMatchObject({ mode: 'LIVE', limit: 10 });
    expect(input.safeParse({ query: 'ai17z', limit: 500 }).success).toBe(false);
    expect(input.safeParse({ query: 'a' }).success).toBe(false);
    expect(input.safeParse({ query: 'ai17z', mode: 'RANKED' }).success).toBe(false);
  });

  it('says why it cannot run rather than failing later', async () => {
    // An agent with no X account has nothing to read X as, and the reason is
    // about the agent rather than about the capability.
    const readiness = await getCapability('x.read_post')!.readiness!({
      agentId: 'a',
      jobId: null,
      accountId: null,
      config: {},
      logger: console as never,
    });
    expect(readiness.status).toBe('UNAVAILABLE');
    expect(readiness.why).toContain('no X account');
  });
});

describe('the normalised shapes that cross the adapter boundary', () => {
  it('keeps the status id as the identity of a post', () => {
    // Identity is the post, not where it was found. Several monitors see one
    // post; anything keyed on the URL or the author duplicates on a quote.
    const parsed = XPost.safeParse({
      statusId: '2094843814082924574',
      url: 'https://x.com/007Ledger/status/2094843814082924574',
      author: { handle: '007Ledger' },
      text: 'hello',
    });
    expect(parsed.success).toBe(true);
    expect(XPost.safeParse({ url: 'x', author: { handle: 'a' }, text: 'b' }).success).toBe(false);
  });

  it('lets a count be absent, which is not the same as zero', () => {
    // An agent told an account has zero followers will say so. A count the page
    // never showed has to come back missing.
    const profile = XProfile.parse({ handle: 'someone' });
    expect(profile.followerCount).toBeUndefined();
    expect(profile.recentPosts).toEqual([]);
  });
});

describe('reading the counts X actually renders', () => {
  it('reads plain and abbreviated numbers', () => {
    expect(parseCount('1,234')).toBe(1234);
    expect(parseCount('12.3K')).toBe(12300);
    expect(parseCount('4M')).toBe(4_000_000);
    expect(parseCount('7')).toBe(7);
  });

  it('answers nothing for what it cannot read', () => {
    for (const value of ['', null, undefined, 'Followers', '—']) {
      expect(parseCount(value), String(value)).toBeUndefined();
    }
  });
});

describe('the first write capability', () => {
  resetCapabilitiesForTest();
  registerXCapabilities();

  it('is a write, and so is off until an owner turns it on', async () => {
    // The default that matters. An agent that looks things up unasked is
    // useful; one that acts unasked is a decision somebody makes.
    const { defaultPermission } = await import('@xbam/shared/contracts');
    const like = getCapability('x.like')!;
    expect(like.effect).toBe('WRITE');
    expect(defaultPermission(like.effect, like.risk)).toBe('DISABLED');
  });

  it('refuses to act outside a job', async () => {
    // Every remote action belongs to a durable job: that is what carries the
    // idempotency key and what a crash is recovered against.
    const readiness = await getCapability('x.like')!.readiness!({
      agentId: 'a',
      jobId: null,
      accountId: 'account-1',
      config: {},
      logger: console as never,
    });
    expect(readiness.status).toBe('UNAVAILABLE');
    expect(readiness.why).toContain('inside a job');
  });

  it('takes a post, not a handle', () => {
    const input = getCapability('x.like')!.input;
    expect(input.safeParse({ post: 'https://x.com/a/status/2094843814082924574' }).success).toBe(true);
    expect(input.safeParse({ post: '@somebody' }).success).toBe(false);
  });
});

describe('the key a capability action is claimed under', () => {
  it('is derived from the job, so a retried job cannot act twice', async () => {
    const { capabilityIdempotencyKey } = await import('@xbam/runtime');
    const key = capabilityIdempotencyKey({
      jobIdempotencyKey: 'x|account|2094843814082924574|REPLY|agent',
      capabilityId: 'x.like',
      targetRef: 'https://x.com/i/web/status/999',
    });
    // Same job, same capability, same target is the same action by
    // construction -- which is what stops a model that asks twice acting twice.
    expect(key).toBe(
      capabilityIdempotencyKey({
        jobIdempotencyKey: 'x|account|2094843814082924574|REPLY|agent',
        capabilityId: 'x.like',
        targetRef: 'https://x.com/i/web/status/999',
      }),
    );
    expect(key).toContain('cap:x.like');
    expect(key).toContain('x|account|2094843814082924574|REPLY|agent');
  });

  it('separates two capabilities and two targets inside one job', () => {
    return import('@xbam/runtime').then(({ capabilityIdempotencyKey }) => {
      const base = { jobIdempotencyKey: 'job-key', targetRef: 'https://x.com/i/web/status/1' };
      expect(capabilityIdempotencyKey({ ...base, capabilityId: 'x.like' })).not.toBe(
        capabilityIdempotencyKey({ ...base, capabilityId: 'x.repost' }),
      );
      expect(capabilityIdempotencyKey({ ...base, capabilityId: 'x.like' })).not.toBe(
        capabilityIdempotencyKey({ ...base, capabilityId: 'x.like', targetRef: 'https://x.com/i/web/status/2' }),
      );
    });
  });
});
