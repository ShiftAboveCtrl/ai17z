import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type JsonWebKey } from 'node:crypto';

/**
 * The few JOSE operations linking to AI17Z Studio needs, on `node:crypto`.
 *
 * Three of them and no more: make a P-256 key, sign a compact JWS with it
 * (a DPoP proof), and verify a compact ES256 JWS against a public key (an
 * entitlement lease). A general JOSE library would bring algorithms nothing
 * here should ever accept, and `alg: none` has been somebody's bug before.
 */

export interface InstallationKey {
  privateJwk: JsonWebKey;
  publicJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  thumbprint: string;
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

/** RFC 7638 thumbprint of a P-256 public key: required members, lexical order. */
export function jwkThumbprint(jwk: { crv: string; kty: string; x: string; y: string }): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return createHash('sha256').update(canonical).digest('base64url');
}

export function newInstallationKey(): InstallationKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const publicJwk = { kty: 'EC' as const, crv: 'P-256' as const, x: pub.x, y: pub.y };
  return { privateJwk: privateKey.export({ format: 'jwk' }), publicJwk, thumbprint: jwkThumbprint(publicJwk) };
}

function signCompact(header: Record<string, unknown>, payload: Record<string, unknown>, privateJwk: JsonWebKey): string {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = createPrivateKey({ key: privateJwk, format: 'jwk' });
  // JOSE wants r||s, not the DER that node produces by default.
  const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(signature)}`;
}

/**
 * A DPoP proof (RFC 9449) for one request. `htu` is the Studio origin and
 * path with no query, because that is what Studio compares it against; `ath`
 * binds the proof to the token it travels with.
 */
export function dpopProof(key: InstallationKey, method: string, htu: string, accessToken?: string): string {
  const payload: Record<string, unknown> = {
    htm: method.toUpperCase(),
    htu,
    iat: Math.floor(Date.now() / 1000),
    jti: randomUUID(),
  };
  if (accessToken) payload.ath = createHash('sha256').update(accessToken).digest('base64url');
  return signCompact({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk }, payload, key.privateJwk);
}

export interface VerifiedJws {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

/**
 * Verifies a compact ES256 JWS against one of the given public keys, chosen
 * by `kid`. Only ES256, whatever the header asks for, and only a key that
 * was pinned beforehand: a JWS that carries or points at its own key proves
 * nothing about who signed it.
 */
export function verifyEs256(
  jws: string,
  keys: ReadonlyArray<{ kid?: string; kty?: string; crv?: string; x?: string; y?: string }>,
): { ok: true; value: VerifiedJws } | { ok: false; why: string } {
  const parts = jws.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]*$/.test(part))) {
    return { ok: false, why: 'not a compact JWS' };
  }
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return { ok: false, why: 'the JWS header or payload is not JSON' };
  }
  if (header.alg !== 'ES256') return { ok: false, why: `signed with ${String(header.alg)}, and only ES256 is accepted` };
  if ('jwk' in header || 'jku' in header || 'x5u' in header || 'x5c' in header) {
    return { ok: false, why: 'the JWS names its own key, which is not accepted' };
  }
  const key = keys.find((candidate) => candidate.kid === header.kid);
  if (!key || key.kty !== 'EC' || key.crv !== 'P-256' || !key.x || !key.y) {
    return { ok: false, why: 'signed with a key this installation does not trust' };
  }
  let good = false;
  try {
    const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: key.x, y: key.y }, format: 'jwk' });
    good = verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2]!, 'base64url'));
  } catch {
    good = false;
  }
  return good ? { ok: true, value: { header, payload } } : { ok: false, why: 'the signature does not verify' };
}
