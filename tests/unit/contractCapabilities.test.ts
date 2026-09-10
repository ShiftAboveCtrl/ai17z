import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What is known about a contract, and the one mistake this family exists to
 * stop an agent making.
 *
 * A proxy's verified source describes the proxy. USDC's is `FiatTokenProxy` --
 * forty lines of delegation -- and an agent that read "verified" and then
 * answered questions about what USDC *does* would be describing the wrong
 * contract with total confidence. Proxy and implementation are separate things
 * here, and the answer says so every time.
 */

let served: { status: number; body: unknown } = { status: 200, body: {} };
const asked: string[] = [];

vi.mock('undici', () => ({
  Agent: class {
    async close() {}
  },
  async fetch(input: unknown) {
    asked.push(String(input));
    return new Response(JSON.stringify(served.body), {
      status: served.status,
      headers: new Headers({ 'content-type': 'application/json' }),
    });
  },
}));

const { registerContractUpstreams, resetBreakerForTest, resetCacheForTest, resetLimiterForTest, resetUpstreamsForTest } =
  await import('@xbam/upstream');
const { registerContractCapabilities } = await import('@xbam/runtime');
const { getCapability, listCapabilities, resetCapabilitiesForTest } = await import('@xbam/tools');

const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

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

async function invoke(id: string, input: unknown) {
  const capability = getCapability(id);
  if (!capability) throw new Error(`${id} is not registered`);
  return capability.run(capability.input.parse(input) as never, context());
}

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
  resetCapabilitiesForTest();
  registerContractUpstreams();
  registerContractCapabilities();
  asked.length = 0;
  served = { status: 200, body: {} };
});
afterEach(() => {
  resetUpstreamsForTest();
  resetCapabilitiesForTest();
});

describe('a contract standing in front of another', () => {
  it('names the implementation and says the source is not about it', async () => {
    served = {
      status: 200,
      body: {
        runtimeMatch: 'match',
        creationMatch: 'match',
        verifiedAt: '2024-08-08T13:20:07Z',
        compilation: { name: 'FiatTokenProxy', compiler: 'solc', compilerVersion: '0.6.12' },
        proxyResolution: {
          isProxy: true,
          proxyType: 'ZeppelinOSProxy',
          implementations: [{ address: '0x43506849D7C04F9138D1A2050bbF3A0c054402dd', name: 'FiatTokenV2_2' }],
        },
      },
    };

    const answer = (await invoke('contract.inspect', { chain: 'ethereum', address: USDC })) as {
      isProxy: boolean;
      proxyType: string;
      implementations: { address: string; name: string }[];
      caution: string | null;
      name: string;
    };

    expect(answer.isProxy).toBe(true);
    expect(answer.proxyType).toBe('ZeppelinOSProxy');
    expect(answer.implementations[0]!.address).toBe('0x43506849D7C04F9138D1A2050bbF3A0c054402dd');
    // The sentence that stops an agent describing the wrong contract.
    expect(answer.caution).toMatch(/proxy/i);
    expect(answer.caution).toContain('0x43506849D7C04F9138D1A2050bbF3A0c054402dd');
    // And the name is the proxy's, not the token's, which is the truth.
    expect(answer.name).toBe('FiatTokenProxy');
  });

  it('says nothing about proxies when it is an ordinary contract', async () => {
    served = {
      status: 200,
      body: {
        runtimeMatch: 'exact_match',
        compilation: { name: 'Dai' },
        proxyResolution: { isProxy: false, implementations: [] },
      },
    };
    const answer = (await invoke('contract.inspect', { chain: 'ethereum', address: DAI })) as {
      isProxy: boolean;
      caution: string | null;
    };
    expect(answer.isProxy).toBe(false);
    expect(answer.caution).toBeNull();
  });
});

describe('how well a contract is verified', () => {
  it('tells an exact match from a behavioural one', async () => {
    // Not a boolean. An exact match is byte-for-byte what produced the deployed
    // code; a plain match agrees on behaviour and differs on build metadata.
    served = { status: 200, body: { runtimeMatch: 'exact_match', creationMatch: 'exact_match' } };
    const exact = (await invoke('contract.verification', { chain: 'ethereum', address: DAI })) as {
      exact: boolean;
      explanation: string;
    };
    expect(exact.exact).toBe(true);
    expect(exact.explanation).toMatch(/byte-for-byte/);

    resetCacheForTest();
    served = { status: 200, body: { runtimeMatch: 'match', creationMatch: null } };
    const loose = (await invoke('contract.verification', { chain: 'base', address: DAI })) as {
      exact: boolean;
      explanation: string;
    };
    expect(loose.exact).toBe(false);
    expect(loose.explanation).toMatch(/metadata differs/);
  });

  it('treats an unverified contract as an answer, not a failure', async () => {
    // Most contracts are unverified. Saying so is the useful thing, and it must
    // not count against the service's health -- looking up ordinary addresses
    // would otherwise cool off a source that is working perfectly.
    served = { status: 404, body: { match: null, creationMatch: null, runtimeMatch: null } };
    const answer = (await invoke('contract.inspect', { chain: 'ethereum', address: DAI })) as {
      verified: boolean;
      verification: string;
      name: string | null;
    };
    expect(answer.verified).toBe(false);
    expect(answer.verification).toBe('Not verified.');
    expect(answer.name).toBeNull();

    const { healthOf } = await import('@xbam/upstream');
    expect(healthOf('contract_ethereum.sourcify').failures).toBe(0);
  });
});

describe('the interface a contract publishes', () => {
  it('lists functions and events by name and shape', async () => {
    served = {
      status: 200,
      body: {
        runtimeMatch: 'match',
        abi: [
          { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }] },
          { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }] },
          { type: 'event', name: 'Transfer', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }] },
          { type: 'constructor', inputs: [] },
        ],
      },
    };
    const answer = (await invoke('contract.abi', { chain: 'ethereum', address: DAI })) as {
      functions: { name: string; inputs: string[]; mutability: string }[];
      events: { name: string }[];
      truncated: boolean;
    };

    expect(answer.functions.map((f) => f.name)).toEqual(['transfer', 'balanceOf']);
    expect(answer.functions[0]!.inputs).toEqual(['address', 'uint256']);
    expect(answer.functions[1]!.mutability).toBe('view');
    expect(answer.events.map((e) => e.name)).toEqual(['Transfer']);
    expect(answer.truncated).toBe(false);
  });

  it('says when it truncated a long interface', async () => {
    served = {
      status: 200,
      body: {
        runtimeMatch: 'match',
        abi: Array.from({ length: 300 }, (_, i) => ({ type: 'function', name: `f${i}`, inputs: [] })),
      },
    };
    const answer = (await invoke('contract.abi', { chain: 'ethereum', address: DAI })) as {
      functions: unknown[];
      truncated: boolean;
    };
    expect(answer.functions).toHaveLength(120);
    expect(answer.truncated).toBe(true);
  });
});

describe('what it asks for', () => {
  it('never asks for every field, because that is the whole source tree', async () => {
    // `fields=all` on a large contract returns both bytecodes, every source
    // file and the standard-json input -- megabytes, for a question about a
    // compiler version.
    served = { status: 200, body: { runtimeMatch: 'match', compilation: { name: 'Dai' } } };
    await invoke('contract.verification', { chain: 'ethereum', address: DAI });
    expect(asked).toHaveLength(1);
    expect(asked[0]).not.toMatch(/fields=all/);
    expect(asked[0]).toMatch(/fields=compilation/);
  });

  it('asks the chain it was told, by that chain’s id', async () => {
    served = { status: 200, body: { runtimeMatch: 'match' } };
    await invoke('contract.verification', { chain: 'base', address: DAI });
    expect(asked[0]).toContain('/8453/');
  });
});

describe('the vocabulary a model is given', () => {
  it('says nothing about which service answered', () => {
    for (const capability of listCapabilities()) {
      if (!capability.id.startsWith('contract.')) continue;
      const surface = `${capability.id} ${capability.name} ${capability.description}`;
      expect(surface, capability.id).not.toMatch(/sourcify|blockscout|etherscan/i);
      expect(capability.effect, capability.id).toBe('READ');
    }
  });
});
