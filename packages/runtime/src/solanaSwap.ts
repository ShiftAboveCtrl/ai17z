import { createHash } from 'node:crypto';
import { z } from 'zod';
import { formatUnits, type WalletIntentParams, type WalletSimulation } from '@xbam/shared/contracts';
import { inspectSolanaTransaction } from './solanaInspect';

/**
 * The rules for a Solana swap an owner approves. The chain code is the wallet
 * adapter's; what it reports is judged here, so no adapter can relax it.
 *
 * ## What is approved
 *
 * The adapter asks Jupiter's Swap API V2 router path (`/swap/v2/build`, which
 * routes through Jupiter's own Metis engine only) for the swap's instructions
 * with the wallet as the taker, and composes the transaction itself. The
 * meta-aggregator path (`/order`) was measured and is not used: excluding
 * every other router there leaves no quote at all, and the other routers'
 * programs are not ones this file can vouch for. The adapter simulates the
 * transaction and pins it: the base64 bytes,
 * the SHA-256 of the message inside them, the block height it stops being
 * valid at, the route's promised floor and what the simulation delivered.
 * The digest the owner approves covers all of that, so an approval is for
 * one exact message and cannot be moved to a different transaction.
 *
 * ## What is refused before anybody is asked
 *
 * - A fee payer other than the wallet, or more than one signer.
 * - Any top-level program outside the short list a Jupiter route uses
 *   (`SWAP_PROGRAMS`, read from a live `/swap/v2/build` answer in October
 *   2026). The DEXes themselves are called inside Jupiter's program, which is
 *   what the list allows; a transaction calling anything else directly is a
 *   different transaction.
 * - A route that promises less than the owner's minimum, or a simulation that
 *   delivered less.
 * - SOL leaving the wallet beyond what the swap needs: the amount in, when the
 *   input is SOL, plus the fee and account rent.
 * - A message whose hash is not the one pinned.
 *
 * ## What is checked after signing
 *
 * `signedMatchesApproved` reads the signed bytes back and refuses them unless
 * they carry the approved message under exactly one signature, so an adapter
 * that built something else at signing time is caught before broadcast.
 */

export const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';

/** The top-level programs a Jupiter (Metis) route uses. Measured, not remembered. */
export const SWAP_PROGRAMS: readonly string[] = [
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'ComputeBudget111111111111111111111111111111',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
];

/** The only router a swap an owner approves may use: Jupiter's own, whose programs are listed above. */
export const SWAP_ROUTER = 'metis';

/** Rent for the token accounts a swap may open, and a little room: 0.01 SOL. Generous, and still a bound. */
export const SWAP_RENT_ALLOWANCE_LAMPORTS = 10_000_000n;

const DIGITS = /^[0-9]{1,40}$/;

/** What an adapter must pin for a swap. Strings, because `pinned` holds strings and numbers only. */
export const PinnedSwap = z.object({
  transaction: z.string().min(4).max(8_000).regex(/^[A-Za-z0-9+/=]+$/),
  messageSha256: z.string().regex(/^[0-9a-f]{64}$/),
  lastValidBlockHeight: z.string().regex(DIGITS),
  router: z.string(),
  quotedOut: z.string().regex(DIGITS),
  quotedMinOut: z.string().regex(DIGITS),
  simulatedOut: z.string().regex(DIGITS),
  /** Lamports the wallet's own SOL balance fell by in the simulation, fee and rent included. */
  simulatedNativeSpent: z.string().regex(DIGITS),
});
export type PinnedSwap = z.infer<typeof PinnedSwap>;

type Swap = Extract<WalletIntentParams, { kind: 'SOLANA_SWAP' }>;

function compactU16(bytes: Uint8Array, at: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = at;
  for (;;) {
    if (i >= bytes.length || shift > 14) throw new Error('The transaction ends early.');
    const b = bytes[i++]!;
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, next: i };
    shift += 7;
  }
}

/** The message inside a serialized transaction, and how many signature slots precede it. */
export function solanaMessageOf(base64: string): { message: Uint8Array; signatures: Uint8Array[] } {
  const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
  const { value: count, next } = compactU16(bytes, 0);
  const start = next + count * 64;
  if (count < 1 || start >= bytes.length) throw new Error('That is not a transaction with a message after its signatures.');
  const signatures: Uint8Array[] = [];
  for (let s = 0; s < count; s += 1) signatures.push(bytes.subarray(next + s * 64, next + (s + 1) * 64));
  return { message: bytes.subarray(start), signatures };
}

export function messageSha256(base64: string): string {
  return createHash('sha256').update(solanaMessageOf(base64).message).digest('hex');
}

function refuse(simulation: WalletSimulation, failure: string): WalletSimulation {
  return { ...simulation, ok: false, failure };
}

/**
 * What an adapter's simulation of a swap is allowed to be. Returns the
 * simulation unchanged when it passes, with the inspection's notes added as
 * warnings, or a failed one saying why. Never throws for a bad simulation:
 * a refusal is an answer the owner reads.
 */
export function judgeSwapSimulation(params: Swap, walletAddress: string, simulation: WalletSimulation): WalletSimulation {
  if (!simulation.ok) return simulation;
  const pinned = PinnedSwap.safeParse(simulation.pinned);
  if (!pinned.success) return refuse(simulation, 'The wallet adapter did not pin the transaction it simulated, so there is nothing exact to approve.');
  const p = pinned.data;

  if (p.router !== SWAP_ROUTER) return refuse(simulation, `The route went through ${p.router}, and only Jupiter's own router is approved for swaps here.`);

  let hash: string;
  try {
    hash = messageSha256(p.transaction);
  } catch (error) {
    return refuse(simulation, `The transaction could not be read: ${error instanceof Error ? error.message : 'malformed'}.`);
  }
  if (hash !== p.messageSha256) return refuse(simulation, 'The transaction pinned is not the one whose message was hashed, so it cannot be approved.');

  const inspection = inspectSolanaTransaction({ transaction: p.transaction, expect: { feePayer: walletAddress, programs: [...SWAP_PROGRAMS] } });
  const denied = inspection.findings.filter((f) => f.severity === 'DENY');
  if (denied.length) return refuse(simulation, denied.map((f) => f.sentence).join(' '));
  if (inspection.signaturesRequired !== 1) return refuse(simulation, `It needs ${inspection.signaturesRequired} signatures; a swap from this wallet needs exactly its own.`);

  const minOut = BigInt(params.minOut);
  const out = (v: string) => `${formatUnits(v, params.outputDecimals)} ${params.outputSymbol}`;
  if (BigInt(p.quotedMinOut) < minOut) {
    return refuse(simulation, `The route promises at least ${out(p.quotedMinOut)}, less than the ${out(params.minOut)} you set.`);
  }
  if (BigInt(p.simulatedOut) < minOut) {
    return refuse(simulation, `Simulated, it delivered ${out(p.simulatedOut)}, less than the ${out(params.minOut)} you set.`);
  }
  const nativeIn = params.inputMint === WRAPPED_SOL ? BigInt(params.amountIn) : 0n;
  const nativeCeiling = nativeIn + BigInt(simulation.maxFee) + SWAP_RENT_ALLOWANCE_LAMPORTS;
  if (BigInt(p.simulatedNativeSpent) > nativeCeiling) {
    return refuse(
      simulation,
      `Simulated, it took ${formatUnits(p.simulatedNativeSpent, 9)} SOL from the wallet, more than the swap, its fee and account rent can explain (${formatUnits(nativeCeiling.toString(), 9)} SOL).`,
    );
  }

  // What a person should still read: the inspector cannot follow a route's accounts through lookup tables.
  const notes = inspection.findings.filter((f) => f.severity === 'NEEDS_APPROVAL').map((f) => f.sentence);
  const warnings = [...simulation.warnings, ...new Set(notes)].slice(0, 12);
  return { ...simulation, warnings };
}

/**
 * Whether signed bytes are the approved transaction: the same message, one
 * signature, and that signature present. Checked after signing and before
 * the network sees anything.
 */
export function signedMatchesApproved(rawBase64: string, pinned: unknown): { ok: true } | { ok: false; why: string } {
  const p = PinnedSwap.safeParse(pinned);
  if (!p.success) return { ok: false, why: 'There is no approved transaction to compare the signed one with.' };
  let signed: ReturnType<typeof solanaMessageOf>;
  try {
    signed = solanaMessageOf(rawBase64);
  } catch {
    return { ok: false, why: 'The signed transaction could not be read.' };
  }
  if (signed.signatures.length !== 1) return { ok: false, why: `The signed transaction carries ${signed.signatures.length} signatures, not one.` };
  if (signed.signatures[0]!.every((b) => b === 0)) return { ok: false, why: 'The signed transaction carries no signature.' };
  const hash = createHash('sha256').update(signed.message).digest('hex');
  if (hash !== p.data.messageSha256) return { ok: false, why: 'What was signed is not the transaction that was approved.' };
  return { ok: true };
}
