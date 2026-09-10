import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What an agent may ask about a chain, and what it must never learn.
 *
 * The capability names are the product's vocabulary and the upstreams are an
 * implementation detail. A model that knew `eth_getBalance`, or worse
 * `publicnode.eth_getBalance`, would be a model whose knowledge went stale the
 * day an endpoint was replaced -- and a catalogue like that is a vendor list
 * somebody has to maintain in the prompt.
 *
 * Mocked at `undici`, because that is what `safeFetch` calls.
 */
const served: { results: Record<string, unknown> } = { results: {} };
const methodsAsked: string[] = [];

/**
 * Which chain each host serves, so the mock answers `eth_chainId` honestly.
 *
 * A mock that answered 1 for everything made every non-Ethereum family refuse
 * itself -- correctly, which is the guard working, and uselessly, because the
 * test then proved only that the guard exists.
 */
const CHAIN_ID_BY_HOST: Record<string, string> = {
  'ethereum-rpc.publicnode.com': '0x1',
  'eth.drpc.org': '0x1',
  'cloudflare-eth.com': '0x1',
  'base-rpc.publicnode.com': '0x2105',
  'mainnet.base.org': '0x2105',
  'base.drpc.org': '0x2105',
  'arbitrum-one-rpc.publicnode.com': '0xa4b1',
  'arb1.arbitrum.io': '0xa4b1',
  'arbitrum.drpc.org': '0xa4b1',
  'optimism-rpc.publicnode.com': '0xa',
  'mainnet.optimism.io': '0xa',
  'optimism.drpc.org': '0xa',
  'polygon-bor-rpc.publicnode.com': '0x89',
  'bsc-rpc.publicnode.com': '0x38',
  'avalanche-c-chain-rpc.publicnode.com': '0xa86a',
};

vi.mock('undici', () => ({
  Agent: class {
    async close() {}
  },
  async fetch(input: unknown, init?: { body?: string }) {
    const body = JSON.parse(String(init?.body ?? '{}')) as { method: string };
    methodsAsked.push(body.method);
    const host = new URL(String(input)).hostname;
    const result = body.method === 'eth_chainId' ? CHAIN_ID_BY_HOST[host] : served.results[body.method];
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: result ?? null }), {
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
    });
  },
}));

const { registerEvmUpstreams, resetBreakerForTest, resetCacheForTest, resetLimiterForTest, resetUpstreamsForTest } =
  await import('@xbam/upstream');
const { registerChainCapabilities } = await import('@xbam/runtime');
const { getCapability, listCapabilities, resetCapabilitiesForTest } = await import('@xbam/tools');

const ANYONE = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';

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

/** Runs a capability the way the loop does: parse the input, then run it. */
async function invoke(id: string, input: unknown) {
  const capability = getCapability(id);
  if (!capability) throw new Error(`${id} is not registered`);
  const parsed = capability.input.parse(input);
  return capability.run(parsed as never, context());
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

describe('the vocabulary a model is given', () => {
  it('names what it answers, never how or from whom', () => {
    const chain = listCapabilities().filter((capability) => capability.id.startsWith('chain.'));
    expect(chain.length).toBeGreaterThan(0);

    for (const capability of chain) {
      const surface = `${capability.id} ${capability.name} ${capability.description}`;
      // No JSON-RPC method names, and no vendor names. An upstream can be
      // replaced tomorrow; nothing a model knows should change when it is.
      expect(surface, capability.id).not.toMatch(/eth_[a-z]/i);
      expect(surface, capability.id).not.toMatch(/publicnode|drpc|cloudflare|llamarpc|ankr|infura|alchemy/i);
      expect(surface, capability.id).not.toMatch(/json-?rpc/i);
    }
  });

  it('offers nothing that sends, signs or approves', () => {
    for (const capability of listCapabilities()) {
      if (!capability.id.startsWith('chain.')) continue;
      expect(capability.id, capability.id).not.toMatch(/send|sign|approve|transfer|swap|unlock|write/i);
      // Every one of them is a read, declared as one.
      expect(capability.effect, capability.id).toBe('READ');
    }
  });

  it('has no contract-call capability yet, because that needs a typed one', () => {
    // `eth_call` is a read in the protocol's sense and an arbitrary contract
    // invocation in practice. These arrive when there is a bounded typed view,
    // not by opening a hole and promising to be careful.
    for (const id of ['chain.read_token', 'chain.read_supply', 'chain.read_allowance', 'chain.call']) {
      expect(getCapability(id), id).toBeNull();
    }
  });
});

describe('reading a chain', () => {
  it('reports a balance as a decimal string, with where it came from', async () => {
    // 1 ETH. A balance does not fit in a double, so it never becomes one.
    served.results.eth_getBalance = '0x0de0b6b3a7640000';
    const answer = (await invoke('chain.read_balance', { chain: 'ethereum', address: ANYONE })) as {
      wei: string;
      chainId: number;
      provenance: { source: string; host: string; readAt: string };
    };

    expect(answer.wei).toBe('1000000000000000000');
    expect(answer.chainId).toBe(1);
    expect(answer.provenance.source).toBe('evm_ethereum.publicnode');
    expect(answer.provenance.host).toBe('ethereum-rpc.publicnode.com');
    expect(Date.parse(answer.provenance.readAt)).not.toBeNaN();
  });

  it('refuses something that is not an address rather than asking about zero', async () => {
    for (const address of ['0x123', 'not-an-address', '', ANYONE.slice(0, -1)]) {
      await expect(invoke('chain.read_balance', { chain: 'ethereum', address })).rejects.toThrow();
    }
  });

  it('refuses a chain it has no sources for', async () => {
    await expect(invoke('chain.read_balance', { chain: 'dogecoin', address: ANYONE })).rejects.toThrow();
  });

  it('tells a contract from a wallet', async () => {
    served.results.eth_getCode = '0x60806040';
    const contract = (await invoke('chain.read_code', { chain: 'base', address: ANYONE })) as {
      isContract: boolean;
      codeBytes: number;
    };
    expect(contract.isContract).toBe(true);
    expect(contract.codeBytes).toBe(4);

    // A different address, because the same question inside the freshness
    // window is answered from the cache -- which is the cache working, and
    // would make this assert nothing.
    served.results.eth_getCode = '0x';
    const other = '0x1111111111111111111111111111111111111111';
    const wallet = (await invoke('chain.read_code', { chain: 'base', address: other })) as { isContract: boolean };
    expect(wallet.isContract).toBe(false);
  });

  it('says a transaction is pending rather than pretending it is mined', async () => {
    served.results.eth_getTransactionByHash = { from: ANYONE, to: ANYONE, value: '0x0', blockNumber: null };
    const answer = (await invoke('chain.read_transaction', { chain: 'ethereum', hash: `0x${'a'.repeat(64)}` })) as {
      found: boolean;
      pending: boolean;
    };
    expect(answer.found).toBe(true);
    expect(answer.pending).toBe(true);
  });

  it('says it could not find one rather than inventing an answer', async () => {
    served.results.eth_getTransactionByHash = null;
    const answer = (await invoke('chain.read_transaction', { chain: 'ethereum', hash: `0x${'b'.repeat(64)}` })) as {
      found: boolean;
      from: string | null;
    };
    expect(answer.found).toBe(false);
    expect(answer.from).toBeNull();
  });

  it('leaves a pre-Byzantium receipt unknown rather than calling it failed', async () => {
    // "Unknown" and "reverted" are different answers, and one of them would be
    // a lie about somebody's transaction.
    served.results.eth_getTransactionReceipt = { gasUsed: '0x5208', blockNumber: '0x10', logs: [] };
    const answer = (await invoke('chain.read_receipt', { chain: 'ethereum', hash: `0x${'c'.repeat(64)}` })) as {
      succeeded: boolean | null;
    };
    expect(answer.succeeded).toBeNull();
  });

  it('turns a block into a time', async () => {
    served.results.eth_getBlockByNumber = { number: '0x10', timestamp: '0x66e00000', transactions: ['0x1', '0x2'] };
    const answer = (await invoke('chain.read_block', { chain: 'optimism', block: 16 })) as {
      number: number;
      minedAt: string;
      transactionCount: number;
    };
    expect(answer.number).toBe(16);
    expect(answer.transactionCount).toBe(2);
    expect(Date.parse(answer.minedAt)).not.toBeNaN();
  });
});

describe('bounds on what one question may ask for', () => {
  it('refuses a log range wider than a public node would answer', async () => {
    await expect(
      invoke('chain.read_logs', { chain: 'ethereum', address: ANYONE, fromBlock: 0, toBlock: 5_000 }),
    ).rejects.toThrow(/at most/);
  });

  it('refuses a range that ends before it starts', async () => {
    await expect(
      invoke('chain.read_logs', { chain: 'ethereum', address: ANYONE, fromBlock: 100, toBlock: 50 }),
    ).rejects.toThrow(/end at or after/);
  });

  it('says when it truncated, rather than implying it returned everything', async () => {
    // A model told it has every event will reason as though it does.
    served.results.eth_getLogs = Array.from({ length: 250 }, (_, i) => ({
      blockNumber: `0x${i.toString(16)}`,
      transactionHash: `0x${'d'.repeat(64)}`,
      topics: [],
    }));
    const answer = (await invoke('chain.read_logs', {
      chain: 'ethereum',
      address: ANYONE,
      fromBlock: 0,
      toBlock: 100,
    })) as { count: number; events: unknown[]; truncated: boolean };

    expect(answer.count).toBe(250);
    expect(answer.events).toHaveLength(200);
    expect(answer.truncated).toBe(true);
  });
});

describe('saying what can be read', () => {
  it('reports every chain and the sources behind it', async () => {
    const answer = (await invoke('chain.health', {})) as {
      chains: { chain: string; chainId: number; readable: boolean; sources: { name: string }[] }[];
    };
    expect(answer.chains.length).toBeGreaterThanOrEqual(7);
    for (const chain of answer.chains) {
      expect(chain.sources.length, chain.chain).toBeGreaterThan(0);
      expect(chain.readable, chain.chain).toBe(true);
    }
  });

  it('says a chain cannot be read when nothing is registered', async () => {
    resetUpstreamsForTest();
    const answer = (await invoke('chain.health', { chain: 'ethereum' })) as {
      chains: { readable: boolean; sources: unknown[] }[];
    };
    expect(answer.chains[0]!.readable).toBe(false);
    expect(answer.chains[0]!.sources).toHaveLength(0);
  });
});
