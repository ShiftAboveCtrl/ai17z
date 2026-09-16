import { describe, expect, it } from 'vitest';
import { actionIdempotencyKeyFor, canonicalTarget, capabilityIdempotencyKey } from '@xbam/runtime';

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

/**
 * The half of the guarantee that canonicalising the target did not reach.
 *
 * `canonicalTarget` made one post one target. It did not make the two writers
 * spell the whole key the same way: `engage.ts` acts through
 * `performCapabilityAction`, whose key carries the capability and the target,
 * while the pipeline claimed under the job's key bare. Those can never collide,
 * so `actions.idempotency_key` could not see them as one action.
 *
 * The engagement record job is held out of the claim, so the pipeline should
 * not run for one at all. Should is not a guarantee, and the recovery reasoning
 * says in as many words that a process dying inside the hold is safe because
 * the action key makes the second attempt a no-op. It only does if they agree.
 */
describe('the key two writers have to agree on', () => {
  const TARGET = 'https://x.com/007Ledger/status/2100096754989314242';

  it('builds a like the same way the capability executor does', () => {
    expect(actionIdempotencyKeyFor({ actionType: 'LIKE', jobIdempotencyKey: JOB, targetRef: TARGET })).toBe(
      capabilityIdempotencyKey({ jobIdempotencyKey: JOB, capabilityId: 'x.like', targetRef: TARGET }),
    );
  });

  it('builds a repost the same way the capability executor does', () => {
    expect(actionIdempotencyKeyFor({ actionType: 'REPOST', jobIdempotencyKey: JOB, targetRef: TARGET })).toBe(
      capabilityIdempotencyKey({ jobIdempotencyKey: JOB, capabilityId: 'x.repost', targetRef: TARGET }),
    );
  });

  it('agrees whichever way the same post was written', () => {
    // The live failure exactly: one writer held the bare id, the other the address.
    expect(actionIdempotencyKeyFor({ actionType: 'LIKE', jobIdempotencyKey: JOB, targetRef: TARGET })).toBe(
      capabilityIdempotencyKey({
        jobIdempotencyKey: JOB,
        capabilityId: 'x.like',
        targetRef: '2100096754989314242',
      }),
    );
  });

  /*
    A reply and a post keep the job's key.

    They have one writer, so there is nothing to agree with, and changing their
    spelling would strand every job already queued under the old one across an
    upgrade.
  */
  it('leaves a reply and a post on the job key', () => {
    for (const actionType of ['REPLY', 'POST']) {
      expect(actionIdempotencyKeyFor({ actionType, jobIdempotencyKey: JOB, targetRef: TARGET })).toBe(JOB);
    }
  });

  it('falls back to the job key when there is no target to build from', () => {
    expect(actionIdempotencyKeyFor({ actionType: 'LIKE', jobIdempotencyKey: JOB, targetRef: null })).toBe(JOB);
  });
});
