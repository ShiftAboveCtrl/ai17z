import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { query, wallets } from '@xbam/database';
import {
  approveIntent,
  createWallet,
  draftIntent,
  loadWalletAdapter,
  reconcileIntent,
  registerWalletAdapter,
  registerWalletCapabilities,
  resetWalletAdapterForTest,
  simulateIntent,
  submitIntent,
  walletReadiness,
  type WalletAdapter,
} from '@xbam/runtime';
import { invokeCapability } from '@xbam/tools';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

beforeAll(() => {
  try {
    registerWalletCapabilities();
  } catch {
    // Already registered by another file in this process.
  }
});

afterEach(() => resetWalletAdapterForTest());

const RECIPIENT = '0x' + 'ab'.repeat(20);

/** An adapter that records what it was asked, and whose network can be told to fail. */
function fakeAdapter(options: { broadcastFails?: boolean; signFails?: boolean; receipt?: 'CONFIRMED' | 'FAILED' | 'PENDING' | 'NOT_FOUND' } = {}) {
  const calls = { sign: 0, broadcast: 0, secrets: [] as string[] };
  const adapter: WalletAdapter = {
    id: 'fake',
    version: '0',
    families: ['EVM', 'SOLANA'],
    generateSecret: () => new Uint8Array(randomBytes(32)),
    addressOf: (family, secret) => (family === 'EVM' ? '0x' + Buffer.from(secret).toString('hex').slice(0, 40) : 'So1' + 'a'.repeat(40)),
    validAddress: (family, address) => (family === 'EVM' ? /^0x[0-9a-fA-F]{40}$/.test(address) : address.length >= 32),
    balances: async () => [{ symbol: 'ETH', amount: '1500000000000000000', decimals: 18, token: null }],
    networkStatus: async () => ({ reachable: true, height: '100', chainProof: '0x1', detail: 'ok' }),
    recentActivity: async () => [],
    simulate: async (_n, _from, intent) => ({
      ok: true,
      maxFee: '21000000000000',
      balanceBefore: '1500000000000000000',
      balanceAfter: (1500000000000000000n - BigInt(intent.amount) - 21000000000000n).toString(),
      warnings: [],
      failure: null,
      pinned: { nonce: 7, maxFeePerGas: '1000000000', gasLimit: 21000 },
    }),
    sign: async (_n, secret) => {
      calls.sign += 1;
      calls.secrets.push(Buffer.from(secret).toString('hex'));
      if (options.signFails) throw new Error('no');
      return { txHash: '0x' + 'cd'.repeat(32), raw: '0x02f8' };
    },
    broadcast: async () => {
      calls.broadcast += 1;
      if (options.broadcastFails) throw new Error('connection reset');
    },
    receipt: async () => options.receipt ?? 'PENDING',
  };
  return { adapter, calls };
}

async function approved(agentId: string, ownerId: string) {
  const { intent } = await draftIntent({ agentId, ownerId, params: { kind: 'NATIVE_TRANSFER', network: 'ethereum', to: RECIPIENT, amount: '1000000000000000' } });
  const simulated = await simulateIntent(intent.id, ownerId);
  expect(simulated.status).toBe('AWAITING_APPROVAL');
  return approveIntent(intent.id, ownerId, simulated.digest!);
}

describe('a wallet', () => {
  it('is sealed at once, and its secret is in no row, route shape or audit', async () => {
    const f = await createFixture();
    const { adapter, calls } = fakeAdapter();
    registerWalletAdapter(adapter);
    const wallet = await createWallet({ agentId: f.agentId, ownerId: f.ownerId, family: 'EVM' });
    expect(Object.keys(wallet)).not.toContain('sealedSecret');
    expect(await createWallet({ agentId: f.agentId, ownerId: f.ownerId, family: 'EVM' })).toMatchObject({ id: wallet.id });

    await approved(f.agentId, f.ownerId).then((i) => submitIntent(i.id, f.ownerId));
    const secretHex = calls.secrets[0]!;
    const [row] = await query<{ sealed_secret: string }>(`SELECT sealed_secret FROM agent_wallets WHERE id = $1`, [wallet.id]);
    expect(row!.sealed_secret).not.toContain(secretHex);
    expect(row!.sealed_secret).not.toContain(Buffer.from(secretHex, 'hex').toString('base64'));
    const everywhere = await query<{ t: string }>(`SELECT data::text AS t FROM audit_events UNION ALL SELECT params::text FROM wallet_intents`);
    for (const r of everywhere) expect(r.t).not.toContain(secretHex);
  });

  it('says why when no adapter is installed, and refuses to make one', async () => {
    const f = await createFixture();
    expect(walletReadiness().ready).toBe(false);
    await expect(createWallet({ agentId: f.agentId, ownerId: f.ownerId, family: 'EVM' })).rejects.toThrow(/No wallet adapter/);
  });

  it('only its owner can create, draft, approve or send', async () => {
    const mine = await createFixture();
    const theirs = await createFixture();
    registerWalletAdapter(fakeAdapter().adapter);
    await createWallet({ agentId: mine.agentId, ownerId: mine.ownerId, family: 'EVM' });
    await expect(createWallet({ agentId: mine.agentId, ownerId: theirs.ownerId, family: 'EVM' })).rejects.toThrow(/not found/i);
    const intent = await approved(mine.agentId, mine.ownerId);
    await expect(submitIntent(intent.id, theirs.ownerId)).rejects.toThrow(/not found/i);
    await expect(draftIntent({ agentId: mine.agentId, ownerId: theirs.ownerId, params: {} })).rejects.toThrow(/not found/i);
  });
});

describe('a transaction', () => {
  it('is typed: no calldata, no unknown kind, no bad address, not to itself', async () => {
    const f = await createFixture();
    registerWalletAdapter(fakeAdapter().adapter);
    const wallet = await createWallet({ agentId: f.agentId, ownerId: f.ownerId, family: 'EVM' });
    const base = { kind: 'NATIVE_TRANSFER', network: 'ethereum', to: RECIPIENT, amount: '1' };
    for (const params of [
      { ...base, data: '0xa9059cbb' },
      { ...base, kind: 'APPROVE' },
      { ...base, kind: 'SIGN_MESSAGE' },
      { ...base, to: '0x123' },
      { ...base, to: wallet.address },
      { ...base, amount: '0' },
      { ...base, amount: '1.5' },
      { ...base, network: 'polygon' },
    ]) {
      await expect(draftIntent({ agentId: f.agentId, ownerId: f.ownerId, params }), JSON.stringify(params)).rejects.toThrow();
    }
  });

  it('is approved only by the digest of what would be signed, and sent exactly once', async () => {
    const f = await createFixture();
    const { adapter, calls } = fakeAdapter({ receipt: 'CONFIRMED' });
    registerWalletAdapter(adapter);
    await createWallet({ agentId: f.agentId, ownerId: f.ownerId, family: 'EVM' });
    const { intent } = await draftIntent({ agentId: f.agentId, ownerId: f.ownerId, params: { kind: 'NATIVE_TRANSFER', network: 'ethereum', to: RECIPIENT, amount: '5' }, idempotencyKey: 'owner-click-0001' });
    const again = await draftIntent({ agentId: f.agentId, ownerId: f.ownerId, params: { kind: 'NATIVE_TRANSFER', network: 'ethereum', to: RECIPIENT, amount: '5' }, idempotencyKey: 'owner-click-0001' });
    expect(again).toMatchObject({ created: false, intent: { id: intent.id } });

    await expect(submitIntent(intent.id, f.ownerId)).rejects.toThrow(/approved/);
    const sim = await simulateIntent(intent.id, f.ownerId);
    await expect(approveIntent(intent.id, f.ownerId, 'f'.repeat(64))).rejects.toThrow(/not the transaction/);
    await approveIntent(intent.id, f.ownerId, sim.digest!);

    const results = await Promise.allSettled([submitIntent(intent.id, f.ownerId), submitIntent(intent.id, f.ownerId), submitIntent(intent.id, f.ownerId)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(calls.sign).toBe(1);
    expect(calls.broadcast).toBe(1);
    const done = (await wallets.getIntent(intent.id))!;
    expect(done).toMatchObject({ status: 'SUBMITTED', txHash: '0x' + 'cd'.repeat(32), approvedBy: f.ownerId });
    await expect(submitIntent(intent.id, f.ownerId)).rejects.toThrow();
    expect((await reconcileIntent(intent.id, f.ownerId)).status).toBe('CONFIRMED');
  });

  it('a broadcast that may or may not have landed is UNKNOWN and is never sent again', async () => {
    const f = await createFixture();
    const { adapter, calls } = fakeAdapter({ broadcastFails: true });
    registerWalletAdapter(adapter);
    await createWallet({ agentId: f.agentId, ownerId: f.ownerId, family: 'EVM' });
    const intent = await approved(f.agentId, f.ownerId);
    const out = await submitIntent(intent.id, f.ownerId);
    expect(out).toMatchObject({ status: 'UNKNOWN', txHash: '0x' + 'cd'.repeat(32) });
    await expect(submitIntent(intent.id, f.ownerId)).rejects.toThrow();
    await expect(simulateIntent(intent.id, f.ownerId)).rejects.toThrow();
    expect(calls.sign).toBe(1);
    expect(calls.broadcast).toBe(1);
    expect((await reconcileIntent(intent.id, f.ownerId)).status).toBe('UNKNOWN');
  });

  it('a signature that failed sent nothing, and an approval expires', async () => {
    const f = await createFixture();
    registerWalletAdapter(fakeAdapter({ signFails: true }).adapter);
    await createWallet({ agentId: f.agentId, ownerId: f.ownerId, family: 'EVM' });
    const failing = await approved(f.agentId, f.ownerId);
    expect((await submitIntent(failing.id, f.ownerId)).status).toBe('FAILED');

    const { adapter, calls } = fakeAdapter();
    registerWalletAdapter(adapter);
    const late = await approved(f.agentId, f.ownerId);
    await expect(submitIntent(late.id, f.ownerId, Date.now() + 11 * 60_000)).rejects.toThrow(/expired/);
    expect((await wallets.getIntent(late.id))!.status).toBe('EXPIRED');
    expect(calls.sign).toBe(0);
  });
});

describe('what an agent can see of it', () => {
  it('four reads, off until enabled, owner only, and never a way to send', async () => {
    const f = await createFixture();
    registerWalletAdapter(fakeAdapter().adapter);
    await createWallet({ agentId: f.agentId, ownerId: f.ownerId, family: 'EVM' });
    const base = { agentId: f.agentId, jobId: null, accountId: null, config: {}, logger: console as never };
    const off = await invokeCapability({ call: { id: 'wallet.balances', input: { network: 'ethereum' } }, context: { ...base, audience: 'OWNER' }, permission: { stored: null, paused: false } });
    expect(off.outcome).not.toBe('SUCCEEDED');
    const publicCall = await invokeCapability({ call: { id: 'wallet.balances', input: { network: 'ethereum' } }, context: base, permission: { stored: 'ALLOWED', paused: false } });
    expect(publicCall.outcome).toBe('REFUSED');
    const on = await invokeCapability({ call: { id: 'wallet.balances', input: { network: 'ethereum' } }, context: { ...base, audience: 'OWNER' }, permission: { stored: 'ALLOWED', paused: false } });
    expect(on.outcome).toBe('SUCCEEDED');
    expect((on.output as { balances: { readable: string }[] }).balances[0]!.readable).toBe('1.5 ETH');
  });
});

describe('loading the adapter', () => {
  it('refuses a file without a pinned hash, or whose hash does not match', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wallet-adapter-'));
    const file = join(dir, 'adapter.mjs');
    writeFileSync(file, 'export const walletAdapter = { id: "x" };\n');
    await loadWalletAdapter({ AI17Z_WALLET_ADAPTER: file });
    expect(walletReadiness()).toMatchObject({ ready: false, detail: expect.stringMatching(/without AI17Z_WALLET_ADAPTER_SHA256/) });
    await loadWalletAdapter({ AI17Z_WALLET_ADAPTER: file, AI17Z_WALLET_ADAPTER_SHA256: '0'.repeat(64) });
    expect(walletReadiness().detail).toMatch(/does not match/);
    const sha = createHash('sha256').update('export const walletAdapter = { id: "x" };\n').digest('hex');
    await loadWalletAdapter({ AI17Z_WALLET_ADAPTER: file, AI17Z_WALLET_ADAPTER_SHA256: sha });
    expect(walletReadiness().detail).toMatch(/does not export a wallet adapter/);
  });
});
