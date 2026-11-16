import { beforeEach, describe, expect, it } from 'vitest';
import {
  holderMapBannedWord, holderMapCaption, renderHolderMapLines,
  HOLDER_MAP_EXCLUSION, HOLDER_MAP_NOT_PROOF, HOLDER_MAP_NOT_READ, HOLDER_MAP_SHARED_SERVICE, HOLDER_MAP_TITLE,
  type HolderMapOnCard,
} from '@xbam/prompts';
import {
  buildHolderMap, firstFundingFromTransaction, holderMapDraftRefusal, holderMapRequested, MAX_HOLDER_MAP_HOLDERS,
  type HolderReadInput,
} from '../../packages/runtime/src/holderMap';
import { readHolderFunding, resetHolderMapCacheForTest } from '../../packages/runtime/src/solanaCapabilities';

const READ_AT = '2026-11-15T14:00:00.000Z';
const SOURCE = 'solana_mainnet.test';
const row = (n: number, over: Partial<HolderReadInput> = {}): HolderReadInput => ({
  owner: `W${n}`, tokenAccount: `T${n}`, sharePct: 10 - n, kind: 'WALLET', readAt: READ_AT,
  funding: { state: 'read', funder: `F${n}`, funderIsProgram: false }, ...over,
});
const shared = (funder: string): Partial<HolderReadInput> => ({ funding: { state: 'read', funder, funderIsProgram: false } });
const build = (holders: HolderReadInput[]) => buildHolderMap({ mint: 'M', readAt: READ_AT, source: SOURCE, holders });

describe('same-funder grouping', () => {
  it('joins two or more accounts whose first funding address is the same, and nobody else', () => {
    const view = build([row(1, shared('X')), row(2), row(3, shared('X')), row(4, shared('Y')), row(5, shared('Y')), row(6, shared('Z'))]);
    expect(view.holders.map(h => [h.funding, h.group])).toEqual([
      ['grouped', 'g1'], ['single', null], ['grouped', 'g1'], ['grouped', 'g2'], ['grouped', 'g2'], ['single', null],
    ]);
    expect(view.groups).toEqual([{ id: 'g1', size: 2 }, { id: 'g2', size: 2 }]);
  });

  it('never lets one account stand as a group, and never exposes the funding address', () => {
    const view = build([row(1), row(2)]);
    expect(view.groups).toEqual([]);
    expect(JSON.stringify(view)).not.toMatch(/F1|F2/);
  });

  it('gives the same read the same ids, in ranking order', () => {
    const holders = [row(1, shared('B')), row(2, shared('A')), row(3, shared('A')), row(4, shared('B'))];
    expect(build(holders)).toEqual(build(holders));
    expect(build(holders).holders[0]!.group).toBe('g1');
  });

  it('leaves out program-owned accounts and accounts first funded by a program, and says so', () => {
    const view = build([
      row(1, { kind: 'PROGRAM', funding: undefined }),
      row(2, { funding: { state: 'read', funder: 'X', funderIsProgram: true } }),
      row(3, { funding: { state: 'read', funder: 'X', funderIsProgram: true } }),
      row(4, shared('Q')), row(5, shared('Q')),
    ]);
    expect(view.holders.map(h => h.funding)).toEqual(['excluded', 'excluded', 'excluded', 'grouped', 'grouped']);
    expect(view.groups).toEqual([{ id: 'g1', size: 2 }]);
    expect(renderHolderMapLines({ form: 'full', view }).join('\n')).toContain(`${HOLDER_MAP_EXCLUSION} (3 here).`);
  });

  it('keeps a failed funding read as unavailable, never as not grouped', () => {
    const view = build([row(1, shared('X')), row(2, { funding: { state: 'unavailable', reason: 'read failed' } }), row(3, shared('X')), row(4, { kind: 'UNKNOWN', funding: undefined })]);
    expect(view.holders.map(h => h.funding)).toEqual(['grouped', 'unavailable', 'grouped', 'unavailable']);
    const text = renderHolderMapLines({ form: 'full', view }).join('\n');
    expect(text).toContain('funding unavailable');
    expect(text).not.toMatch(/#2 [^\n]*not shared/);
  });

  it('draws at most twelve accounts', () => {
    const view = build(Array.from({ length: 20 }, (_, i) => row(i + 1, { sharePct: 1 })));
    expect(view.holders).toHaveLength(MAX_HOLDER_MAP_HOLDERS);
  });
});

describe('absent is never zero', () => {
  it('lists an unread supply percent under not read and never draws it', () => {
    const view = build([row(1), row(2, { sharePct: null }), row(3, { sharePct: Number.NaN }), row(4, { sharePct: 140 })]);
    expect(view.holders.map(h => h.address)).toEqual(['W1']);
    expect(view.notRead).toEqual(['W2', 'W3', 'W4']);
    const lines = renderHolderMapLines({ form: 'full', view });
    expect(lines.join('\n')).toContain('Not read: 3 accounts, supply percent was not available.');
    expect(lines.join('\n')).not.toMatch(/#2 /);
    expect(lines.join('\n')).not.toContain('0.00%');
  });

  it('says funding was not read, rather than that nothing is shared, when no funding was read', () => {
    const view = build([row(1, { funding: { state: 'unavailable', reason: 'read failed' } }), row(2, { funding: { state: 'unavailable', reason: 'read failed' } })]);
    const text = renderHolderMapLines({ form: 'full', view }).join('\n');
    expect(text).toContain('Funding was not read for these accounts, so no grouping is shown.');
    expect(text).not.toContain('No two accounts show');
  });

  it('says nothing is shared only when funding was read and no two matched', () => {
    expect(renderHolderMapLines({ form: 'full', view: build([row(1), row(2)]) }).join('\n')).toContain('No two accounts show the same first funding address in this read.');
  });

  it('states the map could not be read instead of saying nothing', () => {
    expect(renderHolderMapLines({ form: 'note', view: null })).toEqual([HOLDER_MAP_NOT_READ]);
  });
});

describe('wording', () => {
  const view = build([row(1, shared('X')), row(2, shared('X')), row(3, { kind: 'PROGRAM', funding: undefined }), row(4, { sharePct: null }), row(5, { funding: { state: 'unavailable', reason: 'read failed' } })]);
  const forms: HolderMapOnCard[] = [{ form: 'full', view }, { form: 'compact', view }, { form: 'note', view: null }];

  it('carries the fixed caption, the not-a-proof line, the read time and the source', () => {
    const full = renderHolderMapLines(forms[0]!).join('\n');
    expect(full).toContain(holderMapCaption(READ_AT, SOURCE));
    expect(full).toContain('Same first funding address, read at 2026-11-15T14:00:00.000Z, from solana_mainnet.test.');
    expect(full).toContain(HOLDER_MAP_NOT_PROOF);
    expect(full).toContain(HOLDER_MAP_SHARED_SERVICE);
    expect(full).toContain(HOLDER_MAP_TITLE);
    const compact = renderHolderMapLines(forms[1]!).join('\n');
    expect(compact).toContain(READ_AT);
    expect(compact).toContain(SOURCE);
    expect(compact).toContain(HOLDER_MAP_NOT_PROOF);
    expect(compact.split('\n')).toHaveLength(1);
  });

  it('never uses a word that reads as an accusation or a recommendation, in any form or constant', () => {
    const everything = [...forms.flatMap(renderHolderMapLines), HOLDER_MAP_EXCLUSION, HOLDER_MAP_NOT_PROOF, HOLDER_MAP_SHARED_SERVICE, HOLDER_MAP_NOT_READ, HOLDER_MAP_TITLE].join('\n');
    expect(holderMapBannedWord(everything)).toBeNull();
    for (const word of ['bundle', 'bundled', 'sybil', 'insider', 'dev wallet', 'dev-wallet', 'rug', 'rugged', 'scam', 'safe', 'unsafe', 'safely', 'smart money', 'whale', 'cabal', 'buy', 'sell', 'bullish', 'avoid']) {
      expect(holderMapBannedWord(`This is ${word} here`), word).not.toBeNull();
    }
    // Ordinary words that merely contain a banned one are not banned.
    expect(holderMapBannedWord('a trugger, a carugs and a buyer-free place')).toBeNull();
  });

  it('names no person, handle or funding address', () => {
    const everything = forms.flatMap(renderHolderMapLines).join('\n');
    expect(everything).not.toMatch(/@\w|\bF1\b|\bF2\b/);
  });
});

describe('a rewrite cannot drop what makes the map a reading', () => {
  const view = build([row(1, shared('X')), row(2, shared('X')), row(3)]);
  const card = (extra: string[]) => ['Token evidence', 'not a verdict, reads can be wrong', ...extra].join('\n');
  const full = card(renderHolderMapLines({ form: 'full', view }));
  const compact = card(renderHolderMapLines({ form: 'compact', view }));

  it('accepts the rendered map', () => {
    expect(holderMapDraftRefusal(view, 'full', full)).toBeNull();
    expect(holderMapDraftRefusal(view, 'compact', compact)).toBeNull();
  });

  it.each([
    ['a percent figure', (t: string) => t.replace('9.00%', 'a lot')],
    ['the read time', (t: string) => t.replaceAll(READ_AT, 'recently')],
    ['the source', (t: string) => t.replaceAll(SOURCE, 'somewhere')],
    ['the not-a-verdict line', (t: string) => t.replace('not a verdict, reads can be wrong', 'fine')],
    ['the not-a-proof line', (t: string) => t.replace(HOLDER_MAP_NOT_PROOF, '')],
  ])('refuses a draft without %s', (_name, drop) => {
    expect(holderMapDraftRefusal(view, 'full', drop(full))).toEqual(expect.any(String));
  });

  it('refuses a banned word anywhere, and does not require percents of the compact form', () => {
    expect(holderMapDraftRefusal(view, 'full', `${full}\nlooks like a bundle`)).toMatch(/bundle/);
    expect(holderMapDraftRefusal(view, 'compact', `${compact}\nthis is safe`)).toMatch(/safe/);
    expect(holderMapDraftRefusal(view, 'compact', compact.replace(HOLDER_MAP_NOT_PROOF, ''))).toEqual(expect.any(String));
  });
});

describe('what the first transaction says about who paid', () => {
  const tx = (over: Record<string, unknown> = {}) => ({
    meta: { err: null, preBalances: [10_000_000, 0, 1], postBalances: [4_999_000, 5_000_000, 1], ...over },
    transaction: { message: { accountKeys: ['funder', 'wallet', 'sys'], header: { numRequiredSignatures: 1 } } },
  });
  it('reads the signer whose balance fell as the one who paid', () => {
    expect(firstFundingFromTransaction(tx(), 'wallet')).toEqual({ state: 'read', funder: 'funder' });
  });
  it('says nothing when the account did not receive SOL, the transaction failed, or it is missing', () => {
    expect(firstFundingFromTransaction(tx({ postBalances: [10_000_000, 0, 1] }), 'wallet')).toMatchObject({ state: 'unavailable' });
    expect(firstFundingFromTransaction(tx({ err: { InstructionError: [0, 'x'] } }), 'wallet')).toMatchObject({ state: 'unavailable' });
    expect(firstFundingFromTransaction(null, 'wallet')).toMatchObject({ state: 'unavailable' });
    expect(firstFundingFromTransaction(tx(), 'someone else')).toMatchObject({ state: 'unavailable' });
  });
  it('does not credit an account that only received it from a non-signer', () => {
    const t = tx();
    t.transaction.message.header.numRequiredSignatures = 0;
    expect(firstFundingFromTransaction(t, 'wallet')).toMatchObject({ state: 'unavailable', reason: 'no signer paid this account' });
  });
  it('follows loaded addresses of a versioned transaction', () => {
    const t = { meta: { err: null, preBalances: [9, 0], postBalances: [4, 5], loadedAddresses: { writable: ['wallet'], readonly: [] } },
      transaction: { message: { accountKeys: ['funder'], header: { numRequiredSignatures: 1 } } } };
    expect(firstFundingFromTransaction(t, 'wallet')).toEqual({ state: 'read', funder: 'funder' });
  });
});

describe('the ask is opt-in', () => {
  it('recognises a holder map request and nothing broader', () => {
    for (const text of ['check this mint and show the holder map', 'holders map please', 'map the holders', 'map of holders']) expect(holderMapRequested(text), text).toBe(true);
    for (const text of ['check this token', 'who are the top holders', 'my map of the city', 'holder count?']) expect(holderMapRequested(text), text).toBe(false);
  });
});

// A small fake cluster: nothing here reaches a real RPC.
const SYSTEM = '11111111111111111111111111111111';
function cluster(opts: { holders: { owner: string; pct: number; ownerProgram?: string }[]; history: Record<string, { signature: string; err?: unknown }[]>; txs: Record<string, unknown>; fundersProgram?: string[]; failSignaturesFor?: string[] }) {
  const calls: { method: string; params: unknown[] }[] = [];
  const provenance = { source: 'solana_mainnet.test', host: 'h', readAt: READ_AT, fellBackFrom: [] };
  const reader = async (method: string, params: unknown[]) => {
    calls.push({ method, params });
    const ok = (result: unknown) => ({ result, commitment: 'finalized', slot: 1, provenance });
    if (method === 'getTokenSupply') return ok({ value: { amount: '1000', decimals: 0 } });
    if (method === 'getTokenLargestAccounts') return ok({ value: opts.holders.map((h, i) => ({ address: `T${i}`, amount: String(h.pct * 10) })) });
    if (method === 'getMultipleAccounts') {
      const keys = params[0] as string[];
      if ((params[1] as { encoding: string }).encoding === 'jsonParsed') return ok({ value: keys.map(k => ({ data: { parsed: { info: { owner: opts.holders[Number(k.slice(1))]!.owner } } } })) });
      return ok({ value: keys.map(k => {
        const holder = opts.holders.find(h => h.owner === k);
        if (holder?.ownerProgram) return { owner: holder.ownerProgram };
        if (opts.fundersProgram?.includes(k)) return { owner: 'PoolProgram' };
        return k.startsWith('F') ? { owner: SYSTEM } : null;
      }) });
    }
    if (method === 'getSignaturesForAddress') {
      const owner = params[0] as string;
      if (opts.failSignaturesFor?.includes(owner)) throw new Error('rate limited');
      const options = params[1] as { limit: number; before?: string };
      const all = opts.history[owner] ?? [];
      const start = options.before ? all.findIndex(r => r.signature === options.before) + 1 : 0;
      return ok(all.slice(start, start + options.limit).map(r => ({ err: null, ...r })));
    }
    if (method === 'getTransaction') return ok(opts.txs[params[0] as string] ?? null);
    throw new Error(`unexpected ${method}`);
  };
  return { reader: reader as never, calls, count: (m: string) => calls.filter(c => c.method === m).length };
}
const fundedBy = (wallet: string, funder: string) => ({
  meta: { err: null, preBalances: [10, 0], postBalances: [5, 5] },
  transaction: { message: { accountKeys: [funder, wallet], header: { numRequiredSignatures: 1 } } },
});

describe('the bounded funding read', () => {
  beforeEach(() => resetHolderMapCacheForTest());

  it('reads funding per plain wallet, groups by funder, marks failures unavailable and skips programs', async () => {
    const c = cluster({
      holders: [{ owner: 'W1', pct: 30 }, { owner: 'W2', pct: 20 }, { owner: 'W3', pct: 10 }, { owner: 'W4', pct: 5 }, { owner: 'POOL', pct: 4, ownerProgram: 'PoolProgram' }],
      history: { W1: [{ signature: 's1b' }, { signature: 's1a' }], W2: [{ signature: 's2' }], W3: [{ signature: 's3' }], W4: [{ signature: 's4' }] },
      txs: { s1a: fundedBy('W1', 'F1'), s2: fundedBy('W2', 'F1'), s3: fundedBy('W3', 'F2') },
      failSignaturesFor: ['W4'],
    });
    const read = await readHolderFunding('M1', { reader: c.reader });
    const view = buildHolderMap({ mint: read.mint, readAt: read.readAt, source: read.source, holders: read.holders });
    expect(view.holders.map(h => [h.address, h.percent, h.funding, h.group])).toEqual([
      ['W1', 30, 'grouped', 'g1'], ['W2', 20, 'grouped', 'g1'], ['W3', 10, 'single', null], ['W4', 5, 'unavailable', null], ['POOL', 4, 'excluded', null],
    ]);
    expect(read.source).toBe('solana_mainnet.test');
    // The oldest transaction is the last one of the newest-first list; the program is never asked about its history.
    expect(c.calls.some(x => x.method === 'getSignaturesForAddress' && x.params[0] === 'POOL')).toBe(false);
    expect(c.calls.find(x => x.method === 'getTransaction')!.params[0]).toBe('s1a');
  });

  it('skips a failed oldest transaction and reads the first successful one', async () => {
    const c = cluster({ holders: [{ owner: 'W1', pct: 30 }], history: { W1: [{ signature: 'ok' }, { signature: 'failed', err: { x: 1 } }] }, txs: { ok: fundedBy('W1', 'F1') } });
    const read = await readHolderFunding('M2', { reader: c.reader });
    expect(read.holders[0]!.funding).toEqual({ state: 'read', funder: 'F1', funderIsProgram: false });
    expect(c.calls.find(x => x.method === 'getTransaction')!.params[0]).toBe('ok');
  });

  it('does not guess from a later transaction when the history runs past the read window', async () => {
    const long = Array.from({ length: 2000 }, (_, i) => ({ signature: `s${i}` }));
    const c = cluster({ holders: [{ owner: 'W1', pct: 30 }], history: { W1: long }, txs: {} });
    const read = await readHolderFunding('M3', { reader: c.reader });
    expect(read.holders[0]!.funding).toEqual({ state: 'unavailable', reason: 'history longer than the read window' });
    expect(c.count('getSignaturesForAddress')).toBe(2);
    expect(c.count('getTransaction')).toBe(0);
  });

  it('does not group on a program-owned funder', async () => {
    const c = cluster({
      holders: [{ owner: 'W1', pct: 30 }, { owner: 'W2', pct: 20 }],
      history: { W1: [{ signature: 's1' }], W2: [{ signature: 's2' }] }, txs: { s1: fundedBy('W1', 'F1'), s2: fundedBy('W2', 'F1') }, fundersProgram: ['F1'],
    });
    const read = await readHolderFunding('M4', { reader: c.reader });
    const view = buildHolderMap({ mint: 'M4', readAt: read.readAt, source: read.source, holders: read.holders });
    expect(view.holders.map(h => h.funding)).toEqual(['excluded', 'excluded']);
    expect(view.groups).toEqual([]);
  });

  it('stays under a fixed number of reads however many holders the cluster lists', async () => {
    const holders = Array.from({ length: 20 }, (_, i) => ({ owner: `W${i}`, pct: 20 - i }));
    const history = Object.fromEntries(holders.map(h => [h.owner, [{ signature: `s-${h.owner}` }]]));
    const txs = Object.fromEntries(holders.map(h => [`s-${h.owner}`, fundedBy(h.owner, 'F1')]));
    const c = cluster({ holders, history, txs });
    const read = await readHolderFunding('M5', { reader: c.reader });
    expect(read.holders).toHaveLength(MAX_HOLDER_MAP_HOLDERS);
    expect(c.count('getSignaturesForAddress')).toBeLessThanOrEqual(2 * MAX_HOLDER_MAP_HOLDERS);
    expect(c.calls.length).toBeLessThanOrEqual(4 + 3 * MAX_HOLDER_MAP_HOLDERS + 1);
  });

  it('costs a mint one map per cache window, shares one in-flight read, and does not keep a failure', async () => {
    const c = cluster({ holders: [{ owner: 'W1', pct: 30 }], history: { W1: [{ signature: 's1' }] }, txs: { s1: fundedBy('W1', 'F1') } });
    const [a, b] = await Promise.all([readHolderFunding('M6', { reader: c.reader }), readHolderFunding('M6', { reader: c.reader })]);
    const after = c.calls.length;
    await readHolderFunding('M6', { reader: c.reader });
    expect(a).toBe(b);
    expect(c.calls.length).toBe(after);
    const later = await readHolderFunding('M6', { reader: c.reader, now: () => Date.now() + 11 * 60_000 });
    expect(c.calls.length).toBeGreaterThan(after);
    expect(later.holders).toHaveLength(1);

    let failing = true;
    const flaky = (async (...args: unknown[]) => { if (failing) throw new Error('down'); return (c.reader as (...a: unknown[]) => unknown)(...args); }) as never;
    await expect(readHolderFunding('M7', { reader: flaky })).rejects.toThrow('down');
    failing = false;
    await expect(readHolderFunding('M7', { reader: flaky })).resolves.toMatchObject({ mint: 'M7' });
  });
});
