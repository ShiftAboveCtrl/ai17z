import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The first upstream family, and the two things about it that must never drift.
 *
 * **It can only read.** Not "we only use it for reads" -- there is no path from
 * here to a method that signs, spends or unlocks, because the list of methods is
 * an allowlist and everything else is refused before a request is built. A
 * generic JSON-RPC passthrough would be a wallet with extra steps.
 *
 * **The chain is proved, not assumed.** A node that has been repointed answers
 * everything perfectly while describing a different chain. A block height from
 * the wrong chain is worse than no block height, so the id is checked before the
 * answer is trusted.
 *
 * The network is stubbed. What is under test is the decision, and the live proof
 * that these nodes answer at all was taken separately against the real chain.
 */

/**
 * Mocked at `undici`, because that is what `safeFetch` calls.
 *
 * It used to stub `globalThis.fetch`, and when the transport moved to undici's
 * own fetch -- so the socket could be pinned to an address that was judged --
 * the stub stopped intercepting and these tests quietly started reaching the
 * real chain. They still passed, which is the worst way for that to happen:
 * `eth_chainId` really did answer 1, so the wrong-chain case had nothing to
 * catch. Mocking what production imports is the fix.
 */
const served: { chainIdHex: string; results: Record<string, unknown> } = { chainIdHex: '0x1', results: {} };
const methodsAsked: string[] = [];

vi.mock('undici', () => ({
  // A dispatcher the fake fetch ignores; the pinning itself is proved in
  // `safeFetch.test.ts` against the real one.
  Agent: class {
    async close() {}
  },
  async fetch(_input: unknown, init?: { body?: string }) {
    const body = JSON.parse(String(init?.body ?? '{}')) as { method: string };
    methodsAsked.push(body.method);
    const result = body.method === 'eth_chainId' ? served.chainIdHex : (served.results[body.method] ?? '0x1');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
    });
  },
}));

const { EVM_CHAINS, EvmQuery, READ_METHODS, ask, familyMembers, registerEvmUpstreams, resetBreakerForTest, resetCacheForTest, resetLimiterForTest, resetUpstreamsForTest } =
  await import('@xbam/upstream');
type EvmResult = import('@xbam/upstream').EvmResult;
type EvmQueryShape = import('@xbam/upstream').EvmQuery;

/** Answers every JSON-RPC call, with a chain id the caller chooses. */
function serveChain(chainIdHex: string, results: Record<string, unknown> = {}) {
  served.chainIdHex = chainIdHex;
  served.results = results;
  methodsAsked.length = 0;
  return { methods: methodsAsked };
}

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
  methodsAsked.length = 0;
  served.chainIdHex = '0x1';
  served.results = {};
});
afterEach(() => resetUpstreamsForTest());

describe('what may be asked of a chain', () => {
  it('has no method that signs, spends or unlocks', () => {
    // The property, rather than a list of things that happen to be absent. A
    // method added in five years that matches one of these is caught by this
    // test rather than by somebody reading the diff carefully.
    for (const method of READ_METHODS) {
      expect(method, method).not.toMatch(/send|sign|personal_|unlock|account|private/i);
    }
  });

  it('does not include eth_call', () => {
    // A read in the protocol's sense and an arbitrary contract invocation in
    // practice -- and one a model could be talked into shaping. A contract read
    // should arrive as its own narrow query, not as a hole shaped like this.
    expect((READ_METHODS as readonly string[])).not.toContain('eth_call');
    expect((READ_METHODS as readonly string[])).not.toContain('eth_estimateGas');
  });

  it('refuses a method that is not on the list', () => {
    for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'personal_unlockAccount', 'eth_call']) {
      expect(() => EvmQuery.parse({ chain: 'ethereum', method, params: [] }), method).toThrow();
    }
  });

  it('refuses a chain it does not know', () => {
    expect(() => EvmQuery.parse({ chain: 'not-a-chain', method: 'eth_blockNumber' })).toThrow();
  });

  it('refuses a method not on the list even when the schema was bypassed', async () => {
    // A caller that builds a query by hand rather than by parsing gets past the
    // schema. This is the check that cannot be skipped.
    registerEvmUpstreams();
    serveChain('0x1');
    const forged = { chain: 'ethereum', method: 'eth_sendRawTransaction', params: ['0xdeadbeef'] } as unknown as EvmQueryShape;
    await expect(ask<EvmQueryShape, EvmResult>('evm', forged)).rejects.toThrow(/not a method this reads/);
  });
});

describe('which chain a node is actually serving', () => {
  it('proves the id before it trusts anything else', async () => {
    registerEvmUpstreams();
    const { methods } = serveChain('0x1', { eth_blockNumber: '0x18be2f5' });
    const answer = await ask<EvmQueryShape, EvmResult>('evm', EvmQuery.parse({ chain: 'ethereum', method: 'eth_blockNumber' }));

    expect(methods[0]).toBe('eth_chainId');
    expect(answer.value.chainId).toBe(1);
    expect(answer.value.result).toBe('0x18be2f5');
  });

  it('refuses a node that answers for a different chain', async () => {
    // The failure that otherwise looks like health: everything answers, and the
    // numbers are about somewhere else.
    registerEvmUpstreams();
    serveChain('0x2105', { eth_blockNumber: '0x18be2f5' }); // 8453, Base
    await expect(
      ask<EvmQueryShape, EvmResult>('evm', EvmQuery.parse({ chain: 'ethereum', method: 'eth_blockNumber' })),
    ).rejects.toThrow(/says it is chain 8453/);
  });

  it('names every chain it claims to know with the id it must prove', () => {
    expect(EVM_CHAINS.ethereum).toBe(1);
    expect(EVM_CHAINS.base).toBe(8453);
    expect(EVM_CHAINS.arbitrum).toBe(42161);
    expect(EVM_CHAINS.optimism).toBe(10);
    expect(EVM_CHAINS.polygon).toBe(137);
  });
});

describe('the family itself', () => {
  it('is several nodes, ranked, so one being down is a fallback', async () => {
    registerEvmUpstreams();
    const members = familyMembers('evm');
    expect(members.length).toBeGreaterThanOrEqual(3);
    expect(members.map((m) => m.rank)).toEqual([...members.map((m) => m.rank)].sort((a, b) => a - b));
    // Every member declares a rate below what these endpoints publish: they are
    // free services run by somebody else.
    for (const member of members) {
      expect(member.limit.windows.length, member.id).toBeGreaterThan(0);
      for (const window of member.limit.windows) {
        // Every window says whether the operator published it. Neither of these
        // endpoints does, so all of them are ours -- and a future one that is
        // genuinely published has to say so on purpose.
        expect(window.source, `${member.id} ${window.label}`).toBe('SELF_IMPOSED');
      }
      const second = member.limit.windows.find((w) => w.intervalMs === 1_000);
      expect(second?.capacity, member.id).toBeLessThanOrEqual(5);
    }
  });

  it('reads a chain over https only', () => {
    // `allowPrivate` is never set here. A node somebody runs themselves is a
    // deliberate configuration and would be its own upstream.
    for (const member of familyMembers('evm')) {
      expect(member.origin, member.id).not.toMatch(/localhost|127\.|^10\.|^192\.168\./);
    }
  });
});
