import { createHash } from 'node:crypto';

/**
 * Content identifiers, and exactly how much a gateway can be checked.
 *
 * ### A CID identifies a block, not a file
 *
 * This is the distinction everything here turns on, and the easy thing to get
 * wrong. "The CID is the hash of the file" is true only for the narrow case
 * where the file *is* one block. In general a CID names an IPLD block, and a
 * UnixFS file is a root block of links pointing at more blocks -- so for
 * anything larger than a chunk, `sha256(what the gateway sent)` has no reason
 * to equal the CID's multihash, and comparing them would fail on perfectly
 * good content. Worse, writing the comparison anyway and calling a pass
 * "verified" would be a cryptographic claim this code has not earned.
 *
 * So the codec decides what may be claimed:
 *
 * **raw (0x55)** -- `bafkrei...`. The multihash is over the bytes themselves,
 * single block by definition. Hash the body, compare, done. This is genuine
 * verification, and it is what most token metadata happens to be: a small JSON
 * document that fits in one block.
 *
 * **dag-pb (0x70)** -- the old `Qm...` form and `bafybei...`. The multihash is
 * over a protobuf node carrying UnixFS metadata and, for a file over a chunk,
 * links to child blocks. Verifying it properly means fetching the blocks and
 * checking each one, which a plain gateway `GET` does not return. Nothing here
 * pretends otherwise: it is reported `UNVERIFIABLE`.
 *
 * **anything else** -- dag-cbor, dag-json, an unfamiliar codec, or a multihash
 * that is not sha2-256 -- is `UNVERIFIABLE` too, and says which it was rather
 * than failing silently.
 *
 * A directory is a dag-pb node, so it falls under the same rule: a gateway asked
 * for one answers with a generated HTML index, which is not the directory and is
 * not claimed to be.
 *
 * ### Where it does bite, it bites hard
 *
 * Probing in September 2026, `ipfs.io` answered a request for a known **raw**
 * CID with 188 bytes of "This IPFS gateway is switching to a service worker
 * gateway" and a 429. Code that trusted the gateway would have handed that
 * notice page to a model as the file's contents. One hash caught it.
 *
 * That is the whole value proposition, stated at its true size: where the codec
 * permits it this is real cryptographic verification of the gateway, and where
 * it does not, the answer says so.
 */

export const CID_VERIFICATIONS = ['VERIFIED', 'MISMATCH', 'UNVERIFIABLE'] as const;
export type CidVerification = (typeof CID_VERIFICATIONS)[number];

/**
 * What kind of thing this identifier names, which decides what may be claimed.
 *
 * Typed rather than left as a sentence, so a caller can branch on it and a
 * reader can tell "we checked and it matched" from "there was nothing here we
 * could check" -- three different situations that a single boolean flattens
 * into one misleading answer.
 */
export const CID_KINDS = ['RAW_BLOCK', 'DAG_PB', 'OTHER_CODEC', 'UNSUPPORTED_HASH'] as const;
export type CidKind = (typeof CID_KINDS)[number];

export interface ParsedCid {
  /** The text as given, after any `ipfs://` prefix is removed. */
  cid: string;
  version: 0 | 1;
  kind: CidKind;
  /** The multicodec number, when it was a single-byte one this could read. */
  codec: number | null;
  /**
   * The digest this commits to, and **only** when it commits to the bytes.
   *
   * Null for everything else, which is what stops a dag-pb root being compared
   * against a file body and the pass being called verification.
   */
  sha256: string | null;
  why: string;
}

/** The two multicodecs this can reason about. Everything else is unverified. */
const RAW = 0x55;
const DAG_PB = 0x70;

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

  // CIDv0: base58, always dag-pb with sha2-256, always begins Qm.
  if (cid.startsWith('Qm')) {
    const bytes = base58Decode(cid);
    if (!bytes || bytes.length !== 34 || bytes[0] !== 0x12 || bytes[1] !== 0x20) return null;
    return {
      cid,
      version: 0,
      kind: 'DAG_PB',
      codec: DAG_PB,
      sha256: null,
      why:
        'This is a CIDv0, which is always dag-pb: it names a UnixFS node, not the file bytes. A gateway response ' +
        'cannot be checked against it without fetching and verifying the blocks underneath, which a plain gateway ' +
        'request does not return.',
    };
  }

  // CIDv1: base32, lowercase, begins with the multibase prefix 'b'.
  if (cid.startsWith('b')) {
    const bytes = base32Decode(cid.slice(1).toLowerCase());
    if (!bytes || bytes.length < 4) return null;
    if (bytes[0] !== 0x01) return null;

    // The codec is a varint. Everything this needs to tell apart is one byte,
    // so a continuation bit means something longer than raw or dag-pb, and it
    // is reported as such rather than misread as whatever the low byte says.
    const multiByteCodec = (bytes[1]! & 0x80) !== 0;
    const codec = multiByteCodec ? null : bytes[1]!;

    if (multiByteCodec || (codec !== RAW && codec !== DAG_PB)) {
      return {
        cid,
        version: 1,
        kind: 'OTHER_CODEC',
        codec,
        sha256: null,
        why:
          `This identifier uses a codec this does not verify (${codec === null ? 'a multi-byte codec' : `0x${codec.toString(16)}`}), ` +
          'so nothing was checked.',
      };
    }

    const [hashFunction, length] = [bytes[2], bytes[3]];
    if (hashFunction !== 0x12 || length !== 0x20 || bytes.length !== 36) {
      return {
        cid,
        version: 1,
        kind: 'UNSUPPORTED_HASH',
        codec,
        sha256: null,
        why: 'This identifier does not use sha2-256, so nothing was checked.',
      };
    }

    if (codec === RAW) {
      return {
        cid,
        version: 1,
        kind: 'RAW_BLOCK',
        codec,
        sha256: Buffer.from(bytes.subarray(4)).toString('hex'),
        why: 'This identifier names a single raw block, so the bytes themselves are what it commits to.',
      };
    }

    return {
      cid,
      version: 1,
      kind: 'DAG_PB',
      codec,
      sha256: null,
      why:
        'This identifier is dag-pb: it names a UnixFS node, not the file bytes. A gateway response cannot be ' +
        'checked against it without fetching and verifying the blocks underneath.',
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
