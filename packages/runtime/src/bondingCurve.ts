import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { SOLANA_FAMILY, ask, base58Bytes, isAddress, type SolanaQuery, type SolanaResult } from '@xbam/upstream';
import { renderCurveLines, type CurveReading } from '@xbam/prompts';
import type { MarketSnapshot } from '@xbam/shared/contracts';

/**
 * Where a Pump.fun token stands on its bonding curve, read from the chain.
 *
 * ### Where every constant here comes from
 *
 * The program ids, the PDA seeds and the account layout are the ones Pump
 * publishes in its public IDLs (`pump-fun/pump-public-docs`, `idl/pump.json` and
 * `idl/pump_amm.json`), read in November 2026, and the derivation was checked
 * against a live curve: DexScreener's pair address for a Pump token is that
 * token's curve account, and `findProgramAddress` reproduces it byte for byte.
 * The launch parameters (a billion tokens, 793.1 million of them sold along the
 * curve, 1.073 billion and 30 SOL as the virtual starting reserves) are the
 * `Global` account's values as Pump documents them.
 *
 * ### Progress is tokens sold, because that is what the launchpad shows
 *
 * A curve completes when its real token reserves reach zero, so the share of the
 * 793.1 million already sold is the measure Pump's own page uses. It is not the
 * share of SOL collected: the price rises along the curve, so a curve that is
 * half sold holds about a fifth of the SOL it will. Both numbers are reported,
 * and neither is rounded up, in integer arithmetic throughout.
 *
 * ### What this refuses to say
 *
 * Absent is never zero. An address with no curve account, an account owned by
 * some other program, a layout too short to be one, and a read that failed are
 * four different things and none of them is "0%". A curve whose total supply is
 * not the one Pump documents is reported with no percentage, because the
 * percentage would be measured against the wrong launch.
 */

export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
const CURVE_DISCRIMINATOR = Uint8Array.from([23, 183, 248, 55, 96, 216, 172, 96]);

/** Pump's documented launch configuration, in base units (6 decimal tokens, lamports). */
export const PUMP_INITIAL_VIRTUAL_TOKEN = 1_073_000_000_000_000n;
export const PUMP_INITIAL_VIRTUAL_QUOTE = 30_000_000_000n;
export const PUMP_INITIAL_REAL_TOKEN = 793_100_000_000_000n;
export const PUMP_TOKEN_TOTAL_SUPPLY = 1_000_000_000_000_000n;
/**
 * The SOL a curve holds when every real token is sold: the constant product
 * `k` divided by the virtual tokens left, less the virtual SOL it started with.
 * Rounded up, so the target is never understated.
 */
export const PUMP_TARGET_LAMPORTS = (() => {
  const k = PUMP_INITIAL_VIRTUAL_TOKEN * PUMP_INITIAL_VIRTUAL_QUOTE;
  const virtualTokenLeft = PUMP_INITIAL_VIRTUAL_TOKEN - PUMP_INITIAL_REAL_TOKEN;
  return (k + virtualTokenLeft - 1n) / virtualTokenLeft - PUMP_INITIAL_VIRTUAL_QUOTE;
})();

/** The stable prefix every curve account has: discriminator, five u64s and `complete`. */
const PREFIX_BYTES = 8 + 5 * 8 + 1;
const CREATOR_END = PREFIX_BYTES + 32;
/** `is_mayhem_mode` and `is_cashback_coin` sit between the creator and the quote mint. */
const QUOTE_MINT_START = CREATOR_END + 2;
const QUOTE_MINT_END = QUOTE_MINT_START + 32;

// ── Addresses ────────────────────────────────────────────────────────────────

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) leading += 1;
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = BASE58[Number(value % 58n)]! + out;
    value /= 58n;
  }
  return '1'.repeat(leading) + out;
}

function onCurve(candidate: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(candidate);
    return true;
  } catch {
    // Deliberate: a hash that does not decompress to a point is exactly what a
    // program derived address is, so the throw is the answer, not a fault.
    return false;
  }
}

/** Solana's `findProgramAddress`: the first bump, counting down from 255, that lands off the curve. */
export function findProgramAddress(seeds: readonly Uint8Array[], programId: string): { address: string; bump: number } | null {
  const program = base58Bytes(programId);
  if (!program || program.length !== 32) return null;
  const suffix = new TextEncoder().encode('ProgramDerivedAddress');
  for (let bump = 255; bump >= 0; bump -= 1) {
    const parts = [...seeds, Uint8Array.of(bump), program, suffix];
    const joined = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for (const part of parts) { joined.set(part, at); at += part.length; }
    const hash = sha256(joined);
    if (!onCurve(hash)) return { address: base58Encode(hash), bump };
  }
  return null;
}

const ascii = (text: string) => new TextEncoder().encode(text);

/** The account Pump keeps a mint's curve in. Null for something that is not a 32 byte address. */
export function bondingCurveAddress(mint: string): string | null {
  const bytes = base58Bytes(mint);
  if (!bytes || bytes.length !== 32) return null;
  return findProgramAddress([ascii('bonding-curve'), bytes], PUMP_PROGRAM_ID)?.address ?? null;
}

/** The pool Pump's `migrate` instruction creates for a completed curve: canonical index 0, quoted in wrapped SOL. */
export function canonicalPumpPoolAddress(mint: string): string | null {
  const base = base58Bytes(mint);
  const wsol = base58Bytes(WRAPPED_SOL_MINT);
  if (!base || base.length !== 32 || !wsol) return null;
  const authority = findProgramAddress([ascii('pool-authority'), base], PUMP_PROGRAM_ID);
  if (!authority) return null;
  const creator = base58Bytes(authority.address);
  if (!creator) return null;
  return findProgramAddress([ascii('pool'), Uint8Array.of(0, 0), creator, base, wsol], PUMP_AMM_PROGRAM_ID)?.address ?? null;
}

// ── Decoding ─────────────────────────────────────────────────────────────────

export interface DecodedCurve {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  /** Absent on curves written before the field existed. Never defaulted. */
  creator: string | null;
  /**
   * `null` when the account predates the field, which is a SOL curve. A curve
   * quoted in another asset names it, and an all-zero key is how a SOL curve
   * writes it.
   */
  quoteMint: string | null;
}

/** Decodes a curve account, or null when the bytes are not one. Reads only fields the layout can hold. */
export function decodeBondingCurve(data: Uint8Array): DecodedCurve | null {
  if (data.length < PREFIX_BYTES) return null;
  for (let i = 0; i < CURVE_DISCRIMINATOR.length; i += 1) if (data[i] !== CURVE_DISCRIMINATOR[i]) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const flag = data[PREFIX_BYTES - 1]!;
  if (flag > 1) return null;
  const key = (from: number, to: number) => (data.length >= to ? base58Encode(data.subarray(from, to)) : null);
  const mintBytes = data.length >= QUOTE_MINT_END ? data.subarray(QUOTE_MINT_START, QUOTE_MINT_END) : null;
  return {
    virtualTokenReserves: view.getBigUint64(8, true),
    virtualQuoteReserves: view.getBigUint64(16, true),
    realTokenReserves: view.getBigUint64(24, true),
    realQuoteReserves: view.getBigUint64(32, true),
    tokenTotalSupply: view.getBigUint64(40, true),
    complete: flag === 1,
    creator: key(PREFIX_BYTES, CREATOR_END),
    quoteMint: mintBytes ? (mintBytes.every(b => b === 0) ? null : base58Encode(mintBytes)) : null,
  };
}

// ── Progress ─────────────────────────────────────────────────────────────────

export interface CurveProgress {
  /** Basis points of the curve sold, 0 to 10000, or null when it cannot be measured against Pump's launch. */
  progressBps: number | null;
  /** Lamports held by the curve, only when the curve is quoted in SOL. */
  collectedLamports: bigint | null;
  targetLamports: bigint | null;
  /** Why a figure is absent, in a sentence. */
  notes: string[];
}

/** Integer arithmetic, bounded to 0..10000 basis points, rounded down so a curve is never shown as further along than it is. */
export function curveProgress(curve: DecodedCurve): CurveProgress {
  const notes: string[] = [];
  const quoteIsSol = curve.quoteMint === null || curve.quoteMint === WRAPPED_SOL_MINT;
  if (!quoteIsSol) notes.push('This curve is quoted in an asset other than SOL, so no SOL figures are shown.');
  let progressBps: number | null;
  if (curve.complete) {
    progressBps = 10_000;
  } else if (curve.tokenTotalSupply !== PUMP_TOKEN_TOTAL_SUPPLY || curve.realTokenReserves > PUMP_INITIAL_REAL_TOKEN) {
    progressBps = null;
    notes.push('This curve does not match the launch parameters Pump documents, so no percentage is given.');
  } else {
    progressBps = Number(((PUMP_INITIAL_REAL_TOKEN - curve.realTokenReserves) * 10_000n) / PUMP_INITIAL_REAL_TOKEN);
  }
  return {
    progressBps,
    collectedLamports: quoteIsSol ? curve.realQuoteReserves : null,
    targetLamports: quoteIsSol ? PUMP_TARGET_LAMPORTS : null,
    notes,
  };
}

// ── Reading ──────────────────────────────────────────────────────────────────

export type CurveRead =
  | { status: 'NOT_ON_CURVE'; mint: string; curveAddress: string | null; slot: number | null; source: string; fetchedAt: string }
  | {
    status: 'FOUND'; mint: string; curveAddress: string; slot: number | null; source: string; fetchedAt: string;
    curve: DecodedCurve; progress: CurveProgress;
    /** Set only for a completed curve: the Pump pool at the canonical address, if it exists. */
    pool: string | null;
  };

export type AccountReader = (address: string, commitment: SolanaQuery['commitment']) => Promise<{
  exists: boolean; owner: string | null; data: Uint8Array | null; slot: number | null; source: string; fetchedAt: string;
}>;

/** The default reader: `getAccountInfo` as base64 through the allowlisted Solana family. */
export const readAccountBase64: AccountReader = async (address, commitment) => {
  const answer = await ask<SolanaQuery, SolanaResult>(SOLANA_FAMILY, {
    method: 'getAccountInfo', params: [address, { commitment, encoding: 'base64' }], commitment,
  });
  const result = answer.value.result;
  const value = (result && typeof result === 'object' && 'value' in result ? (result as { value: unknown }).value : result) as
    { owner?: unknown; data?: unknown } | null;
  const encoded = Array.isArray(value?.data) && typeof value.data[0] === 'string' ? value.data[0] : null;
  return {
    exists: value !== null && value !== undefined,
    owner: typeof value?.owner === 'string' ? value.owner : null,
    data: encoded === null ? null : new Uint8Array(Buffer.from(encoded, 'base64')),
    slot: answer.value.slot,
    source: answer.provenance.upstreamId,
    fetchedAt: answer.provenance.fetchedAt,
  };
};

/**
 * Reads one mint's Pump curve. Throws when the cluster could not be asked, so
 * the caller reports the read as failed rather than as "not on a curve".
 */
export async function readBondingCurve(
  mint: string,
  options: { commitment?: SolanaQuery['commitment']; read?: AccountReader } = {},
): Promise<CurveRead> {
  const commitment = options.commitment ?? 'finalized';
  const read = options.read ?? readAccountBase64;
  const curveAddress = isAddress(mint) ? bondingCurveAddress(mint) : null;
  const absent = (slot: number | null, source: string, fetchedAt: string): CurveRead =>
    ({ status: 'NOT_ON_CURVE', mint, curveAddress, slot, source, fetchedAt });
  if (!curveAddress) return absent(null, 'solana.read_bonding_curve', new Date().toISOString());

  const account = await read(curveAddress, commitment);
  // Owned by Pump and shaped like its curve, or it is not one: an address that
  // merely holds bytes is not a launch.
  const curve = account.exists && account.owner === PUMP_PROGRAM_ID && account.data ? decodeBondingCurve(account.data) : null;
  if (!curve) return absent(account.slot, account.source, account.fetchedAt);

  const progress = curveProgress(curve);
  let pool: string | null = null;
  if (curve.complete) {
    const candidate = canonicalPumpPoolAddress(mint);
    if (candidate) {
      const found = await read(candidate, commitment).catch(() => null);
      // A pool that cannot be read is "not seen", never a claim that none exists; the caller words it that way.
      if (found?.exists && found.owner === PUMP_AMM_PROGRAM_ID) pool = candidate;
    }
  }
  return { status: 'FOUND', mint, curveAddress, slot: account.slot, source: account.source, fetchedAt: account.fetchedAt, curve, progress, pool };
}

// ── Words ────────────────────────────────────────────────────────────────────

export const NOT_ON_A_CURVE = 'not on a recognized bonding curve';
export const CURVE_SOURCE = 'solana.read_bonding_curve';

/** Basis points as a percentage with one decimal, never rounded up past what was measured. */
export function percentText(bps: number): string {
  const tenths = Math.floor(bps / 10);
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

/** Lamports as SOL with two decimals, cut rather than rounded, trailing zeros dropped. */
export function solText(lamports: bigint): string {
  const hundredths = lamports / 10_000_000n;
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/** What the card carries about a curve, or null when the mint is not on one. */
export function curveReadingOf(read: CurveRead): CurveReading | null {
  if (read.status !== 'FOUND') return null;
  return {
    state: read.curve.complete ? 'GRADUATED' : 'ACTIVE',
    progressBps: read.progress.progressBps,
    collectedLamports: read.progress.collectedLamports === null ? null : read.progress.collectedLamports.toString(),
    targetLamports: read.progress.targetLamports === null ? null : read.progress.targetLamports.toString(),
    pool: read.pool,
    slot: read.slot,
    source: CURVE_SOURCE,
  };
}

/** The sentence a reply may carry, in the fixed template the card uses. */
export function curveStatement(read: CurveRead): string {
  const reading = curveReadingOf(read);
  return reading ? renderCurveLines(reading).join('\n') : NOT_ON_A_CURVE;
}

/**
 * The shape Studio's `/watch` and `/radar` read. Documented here because the
 * endpoint is Studio's: `GET /api/v1/installation/bonding-curve?mint=` returns
 * this, with `null` where a figure was not read. `GRADUATED` means the curve
 * is complete; `migratedPool` is null until its pool is seen at the canonical
 * address.
 */
export interface StudioCurvePayload {
  curveState: 'ACTIVE' | 'GRADUATED';
  progressPct: number | null;
  solReserves: string | null;
  targetSol: string | null;
  migratedPool: string | null;
}

export function studioCurvePayload(read: CurveRead): StudioCurvePayload | null {
  const reading = curveReadingOf(read);
  if (!reading) return null;
  return {
    curveState: reading.state,
    progressPct: reading.progressBps === null ? null : Number(percentText(reading.progressBps)),
    solReserves: reading.collectedLamports,
    targetSol: reading.targetLamports,
    migratedPool: reading.pool,
  };
}

// ── Paper trading ────────────────────────────────────────────────────────────

export interface CurveStatus {
  phase: 'CURVE';
  recognized: boolean;
  /** Names the launchpad whose layout was matched. */
  platform: 'Pump' | null;
  statement: string;
  read: CurveRead | null;
}

/**
 * What a curve-phase quote resolves to. A pool or broker quote is not asked
 * about, and a curve this module does not recognise says so in words rather
 * than being given a number. The paper fill itself is unchanged: price impact
 * on a curve stays unmodelled, and this adds the status beside that fact.
 */
export async function curveStatusForQuote(
  quote: Pick<MarketSnapshot, 'phase' | 'asset' | 'network'>,
  options: { read?: AccountReader } = {},
): Promise<CurveStatus | null> {
  if (quote.phase !== 'CURVE') return null;
  const unrecognised: CurveStatus = { phase: 'CURVE', recognized: false, platform: null, statement: NOT_ON_A_CURVE, read: null };
  if (quote.network !== 'solana' || quote.asset.kind !== 'ONCHAIN') return unrecognised;
  const read = await readBondingCurve(quote.asset.address, { read: options.read });
  if (read.status !== 'FOUND') return { ...unrecognised, read };
  return { phase: 'CURVE', recognized: true, platform: 'Pump', statement: curveStatement(read), read };
}
