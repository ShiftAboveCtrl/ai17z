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

  it('offers all three to the model', () => {
    expect(listModelCallable().map((c) => c.id)).toEqual(['x.read_post', 'x.read_profile', 'x.search']);
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
