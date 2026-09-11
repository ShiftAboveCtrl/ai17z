import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Reading Bitcoin, and the four ways this could mislead.
 *
 * **By calling an address a wallet.** Bitcoin wallets use a fresh address per
 * payment, so one address is a fragment. "This address holds 0.4 BTC" answers
 * "how much do they have" wrongly almost every time.
 *
 * **By adding unconfirmed money to the balance.** Esplora reports chain and
 * mempool statistics separately, and summing them turns money that may never
 * arrive into a balance.
 *
 * **By treating confirmed as a flag.** One confirmation is not six, and a
 * transaction still in the mempool can be replaced outright.
 *
 * **By accepting an address that is not one.** Every Bitcoin address format
 * carries a checksum precisely so a typo is detectable without asking anybody.
 */

interface Reply {
  status?: number;
  body: string;
}

let replies: Record<string, Reply> = {};
let requested: string[] = [];

vi.mock('undici', () => ({
  Agent: class {
    async close() {}
  },
  async fetch(input: unknown) {
    const url = String(input);
    requested.push(url);
    const key = Object.keys(replies).find((candidate) => url.includes(candidate));
    const reply = key ? replies[key]! : { status: 404, body: 'not found' };
    return new Response(reply.body, {
      status: reply.status ?? 200,
      headers: new Headers({ 'content-type': 'application/json' }),
    });
  },
}));

const {
  parseBitcoinAddress,
  registerBitcoinUpstreams,
  resetBreakerForTest,
  resetCacheForTest,
  resetLimiterForTest,
  resetUpstreamsForTest,
} = await import('@xbam/upstream');
const { registerBitcoinCapabilities } = await import('@xbam/runtime');
const { getCapability, resetCapabilitiesForTest } = await import('@xbam/tools');

const GENESIS = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const TAPROOT = 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297';
const TXID = '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b';

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

/** The real shape, taken from the live API. */
function addressBody(chain: Partial<Record<string, number>>, mempool: Partial<Record<string, number>> = {}) {
  return {
    body: JSON.stringify({
      address: GENESIS,
      chain_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0, ...chain },
      mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0, ...mempool },
    }),
  };
}

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
  resetCapabilitiesForTest();
  registerBitcoinUpstreams();
  registerBitcoinCapabilities();
  replies = { '/blocks/tip/height': { body: '966434' } };
  requested = [];
});
afterEach(() => {
  resetUpstreamsForTest();
  resetCapabilitiesForTest();
});

describe('an address is checked by its own checksum', () => {
  it('recognises every format, and says which', () => {
    expect(parseBitcoinAddress(GENESIS)?.kind).toBe('P2PKH');
    expect(parseBitcoinAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')?.kind).toBe('P2SH');
    expect(parseBitcoinAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')?.kind).toBe('P2WPKH');
    expect(parseBitcoinAddress('bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3')?.kind).toBe('P2WSH');
    expect(parseBitcoinAddress(TAPROOT)?.kind).toBe('P2TR');
  });

  it('uses the right checksum constant for each, which is not interchangeable', () => {
    // bech32m exists because bech32 was weak for taproot-length payloads.
    // Checking a taproot address against the version 0 constant rejects every
    // real one, so this is the case that proves they are told apart.
    expect(parseBitcoinAddress(TAPROOT)?.kind).toBe('P2TR');
    expect(parseBitcoinAddress(TAPROOT.slice(0, -1) + '8')).toBeNull();
    expect(parseBitcoinAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5')).toBeNull();
  });

  it('refuses a typo, mixed case, and addresses from other chains', () => {
    // One character of case changed: base58check catches it.
    expect(parseBitcoinAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7Divfna')).toBeNull();
    // Mixed case is invalid by specification, because the checksum is over one case.
    expect(parseBitcoinAddress('bc1qw508d6qejxtdg4y5R3zarvary0c5xw7kv8f3t4')).toBeNull();
    expect(parseBitcoinAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBeNull();
    expect(parseBitcoinAddress('0x1234567890123456789012345678901234567890')).toBeNull();
  });

  it('refuses a testnet address rather than reporting a zero balance for it', () => {
    // The trap: a testnet address is a perfectly valid address that has never
    // existed on this chain, so looking it up here answers "nothing" about
    // something real.
    const capability = getCapability('bitcoin.read_address')!;
    const refusal = capability.input.safeParse({ address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' });
    expect(refusal.success).toBe(false);
    expect(JSON.stringify(refusal.error?.issues)).toMatch(/testnet/i);
    expect(requested).toHaveLength(0);
  });
});

describe('an address summary', () => {
  it('never adds unconfirmed money to the balance', async () => {
    replies[`/address/${GENESIS}`] = addressBody(
      { funded_txo_sum: 5743423379, spent_txo_sum: 0, tx_count: 65746 },
      { funded_txo_sum: 3672, tx_count: 1 },
    );

    const answer = await run<{
      confirmed: { balance: string };
      pending: { balance: string };
      balanceBtc: string;
      caveats: string[];
    }>('bitcoin.read_address', { address: GENESIS });

    expect(answer.confirmed.balance).toBe('5743423379');
    expect(answer.balanceBtc).toBe('57.43423379');
    // Kept apart. Summed it would be 5743427051.
    expect(answer.pending.balance).toBe('3672');
    expect(answer.caveats.join(' ')).toMatch(/not settled and is not included in the balance/i);
  });

  it('subtracts what was spent rather than reporting what was received', async () => {
    replies[`/address/${GENESIS}`] = addressBody({ funded_txo_sum: 1000, spent_txo_sum: 400, tx_count: 2 });
    const answer = await run<{ confirmed: { received: string; spent: string; balance: string } }>(
      'bitcoin.read_address',
      { address: GENESIS },
    );
    expect(answer.confirmed.received).toBe('1000');
    expect(answer.confirmed.spent).toBe('400');
    expect(answer.confirmed.balance).toBe('600');
  });

  it('says an address is not a wallet, every time', async () => {
    replies[`/address/${GENESIS}`] = addressBody({ funded_txo_sum: 1, tx_count: 1 });
    const answer = await run<{ caveats: string[] }>('bitcoin.read_address', { address: GENESIS });
    expect(answer.caveats.join(' ')).toMatch(/new address for every payment/i);
  });
});

describe('a transaction', () => {
  it('counts confirmations rather than reporting a flag', async () => {
    replies[`/tx/${TXID}`] = {
      body: JSON.stringify({
        status: { confirmed: true, block_height: 966430, block_time: 1231006505 },
        fee: 2500,
        vin: [{}],
        vout: [{ value: 5000000000 }],
      }),
    };
    const answer = await run<{ confirmations: number | null; notes: string[]; feeBtc: string | null }>(
      'bitcoin.read_transaction',
      { txid: TXID },
    );
    // Tip 966434, mined at 966430.
    expect(answer.confirmations).toBe(5);
    expect(answer.feeBtc).toBe('0.000025');
    // Under six, so it says so.
    expect(answer.notes.join(' ')).toMatch(/usual point at which a payment is treated as settled/i);
  });

  it('says an unconfirmed transaction can still be replaced', async () => {
    replies[`/tx/${TXID}`] = {
      body: JSON.stringify({ status: { confirmed: false }, fee: 28, vin: [{}], vout: [{ value: 1000 }] }),
    };
    const answer = await run<{ confirmed: boolean; confirmations: number | null; notes: string[] }>(
      'bitcoin.read_transaction',
      { txid: TXID },
    );
    expect(answer.confirmed).toBe(false);
    expect(answer.confirmations).toBeNull();
    expect(answer.notes.join(' ')).toMatch(/replaced by a version paying a higher fee/i);
  });

  it('still reports the transaction when the tip cannot be read', async () => {
    replies[`/tx/${TXID}`] = {
      body: JSON.stringify({ status: { confirmed: true, block_height: 900000, block_time: 1 }, fee: 1, vin: [], vout: [] }),
    };
    replies['/blocks/tip/height'] = { status: 503, body: 'down' };
    const answer = await run<{ confirmed: boolean; confirmations: number | null }>('bitcoin.read_transaction', {
      txid: TXID,
    });
    expect(answer.confirmed).toBe(true);
    expect(answer.confirmations).toBeNull();
  });

  it('refuses something that is not a transaction id', () => {
    const capability = getCapability('bitcoin.read_transaction')!;
    expect(capability.input.safeParse({ txid: `0x${TXID}` }).success).toBe(false);
    expect(capability.input.safeParse({ txid: 'nope' }).success).toBe(false);
    expect(capability.input.safeParse({ txid: TXID }).success).toBe(true);
  });
});

describe('unspent outputs', () => {
  it('treats "too many to list" as an answer, not a failure', async () => {
    // What blockstream.info actually returns for the genesis address, which
    // has 78,725 of them.
    replies[`/address/${GENESIS}/utxo`] = { status: 400, body: 'Too many unspent outputs' };
    const answer = await run<{ listed: boolean; note: string }>('bitcoin.read_unspent', { address: GENESIS });
    expect(answer.listed).toBe(false);
    expect(answer.note).toMatch(/too many unspent outputs/i);
    expect(answer.note).toMatch(/bitcoin.read_address/);
  });

  it('says so when it has shown only part of the list', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      txid: TXID,
      vout: i,
      value: 1000,
      status: { confirmed: true, block_height: 900000 },
    }));
    replies[`/address/${GENESIS}/utxo`] = { body: JSON.stringify(many) };

    const answer = await run<{ outputs: unknown[]; truncated: boolean; note: string; totalShownSats: string }>(
      'bitcoin.read_unspent',
      { address: GENESIS, limit: 5 },
    );
    expect(answer.outputs).toHaveLength(5);
    expect(answer.truncated).toBe(true);
    // The total must not be mistaken for the balance.
    expect(answer.totalShownSats).toBe('5000');
    expect(answer.note).toMatch(/not the address's balance/i);
  });
});

describe('fallback between two sources that really are interchangeable', () => {
  it('uses the second when the first is down, and says which answered', async () => {
    replies['mempool.space'] = { status: 503, body: 'down' };
    replies['blockstream.info/api/address'] = addressBody({ funded_txo_sum: 1000, spent_txo_sum: 0, tx_count: 1 });

    const answer = await run<{ confirmed: { balance: string }; provenance: { source: string; fellBackFrom: string[] } }>(
      'bitcoin.read_address',
      { address: GENESIS },
    );
    expect(answer.confirmed.balance).toBe('1000');
    expect(answer.provenance.source).toBe('bitcoin.blockstream');
    expect(answer.provenance.fellBackFrom).toContain('bitcoin.mempoolspace');
  });
});

describe('when a source misbehaves', () => {
  it('reports a 429 rather than treating it as an answer', async () => {
    replies['/address/'] = { status: 429, body: 'slow down' };
    await expect(run('bitcoin.read_address', { address: GENESIS })).rejects.toThrow();
  });

  it('reports a body that is not JSON', async () => {
    replies[`/address/${GENESIS}`] = { body: '<html>gateway</html>' };
    await expect(run('bitcoin.read_address', { address: GENESIS })).rejects.toThrow();
  });

  it('refuses a tip height that is not a number', async () => {
    replies['/blocks/tip/height'] = { body: 'not a height' };
    const answer = await run<{ readable: boolean; blockHeight: number | null }>('bitcoin.health', {});
    expect(answer.readable).toBe(false);
    expect(answer.blockHeight).toBeNull();
  });
});

describe('what it will not do', () => {
  it('has no capability that broadcasts or signs anything', async () => {
    const { listCapabilities } = await import('@xbam/tools');
    const bitcoin = listCapabilities().filter((capability) => capability.id.startsWith('bitcoin.'));
    expect(bitcoin.length).toBeGreaterThan(0);
    for (const capability of bitcoin) expect(capability.effect).toBe('READ');
    expect(JSON.stringify(bitcoin.map((c) => [c.id, c.description]))).not.toMatch(
      /broadcast|sendraw|sign|private key/i,
    );
  });

  it('never asks for the whole mempool', async () => {
    // 5.16 MB when measured. Nothing here has a path to it.
    //
    // Matched on the path rather than the string "/mempool", which the first
    // version of this did -- and which every request matches, because the host
    // is mempool.space.
    replies[`/address/${GENESIS}`] = addressBody({ funded_txo_sum: 1, tx_count: 1 });
    await run('bitcoin.read_address', { address: GENESIS });
    const paths = requested.map((url) => new URL(url).pathname);
    expect(paths.some((path) => path.startsWith('/api/mempool'))).toBe(false);
    expect(paths.every((path) => /^\/api\/(address|tx|blocks)\b/.test(path))).toBe(true);
  });
});
