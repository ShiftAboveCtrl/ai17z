import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Reading Solana, and the four ways this could lie.
 *
 * **By rounding.** Lamports and token supplies are u64. A balance that has been
 * through a double is a number nobody should quote.
 *
 * **By answering about the wrong cluster.** A node repointed at devnet answers
 * everything perfectly about a different world.
 *
 * **By reading silence as success.** A transaction that reverted is in the
 * signature list and looks exactly like one that worked, unless `err` is
 * carried through.
 *
 * **By dropping the commitment.** A `processed` read can be rolled back, so a
 * balance without its commitment is a number whose reliability cannot be judged.
 */

interface Reply {
  status?: number;
  body: string;
  headers?: Record<string, string>;
}

/** Replies per JSON-RPC method, so a case says only what it cares about. */
let replies: Record<string, Reply | Reply[]> = {};
let calls: { method: string; params: unknown[] }[] = [];

vi.mock('undici', () => ({
  Agent: class {
    async close() {}
  },
  async fetch(_input: unknown, init: { body?: string }) {
    const request = JSON.parse(init.body ?? '{}') as { method: string; params?: unknown[] };
    calls.push({ method: request.method, params: request.params ?? [] });

    const entry = replies[request.method];
    const reply = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]!) : entry;
    if (!reply) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }
    return new Response(reply.body, {
      status: reply.status ?? 200,
      headers: new Headers({ 'content-type': 'application/json', ...(reply.headers ?? {}) }),
    });
  },
}));

const {
  SOLANA_MAINNET_GENESIS,
  base58Bytes,
  isAddress,
  isSignature,
  registerSolanaUpstreams,
  resetBreakerForTest,
  resetCacheForTest,
  resetLimiterForTest,
  resetUpstreamsForTest,
} = await import('@xbam/upstream');
const { registerSolanaCapabilities } = await import('@xbam/runtime');
const { getCapability, resetCapabilitiesForTest } = await import('@xbam/tools');

/** A real mainnet mint, used only as a well-formed address. */
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const A_SIGNATURE =
  '95QFYJxcjSJ9pMkYHEr2JLxfuM21P6BRMHxw7bvkEkSsVB8PEtGeCrqZnkSzfZAtpiX17z9Yg8hLB5RfXRJvQkv';

function ok(result: unknown): Reply {
  return { body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) };
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

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
  resetCapabilitiesForTest();
  registerSolanaUpstreams();
  registerSolanaCapabilities();
  calls = [];
  // Every case starts on the right cluster; the ones about identity say so.
  replies = { getGenesisHash: ok(SOLANA_MAINNET_GENESIS) };
});
afterEach(() => {
  resetUpstreamsForTest();
  resetCapabilitiesForTest();
});

describe('an address is decoded, not pattern-matched', () => {
  it('knows the byte length of what it was given', () => {
    expect(isAddress(USDC)).toBe(true);
    expect(base58Bytes(USDC)?.length).toBe(32);
    expect(isSignature(A_SIGNATURE)).toBe(true);
    expect(base58Bytes(A_SIGNATURE)?.length).toBe(64);

    // A signature is not an address and vice versa -- the mistake somebody
    // makes by pasting the wrong one.
    expect(isAddress(A_SIGNATURE)).toBe(false);
    expect(isSignature(USDC)).toBe(false);
  });

  it('refuses characters base58 does not have', () => {
    // 0, O, I and l are excluded from the alphabet precisely because they are
    // confusable, so a mistyped address must not decode.
    expect(base58Bytes('0OIl')).toBeNull();
    expect(isAddress('not an address')).toBe(false);
    expect(base58Bytes('')).toBeNull();
  });

  it('counts leading zero bytes, which a length check gets wrong', () => {
    // Every leading '1' is a zero byte. The system program's address is 32
    // bytes that are almost all zero, and it is much shorter than 44
    // characters -- a length regex would reject a real address.
    const systemProgram = '11111111111111111111111111111111';
    expect(base58Bytes(systemProgram)?.length).toBe(32);
    expect(isAddress(systemProgram)).toBe(true);
  });

  it('is refused by the capability before anything is asked', async () => {
    const capability = getCapability('solana.read_balance')!;
    expect(capability.input.safeParse({ address: 'nonsense' }).success).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('the cluster is proved before anything it says is trusted', () => {
  it('refuses a node serving devnet, and reads nothing from it', async () => {
    replies = {
      getGenesisHash: ok('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'),
      getBalance: ok({ context: { slot: 1 }, value: 999 }),
    };

    await expect(run('solana.read_balance', { address: USDC })).rejects.toThrow();
    // The point: it never asked for the balance.
    expect(calls.map((call) => call.method)).toEqual(['getGenesisHash']);
  });

  it('asks for the genesis hash first, every time', async () => {
    replies.getBalance = ok({ context: { slot: 446036110 }, value: 533858884382 });
    await run('solana.read_balance', { address: USDC });
    expect(calls[0]!.method).toBe('getGenesisHash');
  });
});

describe('a balance', () => {
  it('is exact, and rendered without dividing', async () => {
    replies.getBalance = ok({ context: { slot: 446036110 }, value: 533858884382 });
    const answer = await run<{ lamports: string; sol: string; slot: number | null }>('solana.read_balance', {
      address: USDC,
    });
    expect(answer.lamports).toBe('533858884382');
    expect(answer.sol).toBe('533.858884382');
    expect(answer.slot).toBe(446036110);
  });

  it('survives a balance past where a double stops counting by ones', async () => {
    // Bigger than Number.MAX_SAFE_INTEGER. This is the whole reason the exact
    // parse exists, proved end to end rather than only in its own unit test.
    replies.getBalance = {
      body: '{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":18446744073709551615}}',
    };
    const answer = await run<{ lamports: string; sol: string }>('solana.read_balance', { address: USDC });
    expect(answer.lamports).toBe('18446744073709551615');
    expect(answer.sol).toBe('18446744073.709551615');
  });

  it('says which commitment it was read at', async () => {
    replies.getBalance = ok({ context: { slot: 1 }, value: 1 });
    const finalized = await run<{ commitment: string }>('solana.read_balance', { address: USDC });
    expect(finalized.commitment).toBe('finalized');

    resetCacheForTest();
    const processed = await run<{ commitment: string }>('solana.read_balance', {
      address: USDC,
      commitment: 'processed',
    });
    expect(processed.commitment).toBe('processed');
    // And it asked for it, rather than relabelling a finalized read.
    const asked = calls.filter((call) => call.method === 'getBalance').at(-1);
    expect(JSON.stringify(asked?.params)).toContain('processed');
  });

  it('says that tokens are not counted in it', async () => {
    replies.getBalance = ok({ context: { slot: 1 }, value: 1 });
    const answer = await run<{ note: string }>('solana.read_balance', { address: USDC });
    expect(answer.note).toMatch(/token/i);
  });
});

describe('a token mint', () => {
  it('reports supply exactly and says who can still change it', async () => {
    replies.getAccountInfo = ok({
      context: { slot: 446036112 },
      value: {
        lamports: 533858884382,
        owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        executable: false,
        space: 82,
        data: {
          program: 'spl-token',
          parsed: {
            type: 'mint',
            info: {
              decimals: 6,
              supply: '7937704767085421',
              mintAuthority: 'BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG',
              freezeAuthority: '7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar',
            },
          },
        },
      },
    });

    const answer = await run<{
      isMint: boolean;
      supply: string | null;
      supplyRendered: string | null;
      observations: string[];
    }>('solana.read_token', { mint: USDC });

    expect(answer.isMint).toBe(true);
    expect(answer.supply).toBe('7937704767085421');
    expect(answer.supplyRendered).toBe('7937704767.085421');
    expect(answer.observations.join(' ')).toMatch(/more of this token can still be created/i);
    expect(answer.observations.join(' ')).toMatch(/frozen/i);
  });

  it('says plainly when an address is not a mint, rather than failing', async () => {
    replies.getAccountInfo = ok({
      context: { slot: 1 },
      value: { lamports: 1, owner: '11111111111111111111111111111111', executable: false, space: 0, data: ['', 'base64'] },
    });
    const answer = await run<{ isMint: boolean; observations: string[] }>('solana.read_token', { mint: USDC });
    expect(answer.isMint).toBe(false);
    expect(answer.observations.join(' ')).toMatch(/not a token mint/i);
  });

  it('reports an absent authority as absent, not as unknown', async () => {
    replies.getAccountInfo = ok({
      context: { slot: 1 },
      value: {
        lamports: 1,
        owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        executable: false,
        space: 82,
        data: { program: 'spl-token', parsed: { type: 'mint', info: { decimals: 9, supply: '0', mintAuthority: null, freezeAuthority: null } } },
      },
    });
    const answer = await run<{ mintAuthority: string | null; observations: string[] }>('solana.read_token', {
      mint: USDC,
    });
    expect(answer.mintAuthority).toBeNull();
    expect(answer.observations.join(' ')).toMatch(/supply cannot be increased/i);
  });
});

describe('an account that is not there', () => {
  it('is an answer, not a failure', async () => {
    replies.getAccountInfo = ok({ context: { slot: 1 }, value: null });
    const answer = await run<{ exists: boolean; lamports: string | null }>('solana.read_account', { address: USDC });
    expect(answer.exists).toBe(false);
    expect(answer.lamports).toBeNull();
  });
});

describe('a program', () => {
  it('says when its code can be replaced', async () => {
    replies.getAccountInfo = ok({
      context: { slot: 1 },
      value: {
        lamports: 200653906,
        owner: 'BPFLoaderUpgradeab1e11111111111111111111111',
        executable: true,
        space: 36,
        data: ['AgAAA', 'base64'],
      },
    });
    const answer = await run<{ isProgram: boolean; upgradeable: boolean | null; observations: string[] }>(
      'solana.read_program',
      { address: USDC },
    );
    expect(answer.isProgram).toBe(true);
    expect(answer.upgradeable).toBe(true);
    expect(answer.observations.join(' ')).toMatch(/upgrade authority can replace the code/i);
  });

  it('does not call a data account a program', async () => {
    replies.getAccountInfo = ok({
      context: { slot: 1 },
      value: { lamports: 1, owner: '11111111111111111111111111111111', executable: false, space: 0, data: ['', 'base64'] },
    });
    const answer = await run<{ isProgram: boolean; upgradeable: boolean | null }>('solana.read_program', {
      address: USDC,
    });
    expect(answer.isProgram).toBe(false);
    expect(answer.upgradeable).toBeNull();
  });
});

describe('a transaction that failed', () => {
  it('is reported as failed rather than as a transaction', async () => {
    replies.getTransaction = ok({
      slot: 446036119,
      blockTime: 1789091442,
      meta: { err: { InstructionError: [3, { Custom: 81 }] }, fee: 5000 },
      transaction: { message: { accountKeys: [USDC] } },
    });
    const answer = await run<{ succeeded: boolean | null; failureReason: string | null; feeLamports: string | null }>(
      'solana.read_transaction',
      { signature: A_SIGNATURE },
    );
    expect(answer.succeeded).toBe(false);
    expect(answer.failureReason).toMatch(/InstructionError/);
    // A failed transaction still cost its fee.
    expect(answer.feeLamports).toBe('5000');
  });

  it('asks in a way that does not refuse every versioned transaction', async () => {
    replies.getTransaction = ok({ slot: 1, blockTime: null, meta: { err: null, fee: 5000 }, transaction: {} });
    await run('solana.read_transaction', { signature: A_SIGNATURE });
    const asked = calls.find((call) => call.method === 'getTransaction');
    // Without this the node rejects most of today's transactions outright.
    expect(JSON.stringify(asked?.params)).toContain('maxSupportedTransactionVersion');
  });

  it('says a signature is unknown rather than inventing a transaction', async () => {
    replies.getTransaction = ok(null);
    const answer = await run<{ found: boolean; succeeded: boolean | null }>('solana.read_transaction', {
      signature: A_SIGNATURE,
    });
    expect(answer.found).toBe(false);
    expect(answer.succeeded).toBeNull();
  });
});

describe('recent activity', () => {
  it('marks the failures, and counts them', async () => {
    replies.getSignaturesForAddress = ok([
      { signature: A_SIGNATURE, slot: 3, blockTime: 1789091442, err: null, confirmationStatus: 'finalized', memo: null },
      {
        signature: A_SIGNATURE,
        slot: 2,
        blockTime: 1789091441,
        err: { InstructionError: [3, { Custom: 81 }] },
        confirmationStatus: 'finalized',
        memo: null,
      },
    ]);

    const answer = await run<{ transactions: { succeeded: boolean }[]; failedCount: number }>(
      'solana.read_signatures',
      { address: USDC },
    );
    expect(answer.transactions.map((row) => row.succeeded)).toEqual([true, false]);
    expect(answer.failedCount).toBe(1);
  });

  it('will not be asked for a thousand at a time', async () => {
    const capability = getCapability('solana.read_signatures')!;
    expect(capability.input.safeParse({ address: USDC, limit: 1000 }).success).toBe(false);
    expect(capability.input.safeParse({ address: USDC, limit: 50 }).success).toBe(true);
  });
});

describe('when the cluster misbehaves', () => {
  it('reports a 429 rather than treating it as an answer', async () => {
    replies.getBalance = { status: 429, body: '{"error":"slow down"}', headers: { 'retry-after': '2' } };
    await expect(run('solana.read_balance', { address: USDC })).rejects.toThrow();
  });

  it('reports a body that is not JSON', async () => {
    replies.getBalance = { body: '<html>proxy error</html>' };
    await expect(run('solana.read_balance', { address: USDC })).rejects.toThrow();
  });

  it('reports a JSON-RPC error rather than a null balance', async () => {
    replies.getBalance = { body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad params' } }) };
    await expect(run('solana.read_balance', { address: USDC })).rejects.toThrow();
  });

  it('reports a 5xx', async () => {
    replies.getBalance = { status: 503, body: 'unavailable' };
    await expect(run('solana.read_balance', { address: USDC })).rejects.toThrow();
  });
});

describe('what it will not do', () => {
  it('has no capability that sends, signs or asks for an airdrop', async () => {
    const { listCapabilities } = await import('@xbam/tools');
    const everything = JSON.stringify(listCapabilities().map((capability) => [capability.id, capability.description]));
    expect(everything).not.toMatch(/sendTransaction|requestAirdrop|simulateTransaction|signTransaction/i);
    for (const capability of listCapabilities().filter((entry) => entry.id.startsWith('solana.'))) {
      expect(capability.effect).toBe('READ');
    }
  });

  it('refuses a method outside the allowlist even when handed one directly', async () => {
    const { ask } = await import('@xbam/upstream');
    // Past the schema, the way a caller building a query by hand would be.
    await expect(
      ask('solana_mainnet', { method: 'sendTransaction', params: [], commitment: 'finalized' }),
    ).rejects.toThrow();
    expect(calls.some((call) => call.method === 'sendTransaction')).toBe(false);
  });
});
