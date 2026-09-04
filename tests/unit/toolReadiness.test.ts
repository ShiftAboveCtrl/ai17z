import { describe, expect, it } from 'vitest';
import { preflightEnabling, toolReadiness, withToolAllowed } from '@xbam/runtime';

const tool = (over: Partial<{ key: string; name: string; enabled: boolean }> = {}) => ({
  key: over.key ?? 'web.research',
  name: over.name ?? 'Web research',
  enabled: over.enabled ?? true,
});

/**
 * "Blocked by policy" names no policy, no setting and no way forward, and the
 * person reading it has already switched the tool on and been told it is both
 * on and not working.
 *
 * Two independent gates cause that: the owner switching a tool on, and the
 * agent's versioned policy permitting it. Neither implies the other, so an
 * answer that does not say which one is unsatisfied is not an answer.
 */
describe('why a tool will or will not run', () => {
  it('says which of the two gates is closed', () => {
    const verdict = toolReadiness(tool(), []);
    expect(verdict.state).toBe('BLOCKED');
    expect(verdict.summary).toContain('switched on');
    expect(verdict.summary).toContain('policy does not permit');
    expect(verdict.setting).toContain('allowlist');
  });

  it('names the exact setting and the exact change', () => {
    const verdict = toolReadiness(tool(), []);
    expect(verdict.setting).toContain('policy.tools.allowed');
    expect(verdict.fix).toContain('"web.research"');
    expect(verdict.grant).toEqual({ addToolToPolicyAllowlist: 'web.research' });
  });

  it('says whether the simple view can fix it', () => {
    // A fix that requires finding Advanced Mode is one most people will not
    // make, so the interface has to know which kind it is dealing with.
    expect(toolReadiness(tool(), []).fixableInEasyMode).toBe(false);
    expect(toolReadiness(tool({ enabled: false }), ['web.research']).fixableInEasyMode).toBe(true);
  });

  it('distinguishes switched off from blocked', () => {
    const off = toolReadiness(tool({ enabled: false }), []);
    expect(off.state).toBe('OFF');
    expect(off.summary).not.toContain('policy does not permit');

    const offButPermitted = toolReadiness(tool({ enabled: false }), ['web.research']);
    expect(offButPermitted.state).toBe('OFF');
    expect(offButPermitted.summary).toContain('permitted by the policy but switched off');
  });

  it('says nothing needs doing when it will run', () => {
    const ready = toolReadiness(tool(), ['web.research']);
    expect(ready.state).toBe('READY');
    expect(ready.fix).toBeNull();
    expect(ready.grant).toBeNull();
  });
});

describe('before the switch rather than during a conversation', () => {
  it('warns that switching on is not enough on its own', () => {
    const check = preflightEnabling(tool(), []);
    expect(check.willRun).toBe(false);
    expect(check.warning).toContain('not enough on its own');
    expect(check.grant).toEqual({ addToolToPolicyAllowlist: 'web.research' });
  });

  it('says nothing when it will simply work', () => {
    const check = preflightEnabling(tool(), ['web.research']);
    expect(check.willRun).toBe(true);
    expect(check.warning).toBeNull();
  });
});

describe('the quick fix changes exactly one thing', () => {
  it('adds the one tool and leaves the rest of the allowlist alone', () => {
    expect(withToolAllowed(['memory.search'], 'web.research')).toEqual(['memory.search', 'web.research']);
  });

  it('is idempotent', () => {
    expect(withToolAllowed(['web.research'], 'web.research')).toEqual(['web.research']);
  });

  it('never widens the policy beyond what was asked', () => {
    // Turning on every tool to make one work is not a fix, it is a security
    // hole with a friendly button on it.
    const before = ['memory.search'];
    const after = withToolAllowed(before, 'web.research');
    expect(after).toHaveLength(before.length + 1);
    expect(before).toEqual(['memory.search']);
  });
});
