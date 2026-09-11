import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Naming a call, when a four-byte hash is not an identity.
 *
 * `0xa9059cbb` is the commonest selector on Ethereum. Asked in September 2026,
 * the open registry returned **six** signatures that hash to it, newest first,
 * so the real `transfer(address,uint256)` came **last**:
 *
 *   workMyDirefulOwner(uint256,uint256)
 *   join_tg_invmru_haha_fd06787(address,bool)
 *   func_2093253501(bytes)
 *   transfer(bytes4[9],bytes5[6],int48[11])
 *   many_msg_babbage(bytes1)
 *   transfer(address,uint256)
 *
 * Those fixtures are that live answer. Anything taking the first result reports
 * every ERC-20 transfer on Ethereum as `workMyDirefulOwner`, which is why the
 * contract's own verified interface is what decides and the database only
 * proposes.
 */

let replies: Record<string, { status?: number; body: string }> = {};
let requested: string[] = [];

vi.mock('undici', () => ({
  Agent: class {
    async close() {}
  },
  async fetch(input: unknown) {
    const url = String(input);
    requested.push(url);
    const key = Object.keys(replies).find((candidate) => url.includes(candidate));
    const reply = key ? replies[key]! : { status: 404, body: '{}' };
    return new Response(reply.body, {
      status: reply.status ?? 200,
      headers: new Headers({ 'content-type': 'application/json' }),
    });
  },
}));

const {
  registerContractUpstreams,
  registerSignatureUpstreams,
  resetBreakerForTest,
  resetCacheForTest,
  resetLimiterForTest,
  resetUpstreamsForTest,
} = await import('@xbam/upstream');
const { registerContractCapabilities } = await import('@xbam/runtime');
const { getCapability, resetCapabilitiesForTest } = await import('@xbam/tools');

const TRANSFER = '0xa9059cbb';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** The six colliding signatures, in the order the registry really returns them. */
const COLLIDING = [
  'workMyDirefulOwner(uint256,uint256)',
  'join_tg_invmru_haha_fd06787(address,bool)',
  'func_2093253501(bytes)',
  'transfer(bytes4[9],bytes5[6],int48[11])',
  'many_msg_babbage(bytes1)',
  'transfer(address,uint256)',
];

function registryAnswers(signatures: string[]) {
  return { body: JSON.stringify({ count: signatures.length, results: signatures.map((s) => ({ text_signature: s })) }) };
}
function curatedAnswers(kind: 'function' | 'event', hash: string, signatures: string[]) {
  return {
    body: JSON.stringify({
      ok: true,
      result: { [kind]: { [hash]: signatures.map((s) => ({ name: s, filtered: false })) }, ...(kind === 'function' ? { event: {} } : { function: {} }) },
    }),
  };
}
/** A Sourcify answer carrying just enough ABI to decide. */
function verifiedWith(abi: unknown[]) {
  return { body: JSON.stringify({ abi, chainId: '1', address: USDC, match: 'exact_match' }) };
}

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

async function run<T>(id: string, input: unknown): Promise<T> {
  const capability = getCapability(id)!;
  return capability.run(capability.input.parse(input) as never, context()) as Promise<T>;
}

interface Named {
  signature: string | null;
  confidence: string;
  why: string;
  candidates: { signature: string; sources: string[] }[];
  checkedAgainstAbi: boolean;
  sourcesAsked: string[];
  sourcesUnreachable: string[];
  note: string;
}

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
  resetCapabilitiesForTest();
  registerContractUpstreams();
  registerSignatureUpstreams();
  registerContractCapabilities();
  replies = {};
  requested = [];
});
afterEach(() => {
  resetUpstreamsForTest();
  resetCapabilitiesForTest();
});

describe('a selector with six signatures', () => {
  it('is settled exactly by the contract’s own interface', async () => {
    /**
     * The curated source deliberately answers nothing here.
     *
     * Otherwise it supplies `transfer(address,uint256)` first and the candidate
     * list happens to begin with the right answer -- so a naive
     * "take the first" implementation would pass this test by luck. With only
     * the registry answering, the list begins with `workMyDirefulOwner` and the
     * only thing that can reach the right answer is the interface.
     */
    replies['4byte.directory'] = registryAnswers(COLLIDING);
    replies['openchain.xyz'] = curatedAnswers('function', TRANSFER, []);
    replies['sourcify'] = verifiedWith([
      { type: 'function', name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }] },
      { type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }] },
    ]);

    const answer = await run<Named>('contract.decode_function', {
      callData: TRANSFER,
      chain: 'ethereum',
      address: USDC,
    });

    expect(answer.confidence).toBe('CONFIRMED');
    expect(answer.signature).toBe('transfer(address,uint256)');
    expect(answer.checkedAgainstAbi).toBe(true);
    // Every candidate is still reported, so the collision is visible.
    expect(answer.candidates.map((c) => c.signature)).toEqual(expect.arrayContaining(COLLIDING));
  });

  it('never promotes the first result when nothing can choose', async () => {
    // No contract given: the registry's own order puts the junk first, and
    // taking it would name every ERC-20 transfer `workMyDirefulOwner`.
    replies['4byte.directory'] = registryAnswers(COLLIDING);
    replies['openchain.xyz'] = curatedAnswers('function', TRANSFER, ['transfer(address,uint256)']);

    const answer = await run<Named>('contract.decode_function', { callData: TRANSFER });
    expect(answer.confidence).toBe('AMBIGUOUS');
    expect(answer.signature).toBeNull();
    expect(answer.candidates.length).toBeGreaterThan(1);
    expect(answer.why).toMatch(/nothing to choose|not verified|no contract/i);
  });

  it('says a selector is not unique, every time', async () => {
    replies['4byte.directory'] = registryAnswers(['transfer(address,uint256)']);
    replies['openchain.xyz'] = curatedAnswers('function', TRANSFER, ['transfer(address,uint256)']);
    const answer = await run<Named>('contract.decode_function', { callData: TRANSFER });
    expect(answer.note).toMatch(/not unique/i);
    // And that arguments are not decoded, which the name would otherwise imply.
    expect(answer.note).toMatch(/argument values are not decoded/i);
  });

  it('uses only the selector, not the arguments after it', async () => {
    replies['4byte.directory'] = registryAnswers(['transfer(address,uint256)']);
    replies['openchain.xyz'] = curatedAnswers('function', TRANSFER, ['transfer(address,uint256)']);
    await run<Named>('contract.decode_function', {
      callData: `${TRANSFER}${'0'.repeat(128)}`,
    });
    const asked = requested.filter((url) => url.includes('4byte'));
    expect(asked[0]).toContain(TRANSFER);
    expect(asked[0]).not.toContain('0'.repeat(64));
  });
});

describe('when the interface cannot decide', () => {
  it('reports an unverified contract as unable to choose, not as an answer', async () => {
    replies['4byte.directory'] = registryAnswers(COLLIDING);
    replies['openchain.xyz'] = curatedAnswers('function', TRANSFER, []);
    replies['sourcify'] = { status: 404, body: '{}' };

    const answer = await run<Named>('contract.decode_function', {
      callData: TRANSFER,
      chain: 'ethereum',
      address: USDC,
    });
    expect(answer.confidence).toBe('AMBIGUOUS');
    expect(answer.checkedAgainstAbi).toBe(false);
    expect(answer.signature).toBeNull();
  });

  it('suggests a proxy when nothing known is in the interface', async () => {
    // The interface is real but has none of the candidates in it -- which is
    // what a call to a proxy's implementation looks like from the proxy.
    replies['4byte.directory'] = registryAnswers(['transfer(address,uint256)']);
    replies['openchain.xyz'] = curatedAnswers('function', TRANSFER, ['transfer(address,uint256)']);
    replies['sourcify'] = verifiedWith([
      { type: 'function', name: 'upgradeTo', inputs: [{ type: 'address' }] },
    ]);

    const answer = await run<Named>('contract.decode_function', {
      callData: TRANSFER,
      chain: 'ethereum',
      address: USDC,
    });
    expect(answer.confidence).toBe('AMBIGUOUS');
    expect(answer.why).toMatch(/proxy/i);
  });

  it('says plainly when no database knows the hash at all', async () => {
    replies['4byte.directory'] = registryAnswers([]);
    replies['openchain.xyz'] = curatedAnswers('function', '0xdeadbeef', []);
    const answer = await run<Named>('contract.decode_function', { callData: '0xdeadbeef' });
    expect(answer.confidence).toBe('UNKNOWN');
    expect(answer.candidates).toEqual([]);
  });

  it('names the limitation when the contract is verified but the hash is unknown', async () => {
    // The honest cost of not hashing signatures ourselves: the entry is in the
    // interface and cannot be pointed at.
    replies['4byte.directory'] = registryAnswers([]);
    replies['openchain.xyz'] = curatedAnswers('function', '0xdeadbeef', []);
    replies['sourcify'] = verifiedWith([{ type: 'function', name: 'mystery', inputs: [] }]);

    const answer = await run<Named>('contract.decode_function', {
      callData: '0xdeadbeef',
      chain: 'ethereum',
      address: USDC,
    });
    expect(answer.confidence).toBe('UNKNOWN');
    expect(answer.why).toMatch(/hashing each signature/i);
  });
});

describe('an event topic', () => {
  it('is settled by the interface the same way', async () => {
    replies['4byte.directory'] = registryAnswers(['Transfer(address,address,uint256)']);
    replies['openchain.xyz'] = curatedAnswers('event', TRANSFER_TOPIC, ['Transfer(address,address,uint256)']);
    replies['sourcify'] = verifiedWith([
      { type: 'event', name: 'Transfer', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }] },
    ]);

    const answer = await run<Named>('contract.decode_event', {
      topic: TRANSFER_TOPIC,
      chain: 'ethereum',
      address: USDC,
    });
    expect(answer.confidence).toBe('CONFIRMED');
    expect(answer.signature).toBe('Transfer(address,address,uint256)');
  });

  it('asks the event side of the databases, not the function side', async () => {
    replies['4byte.directory'] = registryAnswers([]);
    replies['openchain.xyz'] = curatedAnswers('event', TRANSFER_TOPIC, []);
    await run<Named>('contract.decode_event', { topic: TRANSFER_TOPIC });
    expect(requested.some((url) => url.includes('event-signatures'))).toBe(true);
    expect(requested.some((url) => url.includes('event='))).toBe(true);
  });

  it('refuses a topic that is not one', () => {
    const capability = getCapability('contract.decode_event')!;
    expect(capability.input.safeParse({ topic: '0xa9059cbb' }).success).toBe(false);
    expect(capability.input.safeParse({ topic: TRANSFER_TOPIC }).success).toBe(true);
  });
});

describe('what it will not accept', () => {
  it('refuses call data that is not call data', () => {
    const capability = getCapability('contract.decode_function')!;
    expect(capability.input.safeParse({ callData: 'transfer' }).success).toBe(false);
    expect(capability.input.safeParse({ callData: '0xabc' }).success).toBe(false);
    expect(capability.input.safeParse({ callData: TRANSFER }).success).toBe(true);
  });

  it('asks both databases and says which answered', async () => {
    replies['4byte.directory'] = registryAnswers(['transfer(address,uint256)']);
    replies['openchain.xyz'] = { status: 503, body: 'down' };
    const answer = await run<Named>('contract.decode_function', { callData: TRANSFER });
    expect(answer.sourcesAsked).toContain('an open signature registry');
    expect(answer.sourcesUnreachable).toContain('a curated signature database');
    // One source failing is a smaller answer, not no answer.
    expect(answer.candidates.length).toBe(1);
  });
});
