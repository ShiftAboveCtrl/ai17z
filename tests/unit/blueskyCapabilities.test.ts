import { describe, expect, it } from 'vitest';
import { defaultPermission } from '@xbam/shared/contracts';
import { registerBlueskyCapabilities } from '@xbam/runtime';
import {
  TOOLPACKS,
  getCapability,
  listCapabilities,
  listModelCallable,
  registerBuiltinCapabilities,
  resetCapabilitiesForTest,
} from '@xbam/tools';

/**
 * Bluesky's capabilities: what they declare, and what they refuse.
 *
 * The network work is proved against a fixture server in blueskyChannel.test.ts.
 * What this pins is everything a mistake would be silent in, in the shape of
 * xCapabilities.test.ts: the exact surface a model may reach for, that reading
 * is declared as reading (the permission default keys off `effect`), and that
 * the arguments a model actually gets wrong are refused with the field named.
 */
describe('the Bluesky capabilities', () => {
  resetCapabilitiesForTest();
  registerBlueskyCapabilities();

  it('offers exactly these to the model', () => {
    // Pinned exactly. Adding one is meant to fail this test: what a model may
    // choose to do to somebody else's service is the surface of the feature and
    // should never grow by accident. There is no bluesky.post and no
    // bluesky.reply on purpose; see below.
    expect(listModelCallable().map((c) => c.id)).toEqual([
      'bluesky.like',
      'bluesky.read_post',
      'bluesky.read_profile',
      'bluesky.read_thread',
    ]);
  });

  it('keeps every id in one family, so a Plugin can never claim it', () => {
    for (const capability of listCapabilities()) {
      expect(capability.id, capability.id).toMatch(/^bluesky\.[a-z_]+$/);
    }
  });

  it('declares reading as reading and the like as the one write', () => {
    for (const id of ['bluesky.read_post', 'bluesky.read_thread', 'bluesky.read_profile']) {
      const capability = getCapability(id)!;
      expect(capability.effect, id).toBe('READ');
      expect(capability.risk, id).toBe('LOW');
      expect(defaultPermission(capability.effect, capability.risk), id).not.toBe('DISABLED');
    }
    const like = getCapability('bluesky.like')!;
    expect(like.effect).toBe('WRITE');
    // Off until an owner turns it on. An agent that looks things up unasked is
    // useful; one that acts unasked is a decision somebody makes.
    expect(defaultPermission(like.effect, like.risk)).toBe('DISABLED');
  });

  it('takes a post, and refuses a handle', () => {
    const input = getCapability('bluesky.read_post')!.input;
    expect(input.safeParse({ post: 'at://did:plc:alicealicealicealice/app.bsky.feed.post/3kabc' }).success).toBe(true);
    expect(input.safeParse({ post: 'https://bsky.app/profile/alice.test/post/3kabc' }).success).toBe(true);
    // The model's most likely mistake, and one that would otherwise be read as
    // a profile and return nothing about any post.
    expect(input.safeParse({ post: '@alice.test' }).success).toBe(false);
    expect(input.safeParse({ post: 'alice.test' }).success).toBe(false);
    // A record that is not a post is not a post.
    expect(input.safeParse({ post: 'at://did:plc:alicealicealicealice/app.bsky.feed.like/3kabc' }).success).toBe(false);
    // Nor is a lookalike host.
    expect(input.safeParse({ post: 'https://bsky.app.evil.example/profile/a.test/post/3kabc' }).success).toBe(false);
    expect(input.safeParse({}).success).toBe(false);
  });

  it('says why it cannot run rather than failing later', async () => {
    const readiness = await getCapability('bluesky.read_post')!.readiness!({
      agentId: 'a',
      jobId: null,
      accountId: null,
      config: {},
      logger: console as never,
    });
    expect(readiness.status).toBe('UNAVAILABLE');
    expect(readiness.why).toMatch(/Bluesky account/i);
  });

  it('refuses to act outside a job', async () => {
    // Every remote action belongs to a durable job: that is what carries the
    // idempotency key and what a crash is recovered against.
    const readiness = await getCapability('bluesky.like')!.readiness!({
      agentId: 'a',
      jobId: null,
      accountId: 'account-1',
      config: {},
      logger: console as never,
    });
    expect(readiness.status).toBe('UNAVAILABLE');
    expect(readiness.why).toContain('inside a job');
  });
});

describe('Bluesky beside everything else that is registered', () => {
  it('owns the bluesky. prefix and nothing else does', () => {
    resetCapabilitiesForTest();
    registerBuiltinCapabilities();
    registerBlueskyCapabilities();
    const ids = listCapabilities()
      .map((c) => c.id)
      .filter((id) => id.startsWith('bluesky.'))
      .sort();
    expect(ids).toEqual(['bluesky.like', 'bluesky.read_post', 'bluesky.read_profile', 'bluesky.read_thread']);
    // And it does not borrow another family's prefix.
    expect(listCapabilities().filter((c) => c.id.startsWith('x.') && /bluesky/i.test(c.id))).toEqual([]);
  });

  it('has a pack of its own, whose summary does not promise a post', () => {
    const pack = TOOLPACKS.find((entry) => entry.id === 'bluesky');
    expect(pack?.prefixes).toEqual(['bluesky.']);
    // A switch whose description promises more than it grants is worse than none.
    expect(pack?.summary).toMatch(/Replying and posting are set on the account/);
  });
});
