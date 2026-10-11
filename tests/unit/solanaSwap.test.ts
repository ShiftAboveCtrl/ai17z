import { describe, expect, it } from 'vitest';
import { judgeSwapSimulation, messageSha256, signedMatchesApproved, SWAP_PROGRAMS, WRAPPED_SOL, type PinnedSwap } from '@xbam/runtime';
import type { WalletSimulation } from '@xbam/shared/contracts';
import { buildTransaction, keyFor, withSignature, type BuiltInstruction } from '../support/solanaTx';

/**
 * A Solana swap an owner approves. What is pinned: the owner approves one
 * exact message; a fee payer, signer count, program, router, floor or SOL
 * spend outside what a swap needs is refused before anybody is asked; and a
 * signed transaction is sent only if it carries that message.
 */

const WALLET = keyFor(1);
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const [JUPITER, COMPUTE] = [SWAP_PROGRAMS[0]!, SWAP_PROGRAMS[1]!];

const params = {
  kind: 'SOLANA_SWAP' as const,
  network: 'solana' as const,
  inputMint: WRAPPED_SOL,
  outputMint: BONK,
  amountIn: '10000000',
  minOut: '31000000000',
  maxSlippageBps: 100,
  inputDecimals: 9,
  outputDecimals: 5,
  inputSymbol: 'SOL',
  outputSymbol: 'BONK',
};

const route: BuiltInstruction[] = [
  { program: COMPUTE, accounts: [], data: [2, 0, 0, 0, 0] },
  { program: JUPITER, accounts: [WALLET, keyFor(30), keyFor(31)], data: [0xe5, 0x17, 1, 2, 3] },
];

function simulationFor(tx: string, over: Partial<PinnedSwap> = {}, sim: Partial<WalletSimulation> = {}): WalletSimulation {
  const pinned: PinnedSwap = {
    transaction: tx,
    messageSha256: messageSha256(tx),
    lastValidBlockHeight: '300000000',
    router: 'metis',
    quotedOut: '32204701743',
    quotedMinOut: '31882654725',
    simulatedOut: '32190000000',
    simulatedNativeSpent: '12045000',
    ...over,
  };
  return { ok: true, maxFee: '5000', balanceBefore: '50000000', balanceAfter: '37955000', warnings: [], failure: null, pinned, ...sim };
}

describe('a swap the owner is asked about', () => {
  it('passes when it is Jupiter, paid and signed by the wallet, and delivers at least the minimum', () => {
    const tx = buildTransaction({ feePayer: WALLET, instructions: route });
    const judged = judgeSwapSimulation(params, WALLET, simulationFor(tx));
    expect(judged.ok).toBe(true);
    // The route's own instruction cannot be read, and a person is told so.
    expect(judged.warnings.join(' ')).toMatch(/cannot read/);
  });

  it('is refused when a program outside the swap list is called directly', () => {
    const drain = keyFor(66);
    const tx = buildTransaction({ feePayer: WALLET, instructions: [...route, { program: drain, accounts: [WALLET], data: [1] }] });
    const judged = judgeSwapSimulation(params, WALLET, simulationFor(tx));
    expect(judged.ok).toBe(false);
    expect(judged.failure).toContain(drain);
  });

  it('is refused when somebody else pays, or a second signer is needed', () => {
    const other = buildTransaction({ feePayer: keyFor(77), instructions: route });
    expect(judgeSwapSimulation(params, WALLET, simulationFor(other)).failure).toMatch(/fee payer/);
    const two = buildTransaction({ feePayer: WALLET, signers: 2, instructions: route });
    expect(judgeSwapSimulation(params, WALLET, simulationFor(two)).failure).toMatch(/2 signatures/);
  });

  it('is refused below the minimum, whether the route promised less or the simulation delivered less', () => {
    const tx = buildTransaction({ feePayer: WALLET, instructions: route });
    expect(judgeSwapSimulation(params, WALLET, simulationFor(tx, { quotedMinOut: '30999999999' })).failure).toMatch(/promises at least 309999\.99999 BONK/);
    expect(judgeSwapSimulation(params, WALLET, simulationFor(tx, { simulatedOut: '1' })).failure).toMatch(/delivered 0\.00001 BONK/);
  });

  it('is refused when more SOL leaves the wallet than the swap, its fee and rent explain', () => {
    const tx = buildTransaction({ feePayer: WALLET, instructions: route });
    // 0.01 SOL in, 5,000 lamports of fee, 0.01 SOL of rent allowance: anything past 20,005,000 is something else.
    expect(judgeSwapSimulation(params, WALLET, simulationFor(tx, { simulatedNativeSpent: '20005000' })).ok).toBe(true);
    expect(judgeSwapSimulation(params, WALLET, simulationFor(tx, { simulatedNativeSpent: '20005001' })).failure).toMatch(/more than the swap/);
    // Selling a token for SOL, no SOL goes in, so the ceiling is only the fee and rent.
    const selling = { ...params, inputMint: BONK, outputMint: WRAPPED_SOL, minOut: '1' };
    expect(judgeSwapSimulation(selling, WALLET, simulationFor(tx, { simulatedNativeSpent: '12045000' })).failure).toMatch(/more than the swap/);
  });

  it('is refused through another router, with a pinned message that is not the transaction, or with nothing pinned', () => {
    const tx = buildTransaction({ feePayer: WALLET, instructions: route });
    expect(judgeSwapSimulation(params, WALLET, simulationFor(tx, { router: 'okx' })).failure).toMatch(/okx/);
    const other = buildTransaction({ feePayer: WALLET, instructions: route, blockhashSeed: 4 });
    expect(judgeSwapSimulation(params, WALLET, simulationFor(tx, { messageSha256: messageSha256(other) })).failure).toMatch(/not the one whose message/);
    expect(judgeSwapSimulation(params, WALLET, { ...simulationFor(tx), pinned: {} }).failure).toMatch(/did not pin/);
  });

  it('leaves an adapter that already said no as it was', () => {
    const failed: WalletSimulation = { ok: false, maxFee: '5000', balanceBefore: '0', balanceAfter: '0', warnings: [], failure: 'Not enough SOL.', pinned: {} };
    expect(judgeSwapSimulation(params, WALLET, failed)).toEqual(failed);
  });
});

describe('what was signed', () => {
  const tx = buildTransaction({ feePayer: WALLET, instructions: route });
  const pinned = simulationFor(tx).pinned;

  it('is sent only when it carries the approved message under one real signature', () => {
    expect(signedMatchesApproved(withSignature(tx), pinned)).toEqual({ ok: true });
    expect(signedMatchesApproved(tx, pinned)).toMatchObject({ ok: false, why: expect.stringMatching(/no signature/) });
    const swapped = withSignature(buildTransaction({ feePayer: WALLET, instructions: route, blockhashSeed: 5 }));
    expect(signedMatchesApproved(swapped, pinned)).toMatchObject({ ok: false, why: expect.stringMatching(/not the transaction that was approved/) });
    const twice = buildTransaction({ feePayer: WALLET, instructions: route, signatures: [new Uint8Array(64).fill(1), new Uint8Array(64).fill(2)] });
    expect(signedMatchesApproved(twice, pinned)).toMatchObject({ ok: false, why: expect.stringMatching(/2 signatures/) });
    expect(signedMatchesApproved('!!', pinned).ok).toBe(false);
  });
});
