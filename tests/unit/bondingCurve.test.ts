import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderEvidenceCard, type CardReading } from '@xbam/prompts';
import {
  KNOWN_CURVE, KNOWN_POOL, LIVE_CURVE_ADDRESS, LIVE_CURVE_BASE64, LIVE_CURVE_MINT, PUMP_AMM_PROGRAM, PUMP_PROGRAM, curveBytes, toBase64,
} from '../support/curveFixtures';

/**
 * Where a Pump.fun token stands on its bonding curve.
 *
 * What is pinned: the curve and pool addresses are the ones a real launch has
 * (checked against the addresses DexScreener lists), the account decodes from a
 * real mainnet account, progress is integer arithmetic that never leaves 0 to
 * 100 percent, a mint on no curve is never 0 percent, and nothing the module
 * says can be read as a verdict or advice.
 */

let replies: Record<string, unknown[]> = {};
let calls: { method: string; params: unknown[] }[] = [];

vi.mock('undici', () => ({
  Agent: class { async close() {} },
  async fetch(_input: unknown, init: { body?: string }) {
    const request = JSON.parse(init.body ?? '{}') as { method: string; params?: unknown[] };
    calls.push({ method: request.method, params: request.params ?? [] });
    const queue = replies[request.method] ?? [];
    const result = queue.length > 1 ? queue.shift() : queue[0];
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: result ?? null }), {
      status: 200, headers: new Headers({ 'content-type': 'application/json' }),
    });
  },
}));

const upstream = await import('@xbam/upstream');
const runtime = await import('@xbam/runtime');
const { getCapability, resetCapabilitiesForTest } = await import('@xbam/tools');
const {
  NOT_ON_A_CURVE, PUMP_INITIAL_REAL_TOKEN, PUMP_TARGET_LAMPORTS, bondingCurveAddress, canonicalPumpPoolAddress, curveProgress,
  curveStatement, curveStatusForQuote, decodeBondingCurve, percentText, readBondingCurve, solText, studioCurvePayload,
} = runtime;

const account = (owner: string, bytes: Uint8Array | string, slot = 100) => ({
  context: { slot }, value: { lamports: 1, owner, executable: false, space: 166, data: [typeof bytes === 'string' ? bytes : toBase64(bytes), 'base64'] },
});

beforeEach(() => {
  upstream.resetUpstreamsForTest(); upstream.resetBreakerForTest(); upstream.resetCacheForTest(); upstream.resetLimiterForTest();
  resetCapabilitiesForTest(); upstream.registerSolanaUpstreams(); runtime.registerSolanaCapabilities();
  calls = [];
  replies = { getGenesisHash: [upstream.SOLANA_MAINNET_GENESIS] };
});
afterEach(() => { upstream.resetUpstreamsForTest(); resetCapabilitiesForTest(); });

const BANNED = /\b(?:ape|send it|moon|about to bond|dev holding|dump|safe|scam|rug|buy|sell|bullish|bearish)\b/i;

describe('addresses are derived, not remembered', () => {
  it('reproduces the curve address a real launch has', () => {
    expect(bondingCurveAddress(KNOWN_CURVE.mint)).toBe(KNOWN_CURVE.curve);
    expect(bondingCurveAddress(LIVE_CURVE_MINT)).toBe(LIVE_CURVE_ADDRESS);
  });
  it('reproduces the canonical pool a migrated launch has', () => {
    expect(canonicalPumpPoolAddress(KNOWN_POOL.mint)).toBe(KNOWN_POOL.pool);
  });
  it('gives nothing for something that is not a 32 byte address', () => {
    expect(bondingCurveAddress('nonsense')).toBeNull();
    expect(canonicalPumpPoolAddress('0OIl')).toBeNull();
  });
  it('names the programs it was checked against', () => {
    expect(PUMP_PROGRAM).toBe('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    expect(PUMP_AMM_PROGRAM).toBe('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
  });
});

describe('decoding a curve account', () => {
  it('reads a real mainnet account', () => {
    const curve = decodeBondingCurve(new Uint8Array(Buffer.from(LIVE_CURVE_BASE64, 'base64')))!;
    expect(curve.realTokenReserves).toBe(320_839_194_420_897n);
    expect(curve.realQuoteReserves).toBe(23_583_985_641n);
    expect(curve.virtualTokenReserves).toBe(600_739_194_420_897n);
    expect(curve.virtualQuoteReserves).toBe(53_583_985_641n);
    expect(curve.tokenTotalSupply).toBe(1_000_000_000_000_000n);
    expect(curve.complete).toBe(false);
    expect(upstream.isAddress(curve.creator!)).toBe(true);
    expect(curve.quoteMint).toBeNull();
  });
  it('refuses bytes that are not a curve', () => {
    expect(decodeBondingCurve(new Uint8Array(20))).toBeNull();
    expect(decodeBondingCurve(curveBytes({ discriminator: [1, 2, 3, 4, 5, 6, 7, 8] }))).toBeNull();
    expect(decodeBondingCurve(curveBytes({ complete: 2 }))).toBeNull();
  });
  it('leaves the creator absent on an account too short to hold one, rather than inventing it', () => {
    const curve = decodeBondingCurve(curveBytes({ length: 49 }))!;
    expect(curve.creator).toBeNull();
    expect(curve.quoteMint).toBeNull();
  });
});

describe('progress is integer arithmetic bounded to the curve', () => {
  const curve = (over: Parameters<typeof curveBytes>[0]) => decodeBondingCurve(curveBytes(over))!;
  it('is the share of the launch allocation already sold, cut down never up', () => {
    // Half of 793.1 million sold.
    expect(curveProgress(curve({ realToken: PUMP_INITIAL_REAL_TOKEN / 2n })).progressBps).toBe(5000);
    // 472260805579103 of 793100000000000 is 59.548...%, shown as 59.5 and never as 59.6.
    const live = decodeBondingCurve(new Uint8Array(Buffer.from(LIVE_CURVE_BASE64, 'base64')))!;
    const bps = curveProgress(live).progressBps!;
    expect(bps).toBe(5954);
    expect(percentText(bps)).toBe('59.5');
  });
  it('is a measured nought for a launch nobody has bought into, and exactly 100 for a complete curve', () => {
    expect(curveProgress(curve({ realToken: PUMP_INITIAL_REAL_TOKEN })).progressBps).toBe(0);
    expect(curveProgress(curve({ realToken: 0n, complete: 1 })).progressBps).toBe(10_000);
    expect(curveProgress(curve({ realToken: 123n, complete: 1 })).progressBps).toBe(10_000);
  });
  it('never leaves 0 to 100 percent whatever the account says', () => {
    for (const realToken of [0n, 1n, PUMP_INITIAL_REAL_TOKEN - 1n, PUMP_INITIAL_REAL_TOKEN, PUMP_INITIAL_REAL_TOKEN + 1n, 2n ** 64n - 1n]) {
      const { progressBps } = curveProgress(curve({ realToken }));
      if (progressBps !== null) { expect(progressBps).toBeGreaterThanOrEqual(0); expect(progressBps).toBeLessThanOrEqual(10_000); }
    }
  });
  it('gives no percentage for a curve that is not Pump\'s documented launch, and says why', () => {
    const more = curveProgress(curve({ realToken: PUMP_INITIAL_REAL_TOKEN + 1n }));
    expect(more.progressBps).toBeNull();
    expect(more.notes.join(' ')).toMatch(/does not match/);
    expect(curveProgress(curve({ supply: 2_000_000_000_000_000n })).progressBps).toBeNull();
  });
  it('targets the SOL a full curve holds, about 85, from the documented parameters', () => {
    expect(PUMP_TARGET_LAMPORTS).toBe(85_005_359_057n);
    expect(solText(PUMP_TARGET_LAMPORTS)).toBe('85');
    expect(solText(23_583_985_641n)).toBe('23.58');
    expect(solText(0n)).toBe('0');
  });
});

describe('reading one mint', () => {
  const liveReader = (owner = PUMP_PROGRAM) => async () => ({
    exists: true, owner, data: new Uint8Array(Buffer.from(LIVE_CURVE_BASE64, 'base64')), slot: 469_824_739, source: 'solana_mainnet.official', fetchedAt: '2026-11-15T12:00:00.000Z',
  });

  it('reports a pre-graduation curve in the fixed template', async () => {
    const read = await readBondingCurve(LIVE_CURVE_MINT, { read: liveReader() });
    expect(read.status).toBe('FOUND');
    expect(curveStatement(read)).toBe('Bonding curve: 59.5% [collected: 23.58 SOL; target: 85 SOL; source: solana.read_bonding_curve]');
  });

  it('reports a graduated curve with the pool and the slot', async () => {
    const reads: string[] = [];
    const read = await readBondingCurve(KNOWN_POOL.mint, {
      read: async (address) => {
        reads.push(address);
        if (address === KNOWN_POOL.pool) return { exists: true, owner: PUMP_AMM_PROGRAM, data: new Uint8Array(10), slot: 7, source: 's', fetchedAt: 'now' };
        return { exists: true, owner: PUMP_PROGRAM, data: curveBytes({ realToken: 0n, complete: 1 }), slot: 7, source: 's', fetchedAt: 'now' };
      },
    });
    expect(curveStatement(read)).toBe(`Status: graduated [DEX pool: ${KNOWN_POOL.pool}, slot: 7]`);
    expect(reads).toEqual([bondingCurveAddress(KNOWN_POOL.mint), KNOWN_POOL.pool]);
    expect(studioCurvePayload(read)).toEqual({ curveState: 'GRADUATED', progressPct: 100, solReserves: '10000000000', targetSol: '85005359057', migratedPool: KNOWN_POOL.pool });
  });

  it('says a complete curve\'s pool was not found, instead of inventing one or reading it as zero', async () => {
    const read = await readBondingCurve(KNOWN_POOL.mint, {
      read: async (address) => address === KNOWN_POOL.pool
        ? { exists: false, owner: null, data: null, slot: 7, source: 's', fetchedAt: 'now' }
        : { exists: true, owner: PUMP_PROGRAM, data: curveBytes({ realToken: 0n, complete: 1 }), slot: 7, source: 's', fetchedAt: 'now' },
    });
    expect(curveStatement(read)).toBe('Status: graduated [DEX pool: not found at the canonical address, slot: 7]');
    expect(studioCurvePayload(read)!.migratedPool).toBeNull();
  });

  it('is not on a recognized curve when there is no account, when another program owns it, and when it is not shaped like one', async () => {
    const none = await readBondingCurve(LIVE_CURVE_MINT, { read: async () => ({ exists: false, owner: null, data: null, slot: 1, source: 's', fetchedAt: 'now' }) });
    const foreign = await readBondingCurve(LIVE_CURVE_MINT, { read: liveReader('11111111111111111111111111111111') });
    const shapeless = await readBondingCurve(LIVE_CURVE_MINT, { read: async () => ({ exists: true, owner: PUMP_PROGRAM, data: new Uint8Array(166), slot: 1, source: 's', fetchedAt: 'now' }) });
    for (const read of [none, foreign, shapeless]) {
      expect(read.status).toBe('NOT_ON_CURVE');
      expect(curveStatement(read)).toBe('not on a recognized bonding curve');
      expect(curveStatement(read)).not.toMatch(/%|0/);
      expect(studioCurvePayload(read)).toBeNull();
    }
  });

  it('lets a failed read fail, so it is never reported as not on a curve', async () => {
    await expect(readBondingCurve(LIVE_CURVE_MINT, { read: async () => { throw new Error('rpc down'); } })).rejects.toThrow('rpc down');
  });

  it('gives the Studio payload shape, with progress as a number between 0 and 100', async () => {
    const payload = studioCurvePayload(await readBondingCurve(LIVE_CURVE_MINT, { read: liveReader() }))!;
    expect(payload).toEqual({ curveState: 'ACTIVE', progressPct: 59.5, solReserves: '23583985641', targetSol: '85005359057', migratedPool: null });
  });

  it('never words anything as a verdict or advice', async () => {
    const reads = [
      await readBondingCurve(LIVE_CURVE_MINT, { read: liveReader() }),
      await readBondingCurve(KNOWN_POOL.mint, { read: async () => ({ exists: true, owner: PUMP_PROGRAM, data: curveBytes({ realToken: 0n, complete: 1 }), slot: 7, source: 's', fetchedAt: 'now' }) }),
      await readBondingCurve(LIVE_CURVE_MINT, { read: async () => ({ exists: false, owner: null, data: null, slot: 1, source: 's', fetchedAt: 'now' }) }),
    ];
    for (const read of reads) expect(curveStatement(read)).not.toMatch(BANNED);
    expect(NOT_ON_A_CURVE).not.toMatch(BANNED);
  });
});

describe('a curve-phase quote resolves to a status, not an error', () => {
  const MINT = { kind: 'ONCHAIN' as const, network: 'solana' as const, address: LIVE_CURVE_MINT, decimals: 6 };
  it('reads Pump\'s curve for a solana curve quote', async () => {
    const status = await curveStatusForQuote({ phase: 'CURVE', asset: MINT, network: 'solana' }, {
      read: async () => ({ exists: true, owner: PUMP_PROGRAM, data: new Uint8Array(Buffer.from(LIVE_CURVE_BASE64, 'base64')), slot: 1, source: 's', fetchedAt: 'now' }),
    });
    expect(status).toMatchObject({ phase: 'CURVE', recognized: true, platform: 'Pump' });
    expect(status!.statement).toMatch(/^Bonding curve: 59\.5% /);
  });
  it('says an unknown launchpad is not on a recognized curve, never 0%', async () => {
    const other = await curveStatusForQuote({ phase: 'CURVE', asset: { ...MINT, network: 'robinhood' as never }, network: 'robinhood' as never });
    expect(other).toMatchObject({ recognized: false, platform: null, statement: 'not on a recognized bonding curve' });
    const absent = await curveStatusForQuote({ phase: 'CURVE', asset: MINT, network: 'solana' }, {
      read: async () => ({ exists: false, owner: null, data: null, slot: 1, source: 's', fetchedAt: 'now' }),
    });
    expect(absent).toMatchObject({ recognized: false, statement: 'not on a recognized bonding curve' });
  });
  it('is not asked about a pool or a broker', async () => {
    expect(await curveStatusForQuote({ phase: 'POOL', asset: MINT, network: 'solana' })).toBeNull();
    expect(await curveStatusForQuote({ phase: 'BROKER', asset: MINT, network: 'solana' })).toBeNull();
  });
});

describe('the solana.read_bonding_curve capability', () => {
  const run = (input: unknown) => {
    const capability = getCapability('solana.read_bonding_curve')!;
    return capability.run(capability.input.parse(input) as never, {
      agentId: 'a', jobId: null, accountId: null, config: {}, signal: new AbortController().signal,
      logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as never,
    }) as Promise<Record<string, unknown>>;
  };

  it('is registered as a read the model may call, and takes only an exact mint', () => {
    const capability = getCapability('solana.read_bonding_curve')!;
    expect(capability).toMatchObject({ category: 'READ', effect: 'READ', risk: 'LOW', modelCallable: true });
    expect(capability.input.safeParse({ mint: 'nonsense' }).success).toBe(false);
    expect(capability.input.safeParse({ mint: LIVE_CURVE_MINT }).success).toBe(true);
  });

  it('is on the utility allowlist next to the other Solana reads', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('packages/runtime/src/utilityCapabilities.ts', 'utf8')).toContain("'solana.read_bonding_curve'");
  });

  it('reads the derived curve account and answers in the template', async () => {
    replies.getAccountInfo = [account(PUMP_PROGRAM, LIVE_CURVE_BASE64, 469_824_739)];
    const answer = await run({ mint: LIVE_CURVE_MINT });
    expect(calls.filter(c => c.method === 'getAccountInfo')[0]!.params[0]).toBe(LIVE_CURVE_ADDRESS);
    expect(answer).toMatchObject({ recognized: true, platform: 'Pump', curveState: 'ACTIVE', progressPct: 59.5, collectedLamports: '23583985641', migratedPool: null, slot: 469_824_739 });
    expect(answer.statement).toBe('Bonding curve: 59.5% [collected: 23.58 SOL; target: 85 SOL; source: solana.read_bonding_curve]');
  });

  it('answers not on a recognized bonding curve for a mint with no curve, with no percentage at all', async () => {
    replies.getAccountInfo = [null];
    const answer = await run({ mint: LIVE_CURVE_MINT });
    expect(answer).toMatchObject({ recognized: false, platform: null, curveState: null, progressPct: null, statement: 'not on a recognized bonding curve' });
  });
});

describe('the evidence card line', () => {
  const reading: CardReading = { label: 'Liquidity', value: 12_000, unit: 'USD', source: 'solana_tokens.jupiter', fetchedAt: new Date().toISOString(), observedAt: new Date().toISOString(), maxAgeMs: 300_000 };
  const curve = { state: 'ACTIVE' as const, progressBps: 5954, collectedLamports: '23583985641', targetLamports: '85005359057', pool: null, slot: 5, source: 'solana.read_bonding_curve' };

  it('adds one line to the card and leaves every other line as it was', () => {
    const plain = renderEvidenceCard([reading], '');
    const withCurve = renderEvidenceCard([reading], '', Date.now(), '', null, curve);
    expect(withCurve.split('\n').filter(line => !line.startsWith('Bonding curve:')).join('\n')).toBe(plain);
    expect(withCurve).toContain('Bonding curve: 59.5% [collected: 23.58 SOL; target: 85 SOL; source: solana.read_bonding_curve]');
    expect(withCurve).not.toMatch(BANNED);
  });
  it('renders a graduated curve and an unmeasured figure without a zero', () => {
    expect(renderEvidenceCard([reading], '', Date.now(), '', null, { ...curve, state: 'GRADUATED', pool: 'PoolAddr1', slot: 9 })).toContain('Status: graduated [DEX pool: PoolAddr1, slot: 9]');
    const unread = renderEvidenceCard([reading], '', Date.now(), '', null, { ...curve, progressBps: null, collectedLamports: null, targetLamports: null });
    expect(unread).toContain('Bonding curve: unavailable [collected: unavailable SOL; target: unavailable SOL;');
  });
  it('is not a card field, so the five labels Studio\'s card image accepts stay five', async () => {
    const { CARD_FIELD_LABELS } = await import('../../packages/runtime/src/studioEvidenceCardImage');
    expect([...CARD_FIELD_LABELS]).toEqual(['Liquidity', 'Top holders', 'Mint authority', 'Freeze authority', 'Pool age']);
  });
});

describe('asking about the curve is routed to the chain', () => {
  it('routes a curve or graduation question that names a mint', () => {
    const asked = (text: string) => runtime.whatToResearch({ incoming: text, parent: null, parentIsOwn: false, links: [], hasUnreadMedia: false });
    for (const text of [`how close to bonding is ${LIVE_CURVE_MINT}?`, `did it graduate? ${LIVE_CURVE_MINT}`, `${LIVE_CURVE_MINT} curve progress`, `has it bonded yet ${LIVE_CURVE_MINT}`]) {
      const lookup = asked(text).find(l => l.kind === 'curve');
      expect(lookup?.query, text).toBe(LIVE_CURVE_MINT);
    }
  });
  it('does not route a question that is not about a curve, or one with no mint to read', () => {
    const asked = (text: string) => runtime.whatToResearch({ incoming: text, parent: null, parentIsOwn: false, links: [], hasUnreadMedia: false });
    expect(asked(`what is ${LIVE_CURVE_MINT}?`).some(l => l.kind === 'curve')).toBe(false);
    expect(asked('how is the bond market doing today?').some(l => l.kind === 'curve')).toBe(false);
    expect(asked('did it graduate?').some(l => l.kind === 'curve')).toBe(false);
  });
  it('answers a curve lookup from the chain and carries the statement as a sourced finding', async () => {
    replies.getAccountInfo = [account(PUMP_PROGRAM, LIVE_CURVE_BASE64)];
    const result = await runtime.research([{ kind: 'curve', query: LIVE_CURVE_MINT, reason: 'asked' }]);
    expect(result.failed).toEqual([]);
    expect(result.findings[0]).toMatchObject({ kind: 'curve', source: 'solana.read_bonding_curve' });
    expect(result.findings[0]!.summary).toMatch(/^Bonding curve: 59\.5% /);
    // Switched off with market data, and said so rather than skipped.
    const off = await runtime.research([{ kind: 'curve', query: LIVE_CURVE_MINT, reason: 'asked' }], { sources: { market: false } });
    expect(off.findings).toEqual([]);
    expect(off.failed[0]!.reason).toMatch(/market data/);
  });
  it('reports a failed read as a gap, never as not on a curve', async () => {
    replies.getAccountInfo = [new Error('network down')];
    const result = await runtime.research([{ kind: 'curve', query: LIVE_CURVE_MINT, reason: 'asked' }]);
    expect(result.findings).toEqual([]);
    expect(result.failed[0]!.reason).toMatch(/could not be read/);
  });
});
