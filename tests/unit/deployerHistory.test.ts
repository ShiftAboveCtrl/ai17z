import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderEvidenceCard, renderDeployerLines, type CardReading, type DeployerHistory } from '@xbam/prompts';

const mint = 'So11111111111111111111111111111111111111112';
const payer = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const other = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const answers = vi.hoisted(() => ({ calls: [] as string[], signatures: null as unknown, transaction: null as unknown, fail: false }));
vi.mock('@xbam/upstream', async importOriginal => {
  const actual = await importOriginal<typeof import('@xbam/upstream')>();
  return {
    ...actual,
    ask: async (_family: string, query: { method: string }) => {
      answers.calls.push(query.method);
      if (answers.fail) throw new Error('rpc down');
      const result = query.method === 'getSignaturesForAddress' ? answers.signatures : answers.transaction;
      return { value: { result, commitment: 'finalized', slot: 1 },
        provenance: { upstreamId: 'solana_mainnet.official', fetchedAt: new Date().toISOString() } };
    },
  };
});
const { readDeployerHistory, readMintCreator, resetDeployerCacheForTest } = await import('../../packages/runtime/src/deployerHistory');

const creation = (over: Record<string, unknown> = {}) => ({
  blockTime: 1_760_000_000,
  meta: { err: null, innerInstructions: [] },
  transaction: { message: { accountKeys: [{ pubkey: payer, signer: true }, { pubkey: mint }],
    instructions: [{ parsed: { type: 'initializeMint2', info: { mint } } }] } },
  ...over,
});

beforeEach(() => {
  resetDeployerCacheForTest();
  answers.calls = []; answers.fail = false;
  answers.signatures = [{ signature: 'newest', err: null }, { signature: 'oldest', err: null }];
  answers.transaction = creation();
});

describe('reading who created a mint', () => {
  it('takes the fee payer of the oldest transaction when it initializes this mint', async () => {
    const creator = await readMintCreator(mint);
    expect(creator).toMatchObject({ address: payer, createdAt: new Date(1_760_000_000_000).toISOString(), source: 'solana_mainnet.official' });
    expect(answers.calls).toEqual(['getSignaturesForAddress', 'getTransaction']);
  });
  it('finds the initialization among inner instructions too', async () => {
    answers.transaction = creation({ transaction: { message: { accountKeys: [{ pubkey: payer }], instructions: [] } },
      meta: { err: null, innerInstructions: [{ instructions: [{ parsed: { type: 'initializeMint', info: { mint } } }] }] } });
    expect((await readMintCreator(mint))?.address).toBe(payer);
  });
  it('is unavailable, not guessed, when the oldest transaction does not create this mint', async () => {
    answers.transaction = creation({ transaction: { message: { accountKeys: [{ pubkey: payer }],
      instructions: [{ parsed: { type: 'initializeMint2', info: { mint: other } } }] } } });
    expect(await readMintCreator(mint)).toBeNull();
    answers.transaction = creation({ meta: { err: { InstructionError: [0, 'x'] }, innerInstructions: [] } });
    expect(await readMintCreator(mint)).toBeNull();
  });
  it('is unavailable when a full page of signatures means the oldest one is unproven', async () => {
    answers.signatures = Array.from({ length: 1000 }, (_, i) => ({ signature: `s${i}`, err: null }));
    expect(await readMintCreator(mint)).toBeNull();
    expect(answers.calls).toEqual(['getSignaturesForAddress']);
    answers.signatures = [];
    expect(await readMintCreator(mint)).toBeNull();
  });
  it('is unavailable when the read fails', async () => {
    answers.fail = true;
    expect(await readMintCreator(mint)).toBeNull();
  });
  it('keeps a proved creator, so a repeat ask costs no further reads', async () => {
    await readMintCreator(mint);
    answers.calls = [];
    expect((await readMintCreator(mint))?.address).toBe(payer);
    expect(answers.calls).toEqual([]);
  });
  it('does not keep a failure', async () => {
    answers.fail = true; await readMintCreator(mint);
    answers.fail = false;
    expect((await readMintCreator(mint))?.address).toBe(payer);
  });
});

describe('the index launch count', () => {
  const now = new Date().toISOString();
  const index = (developer: string | null, developerLaunches: number | null) =>
    ({ developer, developerLaunches, source: 'solana_tokens.jupiter', fetchedAt: now, observedAt: now });
  it('is used only when the index names the address the chain gave', async () => {
    expect((await readDeployerHistory(mint, index(payer, 7))).otherLaunches).toBe(7);
    expect((await readDeployerHistory(mint, index(other, 7))).otherLaunches).toBeNull();
    expect((await readDeployerHistory(mint, index(null, 7))).otherLaunches).toBeNull();
  });
  it('keeps an unreported count absent rather than zero', async () => {
    expect((await readDeployerHistory(mint, index(payer, null))).otherLaunches).toBeNull();
  });
  it('is never shown without a proved address', async () => {
    answers.fail = true;
    const history = await readDeployerHistory(mint, index(payer, 7));
    expect(history.address).toBeNull();
    expect(history.otherLaunches).toBeNull();
  });
});

describe('the deployer lines on the card', () => {
  const fresh = new Date().toISOString();
  const history = (over: Partial<DeployerHistory> = {}): DeployerHistory => ({
    address: payer, createdAt: '2026-01-01T00:00:00.000Z', source: 'solana_mainnet.official', fetchedAt: fresh,
    otherLaunches: 3, launchesSource: 'solana_tokens.jupiter', launchesFetchedAt: fresh, launchesObservedAt: fresh,
    launchesMaxAgeMs: 300_000, earlier: [], ...over });
  const reading: CardReading = { label: 'Liquidity', value: 12000, unit: 'USD', source: 'solana_tokens.jupiter',
    fetchedAt: fresh, observedAt: fresh, maxAgeMs: 300_000 };
  const BANNED = /\b(?:rug|rugged|scam|serial|dev dumped|safe|avoid|dumped|rugger)\b/i;

  it('adds sourced lines and keeps the not-a-verdict line', () => {
    const text = renderEvidenceCard([reading], '', Date.now(), '', history());
    expect(text).toContain(`Deployer (creation fee payer): ${payer} [solana_mainnet.official; created 2026-01-01T00:00:00.000Z; fetched ${fresh}]`);
    expect(text).toContain(`Launches by this address, index count: 3 [solana_tokens.jupiter; fetched ${fresh}]`);
    expect(text).toContain('not a verdict, reads can be wrong');
    expect(text).not.toMatch(BANNED);
  });
  it('leaves the card exactly as before when there is no deployer section', () => {
    expect(renderEvidenceCard([reading], '', Date.now(), '', null)).toBe(renderEvidenceCard([reading], '', Date.now(), ''));
    expect(renderEvidenceCard([reading], '')).not.toContain('Deployer');
  });
  it('says unavailable, never zero, for a missing address, count or stale count', () => {
    const none = renderDeployerLines(history({ address: null, otherLaunches: 0 }));
    expect(none).toEqual(['Deployer (creation fee payer): unavailable', 'Launches by this address, index count: unavailable']);
    expect(renderDeployerLines(history({ otherLaunches: null }))[1]).toMatch(/unavailable$/);
    expect(renderDeployerLines(history({ launchesFetchedAt: '2000-01-01T00:00:00Z' }))[1]).toMatch(/unavailable$/);
    expect(renderDeployerLines(history({ otherLaunches: 0 }))[1]).toContain('index count: 0 [');
  });
  it('prints at most five earlier launches, in the order given, each with its source and read time', () => {
    const earlier = Array.from({ length: 8 }, (_, i) => ({ mint: `Mint${i}`, liquidityNowUsd: i === 1 ? null : 100 + i,
      liquidityAtCreationUsd: null, source: 'market_gecko.geckoterminal', readAt: fresh }));
    const lines = renderDeployerLines(history({ earlier })).filter(l => l.startsWith('Earlier launch'));
    expect(lines).toHaveLength(5);
    expect(lines.map(l => l.split(' ')[2])).toEqual(['Mint0:', 'Mint1:', 'Mint2:', 'Mint3:', 'Mint4:']);
    expect(lines[1]).toContain('liquidity now unavailable, at creation unavailable');
    expect(lines[0]).toContain(`[market_gecko.geckoterminal; read ${fresh}]`);
    expect(lines.join('\n')).not.toMatch(BANNED);
  });
});
