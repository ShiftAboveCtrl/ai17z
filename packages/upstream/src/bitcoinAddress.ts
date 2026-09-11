import { createHash } from 'node:crypto';

/**
 * Telling whether something is a Bitcoin address, by its own checksum.
 *
 * Every Bitcoin address format carries a checksum, for exactly this purpose: a
 * mistyped address is meant to be detectable without asking anybody. So the
 * check here is the real one rather than a shape regex -- a typo fails it, and
 * nothing is sent to a node about an address that does not exist.
 *
 * It also answers a question worth answering on its own. "This is a taproot
 * address" and "this is a testnet address" are both things somebody pasting one
 * would want to be told, and the second is the mistake that otherwise ends with
 * an agent reporting a zero balance for an address that has never been on the
 * chain it was looked up on.
 */

export const BITCOIN_ADDRESS_KINDS = ['P2PKH', 'P2SH', 'P2WPKH', 'P2WSH', 'P2TR'] as const;
export type BitcoinAddressKind = (typeof BITCOIN_ADDRESS_KINDS)[number];

export interface BitcoinAddress {
  kind: BitcoinAddressKind;
  network: 'mainnet' | 'testnet';
  /** What a person would call it, for saying back to them. */
  describe: string;
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

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

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

/** Base58Check: 1 version byte, 20 payload bytes, 4 checksum bytes. */
function parseBase58Check(value: string): BitcoinAddress | null {
  const decoded = base58Decode(value);
  if (!decoded || decoded.length !== 25) return null;

  const body = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21);
  const expected = sha256(sha256(body)).subarray(0, 4);
  for (let i = 0; i < 4; i += 1) if (checksum[i] !== expected[i]) return null;

  switch (body[0]) {
    case 0x00:
      return { kind: 'P2PKH', network: 'mainnet', describe: 'an original-style address' };
    case 0x05:
      return { kind: 'P2SH', network: 'mainnet', describe: 'a script address' };
    case 0x6f:
      return { kind: 'P2PKH', network: 'testnet', describe: 'a testnet address' };
    case 0xc4:
      return { kind: 'P2SH', network: 'testnet', describe: 'a testnet script address' };
    default:
      return null;
  }
}

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let check = 1;
  for (const value of values) {
    const top = check >>> 25;
    check = ((check & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) if ((top >>> i) & 1) check ^= GENERATOR[i]!;
  }
  return check >>> 0;
}

function expandHrp(hrp: string): number[] {
  const high: number[] = [];
  const low: number[] = [];
  for (const character of hrp) {
    const code = character.charCodeAt(0);
    high.push(code >>> 5);
    low.push(code & 31);
  }
  return [...high, 0, ...low];
}

/**
 * Segwit addresses, including the two checksum constants.
 *
 * Version 0 uses bech32 and version 1 and up use bech32m, and they are *not*
 * interchangeable -- that separation is the whole point of bech32m, introduced
 * because the original had a weakness for the longer payloads taproot uses.
 * Checking a taproot address against the version 0 constant rejects every real
 * one.
 */
function parseBech32(value: string): BitcoinAddress | null {
  // Mixed case is invalid by the specification, because the checksum is
  // defined over one case only.
  if (value !== value.toLowerCase() && value !== value.toUpperCase()) return null;
  const lower = value.toLowerCase();

  const split = lower.lastIndexOf('1');
  if (split < 1 || split + 7 > lower.length || lower.length > 90) return null;

  const hrp = lower.slice(0, split);
  if (hrp !== 'bc' && hrp !== 'tb') return null;

  const data: number[] = [];
  for (const character of lower.slice(split + 1)) {
    const index = BECH32_CHARSET.indexOf(character);
    if (index < 0) return null;
    data.push(index);
  }

  const witnessVersion = data[0]!;
  if (witnessVersion > 16) return null;

  const checksum = polymod([...expandHrp(hrp), ...data]);
  // 1 for bech32 (witness version 0), 0x2bc830a3 for bech32m (version 1+).
  const expected = witnessVersion === 0 ? 1 : 0x2bc830a3;
  if (checksum !== expected) return null;

  // The program itself, unpacked from 5-bit groups to bytes, so its length can
  // be checked: 20 bytes is a key, 32 is a script or a taproot output.
  const programBits = (data.length - 1 - 6) * 5;
  const programBytes = Math.floor(programBits / 8);

  const network = hrp === 'bc' ? 'mainnet' : 'testnet';
  if (witnessVersion === 0) {
    if (programBytes === 20) return { kind: 'P2WPKH', network, describe: 'a segwit address' };
    if (programBytes === 32) return { kind: 'P2WSH', network, describe: 'a segwit script address' };
    return null;
  }
  if (witnessVersion === 1 && programBytes === 32) {
    return { kind: 'P2TR', network, describe: 'a taproot address' };
  }
  return null;
}

/** What this address is, or nothing if its own checksum says it is not one. */
export function parseBitcoinAddress(value: string): BitcoinAddress | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return parseBech32(trimmed) ?? parseBase58Check(trimmed);
}

export function isBitcoinAddress(value: string): boolean {
  return parseBitcoinAddress(value) !== null;
}

/** A transaction id: 32 bytes as hex, and no 0x prefix on this chain. */
export function isBitcoinTxid(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value.trim());
}
