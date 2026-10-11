import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { wallets } from '@xbam/database';
import {
  approveIntent,
  base58,
  createWallet,
  draftIntent,
  messageSha256,
  registerWalletAdapter,
  resetWalletAdapterForTest,
  simulateIntent,
  submitIntent,
  SWAP_PROGRAMS,
  SWAP_VALID_MS,
  WRAPPED_SOL,
  type WalletAdapter,
} from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { buildTransaction, keyFor, withSignature } from '../support/solanaTx';

/**
 * A Solana swap through the wallet's whole lifecycle, against the real
 * database: the new kind is accepted by its CHECK, the digest the owner
 * approves covers the exact message, a swap priced over a minute ago is
 * neither approved nor sent, and a signer that returns a different message
 * sends nothing.
 */

installHarness();
afterEach(() => resetWalletAdapterForTest());

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SECRET = new Uint8Array(randomBytes(32));
// The wallet's address, as a real 32-byte key, so the transaction can name it as fee payer.
const WALLET = base58(Uint8Array.from([9, ...SECRET.subarray(1)]));

const swap = {
  kind: 'SOLANA_SWAP',
  network: 'solana',
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

function swapAdapter(options: { signsSomethingElse?: boolean; outBelowMinimum?: boolean } = {}) {
  const calls = { sign: 0, broadcast: 0 };
  const tx = buildTransaction({
    feePayer: WALLET,
    instructions: [
      { program: SWAP_PROGRAMS[1]!, accounts: [], data: [2, 0, 0, 0, 0] },
      { program: SWAP_PROGRAMS[0]!, accounts: [WALLET, keyFor(30)], data: [0xe5, 1] },
    ],
  });
  const adapter: WalletAdapter = {
    id: 'fake-solana',
    version: '0',
    families: ['SOLANA'],
    generateSecret: () => SECRET,
    addressOf: () => WALLET,
    validAddress: (_family, address) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address),
    balances: async () => [],
    networkStatus: async () => ({ reachable: true, height: '1', chainProof: 'solana', detail: 'ok' }),
    recentActivity: async () => [],
    simulate: async () => ({
      ok: true,
      maxFee: '5000',
      balanceBefore: '50000000',
      balanceAfter: '37955000',
      warnings: [],
      failure: null,
      pinned: {
        transaction: tx,
        messageSha256: messageSha256(tx),
        lastValidBlockHeight: '300000000',
        router: 'metis',
        quotedOut: '32204701743',
        quotedMinOut: '31882654725',
        simulatedOut: options.outBelowMinimum ? '100' : '32190000000',
        simulatedNativeSpent: '12045000',
      },
    }),
    sign: async () => {
      calls.sign += 1;
      const signed = options.signsSomethingElse
        ? withSignature(buildTransaction({ feePayer: WALLET, instructions: [{ program: SWAP_PROGRAMS[0]!, accounts: [WALLET, keyFor(99)], data: [1] }] }))
        : withSignature(tx);
      return { txHash: 'sig' + 'x'.repeat(60), raw: signed };
    },
    broadcast: async () => {
      calls.broadcast += 1;
    },
    receipt: async () => 'PENDING',
  };
  return { adapter, calls };
}

async function setUp(options: Parameters<typeof swapAdapter>[0] = {}) {
  const f = await createFixture();
  const { adapter, calls } = swapAdapter(options);
  registerWalletAdapter(adapter);
  await createWallet({ agentId: f.agentId, ownerId: f.ownerId, family: 'SOLANA' });
  const { intent } = await draftIntent({ agentId: f.agentId, ownerId: f.ownerId, params: swap });
  return { f, calls, intent };
}

describe('a swap', () => {
  it('is approved by the digest of its exact message and sent once', async () => {
    const { f, calls, intent } = await setUp();
    expect(intent.kind).toBe('SOLANA_SWAP');
    const simulated = await simulateIntent(intent.id, f.ownerId);
    expect(simulated.status).toBe('AWAITING_APPROVAL');
    await approveIntent(intent.id, f.ownerId, simulated.digest!);
    expect((await submitIntent(intent.id, f.ownerId)).status).toBe('SUBMITTED');
    expect(calls).toEqual({ sign: 1, broadcast: 1 });
  });

  it('that would deliver less than the minimum never reaches approval', async () => {
    const { f, intent } = await setUp({ outBelowMinimum: true });
    const simulated = await simulateIntent(intent.id, f.ownerId);
    expect(simulated.status).toBe('DRAFTED');
    expect(simulated.digest).toBeNull();
    expect(simulated.error).toMatch(/less than the 310000 BONK you set/);
  });

  it('priced more than a minute ago is neither approved nor sent', async () => {
    const { f, calls, intent } = await setUp();
    const simulated = await simulateIntent(intent.id, f.ownerId);
    await approveIntent(intent.id, f.ownerId, simulated.digest!);
    await expect(submitIntent(intent.id, f.ownerId, Date.now() + SWAP_VALID_MS + 1_000)).rejects.toThrow(/expired/);
    expect((await wallets.getIntent(intent.id))!.status).toBe('EXPIRED');
    expect(calls.sign).toBe(0);
  });

  it('signed as something other than what was approved sends nothing', async () => {
    const { f, calls, intent } = await setUp({ signsSomethingElse: true });
    const simulated = await simulateIntent(intent.id, f.ownerId);
    await approveIntent(intent.id, f.ownerId, simulated.digest!);
    const out = await submitIntent(intent.id, f.ownerId);
    expect(out.status).toBe('FAILED');
    expect(out.error).toMatch(/not the transaction that was approved/);
    expect(calls).toEqual({ sign: 1, broadcast: 0 });
  });

  it('into the same token, or with a decimal amount, is not a transaction at all', async () => {
    const { f } = await setUp();
    await expect(draftIntent({ agentId: f.agentId, ownerId: f.ownerId, params: { ...swap, outputMint: WRAPPED_SOL } })).rejects.toThrow(/two different tokens/);
    await expect(draftIntent({ agentId: f.agentId, ownerId: f.ownerId, params: { ...swap, amountIn: '0.01' } })).rejects.toThrow(/whole number/);
    await expect(draftIntent({ agentId: f.agentId, ownerId: f.ownerId, params: { ...swap, network: 'ethereum' } })).rejects.toThrow();
  });
});
