import { describe, expect, it } from 'vitest';
import { POST_OUTCOME_AMBIGUOUS, postHasReadBack, priorPostWasAmbiguous } from '../../packages/runtime/src/postReadBack';

const verification = (evidence: Record<string, unknown> = {}) => ({
  verified: true,
  detail: 'ok',
  targetRef: null,
  targetUrl: null,
  targetAuthorHandle: null,
  evidence,
});

describe('what counts as evidence that a post is public', () => {
  it('accepts an id or an address read back', () => {
    expect(postHasReadBack({ remoteActionId: '1', remoteActionUrl: null, verification: verification() })).toBe(true);
    expect(postHasReadBack({ remoteActionId: null, remoteActionUrl: 'https://x.invalid/s/1', verification: verification() })).toBe(true);
  });

  it('refuses a submit with nothing read back, whether or not the composer closed', () => {
    expect(postHasReadBack({ remoteActionId: null, remoteActionUrl: null, verification: verification() })).toBe(false);
    expect(
      postHasReadBack({ remoteActionId: null, remoteActionUrl: null, verification: verification({ composerClosed: true, readBackConfirmed: false }) }),
    ).toBe(false);
  });

  it('believes an adapter that says the read-back failed, even when an id came with it', () => {
    expect(postHasReadBack({ remoteActionId: '1', remoteActionUrl: null, verification: verification({ readBackConfirmed: false }) })).toBe(false);
  });

  it('recognises an earlier attempt that was left ambiguous, and nothing else', () => {
    expect(priorPostWasAmbiguous({ postOutcome: POST_OUTCOME_AMBIGUOUS })).toBe(true);
    expect(priorPostWasAmbiguous({ readBackConfirmed: false })).toBe(false);
    expect(priorPostWasAmbiguous(null)).toBe(false);
  });
});
