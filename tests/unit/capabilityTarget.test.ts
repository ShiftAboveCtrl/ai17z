import { describe, expect, it } from 'vitest';
import { canonicalTarget, capabilityIdempotencyKey } from '@xbam/runtime';

/**
 * One post is one target, however it was written.
 *
 * `actions.idempotency_key` is what stops a capability acting twice on the same
 * thing, and it is built from the target. So the guarantee was only ever as
 * good as the spelling.
 *
 * Measured on a live account: an agent's own like carried the bare status id
 * and the pipeline's execution of the same job carried that post's address, so
 * one post produced two action rows and the unique index had nothing to say
 * about it. The same trap `deliberate.ts` already names for its own keys.
 */

const JOB = 'job-key';

describe('the target a key is built from', () => {
  it('reads a post id and its address as one thing', () => {
    expect(canonicalTarget('2100096754989314242')).toBe('2100096754989314242');
    expect(canonicalTarget('https://x.com/007Ledger/status/2100096754989314242')).toBe('2100096754989314242');
    // The old spelling, and one with a query string on it.
    expect(canonicalTarget('https://twitter.com/a/statuses/2100096754989314242')).toBe('2100096754989314242');
    expect(canonicalTarget('https://x.com/a/status/2100096754989314242?s=20')).toBe('2100096754989314242');
  });

  it('gives both spellings the same key', () => {
    const byId = capabilityIdempotencyKey({
      jobIdempotencyKey: JOB,
      capabilityId: 'x.like',
      targetRef: '2100096754989314242',
    });
    const byUrl = capabilityIdempotencyKey({
      jobIdempotencyKey: JOB,
      capabilityId: 'x.like',
      targetRef: 'https://x.com/007Ledger/status/2100096754989314242',
    });
    expect(byUrl).toBe(byId);
  });

  it('still tells two different posts apart', () => {
    const a = capabilityIdempotencyKey({ jobIdempotencyKey: JOB, capabilityId: 'x.like', targetRef: '111111111111' });
    const b = capabilityIdempotencyKey({ jobIdempotencyKey: JOB, capabilityId: 'x.like', targetRef: '222222222222' });
    expect(a).not.toBe(b);
  });

  it('still tells two capabilities apart on one post', () => {
    const like = capabilityIdempotencyKey({ jobIdempotencyKey: JOB, capabilityId: 'x.like', targetRef: '111111111111' });
    const repost = capabilityIdempotencyKey({
      jobIdempotencyKey: JOB,
      capabilityId: 'x.repost',
      targetRef: '111111111111',
    });
    expect(like).not.toBe(repost);
  });

  it('leaves a target it does not recognise exactly as it came', () => {
    /*
      Guessing at an unfamiliar target is how two genuinely different actions
      become one, which is a worse failure than the one this fixes: a duplicate
      action is a wasted call, and a collision is an action that never happens.
    */
    for (const target of ['@somebody', 'a-conversation-id', 'https://example.com/thing/12345', '']) {
      expect(canonicalTarget(target)).toBe(target.trim());
    }
  });

  it('is not fooled by a number that is not a status', () => {
    // A path that merely contains digits is not a post.
    expect(canonicalTarget('https://x.com/i/spaces/1234567890123')).toBe('https://x.com/i/spaces/1234567890123');
  });
});
