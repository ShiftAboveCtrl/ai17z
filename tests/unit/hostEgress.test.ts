import { describe, expect, it } from 'vitest';
import {
  ENFORCEMENT_CAVEATS,
  MANDATORY_DENIALS,
  effectiveDenials,
  egressPlan,
  addressFamilyOf,
  hostIsDenied,
  mayConnectTo,
  nftablesRuleset,
  planIsSound,
  verifyLoadedRuleset,
  type EgressPlan,
} from '@xbam/runtime';

/**
 * The half of tenant isolation a hypervisor does not buy.
 *
 * Firecracker filters no guest traffic and says so, so the properties worth
 * pinning here are the ones whose absence is invisible: a denial a
 * configuration removed, an allow sitting above a deny, a v4 list with no v6
 * behind it, and a ruleset that was generated but never loaded.
 */

describe('what no configuration may remove', () => {
  it('denies the cloud metadata address', () => {
    // The single most valuable address to a compromised guest.
    expect(MANDATORY_DENIALS).toContain('169.254.169.254/32');
  });

  it('keeps the mandatory denials when a policy empties the field', () => {
    // `deniedCidrs` has a default, and a default is something somebody can
    // overwrite with an empty array.
    const out = effectiveDenials({ deniedCidrs: [] });
    for (const must of MANDATORY_DENIALS) expect(out, must).toContain(must);
  });

  it('keeps them when a policy supplies a different list entirely', () => {
    const out = effectiveDenials({ deniedCidrs: ['203.0.113.0/24'] });
    expect(out).toContain('203.0.113.0/24');
    expect(out).toContain('169.254.169.254/32');
  });

  it('does not duplicate one the policy repeats', () => {
    const out = effectiveDenials({ deniedCidrs: ['127.0.0.0/8', '  127.0.0.0/8  '] });
    expect(out.filter((c) => c === '127.0.0.0/8')).toHaveLength(1);
  });

  it('covers both families, because a list that forgets v6 is not one', () => {
    const families = new Set(MANDATORY_DENIALS.map(addressFamilyOf));
    expect(families.has('ip')).toBe(true);
    expect(families.has('ip6')).toBe(true);
  });
});

describe('the plan', () => {
  it('drops by default', () => {
    // A missing allow is a support ticket; a missing deny is an incident.
    expect(egressPlan().basePolicy).toBe('DROP');
  });

  it('is sound as generated', () => {
    expect(planIsSound(egressPlan())).toEqual({ ok: true });
  });

  it('puts every denial above the allow', () => {
    const plan = egressPlan();
    for (const family of ['ip', 'ip6'] as const) {
      const ofFamily = plan.rules.filter((r) => r.family === family);
      const firstAllow = ofFamily.findIndex((r) => r.action === 'ALLOW');
      expect(firstAllow, family).toBeGreaterThan(0);
      expect(ofFamily.slice(firstAllow).every((r) => r.target === 'any'), family).toBe(true);
    }
  });

  it('gives every rule a reason', () => {
    for (const rule of egressPlan().rules) expect(rule.why.length, rule.target).toBeGreaterThan(10);
  });

  it('denies everything else when a runtime has no business online', () => {
    const plan = egressPlan({ publicInternet: false });
    expect(plan.rules.filter((r) => r.target === 'any').every((r) => r.action === 'DENY')).toBe(true);
    expect(planIsSound(plan)).toEqual({ ok: true });
  });

  it('keeps denied names out of the packet rules', () => {
    // A packet filter cannot match a hostname, and a rule claiming to would be
    // matching whatever that name resolved to when the ruleset was written.
    const plan = egressPlan({ deniedHosts: ['Metadata.Example.COM'] });
    expect(plan.deniedHosts).toEqual(['metadata.example.com']);
    expect(plan.rules.some((r) => r.target.includes('example'))).toBe(false);
  });
});

describe('a plan that would not do its job', () => {
  const sound = egressPlan();

  const without = (target: string): EgressPlan => ({
    ...sound,
    rules: sound.rules.filter((r) => r.target !== target),
  });

  it('refuses a plan missing a mandatory denial', () => {
    const out = planIsSound(without('169.254.169.254/32'));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.problems.join(' ')).toContain('169.254.169.254/32');
  });

  it('refuses an accept base policy', () => {
    const out = planIsSound({ ...sound, basePolicy: 'ACCEPT' as unknown as 'DROP' });
    expect(out.ok).toBe(false);
  });

  it('refuses an allow sitting above a deny', () => {
    // First match wins, so this silently defeats the deny, and it is exactly
    // the mistake that is invisible in a diff.
    const reordered: EgressPlan = {
      ...sound,
      rules: [...sound.rules].sort((a, b) => (a.action === 'ALLOW' ? -1 : b.action === 'ALLOW' ? 1 : 0)),
    };
    const out = planIsSound(reordered);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.problems.join(' ')).toContain('defeats');
  });

  it('refuses a plan with nothing denied on one family', () => {
    const out = planIsSound({ ...sound, rules: sound.rules.filter((r) => r.family !== 'ip6') });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.problems.join(' ')).toContain('ip6');
  });

  it('reports every problem rather than the first', () => {
    const broken: EgressPlan = { ...sound, basePolicy: 'ACCEPT' as unknown as 'DROP', rules: [] };
    const out = planIsSound(broken);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.problems.length).toBeGreaterThan(MANDATORY_DENIALS.length);
  });
});

describe('rendering a ruleset', () => {
  it('carries every denial and a drop policy', () => {
    const text = nftablesRuleset(egressPlan(), 'tap0');
    for (const must of MANDATORY_DENIALS) expect(text, must).toContain(must);
    expect(text).toContain('policy drop');
  });

  it('carries the reasons, so the host and this file say the same thing', () => {
    const text = nftablesRuleset(egressPlan(), 'tap0');
    expect(text).toContain('Cloud instance metadata');
  });

  it('refuses an interface name that is not one', () => {
    for (const bad of ['tap0; rm -rf /', '', 'a'.repeat(32), 'tap 0', '../tap0']) {
      expect(() => nftablesRuleset(egressPlan(), bad), bad).toThrow();
    }
  });
});

describe('what actually loaded on the host', () => {
  it('accepts a ruleset carrying every denial and a drop policy', () => {
    const text = nftablesRuleset(egressPlan(), 'tap0');
    expect(verifyLoadedRuleset(text)).toEqual({ enforced: true });
  });

  it('refuses silence, which is not the same as nothing being denied', () => {
    const out = verifyLoadedRuleset('');
    expect(out.enforced).toBe(false);
    if (out.enforced) return;
    expect(out.missing.length).toBe(MANDATORY_DENIALS.length);
  });

  it('names what the host is missing', () => {
    // A rule that was generated is not a rule that is loaded, and a host whose
    // ruleset failed to apply looks exactly like one where it did.
    const text = nftablesRuleset(egressPlan(), 'tap0').replace('169.254.169.254/32', '198.51.100.1/32');
    const out = verifyLoadedRuleset(text);
    expect(out.enforced).toBe(false);
    if (out.enforced) return;
    expect(out.missing).toContain('169.254.169.254/32');
  });

  it('refuses a ruleset that denies everything named and accepts by default', () => {
    const text = nftablesRuleset(egressPlan(), 'tap0').replace('policy drop', 'policy accept');
    const out = verifyLoadedRuleset(text);
    expect(out.enforced).toBe(false);
    if (out.enforced) return;
    expect(out.why).toContain('default');
  });
});

describe('at the moment of connecting', () => {
  it('refuses the metadata address and the private ranges', () => {
    for (const addr of ['169.254.169.254', '127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.9.9', '::1', 'fe80::1']) {
      expect(mayConnectTo(addr).allowed, addr).toBe(false);
    }
  });

  it('refuses a private address wearing an IPv6 hat', () => {
    // The case a second implementation would have got wrong, which is why
    // there is not a second implementation.
    expect(mayConnectTo('::ffff:169.254.169.254').allowed).toBe(false);
    expect(mayConnectTo('64:ff9b::a01:203').allowed).toBe(false);
  });

  it('allows an ordinary public address', () => {
    expect(mayConnectTo('93.184.216.34').allowed).toBe(true);
  });

  it('says why, so a refusal is explainable', () => {
    const out = mayConnectTo('169.254.169.254');
    expect(out.allowed).toBe(false);
    if (out.allowed) return;
    expect(out.why.length).toBeGreaterThan(5);
  });
});

describe('denied names', () => {
  const plan = egressPlan({ deniedHosts: ['internal.example.com'] });

  it('matches the name and its subdomains', () => {
    expect(hostIsDenied('internal.example.com', plan)).toBe(true);
    expect(hostIsDenied('db.internal.example.com', plan)).toBe(true);
    expect(hostIsDenied('INTERNAL.EXAMPLE.COM.', plan)).toBe(true);
  });

  it('does not match a name that merely ends with the same letters', () => {
    expect(hostIsDenied('notinternal.example.com', plan)).toBe(false);
  });

  it('allows an unrelated name', () => {
    expect(hostIsDenied('example.org', plan)).toBe(false);
  });

  it('refuses an empty name rather than allowing it', () => {
    expect(hostIsDenied('   ', plan)).toBe(true);
  });
});

describe('what this does not do', () => {
  it('says so, because egress filtering is never complete', () => {
    const all = ENFORCEMENT_CAVEATS.join(' ').toLowerCase();
    expect(all).toContain('not a loaded ruleset');
    expect(all).toContain('hostname is not an address');
    expect(all).toContain('not a content filter');
  });

  it('does not claim to stop a determined guest seeing the public web', () => {
    const all = ENFORCEMENT_CAVEATS.join(' ').toLowerCase();
    expect(all).toContain('proxy');
  });
});
