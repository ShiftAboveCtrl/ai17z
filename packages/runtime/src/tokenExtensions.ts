import { z } from 'zod';
import { SOLANA_FAMILY, ask, isAddress, type SolanaQuery, type SolanaResult } from '@xbam/upstream';
import type { MintExtensions } from '@xbam/prompts';

/**
 * What a Solana mint's own bytes say about Token-2022 extensions.
 *
 * ### Read from the account, decoded here
 *
 * The mint account is fetched once (`getAccountInfo`, base64) and the extension
 * area is walked by this file. Nothing comes from an index's say-so and nothing
 * from a post. The node can also decode extensions itself, but a decode this code
 * did not perform is a decode it cannot vouch for, and the layout is small.
 *
 * ### Layout
 *
 * A mint is 82 bytes. Token-2022 pads a mint that carries extensions to 165 bytes
 * (the size of a token account, so the two can be told apart), puts the account
 * type at byte 165 (1 is a mint, 2 is a token account) and follows it with
 * type-length-value entries: a u16 type, a u16 length, then that many bytes.
 *
 * ### Absent is never zero
 *
 * Every way of not knowing is `unread`: no account, a wrong owner, a short or
 * padded-wrong buffer, an entry that runs past the end, a known extension of the
 * wrong size. An `unread` mint says nothing about its fee, and the card says
 * "extensions unread" rather than any number. A fee of zero is reported only
 * when the extension is present, decoded, and says zero.
 *
 * Extension type ids this does not decode are listed by id and said to be
 * present. They are not skipped silently and they are not guessed at.
 */

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/**
 * Ids as numbered in the Token-2022 program's `ExtensionType` enum. Account-level
 * ids (TransferFeeAmount is 2) never appear on a mint and are not listed.
 */
export const EXTENSION_TYPE = {
  TransferFeeConfig: 1,
  DefaultAccountState: 6,
  PermanentDelegate: 12,
  TransferHook: 14,
} as const;

const BASE_MINT_LEN = 82;
const ACCOUNT_TYPE_OFFSET = 165;
const ACCOUNT_TYPE_MINT = 1;
const TLV_START = ACCOUNT_TYPE_OFFSET + 1;
/**
 * Mainnet-beta has no warmup, so an epoch is exactly this many slots from slot
 * zero. The Solana family proves it is serving mainnet-beta by genesis hash
 * before it answers, which is what makes this arithmetic and not an assumption.
 */
const SLOTS_PER_EPOCH = 432_000;
/** A mint's extensions can be reconfigured by their authority, so a reading is as old as its read. */
export const EXTENSIONS_MAX_AGE_MS = 5 * 60_000;

export interface TransferFeeEntry { epoch: bigint; maxFee: bigint; bps: number }

export interface ParsedMint {
  transferFee: { older: TransferFeeEntry; newer: TransferFeeEntry } | null;
  permanentDelegate: string | null;
  transferHookProgram: string | null;
  defaultAccountState: 'initialized' | 'frozen' | null;
  otherTypeIds: number[];
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 of raw bytes, for the addresses stored inside extension data. */
export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i]! * 256;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) leading += 1;
  return '1'.repeat(leading) + digits.reverse().map((d) => BASE58[d]).join('');
}

/** An optional address as the program stores it: 32 zero bytes means none. */
function optionalKey(slice: Uint8Array): string | null {
  return slice.every((b) => b === 0) ? null : base58Encode(slice);
}

function readFee(view: DataView, at: number): TransferFeeEntry {
  return { epoch: view.getBigUint64(at, true), maxFee: view.getBigUint64(at + 8, true), bps: view.getUint16(at + 16, true) };
}

/**
 * Decodes a Token-2022 mint account's data, or null when it cannot be decoded
 * with confidence. Never throws on hostile bytes.
 */
export function parseToken2022Mint(data: Uint8Array): ParsedMint | null {
  if (data.length < BASE_MINT_LEN) return null;
  // The base mint's is_initialized byte. An account that was never initialised has no meaning to read.
  if (data[45] !== 1) return null;
  const empty: ParsedMint = { transferFee: null, permanentDelegate: null, transferHookProgram: null, defaultAccountState: null, otherTypeIds: [] };
  if (data.length === BASE_MINT_LEN) return empty;
  // Between 83 and 165 bytes is neither a bare mint nor a padded one.
  if (data.length <= ACCOUNT_TYPE_OFFSET || data[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT) return null;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: ParsedMint = { ...empty, otherTypeIds: [] };
  const seen = new Set<number>();
  let at = TLV_START;
  while (at + 4 <= data.length) {
    const type = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    // Zeroed space after the last entry is an uninitialised entry of length zero.
    if (type === 0 && length === 0) break;
    const start = at + 4;
    const end = start + length;
    if (end > data.length || seen.has(type)) return null;
    seen.add(type);
    const body = data.subarray(start, end);
    if (type === EXTENSION_TYPE.TransferFeeConfig) {
      // authority (32) + withdraw authority (32) + withheld amount (8) + older fee (18) + newer fee (18)
      if (length !== 108) return null;
      out.transferFee = { older: readFee(view, start + 72), newer: readFee(view, start + 90) };
    } else if (type === EXTENSION_TYPE.PermanentDelegate) {
      if (length !== 32) return null;
      out.permanentDelegate = optionalKey(body);
    } else if (type === EXTENSION_TYPE.TransferHook) {
      // authority (32) + program id (32); a zero program id means no hook is set
      if (length !== 64) return null;
      out.transferHookProgram = optionalKey(body.subarray(32, 64));
    } else if (type === EXTENSION_TYPE.DefaultAccountState) {
      if (length !== 1) return null;
      const state = body[0];
      if (state === 1) out.defaultAccountState = 'initialized';
      else if (state === 2) out.defaultAccountState = 'frozen';
      else return null;
    } else {
      out.otherTypeIds.push(type);
    }
    at = end;
  }
  out.otherTypeIds.sort((a, b) => a - b);
  return out;
}

/**
 * The fee in effect at a slot. A fee change is scheduled for a later epoch, so the
 * newer entry applies only once its epoch has begun.
 */
export function feeInEffect(fees: { older: TransferFeeEntry; newer: TransferFeeEntry }, slot: number): { bps: number; maxFee: string } {
  const epoch = BigInt(Math.floor(slot / SLOTS_PER_EPOCH));
  const entry = epoch >= fees.newer.epoch ? fees.newer : fees.older;
  return { bps: entry.bps, maxFee: entry.maxFee.toString() };
}

const Common = { source: z.string(), fetchedAt: z.string().nullable(), maxAgeMs: z.number() };

/** The capability output shape of a `MintExtensions`, so the card and the capability cannot drift apart. */
export const MintExtensionsOut = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unread'), ...Common }),
  z.object({ status: z.literal('not_applicable'), ...Common }),
  z.object({
    status: z.literal('read'), ...Common,
    transferFee: z.object({ bps: z.number().int().min(0).max(65535), maxFee: z.string() }).nullable(),
    permanentDelegate: z.string().nullable(),
    transferHookProgram: z.string().nullable(),
    defaultAccountState: z.enum(['initialized', 'frozen']).nullable(),
    otherTypeIds: z.array(z.number().int()),
  }),
]);

function unread(source: string, fetchedAt: string | null): MintExtensions {
  return { status: 'unread', source, fetchedAt, maxAgeMs: EXTENSIONS_MAX_AGE_MS };
}

/**
 * The extension reading for one mint. Never throws: any failed read is `unread`,
 * which the card prints as such, so a fee is never invented by a failure.
 */
export async function readMintExtensions(mint: string): Promise<MintExtensions> {
  if (!isAddress(mint)) return unread(SOLANA_FAMILY, null);
  let source: string = SOLANA_FAMILY;
  let fetchedAt: string | null = null;
  try {
    const answer = await ask<SolanaQuery, SolanaResult>(SOLANA_FAMILY, {
      method: 'getAccountInfo', params: [mint, { encoding: 'base64', commitment: 'finalized' }], commitment: 'finalized',
    });
    source = answer.provenance.upstreamId;
    fetchedAt = answer.provenance.fetchedAt;
    const result = answer.value.result as { value?: { owner?: unknown; data?: unknown } | null } | null;
    const account = result?.value;
    if (!account || typeof account.owner !== 'string' || !Array.isArray(account.data)) return unread(source, fetchedAt);
    const [encoded, encoding] = account.data as unknown[];
    if (typeof encoded !== 'string' || encoding !== 'base64' || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return unread(source, fetchedAt);
    const bytes = new Uint8Array(Buffer.from(encoded, 'base64'));

    if (account.owner === TOKEN_PROGRAM) {
      // The original program has no extension area; its mint is exactly 82 bytes and initialised.
      return bytes.length === BASE_MINT_LEN && bytes[45] === 1
        ? { status: 'not_applicable', source, fetchedAt, maxAgeMs: EXTENSIONS_MAX_AGE_MS }
        : unread(source, fetchedAt);
    }
    if (account.owner !== TOKEN_2022_PROGRAM) return unread(source, fetchedAt);
    const parsed = parseToken2022Mint(bytes);
    if (!parsed) return unread(source, fetchedAt);
    const slot = answer.value.slot;
    // Without the slot the fee in effect cannot be chosen between its two scheduled entries.
    if (parsed.transferFee && (slot === null || !Number.isFinite(slot))) return unread(source, fetchedAt);
    return {
      status: 'read', source, fetchedAt, maxAgeMs: EXTENSIONS_MAX_AGE_MS,
      transferFee: parsed.transferFee ? feeInEffect(parsed.transferFee, slot as number) : null,
      permanentDelegate: parsed.permanentDelegate,
      transferHookProgram: parsed.transferHookProgram,
      defaultAccountState: parsed.defaultAccountState,
      otherTypeIds: parsed.otherTypeIds,
    };
  } catch {
    // Deliberate: a failed read is "extensions unread" on the card, never a failed card.
    return unread(source, fetchedAt);
  }
}
