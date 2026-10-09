import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What happened to a transaction somebody is unsure about.
 *
 * The verdicts that matter most are the ones that stop a second send:
 * pending, confirming, replaced and mismatched all say NO, and the only
 * resend ever offered after a missing transaction is one with the same nonce,
 * which cannot execute twice.
 */
const served: { results: Record<string, unknown> } = { results: {} };
const methodsAsked: string[] = [];

vi.mock('undici', () => ({
  Agent: class {
    async close() {}
  },
  async fetch(input: unknown, init?: { body?: string }) {
    const body = JSON.parse(String(init?.body ?? '{}')) as { method: string };
    methodsAsked.push(body.method);
    const host = new URL(String(input)).hostname;
    const result = body.method === 'eth_chainId' ? (host.includes('eth') || host.includes('cloudflare') ? '0x1' : null) : served.results[body.method];
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: result ?? null }), {
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
    });
  },
}));

const { registerEvmUpstreams, resetBreakerForTest, resetCacheForTest, resetLimiterForTest, resetUpstreamsForTest } =
  await import('@xbam/upstream');
const { registerChainCapabilities, judgeReconciliation } = await import('@xbam/runtime');
const { getCapability, resetCapabilitiesForTest } = await import('@xbam/tools');

const SENDER = '0x742d35cc6634c0532925a3b844bc454e4438f44e';
const RECIPIENT = '0x000000000000000000000000000000000000dead';
const HASH = `0x${'ab'.repeat(32)}`;

const mined = (over: Partial<{ from: string; to: string | null; valueWei: string; nonce: number; blockNumber: number | null }> = {}) => ({
  from: SENDER,
  to: RECIPIENT,
  valueWei: '1000',
  nonce: 7,
  blockNumber: 100,
  ...over,
});

describe('the judgement', () => {
  it('calls a deep, successful transaction confirmed, and says not to send it again', () => {
    const r = judgeReconciliation({ transaction: mined(), receipt: { succeeded: true, blockNumber: 100 }, head: 111, senderMinedNonce: null }, undefined, 12);
    expect(r).toMatchObject({ verdict: 'CONFIRMED', mayResend: 'NO', confirmations: 12 });
  });

  it('holds a shallow one at confirming', () => {
    const r = judgeReconciliation({ transaction: mined(), receipt: { succeeded: true, blockNumber: 100 }, head: 102, senderMinedNonce: null }, undefined, 12);
    expect(r).toMatchObject({ verdict: 'CONFIRMING', mayResend: 'NO', confirmations: 3 });
  });

  it('reads a revert as nothing having happened, and a resend as a new decision', () => {
    const r = judgeReconciliation({ transaction: mined(), receipt: { succeeded: false, blockNumber: 100 }, head: 200, senderMinedNonce: null }, undefined, 12);
    expect(r).toMatchObject({ verdict: 'REVERTED', mayResend: 'YES_AS_A_NEW_DECISION' });
  });

  it('never turns a receipt with no status into a failure', () => {
    const r = judgeReconciliation({ transaction: mined(), receipt: { succeeded: null, blockNumber: 100 }, head: 200, senderMinedNonce: null }, undefined, 12);
    expect(r).toMatchObject({ verdict: 'STATUS_UNKNOWN', mayResend: 'NO' });
  });

  it('says to wait for one still in the mempool', () => {
    const r = judgeReconciliation({ transaction: mined({ blockNumber: null }), receipt: null, head: null, senderMinedNonce: null }, undefined, 12);
    expect(r).toMatchObject({ verdict: 'PENDING', mayResend: 'NO' });
  });

  it('refuses to vouch for a hash that is a different transaction', () => {
    const r = judgeReconciliation(
      { transaction: mined({ valueWei: '5' }), receipt: { succeeded: true, blockNumber: 100 }, head: 200, senderMinedNonce: null },
      { to: RECIPIENT.toUpperCase().replace('0X', '0x'), valueWei: '1000' },
      12,
    );
    expect(r.verdict).toBe('MISMATCH');
    expect(r.mayResend).toBe('NO');
    expect(r.findings[0]!.sentence).toMatch(/carrying 5 wei, not 1000/);
  });

  it('treats an address in another case as the same address', () => {
    const r = judgeReconciliation(
      { transaction: mined(), receipt: { succeeded: true, blockNumber: 100 }, head: 200, senderMinedNonce: null },
      { from: SENDER.toUpperCase().replace('0X', '0x') },
      12,
    );
    expect(r.verdict).toBe('CONFIRMED');
  });

  it('offers only a same-nonce resend for a hash nobody has seen', () => {
    const r = judgeReconciliation({ transaction: null, receipt: null, head: null, senderMinedNonce: null }, undefined, 12);
    expect(r).toMatchObject({ verdict: 'NOT_FOUND', mayResend: 'ONLY_WITH_SAME_NONCE' });
    expect(r.findings[0]!.sentence).toMatch(/not proof it never happened/);
  });

  it('tells a used nonce from a free one', () => {
    const used = judgeReconciliation({ transaction: null, receipt: null, head: null, senderMinedNonce: 8 }, { from: SENDER, nonce: 7 }, 12);
    expect(used).toMatchObject({ verdict: 'REPLACED', mayResend: 'NO' });
    const free = judgeReconciliation({ transaction: null, receipt: null, head: null, senderMinedNonce: 7 }, { from: SENDER, nonce: 7 }, 12);
    expect(free).toMatchObject({ verdict: 'NOT_FOUND', mayResend: 'ONLY_WITH_SAME_NONCE' });
    expect(free.findings[0]!.code).toBe('NONCE_FREE');
  });
});

function context() {
  return {
    agentId: 'agent-1',
    jobId: null,
    accountId: null,
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {}, child: () => context().logger } as never,
    signal: new AbortController().signal,
  };
}

async function reconcile(input: unknown) {
  const capability = getCapability('transaction.reconcile');
  if (!capability) throw new Error('transaction.reconcile is not registered');
  return capability.run(capability.input.parse(input) as never, context()) as Promise<Record<string, unknown>>;
}

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
  resetCapabilitiesForTest();
  registerEvmUpstreams();
  registerChainCapabilities();
  methodsAsked.length = 0;
  served.results = {};
});
afterEach(() => {
  resetUpstreamsForTest();
  resetCapabilitiesForTest();
});

describe('the capability', () => {
  it('is a read, offered to a model, and sends nothing', () => {
    const capability = getCapability('transaction.reconcile')!;
    expect(capability.effect).toBe('READ');
    expect(capability.modelCallable).toBe(true);
    expect(`${capability.name} ${capability.description}`).not.toMatch(/eth_[a-z]/i);
  });

  it('reads the transaction, its receipt and the head, and answers from them', async () => {
    served.results = {
      eth_getTransactionByHash: { from: SENDER, to: RECIPIENT, value: '0x3e8', nonce: '0x7', blockNumber: '0x64' },
      eth_getTransactionReceipt: { status: '0x1', blockNumber: '0x64' },
      eth_blockNumber: '0x6f',
    };
    const answer = await reconcile({ chain: 'ethereum', hash: HASH, expect: { to: RECIPIENT, valueWei: '1000' } });
    expect(answer).toMatchObject({ verdict: 'CONFIRMED', mayResend: 'NO', confirmations: 12, blockNumber: 100, observed: { nonce: 7, valueWei: '1000' } });
    expect((answer.sources as { read: string }[]).map((s) => s.read)).toEqual(['transaction', 'receipt', 'head']);
    expect(methodsAsked).not.toContain('eth_getTransactionCount');
  });

  it("asks for the sender's nonce only when it decides between missing and replaced", async () => {
    served.results = { eth_getTransactionByHash: null, eth_getTransactionCount: '0x9' };
    const answer = await reconcile({ chain: 'ethereum', hash: HASH, expect: { from: SENDER, nonce: 7 } });
    expect(answer).toMatchObject({ verdict: 'REPLACED', mayResend: 'NO', observed: null });
    expect(methodsAsked).toContain('eth_getTransactionCount');
  });

  it('refuses a hash that is not one before asking anything', async () => {
    await expect(reconcile({ chain: 'ethereum', hash: '0x1234' })).rejects.toThrow(/transaction hash/);
    expect(methodsAsked.filter((m) => m !== 'eth_chainId')).toEqual([]);
  });
});
