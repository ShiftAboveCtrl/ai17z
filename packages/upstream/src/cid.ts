import { createHash } from 'node:crypto';

/**
 * Content identifiers, and the one property that makes a gateway safe to use.
 *
 * An IPFS gateway is somebody else's server standing between AI17Z and the
 * content. Ordinarily that would mean trusting it. It does not here, because a
 * CID **is a hash of the content**: whatever comes back can be hashed and
 * compared, and a gateway that returns something else is caught rather than
 * believed.
 *
 * This is not theoretical. Probing in September 2026, `ipfs.io` answered a
 * request for a known CID with 188 bytes of "This IPFS gateway is switching to
 * a service worker gateway" and a 429. Code that trusted the gateway would have
 * handed that notice page to a model as the file's contents. The hash check
 * caught it in one line.
 *
 * ### What can be checked, and what honestly cannot
 *
 * A **raw** CIDv1 -- `bafkrei...`, codec 0x55 -- commits to the sha2-256 of the
 * bytes themselves, so verifying it is a hash and a comparison. Small JSON
 * documents, which is most token metadata, are usually stored this way.
 *
 * A **dag-pb** CID -- the old `Qm...` form, and `bafybei...` -- commits to a
 * protobuf node wrapping UnixFS metadata, and for anything over a chunk it
 * commits to a tree of them. Verifying that means implementing UnixFS chunking,
 * and getting it subtly wrong would produce a check that says "verified" while
 * checking nothing -- worse than no check at all.
 *
 * So this verifies what it can verify exactly, and reports `UNVERIFIABLE` for
 * the rest rather than implying an assurance it did not make. Which of the two
 * happened travels with the content.
 */

export const CID_VERIFICATIONS = ['VERIFIED', 'MISMATCH', 'UNVERIFIABLE'] as const;
export type CidVerification = (typeof CID_VERIFICATIONS)[number];

export interface ParsedCid {
  /** The text as given, after any `ipfs://` prefix is removed. */
  cid: string;
  /** Present only when this CID commits directly to the bytes. */
  sha256: string | null;
  why: string;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base32Decode(input: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const character of input) {
    const index = BASE32.indexOf(character);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function base58Decode(input: string): Uint8Array | null {
  if (input.length === 0 || input.length > 128) return null;
  const bytes: number[] = [];
  for (const character of input) {
    let carry = BASE58.indexOf(character);
    if (carry < 0) return null;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < input.length && input[i] === '1'; i += 1) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

/** Strips `ipfs://`, a gateway path, or a trailing slash, leaving the CID. */
export function normaliseCid(value: string): { cid: string; path: string } | null {
  let text = value.trim();
  if (text.length === 0) return null;

  if (text.startsWith('ipfs://')) text = text.slice('ipfs://'.length);
  // A full gateway URL: take whatever follows /ipfs/.
  const gatewayAt = text.indexOf('/ipfs/');
  if (gatewayAt >= 0) text = text.slice(gatewayAt + '/ipfs/'.length);

  const [cid, ...rest] = text.split('/');
  if (!cid) return null;
  // Only the characters the two encodings use, so nothing path-like or
  // scheme-like reaches a URL later.
  if (!/^[A-Za-z0-9]+$/.test(cid) || cid.length < 20 || cid.length > 120) return null;
  return { cid, path: rest.join('/') };
}

/**
 * What a CID is, and whether its content can be checked against it.
 *
 * Never throws: an unparseable CID is `null`, which the caller reports rather
 * than guessing past.
 */
export function parseCid(value: string): ParsedCid | null {
  const normalised = normaliseCid(value);
  if (!normalised) return null;
  const { cid } = normalised;

  // CIDv0: base58, always dag-pb sha2-256, always begins Qm.
  if (cid.startsWith('Qm')) {
    const bytes = base58Decode(cid);
    if (!bytes || bytes.length !== 34 || bytes[0] !== 0x12 || bytes[1] !== 0x20) return null;
    return {
      cid,
      sha256: null,
      why: 'This is a CIDv0, which commits to a UnixFS node rather than to the bytes themselves, so the content cannot be checked against it here.',
    };
  }

  // CIDv1: base32, lowercase, begins with the multibase prefix 'b'.
  if (cid.startsWith('b')) {
    const bytes = base32Decode(cid.slice(1).toLowerCase());
    if (!bytes || bytes.length < 4) return null;
    const [version, codec, hashFunction, length] = [bytes[0], bytes[1], bytes[2], bytes[3]];
    if (version !== 0x01) return null;
    if (hashFunction !== 0x12 || length !== 0x20 || bytes.length !== 36) {
      return {
        cid,
        sha256: null,
        why: 'This CID does not use sha2-256, so the content cannot be checked against it here.',
      };
    }
    // 0x55 is the raw codec: the hash is of the content itself.
    if (codec === 0x55) {
      return {
        cid,
        sha256: Buffer.from(bytes.subarray(4)).toString('hex'),
        why: 'This CID commits directly to the bytes, so the content was checked against it.',
      };
    }
    return {
      cid,
      sha256: null,
      why: 'This CID commits to a UnixFS node rather than to the bytes themselves, so the content cannot be checked against it here.',
    };
  }

  return null;
}

/** Whether these bytes are what the CID says they should be. */
export function verifyCid(parsed: ParsedCid, body: Uint8Array): CidVerification {
  if (parsed.sha256 === null) return 'UNVERIFIABLE';
  const actual = createHash('sha256').update(body).digest('hex');
  return actual === parsed.sha256 ? 'VERIFIED' : 'MISMATCH';
}
