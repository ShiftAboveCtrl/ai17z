import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { dpopProof, jwkThumbprint, newInstallationKey, verifyEs256 } from '../../packages/runtime/src/studioJose';
import { LEASE_AUDIENCE, LEASE_TYPE, entitlementDecision, verifyLease, type LeaseEntitlement } from '../../packages/runtime/src/studioLink';

const b64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

function studioKey(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return { privateKey, pub: { kid, kty: 'EC' as const, crv: 'P-256' as const, x: jwk.x, y: jwk.y } };
}

function signJws(header: Record<string, unknown>, payload: Record<string, unknown>, key: ReturnType<typeof studioKey>['privateKey']) {
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

const ORIGIN = 'https://studio.example';
const INSTALLATION = '0b7d8f0e-0000-4000-8000-000000000001';
const NOW = new Date('2026-09-27T12:00:00Z');
const seconds = Math.floor(NOW.getTime() / 1000);

function lease(key: ReturnType<typeof studioKey>, thumbprint: string, overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  return signJws(
    { alg: 'ES256', typ: LEASE_TYPE, kid: key.pub.kid, ...header },
    {
      iss: ORIGIN,
      aud: LEASE_AUDIENCE,
      sub: INSTALLATION,
      jti: 'lease-1',
      iat: seconds - 60,
      exp: seconds + 3600,
      cnf: { jkt: thumbprint },
      entitlements: [],
      ...overrides,
    },
    key.privateKey,
  );
}

describe('installation key and DPoP proofs', () => {
  it('signs a proof Studio can verify: header key, method, URL, time, jti and token hash', () => {
    const key = newInstallationKey();
    expect(key.thumbprint).toBe(jwkThumbprint(key.publicJwk));
    expect(key.publicJwk).not.toHaveProperty('d');
    const proof = dpopProof(key, 'get', `${ORIGIN}/api/v1/installation/entitlements`, 'the-token');
    const [h, p, s] = proof.split('.');
    const header = JSON.parse(Buffer.from(h!, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    expect(header).toEqual({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk });
    expect(payload).toMatchObject({ htm: 'GET', htu: `${ORIGIN}/api/v1/installation/entitlements`, ath: createHash('sha256').update('the-token').digest('base64url') });
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
    const publicKey = createPublicKey({ key: key.publicJwk, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'))).toBe(true);
    expect(dpopProof(key, 'GET', ORIGIN)).not.toBe(dpopProof(key, 'GET', ORIGIN));
  });
});

describe('lease verification', () => {
  const studio = studioKey('lease-a');
  const install = newInstallationKey();
  const expect_ = { origin: ORIGIN, installationId: INSTALLATION, thumbprint: install.thumbprint, keys: [studio.pub] };

  it('accepts a lease Studio signed for this installation and key', () => {
    const verdict = verifyLease(lease(studio, install.thumbprint), expect_, NOW);
    expect(verdict.ok).toBe(true);
  });

  it.each([
    ['signed by another key', () => lease(studioKey('lease-a'), install.thumbprint), /not genuine/],
    ['from an unpinned kid', () => lease(studioKey('lease-z'), install.thumbprint), /does not trust/],
    ['for another installation', () => lease(studio, install.thumbprint, { sub: 'someone-else' }), /different installation/],
    ['bound to another key', () => lease(studio, 'other-thumbprint'), /different installation key/],
    ['from another Studio', () => lease(studio, install.thumbprint, { iss: 'https://evil.example' }), /different Studio/],
    ['addressed elsewhere', () => lease(studio, install.thumbprint, { aud: 'something-else' }), /not addressed/],
    ['expired', () => lease(studio, install.thumbprint, { exp: seconds - 1 }), /pause until Studio can be reached/],
    ['from the future', () => lease(studio, install.thumbprint, { iat: seconds + 3600 }), /future/],
    ['of the wrong type', () => lease(studio, install.thumbprint, {}, { typ: 'JWT' }), /wrong kind/],
    ['naming its own key', () => lease(studio, install.thumbprint, {}, { jwk: studio.pub }), /names its own key/],
  ])('refuses a lease %s', (_label, make, why) => {
    const verdict = verifyLease(make(), expect_, NOW);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toMatch(why);
  });

  it('refuses a lease whose payload was edited after signing, and one with no real signature', () => {
    const good = lease(studio, install.thumbprint, { entitlements: [] });
    const [h, , s] = good.split('.');
    const edited = `${h}.${b64({ iss: ORIGIN, aud: LEASE_AUDIENCE, sub: INSTALLATION, jti: 'x', iat: seconds, exp: seconds + 99999, cnf: { jkt: install.thumbprint }, entitlements: [{ plugin_id: 'free-stuff', usable: true }] })}.${s}`;
    expect(verifyLease(edited, expect_, NOW).ok).toBe(false);
    const none = `${b64({ alg: 'none', typ: LEASE_TYPE, kid: 'lease-a' })}.${good.split('.')[1]}.`;
    expect(verifyLease(none, expect_, NOW).ok).toBe(false);
    const hs = `${b64({ alg: 'HS256', typ: LEASE_TYPE, kid: 'lease-a' })}.${good.split('.')[1]}.${s}`;
    expect(verifyEs256(hs, [studio.pub]).ok).toBe(false);
  });
});

describe('what a lease allows', () => {
  const plugin = { id: 'weather-pro', version: '1.2.0', manifestSha256: 'a'.repeat(64) };
  const cap = 'plugin_weather_pro.read_forecast';
  const entry = (overrides: Partial<LeaseEntitlement> = {}): LeaseEntitlement => ({
    entitlement_id: 'e1',
    plugin_id: 'weather-pro',
    revision: 1,
    usable: true,
    reason: null,
    delivery_mode: 'HOSTED_GATEWAY',
    version: '1.2.0',
    manifest_sha256: 'a'.repeat(64),
    capability_ids: [cap],
    ...overrides,
  });

  it('allows the exact version, manifest and capability', () => {
    expect(entitlementDecision([entry()], plugin, cap)).toEqual({ ok: true });
  });

  it.each([
    ['no entitlement', [], /no entitlement/],
    ['no seat here', [entry({ usable: false, reason: 'NO_SEAT_FOR_THIS_INSTALLATION', capability_ids: [] })], /not assigned to this installation/],
    ['a revoked entitlement', [entry({ usable: false, reason: 'ENTITLEMENT_REVOKED' })], /revoked/],
    ['another version', [entry({ version: '1.3.0' })], /not the version Studio publishes/],
    ['an edited manifest', [entry({ manifest_sha256: 'b'.repeat(64) })], /not the version Studio publishes/],
    ['a capability not covered', [entry({ capability_ids: ['plugin_weather_pro.other'] })], /not part of what your entitlement/],
  ])('refuses %s', (_label, entitlements, why) => {
    const decision = entitlementDecision(entitlements as LeaseEntitlement[], plugin, cap);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.why).toMatch(why);
  });
});
