import { createSign, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MEASUREMENT_CAVEATS,
  allowedMeasurementsFrom,
  measurementAllowed,
  measurementOf,
  pinPolicyKey,
  pinnedPolicyKeys,
  resetPolicyKeysForTest,
  verifyMeasurementPolicy,
  type MeasurementPolicy,
  type SignedMeasurementPolicy,
} from '@xbam/runtime';

/**
 * Which runtime images may receive a tenant's keys.
 *
 * The case that matters, and the one a signature cannot catch: a host serving
 * last month's correctly signed policy. Nothing is forged, every signature
 * verifies, and the only thing that notices is a generation that only goes up.
 */

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const SPKI = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const KEY_ID = 'release-2026';

const A = 'sha256:' + 'a'.repeat(64);
const B = 'sha256:' + 'b'.repeat(64);

function sign(policy: MeasurementPolicy, keyId = KEY_ID): SignedMeasurementPolicy {
  const payload = JSON.stringify(policy);
  const signer = createSign('sha256');
  signer.update(payload);
  const signature = signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return { payload, signature, keyId };
}

const policy = (over: Partial<MeasurementPolicy> = {}): MeasurementPolicy => ({
  generation: 10,
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  minimumGeneration: 5,
  entries: [
    { measurement: A, version: '1.0.0-beta.70', generation: 10, publishedAt: new Date().toISOString() },
    { measurement: B, version: '1.0.0-beta.69', generation: 9, publishedAt: new Date().toISOString() },
  ],
  ...over,
});

beforeEach(() => {
  resetPolicyKeysForTest();
  pinPolicyKey({ keyId: KEY_ID, publicKeySpki: SPKI });
});

afterEach(() => resetPolicyKeysForTest());

describe('a key is pinned, never discovered', () => {
  it('accepts a policy signed by a pinned key', () => {
    const out = verifyMeasurementPolicy(sign(policy()), 0);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.keyId).toBe(KEY_ID);
  });

  it('refuses one signed by a key nobody pinned', () => {
    // A key fetched alongside the document it verifies is not a second opinion.
    const out = verifyMeasurementPolicy(sign(policy(), 'somebody-else'), 0);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reasons.join(' ')).toContain('not a second opinion');
  });

  it('refuses to replace a pinned key, and allows adding one', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const otherSpki = other.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    expect(() => pinPolicyKey({ keyId: KEY_ID, publicKeySpki: otherSpki })).toThrow(/may never replace one/);
    pinPolicyKey({ keyId: 'release-2027', publicKeySpki: otherSpki });
    expect([...pinnedPolicyKeys()].sort()).toEqual(['release-2026', 'release-2027']);
  });

  it('pinning the same key twice is not a replacement', () => {
    expect(() => pinPolicyKey({ keyId: KEY_ID, publicKeySpki: SPKI })).not.toThrow();
  });

  it('refuses a tampered payload', () => {
    const signed = sign(policy());
    const tampered = { ...signed, payload: signed.payload.replace('beta.70', 'beta.99') };
    expect(verifyMeasurementPolicy(tampered, 0).ok).toBe(false);
  });
});

describe('the rollback a signature cannot catch', () => {
  it('refuses a correctly signed older policy', () => {
    /*
      The host is not forging anything. It is choosing which truth to serve,
      and every signature check passes. Only the generation notices.
    */
    const out = verifyMeasurementPolicy(sign(policy({ generation: 7 })), 10);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reasons.join(' ')).toContain('without forging anything');
  });

  it('accepts the same generation again, because a reboot is not a rollback', () => {
    expect(verifyMeasurementPolicy(sign(policy({ generation: 10 })), 10).ok).toBe(true);
  });

  it('accepts a newer one', () => {
    expect(verifyMeasurementPolicy(sign(policy({ generation: 11 })), 10).ok).toBe(true);
  });

  it('refuses a policy with no usable generation at all', () => {
    const out = verifyMeasurementPolicy(sign(policy({ generation: 0 })), 0);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reasons.join(' ')).toContain('only thing that can catch a rollback');
  });

  it('refuses an expired policy, so a withheld update cannot be served for ever', () => {
    const out = verifyMeasurementPolicy(sign(policy({ expiresAt: new Date(Date.now() - 1_000).toISOString() })), 0);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reasons.join(' ')).toContain('expired');
  });

  it('refuses a policy allowing nothing', () => {
    expect(verifyMeasurementPolicy(sign(policy({ entries: [] })), 0).ok).toBe(false);
  });
});

describe('asking a policy about one measurement', () => {
  it('allows one it published', () => {
    const out = measurementAllowed(policy(), A);
    expect(out.allowed).toBe(true);
    if (!out.allowed) return;
    expect(out.version).toBe('1.0.0-beta.70');
  });

  it('refuses one it never published', () => {
    const out = measurementAllowed(policy(), 'sha256:' + 'f'.repeat(64));
    expect(out.allowed).toBe(false);
    if (out.allowed) return;
    expect(out.why).toContain('did not publish it');
  });

  it('refuses a revoked one, and says why rather than calling it old', () => {
    // An operator reading "too old" about an image withdrawn for a
    // vulnerability looks in the wrong place.
    const withRevocation = policy({
      entries: [
        {
          measurement: A,
          version: '1.0.0-beta.70',
          generation: 10,
          publishedAt: new Date().toISOString(),
          revokedAt: new Date(Date.now() - 1_000).toISOString(),
          revokedReason: 'a dependency advisory',
        },
      ],
    });
    const out = measurementAllowed(withRevocation, A);
    expect(out.allowed).toBe(false);
    if (out.allowed) return;
    expect(out.why).toContain('a dependency advisory');
    expect(out.why).toContain('look current');
  });

  it('does not treat a future revocation as a current one', () => {
    const later = policy({
      entries: [
        {
          measurement: A,
          version: '1.0.0-beta.70',
          generation: 10,
          publishedAt: new Date().toISOString(),
          revokedAt: new Date(Date.now() + 86_400_000).toISOString(),
          revokedReason: 'scheduled withdrawal',
        },
      ],
    });
    expect(measurementAllowed(later, A).allowed).toBe(true);
  });

  it('refuses one below the floor, which closes a range without listing it', () => {
    const out = measurementAllowed(policy({ minimumGeneration: 10 }), B);
    expect(out.allowed).toBe(false);
    if (out.allowed) return;
    expect(out.why).toContain('is the floor');
  });

  it('hands the verifier only what is currently allowed', () => {
    const allowed = allowedMeasurementsFrom(policy({ minimumGeneration: 10 }));
    expect(allowed).toEqual([A]);
  });
});

describe('measuring an image', () => {
  it('is one spelling, so two digests of one image are the same string', () => {
    const bytes = new Uint8Array(Buffer.from('an image', 'utf8'));
    expect(measurementOf(bytes)).toBe(measurementOf(new Uint8Array(Buffer.from('an image', 'utf8'))));
    expect(measurementOf(bytes)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes when the image does', () => {
    expect(measurementOf(new Uint8Array([1]))).not.toBe(measurementOf(new Uint8Array([2])));
  });
});

describe('what this says about itself', () => {
  it('explains why neither a constant nor a database row would do', () => {
    const all = MEASUREMENT_CAVEATS.join(' ');
    expect(all).toContain('pinned in source cannot be rotated');
    expect(all).toContain('includes the host operator');
  });

  it('says a signature cannot catch a rollback', () => {
    expect(MEASUREMENT_CAVEATS.join(' ')).toContain('A signature cannot catch a rollback');
  });

  it('says nothing has been signed or published yet', () => {
    expect(MEASUREMENT_CAVEATS.join(' ')).toContain('No policy has been signed');
  });
});
