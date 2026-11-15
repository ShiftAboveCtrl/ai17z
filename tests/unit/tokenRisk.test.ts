import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What security services observe, and the two ways this could lie.
 *
 * **By judging.** "Safe" and "scam" are the words this must never produce. The
 * services report attributes; the useful, defensible thing is the attribute
 * with its source attached. A verdict is a claim AI17Z cannot support and would
 * be believed anyway.
 *
 * **By reading silence as reassurance.** The fields come back as `"0"`, `"1"`,
 * and an empty string for anything the service did not check. Treating that
 * empty as nought turns "we did not look" into "it is fine" -- the worst
 * possible direction for this particular error, and the one an agent would then
 * repeat to somebody about to spend money.
 */

let responses: Record<string, { status: number; body: string }> = {};
/** Solana JSON-RPC results, one per call, in the order that method is asked. */
let rpcQueue: Record<string, unknown[]> = {};

vi.mock('undici', () => ({
  Agent: class {
    async close() {}
  },
  async fetch(input: unknown, init?: { body?: string }) {
    const url = String(input);
    if (url.includes('solana.com')) {
      const request = JSON.parse(init?.body ?? '{}') as { method?: string };
      const method = request.method ?? '';
      const queued = rpcQueue[method];
      const result = queued?.length ? queued.shift() : null;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }
    const match = Object.keys(responses).find((key) => url.includes(key));
    const answer = match ? responses[match]! : { status: 404, body: '{}' };
    return new Response(answer.body, {
      status: answer.status,
      headers: new Headers({ 'content-type': 'application/json' }),
    });
  },
}));

const { registerTokenRiskUpstreams, resetBreakerForTest, resetCacheForTest, resetLimiterForTest, resetUpstreamsForTest } =
  await import('@xbam/upstream');
const { registerTokenRiskCapabilities } = await import('@xbam/runtime');
const { getCapability, resetCapabilitiesForTest } = await import('@xbam/tools');

const TOKEN = '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE';

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

interface RiskAnswer {
  cardReadings: { label: string; value: number | boolean | null; source?: string }[];
  lp: { burnedPct: number | null; lockedPct: number | null; unavailable: boolean } | null;
  observations: { what: string; detail: string; source: string; kind: string }[];
  notChecked: string[];
  limitations: string[];
  sourcesAnswering: number;
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

it('reports burned LP as a percentage reading, and an unread pool as unavailable rather than zero', async () => {
  const { SOLANA_MAINNET_GENESIS, registerSolanaUpstreams, registerMarketUpstreams } = await import('@xbam/upstream');
  const { resetLpCacheForTest, STREAMFLOW_PROGRAM } = await import('../../packages/runtime/src/lpLock');
  resetLpCacheForTest();
  registerSolanaUpstreams();
  registerMarketUpstreams();
  const pool = 'Pool111111111111111111111111111111111111111';
  const lpBytes = Buffer.alloc(32);
  lpBytes[0] = 9;
  lpBytes[31] = 1;
  const poolData = Buffer.alloc(496);
  poolData.set(lpBytes, 464);
  const streamOwner = 'StrmOwnr11111111111111111111111111111111111';
  const end = BigInt(Math.floor(Date.now() / 1000) + 3_600);
  const streamData = Buffer.alloc(41);
  let left = end;
  for (let i = 0; i < 8; i += 1) {
    streamData[33 + i] = Number(left & 0xffn);
    left >>= 8n;
  }
  const repeat = (value: unknown) => new Proxy([value], { get: (target, prop) => prop === 'shift' ? () => value : Reflect.get(target, prop) });
  rpcQueue = {
    getGenesisHash: repeat(SOLANA_MAINNET_GENESIS),
    getAccountInfo: [{ context: { slot: 1 }, value: { owner: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', executable: false, data: [poolData.toString('base64'), 'base64'] } }],
    getTokenSupply: [{ context: { slot: 1 }, value: { amount: '1000', decimals: 6 } }],
    getTokenLargestAccounts: [{ context: { slot: 1 }, value: [{ address: 'BurnAcct11111111111111111111111111111111111', amount: '800' }, { address: 'StrmAcct11111111111111111111111111111111111', amount: '200' }] }],
    getMultipleAccounts: [
      { context: { slot: 1 }, value: [{ data: { parsed: { info: { owner: '1nc1nerator11111111111111111111111111111111' } } } }, { data: { parsed: { info: { owner: streamOwner } } } }] },
      { context: { slot: 1 }, value: [
        { owner: '11111111111111111111111111111111', executable: false, data: ['', 'base64'] },
        { owner: STREAMFLOW_PROGRAM, executable: false, data: [streamData.toString('base64'), 'base64'] },
      ] },
    ],
  };
  responses['dexscreener.com'] = {
    status: 200,
    body: JSON.stringify({ pairs: [{ chainId: 'solana', pairAddress: pool, baseToken: { address: SOL_MINT }, quoteToken: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }, liquidity: { usd: 1000 } }] }),
  };
  responses['jup.ag'] = {
    status: 200,
    body: JSON.stringify([{ id: SOL_MINT, liquidity: 1000, updatedAt: new Date().toISOString(), firstPool: { createdAt: new Date().toISOString() }, audit: { topHoldersPercentage: 10, mintAuthorityDisabled: true, freezeAuthorityDisabled: true } }]),
  };
  const capability = getCapability('token.inspect_risk')!;
  const answer = await capability.run(capability.input.parse({ chain: 'solana', address: SOL_MINT }) as never, context()) as RiskAnswer;
  expect(answer.cardReadings.find(r => r.label === 'LP burned')?.value).toBe(80);
  expect(answer.cardReadings.find(r => r.label === 'LP locked')?.value).toBe(20);
  expect(answer.lp?.unavailable).toBe(false);
  expect(JSON.stringify(answer).toLowerCase()).not.toMatch(/\b(?:safe|unruggable|rug|scam)\b/);

  resetLpCacheForTest();
  rpcQueue = { getGenesisHash: repeat(SOLANA_MAINNET_GENESIS) };
  delete responses['dexscreener.com'];
  const other = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const unread = await capability.run(capability.input.parse({ chain: 'solana', address: other }) as never, context()) as RiskAnswer;
  expect(unread.cardReadings.find(r => r.label === 'LP status')?.value).toBeNull();
  expect(unread.cardReadings.some(r => r.label === 'LP burned' && r.value === 0)).toBe(false);
  expect(unread.lp?.unavailable).toBe(true);
  expect(unread.cardReadings.filter(r => ['Liquidity', 'Top holders', 'Mint authority', 'Freeze authority', 'Pool age'].includes(r.label))).toHaveLength(5);
});

/** Queues for one Raydium pool whose LP is held in the given token accounts. */
async function queueLpPool(holders: { account: string; amount: string; owner: string; ownerAccount: unknown }[]) {
  const { SOLANA_MAINNET_GENESIS } = await import('@xbam/upstream');
  const pool = 'Pool111111111111111111111111111111111111111';
  const lpBytes = Buffer.alloc(32);
  lpBytes[0] = 9;
  lpBytes[31] = 1;
  const poolData = Buffer.alloc(496);
  poolData.set(lpBytes, 464);
  const repeat = (value: unknown) => new Proxy([value], { get: (target, prop) => prop === 'shift' ? () => value : Reflect.get(target, prop) });
  rpcQueue = {
    getGenesisHash: repeat(SOLANA_MAINNET_GENESIS),
    getAccountInfo: [{ context: { slot: 1 }, value: { owner: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', executable: false, data: [poolData.toString('base64'), 'base64'] } }],
    getTokenSupply: [{ context: { slot: 1 }, value: { amount: '1000', decimals: 6 } }],
    getTokenLargestAccounts: [{ context: { slot: 1 }, value: holders.map(h => ({ address: h.account, amount: h.amount })) }],
    getMultipleAccounts: [
      { context: { slot: 1 }, value: holders.map(h => ({ data: { parsed: { info: { owner: h.owner } } } })) },
      { context: { slot: 1 }, value: holders.map(h => h.ownerAccount) },
    ],
  };
  responses['dexscreener.com'] = {
    status: 200,
    body: JSON.stringify({ pairs: [{ chainId: 'solana', pairAddress: pool, baseToken: { address: SOL_MINT }, quoteToken: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }, liquidity: { usd: 1000 } }] }),
  };
  responses['jup.ag'] = {
    status: 200,
    body: JSON.stringify([{ id: SOL_MINT, liquidity: 1000, updatedAt: new Date().toISOString(), firstPool: { createdAt: new Date().toISOString() }, audit: { topHoldersPercentage: 10, mintAuthorityDisabled: true, freezeAuthorityDisabled: true } }]),
  };
}

it('does not count LP in a Streamflow escrow token account as locked when its owner PDA has no account', async () => {
  // Real layout: the LP sits in the escrow token account, whose SPL owner is a PDA
  // derived from ["strm", metadata] and which has no account of its own. The metadata
  // account that holds end_time is not reachable from it, so a lock is not proved.
  const { registerSolanaUpstreams, registerMarketUpstreams } = await import('@xbam/upstream');
  const { resetLpCacheForTest } = await import('../../packages/runtime/src/lpLock');
  resetLpCacheForTest();
  registerSolanaUpstreams();
  registerMarketUpstreams();
  const escrowOwner = 'EscrowPda1111111111111111111111111111111111';
  await queueLpPool([
    { account: 'BurnAcct11111111111111111111111111111111111', amount: '700', owner: '1nc1nerator11111111111111111111111111111111',
      ownerAccount: { owner: '11111111111111111111111111111111', executable: false, data: ['', 'base64'] } },
    { account: 'EscrowTok1111111111111111111111111111111111', amount: '300', owner: escrowOwner, ownerAccount: null },
  ]);
  const capability = getCapability('token.inspect_risk')!;
  const answer = await capability.run(capability.input.parse({ chain: 'solana', address: SOL_MINT }) as never, context()) as RiskAnswer & { lp: { heldByContract: string[] } };
  expect(answer.cardReadings.find(r => r.label === 'LP burned')?.value).toBe(70);
  expect(answer.cardReadings.find(r => r.label === 'LP locked')?.value).toBe(0);
  expect(answer.lp?.heldByContract).toEqual([escrowOwner]);
});

it('retries a failed LP read after thirty seconds but keeps a good one for five minutes', async () => {
  const { registerSolanaUpstreams, registerMarketUpstreams } = await import('@xbam/upstream');
  const { resetLpCacheForTest, LP_UNAVAILABLE_CACHE_MS, LP_CACHE_MS } = await import('../../packages/runtime/src/lpLock');
  resetLpCacheForTest();
  registerSolanaUpstreams();
  registerMarketUpstreams();
  const capability = getCapability('token.inspect_risk')!;
  const run = () => capability.run(capability.input.parse({ chain: 'solana', address: SOL_MINT }) as never, context()) as Promise<RiskAnswer>;
  const start = Date.now();
  const clock = vi.spyOn(Date, 'now');
  try {
    clock.mockReturnValue(start);
    // No pool is indexed yet: unavailable.
    const { SOLANA_MAINNET_GENESIS } = await import('@xbam/upstream');
    rpcQueue = { getGenesisHash: new Proxy([SOLANA_MAINNET_GENESIS], { get: (t, p) => p === 'shift' ? () => SOLANA_MAINNET_GENESIS : Reflect.get(t, p) }) };
    expect((await run()).lp?.unavailable).toBe(true);

    // Inside the short window the failure is served from cache even though a good read is now possible.
    await queueLpPool([{ account: 'BurnAcct11111111111111111111111111111111111', amount: '1000', owner: '1nc1nerator11111111111111111111111111111111',
      ownerAccount: { owner: '11111111111111111111111111111111', executable: false, data: ['', 'base64'] } }]);
    clock.mockReturnValue(start + LP_UNAVAILABLE_CACHE_MS - 1_000);
    expect((await run()).lp?.unavailable).toBe(true);

    // Past it, the read is made again and succeeds.
    clock.mockReturnValue(start + LP_UNAVAILABLE_CACHE_MS + 1_000);
    expect((await run()).lp?.unavailable).toBe(false);

    // A success is not re-read inside five minutes.
    rpcQueue = {};
    clock.mockReturnValue(start + LP_UNAVAILABLE_CACHE_MS + LP_CACHE_MS - 1_000);
    expect((await run()).lp?.unavailable).toBe(false);
  } finally {
    clock.mockRestore();
  }
});

it('does not treat EVM mintability as proof of a disabled mint authority', async () => {
  responses = { token_security: security({ is_mintable: '0' }) };
  const answer = await inspect();
  expect(answer.cardReadings.find(r => r.label === 'Mint authority')?.value).toBeNull();
});

async function invoke(id: string, input: unknown): Promise<unknown> {
  const capability = getCapability(id);
  if (!capability) throw new Error(`${id} is not registered`);
  return capability.run(capability.input.parse(input) as never, context());
}

async function inspect(): Promise<RiskAnswer> {
  const capability = getCapability('token.inspect_risk')!;
  return capability.run(
    capability.input.parse({ chain: 'ethereum', address: TOKEN }) as never,
    context(),
  ) as Promise<RiskAnswer>;
}

/** A GoPlus body with whatever fields a case needs. */
function security(fields: Record<string, unknown>) {
  return { status: 200, body: JSON.stringify({ result: { [TOKEN.toLowerCase()]: fields } }) };
}

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
  resetCapabilitiesForTest();
  registerTokenRiskUpstreams();
  registerTokenRiskCapabilities();
  responses = {};
  rpcQueue = {};
});
afterEach(() => {
  resetUpstreamsForTest();
  resetCapabilitiesForTest();
});

describe('a field nobody checked', () => {
  it('is listed as not checked, and never reported as clean', async () => {
    // The empty string is the trap. `sell_tax: ""` means the service did not
    // look, and an agent told "sell tax 0%" would repeat that to somebody about
    // to buy.
    responses = {
      'gopluslabs.io': security({ buy_tax: '0', sell_tax: '', is_honeypot: '', holder_count: 42 }),
      'honeypot.is': { status: 200, body: JSON.stringify({ simulationSuccess: false }) },
    };
    const answer = await inspect();

    expect(answer.notChecked.join(' ')).toMatch(/Sell tax/);
    expect(answer.notChecked.join(' ')).toMatch(/Cannot be sold/);
    // And crucially, nothing claims a sell tax at all.
    expect(answer.observations.find((o) => o.what === 'Sell tax')).toBeUndefined();
    // The buy tax it *did* check is reported.
    expect(answer.observations.find((o) => o.what === 'Buy tax')?.detail).toBe('0%');
  });

  it('says a simulation that did not run taught it nothing', async () => {
    // Not "not a honeypot". A simulation that failed is silence.
    responses = {
      'gopluslabs.io': security({ buy_tax: '0' }),
      'honeypot.is': { status: 200, body: JSON.stringify({ simulationSuccess: false }) },
    };
    const answer = await inspect();
    expect(answer.notChecked.join(' ')).toMatch(/Whether it can be sold/);
    expect(answer.observations.find((o) => o.what === 'Could be sold again')).toBeUndefined();
  });
});

describe('what it will not say', () => {
  it('never produces a verdict, however bad the readings are', async () => {
    responses = {
      'gopluslabs.io': security({
        buy_tax: '0.99',
        sell_tax: '0.99',
        is_honeypot: '1',
        is_mintable: '1',
        hidden_owner: '1',
        can_take_back_ownership: '1',
        is_open_source: '0',
        creator_percent: '0.95',
      }),
      'honeypot.is': {
        status: 200,
        body: JSON.stringify({ simulationSuccess: true, honeypotResult: { isHoneypot: true } }),
      },
    };
    const answer = await inspect();

    const everything = JSON.stringify(answer).toLowerCase();
    // The two words that must never appear as a judgement.
    expect(everything).not.toMatch(/\bis a scam\b/);
    expect(everything).not.toMatch(/\bsafe to buy\b/);
    expect(everything).not.toMatch(/\bverdict\b/);
    expect(everything).not.toMatch(/\brug\b/);

    // What it does say: the readings, flagged as the sources flagged them.
    const flags = answer.observations.filter((o) => o.kind === 'FLAG');
    expect(flags.length).toBeGreaterThan(4);
    expect(answer.observations.every((o) => o.source.length > 0)).toBe(true);
  });

  it('carries its limitations every time, not only when something looks wrong', async () => {
    responses = {
      'gopluslabs.io': security({ buy_tax: '0', sell_tax: '0', is_honeypot: '0' }),
      'honeypot.is': {
        status: 200,
        body: JSON.stringify({ simulationSuccess: true, honeypotResult: { isHoneypot: false } }),
      },
    };
    const answer = await inspect();
    expect(answer.limitations.length).toBeGreaterThanOrEqual(3);
    expect(answer.limitations.join(' ')).toMatch(/not a judgement/i);
    // The one that matters most on a clean-looking token.
    expect(answer.limitations.join(' ')).toMatch(/can still lose money/i);
  });
});

describe('what each source actually said', () => {
  it('attributes every observation', async () => {
    responses = {
      'gopluslabs.io': security({ buy_tax: '0.05', holder_count: 1000 }),
      'honeypot.is': {
        status: 200,
        body: JSON.stringify({ simulationSuccess: true, simulationResult: { buyTax: 5, sellTax: 5 } }),
      },
    };
    const answer = await inspect();
    expect(answer.sourcesAnswering).toBe(2);
    // Both sources reported a buy tax and both readings survive, separately.
    const buys = answer.observations.filter((o) => o.what.startsWith('Buy tax'));
    expect(buys).toHaveLength(2);
    expect(new Set(buys.map((o) => o.source)).size).toBe(2);
  });

  it('says nothing was corroborated when only one source answered', async () => {
    responses = { 'gopluslabs.io': security({ buy_tax: '0' }) };
    const answer = await inspect();
    expect(answer.sourcesAnswering).toBe(1);
    expect(answer.limitations.join(' ')).toMatch(/nothing here has been corroborated/i);
  });

  it('treats a contract nobody has analysed as a finding of its own', async () => {
    // "Nobody has looked at this" is worth knowing about a token somebody is
    // being offered, and it is not the same as a clean report.
    responses = { 'gopluslabs.io': { status: 200, body: JSON.stringify({ result: {} }) } };
    const answer = await inspect();
    expect(answer.observations.find((o) => o.what === 'Never analysed')?.kind).toBe('FLAG');
  });
});

/** The 20-field record the address endpoint returns, all noughts by default. */
function addressRecord(overrides: Record<string, string> = {}) {
  const base: Record<string, string> = {
    cybercrime: '0',
    money_laundering: '0',
    number_of_malicious_contracts_created: '0',
    gas_abuse: '0',
    financial_crime: '0',
    darkweb_transactions: '0',
    reinit: '0',
    phishing_activities: '0',
    contract_address: '0',
    fake_kyc: '0',
    blacklist_doubt: '0',
    fake_standard_interface: '0',
    data_source: '',
    stealing_attack: '0',
    blackmail_activities: '0',
    sanctioned: '0',
    malicious_mining_activities: '0',
    mixer: '0',
    fake_token: '0',
    honeypot_related_address: '0',
  };
  return JSON.stringify({ code: 1, message: 'ok', result: { ...base, ...overrides } });
}

describe('an address in a list of known bad addresses', () => {
  it('reports what is recorded, and credits whoever recorded it', async () => {
    // The shape the live service returns for the Ronin bridge exploiter.
    responses = {
      'address_security': {
        status: 200,
        body: addressRecord({
          sanctioned: '1',
          stealing_attack: '1',
          blacklist_doubt: '1',
          data_source: 'SlowMist,BlockSec',
        }),
      },
    };
    const answer = (await invoke('address.risk_evidence', { chain: 'ethereum', address: TOKEN })) as {
      matched: boolean;
      observations: { what: string; detail: string; source: string; kind: string }[];
      recordedBy: string | null;
    };

    expect(answer.matched).toBe(true);
    expect(answer.observations.map((o) => o.what).sort()).toEqual(['Sanctions list', 'Suspected', 'Theft']);
    // Every claim is somebody's, and the somebody is named.
    expect(answer.recordedBy).toBe('SlowMist,BlockSec');
    expect(answer.observations[0]!.source).toMatch(/citing SlowMist,BlockSec/);
  });

  /**
   * The property this capability exists to get right.
   *
   * Probed September 2026: the Uniswap V2 router, which every security service
   * has looked at, returns every field nought and no data source -- exactly
   * like an address that has never been used. There is no field that tells
   * those apart, so a nought must never become "not sanctioned".
   */
  it('does not turn an empty record into a clean bill', async () => {
    responses = { 'address_security': { status: 200, body: addressRecord() } };
    const answer = (await invoke('address.risk_evidence', { chain: 'ethereum', address: TOKEN })) as {
      matched: boolean;
      observations: unknown[];
      recordedBy: string | null;
      limitations: string[];
    };

    expect(answer.matched).toBe(false);
    // Nothing is asserted about it. In particular there is no observation
    // saying "not sanctioned", which is a clearance no source has given.
    expect(answer.observations).toEqual([]);
    expect(answer.recordedBy).toBeNull();
    expect(answer.limitations.join(' ')).toMatch(/not the same as it having been checked and found safe/i);
    expect(answer.limitations.join(' ')).toMatch(/new or unreported address looks exactly like a clean one/i);
  });

  it('says the limitations even when something did match', async () => {
    // A caveat that appears only on the reassuring answer trains a reader to
    // treat its absence as confidence.
    responses = {
      'address_security': { status: 200, body: addressRecord({ phishing_activities: '1', data_source: 'SlowMist' }) },
    };
    const answer = (await invoke('address.risk_evidence', { chain: 'ethereum', address: TOKEN })) as {
      limitations: string[];
    };
    expect(answer.limitations.length).toBeGreaterThan(0);
    expect(answer.limitations.join(' ')).toMatch(/Nothing here is a judgement that an address is safe or unsafe/i);
    expect(answer.limitations.join(' ')).toMatch(/shared by everybody who uses it/i);
  });

  it('does not treat being a contract as something recorded against it', async () => {
    // Every contract on the chain sets this. Counting it as a match would make
    // the whole capability answer "matched" for all of them.
    responses = { 'address_security': { status: 200, body: addressRecord({ contract_address: '1' }) } };
    const answer = (await invoke('address.risk_evidence', { chain: 'ethereum', address: TOKEN })) as {
      matched: boolean;
      isContract: boolean | null;
      observations: unknown[];
    };
    expect(answer.matched).toBe(false);
    expect(answer.observations).toEqual([]);
    // Still reported, because it is a useful fact -- just not a mark against it.
    expect(answer.isContract).toBe(true);
  });

  it('counts deployed malicious contracts as a match even with no other flag', async () => {
    responses = {
      'address_security': { status: 200, body: addressRecord({ number_of_malicious_contracts_created: '4' }) },
    };
    const answer = (await invoke('address.risk_evidence', { chain: 'ethereum', address: TOKEN })) as {
      matched: boolean;
      observations: { what: string; detail: string }[];
    };
    expect(answer.matched).toBe(true);
    expect(answer.observations[0]!.what).toBe('Malicious contracts deployed');
    expect(answer.observations[0]!.detail).toMatch(/4 recorded/);
  });

  it('reports an address the source has an entry for but no flag on', async () => {
    // A data source with nothing set is still an entry, and saying "no match"
    // about it would be wrong in the other direction.
    responses = { 'address_security': { status: 200, body: addressRecord({ data_source: 'SlowMist' }) } };
    const answer = (await invoke('address.risk_evidence', { chain: 'ethereum', address: TOKEN })) as {
      matched: boolean;
      limitations: string[];
    };
    expect(answer.matched).toBe(true);
    expect(answer.limitations.join(' ')).not.toMatch(/does not appear in the known-malicious lists/i);
  });

  it('refuses something that is not an address', async () => {
    await expect(invoke('address.risk_evidence', { chain: 'ethereum', address: 'vitalik.eth' })).rejects.toThrow();
  });
});
