import { createHash, createPublicKey, verify } from 'node:crypto';

/**
 * Which AI17Z runtime images may receive a tenant's keys, and who says so.
 *
 * The attestation verifier takes a list of allowed measurements. This is where
 * that list comes from, and the reason it is a signed document rather than a
 * constant is that both of the obvious alternatives are wrong.
 *
 * A measurement pinned in source cannot be rotated. A legitimate runtime
 * update would make every running tenant unbootable the moment the new image
 * shipped, or would require shipping the new allowed measurement in the very
 * release that needs it, which is a chicken and egg with a customer's agent
 * inside it.
 *
 * A measurement list in the database can be edited by anybody who can edit the
 * database, which on a hosted machine includes the host operator. That is the
 * person the whole architecture exists to exclude, so a list they can append
 * to is not a list.
 *
 * So: a signed, versioned document, verified against keys pinned at link time,
 * exactly as the Studio entitlement lease already works. The host can serve it,
 * cache it, or withhold it. It cannot add to it.
 *
 * Nothing here holds a private key or signs anything. Signing happens where
 * releases are made, which is not a hosted runtime.
 */

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export interface AllowedMeasurement {
  /** The measurement itself: a container digest, or a PCR value. */
  measurement: string;
  /** The AI17Z release it belongs to, so a human can tell what this is. */
  version: string;
  /**
   * Monotonic, and the whole of the rollback defence.
   *
   * A host that serves an older signed policy is serving a genuinely signed
   * document, so a signature cannot catch it. A generation that only ever goes
   * up can.
   */
  generation: number;
  /** When this release was published. */
  publishedAt: string;
  /**
   * Withdrawn, with a reason. A revoked measurement is refused even though it
   * is still in a signed document, because deleting it from the document would
   * make an older copy of that document look current.
   */
  revokedAt?: string | null;
  revokedReason?: string | null;
}

export interface MeasurementPolicy {
  /** Monotonic across the document, not per entry. */
  generation: number;
  issuedAt: string;
  /** Past this, a policy is stale and a runtime stops being allowed to boot on it. */
  expiresAt: string;
  entries: AllowedMeasurement[];
  /**
   * The lowest generation a runtime may still be started from.
   *
   * Separate from revocation: a release can be too old to start without
   * anything being wrong with it, and raising this floor is how a known-bad
   * range is closed without listing every entry in it.
   */
  minimumGeneration: number;
}

export interface SignedMeasurementPolicy {
  /** The policy, as the exact bytes that were signed. */
  payload: string;
  /** Base64url signature over those bytes. */
  signature: string;
  /** Which pinned key signed it. */
  keyId: string;
}

/**
 * A key AI17Z pinned at link time.
 *
 * Pinned, never discovered: a key fetched from the same place as the document
 * it verifies is not a second opinion. A later answer may add a key and may
 * never replace one, which is the rule the Studio lease already follows.
 */
export interface PolicyKey {
  keyId: string;
  /** SPKI DER, base64. ES256. */
  publicKeySpki: string;
}

const keys = new Map<string, PolicyKey>();

/** Adds a pinned key. Adding is allowed; replacing is not. */
export function pinPolicyKey(key: PolicyKey): void {
  const existing = keys.get(key.keyId);
  if (existing && existing.publicKeySpki !== key.publicKeySpki) {
    throw new Error(
      `${key.keyId} is already pinned to a different key. A later answer may add a key and may never replace one: replacing is how a compromised signer becomes the only signer.`,
    );
  }
  keys.set(key.keyId, key);
}

export function resetPolicyKeysForTest(): void {
  keys.clear();
}

export function pinnedPolicyKeys(): readonly string[] {
  return [...keys.keys()];
}

// ---------------------------------------------------------------------------
// Verifying one
// ---------------------------------------------------------------------------

export type PolicyVerdict =
  | { ok: true; policy: MeasurementPolicy; keyId: string }
  | { ok: false; reasons: readonly string[] };

/**
 * Verifies a signed policy and returns what it says.
 *
 * `lastSeenGeneration` is the highest generation this installation has ever
 * accepted. Passing it is what makes rollback detectable: without it a host
 * can serve last month's correctly signed policy for ever, and every signature
 * check passes.
 */
export function verifyMeasurementPolicy(
  signed: SignedMeasurementPolicy,
  lastSeenGeneration: number,
  now: Date = new Date(),
): PolicyVerdict {
  const reasons: string[] = [];

  const key = keys.get(signed.keyId);
  if (!key) {
    return {
      ok: false,
      reasons: [
        `No key is pinned under ${signed.keyId}, so nothing has verified this policy. A key fetched alongside the document it verifies is not a second opinion.`,
      ],
    };
  }

  let signatureOk = false;
  try {
    signatureOk = verify(
      'sha256',
      Buffer.from(signed.payload, 'utf8'),
      { key: createPublicKey({ key: Buffer.from(key.publicKeySpki, 'base64'), format: 'der', type: 'spki' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(signed.signature, 'base64url'),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) reasons.push('The signature does not verify against the pinned key.');

  let policy: MeasurementPolicy | null = null;
  try {
    policy = JSON.parse(signed.payload) as MeasurementPolicy;
  } catch {
    reasons.push('The payload is not readable as a policy.');
  }

  if (policy) {
    if (!Number.isInteger(policy.generation) || policy.generation < 1) {
      reasons.push('The policy has no usable generation, which is the only thing that can catch a rollback.');
    } else if (policy.generation < lastSeenGeneration) {
      /*
        A correctly signed older document. The signature is genuine, which is
        exactly why a signature cannot catch this: the host is not forging
        anything, it is choosing which truth to serve.
      */
      reasons.push(
        `This policy is generation ${policy.generation} and generation ${lastSeenGeneration} has already been seen. An older correctly signed policy is how a host rolls a runtime back without forging anything.`,
      );
    }

    const expires = Date.parse(policy.expiresAt);
    if (!Number.isFinite(expires)) reasons.push('The policy has no readable expiry.');
    else if (expires <= now.getTime()) {
      // Expiry is what stops a host serving a valid document for ever after
      // the signer has stopped publishing.
      reasons.push(`The policy expired at ${policy.expiresAt}.`);
    }

    if (!Array.isArray(policy.entries) || policy.entries.length === 0) {
      reasons.push('The policy allows no measurements, so no runtime could start on it.');
    }
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, policy: policy!, keyId: signed.keyId };
}

// ---------------------------------------------------------------------------
// Asking it about one measurement
// ---------------------------------------------------------------------------

export type MeasurementVerdict =
  | { allowed: true; version: string; generation: number }
  | { allowed: false; why: string };

/**
 * Whether one measurement may receive tenant keys, according to a policy.
 *
 * Revocation is checked before the floor, because a revoked measurement is
 * refused with its reason and an old one is refused with a different one, and
 * an operator reading "too old" about an image that was withdrawn for a
 * vulnerability would look in the wrong place.
 */
export function measurementAllowed(policy: MeasurementPolicy, measurement: string, now: Date = new Date()): MeasurementVerdict {
  const entry = policy.entries.find((e) => e.measurement === measurement);
  if (!entry) return { allowed: false, why: 'That measurement is not in the policy, so AI17Z did not publish it.' };

  if (entry.revokedAt) {
    const when = Date.parse(entry.revokedAt);
    if (Number.isFinite(when) && when <= now.getTime()) {
      return {
        allowed: false,
        why: `${entry.version} was revoked${entry.revokedReason ? `: ${entry.revokedReason}` : '.'} A revoked entry stays in the document, because removing it would make an older copy of the document look current.`,
      };
    }
  }

  if (entry.generation < policy.minimumGeneration) {
    return {
      allowed: false,
      why: `${entry.version} is generation ${entry.generation} and ${policy.minimumGeneration} is the floor. Raising the floor closes a range without listing every entry in it.`,
    };
  }

  return { allowed: true, version: entry.version, generation: entry.generation };
}

/** The measurements a policy currently allows, for handing to the verifier. */
export function allowedMeasurementsFrom(policy: MeasurementPolicy, now: Date = new Date()): readonly string[] {
  return policy.entries.filter((e) => measurementAllowed(policy, e.measurement, now).allowed).map((e) => e.measurement);
}

/**
 * The digest of an image, for comparing one this installation built against
 * one a policy names.
 *
 * Here so there is one spelling of it. A measurement compared with a
 * differently-computed digest is two things that look the same and are not.
 */
export function measurementOf(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export const MEASUREMENT_CAVEATS: readonly string[] = [
  'A measurement pinned in source cannot be rotated, and a legitimate runtime update would make every running tenant unbootable or need to ship inside the release that requires it.',
  'A measurement list in a database can be appended to by whoever can edit the database, which on a hosted machine includes the host operator: the person the architecture exists to exclude.',
  'A signature cannot catch a rollback. An older policy is correctly signed, so the host is choosing which truth to serve rather than forging one, and only a monotonic generation notices.',
  'A revoked entry stays in the document. Removing it would make an older copy of the document look current.',
  'Nothing here signs anything or holds a private key. Signing happens where releases are made, which is not a hosted runtime.',
  'No policy has been signed or published, and no runtime image exists to measure, so there is nothing yet for this to allow.',
];
