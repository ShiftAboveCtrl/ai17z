import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, ResolvedContext, type ContextPost, type PolicyConfig } from '@xbam/shared/contracts';
import { checkAudience } from '@xbam/runtime';

/**
 * "Only reply to verified accounts" has to actually do something.
 *
 * A switch in the interface that no code reads is worse than no switch: it
 * tells somebody a restriction is in force when nothing is enforcing it. These
 * tests are the reason that control exists at all.
 *
 * The rule fails closed. Verification has three states, and only `true` passes:
 * an author the channel could not read is refused with a different message, so
 * "not verified" and "could not tell" never look the same in a trace.
 */

function contextFrom(incoming: Partial<ContextPost>) {
  return ResolvedContext.parse({
    targetRef: 'https://x.com/i/status/1',
    targetAuthorHandle: incoming.authorHandle ?? 'stranger',
    incomingText: 'hello',
    conversation: {
      incoming: {
        remoteId: '1',
        remoteUrl: null,
        authorHandle: 'stranger',
        authorDisplayName: null,
        text: 'hello',
        createdAt: null,
        isSelf: false,
        authorVerified: null,
        ...incoming,
      },
      parent: null,
      ancestors: [],
      root: null,
      quote: null,
      participants: [],
      excludedCount: 0,
      method: 'STATUS_ANCHORED',
      branchConfirmed: true,
      note: '',
    },
  });
}

const verifiedOnly: PolicyConfig = {
  ...DEFAULT_POLICY,
  content: { ...DEFAULT_POLICY.content, requireVerifiedAuthor: true },
};

describe('only answering verified accounts', () => {
  it('lets a verified author through', () => {
    const decision = checkAudience(verifiedOnly, contextFrom({ authorVerified: true }));
    expect(decision.allow).toBe(true);
  });

  it('refuses an author the platform does not show as verified', () => {
    const decision = checkAudience(verifiedOnly, contextFrom({ authorVerified: false }));
    expect(decision.allow).toBe(false);
    if (decision.allow) return;
    expect(decision.reason).toBe('author_not_verified');
    expect(decision.message).toContain('not verified');
  });

  it('refuses, distinctly, when verification could not be read', () => {
    // Failing open here would make the restriction meaningless on any channel
    // that cannot report verification, which is most of them.
    const decision = checkAudience(verifiedOnly, contextFrom({ authorVerified: null }));
    expect(decision.allow).toBe(false);
    if (decision.allow) return;
    expect(decision.reason).toBe('verification_unknown');
    expect(decision.message).toContain('could not be read');
  });

  it('does nothing at all when the rule is off', () => {
    for (const verified of [true, false, null]) {
      expect(checkAudience(DEFAULT_POLICY, contextFrom({ authorVerified: verified })).allow).toBe(true);
    }
  });

  it('still refuses a blocked handle before it considers verification', () => {
    const policy: PolicyConfig = {
      ...verifiedOnly,
      content: { ...verifiedOnly.content, blockedRemoteHandles: ['stranger'] },
    };
    const decision = checkAudience(policy, contextFrom({ authorVerified: true }));
    expect(decision.allow).toBe(false);
    if (decision.allow) return;
    expect(decision.reason).toBe('blocked_handle');
  });
});
