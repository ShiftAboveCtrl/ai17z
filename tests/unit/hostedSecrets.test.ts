import { describe, expect, it } from 'vitest';
import { KEY_CUSTODY_VALUES, PROVIDER_TIERS } from '@xbam/shared/contracts';
import {
  ASSIGNMENT_FORBIDDEN_FIELDS,
  CUSTODY_GUARANTEES,
  RUNTIME_KEY_BYTES,
  SECRET_PLACEMENT_RULES,
  carriesSecret,
  custodyFor,
  custodyGuaranteesAreComplete,
  newRuntimeMasterKey,
  secretsMatch,
} from '@xbam/runtime';

/**
 * Where a hosted tenant's secrets live, and the key that must not exist.
 *
 * The property worth proving is a negative: there is no key here that opens
 * more than one tenant, and no code path that could produce one. An operator
 * who can read every customer is a breach that already happened and is
 * waiting to be noticed.
 */

describe('every tenant gets its own key', () => {
  it('generates a full-length key from a CSPRNG', () => {
    const key = newRuntimeMasterKey();
    expect(key).toHaveLength(RUNTIME_KEY_BYTES);
    expect(RUNTIME_KEY_BYTES).toBe(32);
  });

  it('never generates the same key twice', () => {
    // A key derived from a runtime id, a tenant name or a timestamp is a key
    // somebody can regenerate, and the point is that nobody can.
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(newRuntimeMasterKey().toString('hex'));
    expect(seen.size).toBe(200);
  });

  it('takes no arguments, so a key cannot be derived from anything', () => {
    // If this ever grows a parameter, somebody is about to make keys
    // predictable from a tenant identifier.
    expect(newRuntimeMasterKey).toHaveLength(0);
  });
});

describe('what custody actually guarantees', () => {
  it('accounts for every custody value', () => {
    expect(custodyGuaranteesAreComplete()).toBe(true);
    for (const value of KEY_CUSTODY_VALUES) expect(CUSTODY_GUARANTEES[value]).toBeTruthy();
  });

  it('admits a host operator can read a host-sealed runtime', () => {
    // The uncomfortable answer, stated. A vague one is worse.
    expect(CUSTODY_GUARANTEES.HOST_SEALED.hostOperatorCanRead).toBe(true);
    expect(CUSTODY_GUARANTEES.HOST_SEALED.detail).toContain('not host-blind');
  });

  it('says attested release is designed and unproven rather than available', () => {
    expect(CUSTODY_GUARANTEES.ATTESTED_RELEASE.hostOperatorCanRead).toBe(false);
    const detail = CUSTODY_GUARANTEES.ATTESTED_RELEASE.detail.toLowerCase();
    expect(detail).toContain('not enabled');
    // And names the three things that would have to be true.
    expect(detail).toContain('root of trust');
    expect(detail).toContain('measurement');
    expect(detail).toContain('debug refused');
  });

  it('gives every schedulable tier host-sealed custody today', () => {
    // Attested release is reachable only from the confidential tier, and that
    // tier is not schedulable, so in practice every tenant is host-sealed.
    for (const tier of PROVIDER_TIERS) {
      const custody = custodyFor(tier);
      if (tier === 'CONFIDENTIAL_COMPUTE') expect(custody).toBe('ATTESTED_RELEASE');
      else expect(custody, tier).toBe('HOST_SEALED');
    }
  });
});

describe('a secret is refused at every boundary it has no business crossing', () => {
  it('finds key material by shape', () => {
    const hit = carriesSecret({ runtimeId: 'r-1', blob: 'aGVsbG8gdGhpcyBpcyBsb25nIGVub3VnaA' });
    expect(hit.found).toBe(true);
    if (!hit.found) return;
    expect(hit.where).toBe('blob');
  });

  it('refuses a field named like a secret whatever it holds', () => {
    // A field called masterKey with a short value today is a field with a
    // long one tomorrow.
    for (const field of ['masterKey', 'api_key', 'secret', 'token', 'password', 'seed', 'privateKey', 'mnemonic']) {
      const hit = carriesSecret({ runtimeId: 'r', [field]: 'x' });
      expect(hit.found, field).toBe(true);
    }
  });

  it('looks inside nested structures and arrays', () => {
    const hit = carriesSecret({ a: { b: [{ c: { apiKey: 'short' } }] } });
    expect(hit.found).toBe(true);
    if (!hit.found) return;
    expect(hit.where).toContain('apiKey');
  });

  it('passes an ordinary host assignment', () => {
    // The thing a host is actually given has to survive this, or the guard is
    // useless at the place it matters most.
    const assignment = {
      runtimeId: '11111111-1111-4111-8111-111111111111',
      generation: 1,
      runtimeClass: 'general-1',
      version: '1.0.0-beta.63',
      keyCustody: 'HOST_SEALED',
    };
    expect(carriesSecret(assignment).found, JSON.stringify(carriesSecret(assignment))).toBe(false);
  });

  it('agrees with the fields a host assignment already forbids', () => {
    // Two guards, one rule: the builder omits these and the receiver refuses
    // them, so a control plane bug cannot start leaking onto hosts.
    for (const field of ASSIGNMENT_FORBIDDEN_FIELDS.filter((f) => /key|secret|token|wallet/i.test(f))) {
      expect(carriesSecret({ [field]: 'anything' }).found, field).toBe(true);
    }
  });
});

describe('comparing a presented secret', () => {
  it('matches equal values and rejects different ones', () => {
    expect(secretsMatch('abcdef', 'abcdef')).toBe(true);
    expect(secretsMatch('abcdef', 'abcdeg')).toBe(false);
  });

  it('rejects a length mismatch without throwing', () => {
    // timingSafeEqual throws on unequal lengths, and throwing is itself an
    // answer that arrives faster than a wrong value does.
    expect(() => secretsMatch('short', 'considerably longer')).not.toThrow();
    expect(secretsMatch('short', 'considerably longer')).toBe(false);
  });

  it('handles empty input without exploding', () => {
    expect(secretsMatch('', '')).toBe(true);
    expect(secretsMatch('', 'x')).toBe(false);
  });
});

describe('where secrets may not go', () => {
  it('names the places this project could put one by accident', () => {
    const all = SECRET_PLACEMENT_RULES.join(' ').toLowerCase();
    expect(all).toContain('never sent to the control plane');
    // The one that matters most.
    expect(all).toContain('no key exists that opens more than one tenant');
    expect(all).toContain('container image');
    expect(all).toContain('scheduler metadata');
    expect(all).toContain('prompt context');
    expect(all).toContain('studio stores no plaintext');
    expect(all).toContain('storing one is not permission to read it');
  });
});
