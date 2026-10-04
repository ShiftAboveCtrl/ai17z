import { randomBytes, timingSafeEqual } from 'node:crypto';
import { KEY_CUSTODY_VALUES, type KeyCustody, type ProviderTier } from '@xbam/shared/contracts';

/**
 * Where a hosted tenant's secrets live, and who can reach them.
 *
 * A local owner's AI17Z has one master key and everything in its database is
 * sealed under it. Hosting multiplies that: every tenant gets a key of their
 * own, and the thing that must never exist is one key that opens all of them.
 * An operator who can read every customer is a breach that has already
 * happened and is waiting to be noticed.
 *
 * So the hierarchy is deliberately shallow and has no root:
 *
 *   per-runtime master key   generated in the runtime, never leaves it
 *     -> provider credentials, X session, wallet material, plugin secrets
 *
 * There is no tenant-spanning key above that line, and nothing in this module
 * can produce one. The control plane stores which custody a runtime uses and
 * nothing it could decrypt with.
 *
 * On first-party hardware the key is sealed on the host, which means an
 * operator with root could in principle reach it while the runtime runs. That
 * is stated rather than hidden, and it is the exact gap attested release
 * closes. Nothing here claims otherwise.
 */

/** How long a generated key is. 256 bits, matching the AES-256-GCM the core uses. */
export const RUNTIME_KEY_BYTES = 32;

/**
 * Make a key for one runtime.
 *
 * `randomBytes` is a CSPRNG, which is the only acceptable source: a key
 * derived from a runtime id, a tenant name or a timestamp is a key somebody
 * can regenerate, and the whole point is that nobody can.
 */
export function newRuntimeMasterKey(): Buffer {
  return randomBytes(RUNTIME_KEY_BYTES);
}

/**
 * Where a secret may and may not go.
 *
 * Data rather than prose so the tests can assert against the places that
 * actually handle secrets. Each line is something this project has either
 * already been bitten by or is one mistake away from.
 */
export const SECRET_PLACEMENT_RULES: readonly string[] = [
  'A runtime master key is generated inside the runtime and never sent to the control plane.',
  'No key exists that opens more than one tenant.',
  'A key is never written to a container image, a command line argument or an environment file that is logged.',
  'A key is never placed in scheduler metadata, a host assignment, telemetry or an audit row.',
  'A key is never shown to a model or placed in prompt context.',
  'Studio stores no plaintext provider credential, X password, wallet key or runtime key.',
  'A provider credential reaches a runtime over a path bound to that runtime and is sealed on arrival.',
  'A backup is encrypted with the runtime own key, so storing one is not permission to read it.',
];

/**
 * What a runtime's key custody actually guarantees.
 *
 * Written as the honest answer to "can the host operator read my agent",
 * because that is the question a hosted customer is really asking and a vague
 * answer is worse than an uncomfortable one.
 */
export const CUSTODY_GUARANTEES: Record<KeyCustody, { hostOperatorCanRead: boolean; detail: string }> = {
  HOST_SEALED: {
    hostOperatorCanRead: true,
    detail:
      'The key is sealed on the host. An operator with root on that machine could in principle read it while the runtime is running, so access is minimised and audited rather than prevented. This is not host-blind hosting and is not described as such.',
  },
  ATTESTED_RELEASE: {
    hostOperatorCanRead: false,
    detail:
      'The key is released only against an attestation report verified to the hardware vendor root of trust, matching a published measurement, with debug refused. Not enabled: the attestation path is designed and unproven.',
  },
};

/**
 * Which custody a tier may use.
 *
 * `ATTESTED_RELEASE` is reachable only from a confidential tier, and that tier
 * is not schedulable, so in practice every tenant today is `HOST_SEALED`. The
 * mapping exists so that enabling confidential hosting later is a change of
 * which tier is allowed rather than a change of what custody means.
 */
export function custodyFor(tier: ProviderTier): KeyCustody {
  return tier === 'CONFIDENTIAL_COMPUTE' ? 'ATTESTED_RELEASE' : 'HOST_SEALED';
}

/**
 * Whether a value looks like something that should never have been passed in.
 *
 * Used by the guards below rather than by anything clever. It errs towards
 * refusing: a false positive costs somebody a confusing error, and a false
 * negative puts a key in a log.
 */
/**
 * A uuid is 36 characters of hex and hyphens and is therefore exactly the
 * shape this looks for, so every ordinary payload would be refused: a host
 * assignment carries a runtime id and nothing else. Exempted explicitly
 * rather than by shortening the length floor, because a 32-character key is
 * the common case and lowering the floor is what the floor is for.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksSecret(value: string): boolean {
  if (value.length < 16) return false;
  if (UUID.test(value)) return false;
  // A long run of base64url or hex with no spaces is the shape of key
  // material, a token or a sealed blob.
  return /^[A-Za-z0-9_\-+/=]{16,}$/.test(value) || /^[0-9a-f]{32,}$/i.test(value);
}

/**
 * Words that make a field name a refusal whatever it holds.
 *
 * Matched against the field name split on camel case and underscores, because
 * the first version tested the whole name and therefore missed
 * `walletAddress`: `wallet` was in the list that builds a host assignment and
 * not in the list that refuses one, which is two guards disagreeing about one
 * rule.
 */
const SECRET_WORDS = new Set([
  'key', 'keys', 'secret', 'secrets', 'token', 'password', 'passphrase', 'seed',
  'mnemonic', 'privatekey', 'wallet', 'credential', 'credentials', 'jwk', 'signature',
]);

/**
 * Fields that are *about* a key rather than a key.
 *
 * `keyCustody` is a bounded enum saying how a key is held and it travels on
 * every host assignment, so refusing it would refuse the thing this guard
 * exists to let through. A public key is public by definition and is what a
 * host enrols with. Everything else keeps the strict rule, `privateKey`
 * included, and the list is short on purpose: each entry is a hole somebody
 * has to justify.
 */
const KEY_ADJACENT_FIELDS = new Set([
  'keycustody',
  'keyid',
  'keyalgorithm',
  'publickey',
  'publickeyjwk',
  'publicjwk',
  'keyfingerprint',
  'keythumbprint',
]);

function nameIsSecret(key: string): boolean {
  if (KEY_ADJACENT_FIELDS.has(key.toLowerCase().replace(/[^a-z0-9]+/g, ''))) return false;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
  return words.some((w) => SECRET_WORDS.has(w));
}

/**
 * Refuse to hand a structure onwards if it carries key material.
 *
 * The call sites that matter are the ones that cross a boundary: a host
 * assignment, a scheduler record, a telemetry payload, an audit row. Each of
 * those is somewhere a secret has no business being, and each is somewhere a
 * future field could put one by accident.
 */
export function carriesSecret(payload: unknown, path = ''): { found: true; where: string } | { found: false } {
  if (typeof payload === 'string') {
    return looksSecret(payload) ? { found: true, where: path || 'value' } : { found: false };
  }
  if (Array.isArray(payload)) {
    for (const [i, item] of payload.entries()) {
      const hit = carriesSecret(item, `${path}[${i}]`);
      if (hit.found) return hit;
    }
    return { found: false };
  }
  if (payload && typeof payload === 'object') {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      // A field named like a secret is refused whatever it holds, because a
      // field called `masterKey` with a short value today is a field with a
      // long one tomorrow.
      if (nameIsSecret(key)) {
        return { found: true, where: path ? `${path}.${key}` : key };
      }
      const hit = carriesSecret(value, path ? `${path}.${key}` : key);
      if (hit.found) return hit;
    }
  }
  return { found: false };
}

/**
 * Compare two secrets without leaking which byte differed.
 *
 * Needed wherever a presented value is checked against a stored one. The
 * length check is deliberately separate: `timingSafeEqual` throws on a length
 * mismatch, and throwing is itself an answer, so both sides are padded to a
 * fixed comparison instead.
 */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Still do a comparison of equal length so the timing does not say
    // "wrong length" faster than it says "wrong value".
    const pad = Buffer.alloc(Math.max(left.length, right.length));
    const other = Buffer.alloc(pad.length);
    left.copy(pad);
    right.copy(other);
    timingSafeEqual(pad, other);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** Every custody value is accounted for, so adding one cannot skip its guarantee. */
export function custodyGuaranteesAreComplete(): boolean {
  return KEY_CUSTODY_VALUES.every((v) => v in CUSTODY_GUARANTEES);
}
