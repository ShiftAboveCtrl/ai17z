import { afterEach, describe, expect, it } from 'vitest';
import { agents as agentsRepo, tradeShadows, trading } from '@xbam/database';
import { AssetRef, MarketSnapshot, SHADOW_OUTCOMES, type TradeMandate, type TradeVenue } from '@xbam/shared/contracts';
import {
  MAX_SHADOWS_PER_PASS,
  registerMarketReader,
  resetMarketReadersForTest,
  runDueShadows,
  type MarketReader,
} from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();
afterEach(() => resetMarketReadersForTest());

/**
 * Shadow trading: the real pipeline, on a schedule, executing nothing.
 *
 * The reader is a fake here, because what is being proved is not any venue's
 * arithmetic: it is that a due shadow runs the one pipeline, that the claim
 * cannot run one shadow twice, that a global pause stops it before it spends a
 * market read, and that every outcome including a thrown one is recorded
 * rather than lost. The live market is proved once, in
 * `poolMarketLive.test.ts`, and nothing is gained by proving it again here.
 */

const TOKEN = AssetRef.parse({
  kind: 'ONCHAIN',
  network: 'robinhood',
  address: '0x00000000000000000000000000000000000000aa',
  decimals: 18,
  symbol: 'FIXTURE',
});
const NATIVE = AssetRef.parse({ kind: 'NATIVE', network: 'robinhood' });

const snap = (over: Partial<MarketSnapshot> = {}): MarketSnapshot =>
  MarketSnapshot.parse({
    venue: 'PONS_V2_CURVE',
    network: 'robinhood',
    asset: TOKEN,
    quoteAsset: NATIVE,
    atBlock: '1000',
    observedAt: new Date().toISOString(),
    priceBaseUnits: '1000000000000000000',
    liquidityBase: '500000000000000000000',
    feeMicroBps: 10_000,
    phase: 'CURVE',
    source: 'fake-reader',
    ...over,
  });

/**
 * A reader that answers now, every time.
 *
 * `observedAt` is taken at the moment of the call rather than once, because
 * the gate compares the fresh read against the instant the verdict is reached
 * and a snapshot frozen at module load is stale by the time a test runs.
 */
function liveishReader(
  venues: readonly TradeVenue[] = ['PONS_V2_CURVE'],
  answer: () => MarketSnapshot | null = () => snap(),
): MarketReader {
  return { id: 'fake', version: '1', venues, async read() { return answer(); } };
}

const mandate = (over: Record<string, unknown> = {}) =>
  ({
    mode: 'PAPER',
    approval: 'OWNER_APPROVES_EACH',
    venues: ['PONS_V2_CURVE'],
    networks: ['robinhood'],
    allowedAssets: [TOKEN, NATIVE],
    maxPerTrade: '10000000000000000000',
    maxPerDay: '50000000000000000000',
    maxOpenExposure: '40000000000000000000',
    maxOpenPositions: 50,
    maxSlippageBps: 100,
    maxPriceImpactBps: 200,
    minLiquidityBase: '1000000000000000000',
    maxFeeBase: '100000000000000000',
    quoteMaxAgeMs: 30_000,
    expiresAt: null,
    paused: false,
    ...over,
  }) as unknown as Omit<TradeMandate, 'id' | 'agentId'>;

async function shadowed(over: Record<string, unknown> = {}, mandateOver: Record<string, unknown> = {}) {
  const fixture = await createFixture();
  await trading.putMandate({ agentId: fixture.agentId, ownerId: fixture.ownerId, mandate: mandate(mandateOver) });
  const row = await tradeShadows.putShadow({
    agentId: fixture.agentId,
    ownerId: fixture.ownerId,
    label: 'fixture pair',
    venue: 'PONS_V2_CURVE',
    side: 'BUY',
    assetIn: NATIVE,
    assetOut: TOKEN,
    subject: TOKEN,
    maxIn: '1000000000000000000',
    maxSlippageBps: 50,
    maxPriceImpactBps: 100,
    maxFeeBase: '100000000000000000',
    intervalSeconds: 300,
    ...over,
  });
  return { fixture, row };
}

describe('a due shadow runs the one pipeline', () => {
  it('fills, journals an ordinary paper intent, and counts it', async () => {
    registerMarketReader(liveishReader());
    const { fixture, row } = await shadowed();

    const pass = await runDueShadows();
    expect(pass.ran).toBe(1);
    expect(pass.outcomes[0]!.outcome).toBe('FILLED');

    // The record is the journal, not the tally. A shadow that counted fills
    // without leaving an intent would be a number nobody can check.
    const intents = await trading.listIntents(fixture.agentId, 10);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.mode).toBe('PAPER');
    expect(intents[0]!.status).toBe('PAPER_FILLED');

    const after = await tradeShadows.getShadow(row.id);
    expect(after!.runs).toBe(1);
    expect(after!.fills).toBe(1);
    expect(after!.lastOutcome).toBe('FILLED');
    expect(after!.lastDetail).toMatch(/^Filled /);
  });

  it('is not due again until its interval has passed', async () => {
    registerMarketReader(liveishReader());
    const { row } = await shadowed({ intervalSeconds: 3600 });

    expect((await runDueShadows()).ran).toBe(1);
    // The claim moved `next_run_at` forward in the statement that selected
    // the row, so a second pass a moment later finds nothing. This is the
    // property that stops two workers running one shadow.
    const second = await runDueShadows();
    expect(second.ran).toBe(0);
    expect(second.why).toBe('NONE_DUE');
    expect((await tradeShadows.getShadow(row.id))!.runs).toBe(1);
  });

  it('moves the next run forward from now, not from when it was due', async () => {
    // A worker that was off for a day must not then run a shadow every second
    // catching up. Being late is not a reason to do a day's market reads at
    // once against somebody else's API.
    registerMarketReader(liveishReader());
    const { row } = await shadowed({ intervalSeconds: 600 });
    const wasDue = Date.parse(row.nextRunAt);

    // Claimed two days after it came due, which is what a worker that was off
    // for two days sees. Expressed by moving the claim's instant rather than
    // the row's, because the row's is only ever written by the claim.
    const twoDaysOn = new Date(wasDue + 48 * 60 * 60 * 1000);
    expect(await tradeShadows.claimDue(5, twoDaysOn)).toHaveLength(1);

    const claimed = await tradeShadows.getShadow(row.id);
    // Ten minutes after the claim, so one run happens and then the ordinary
    // pace resumes.
    expect(Date.parse(claimed!.nextRunAt) - twoDaysOn.getTime()).toBe(600_000);
    // And emphatically not ten minutes after it came due, which would leave it
    // due again immediately and do two days of market reads in a burst.
    expect(Date.parse(claimed!.nextRunAt) - wasDue).toBeGreaterThan(47 * 60 * 60 * 1000);
  });

  it('records a refusal with its reasons rather than as a failure', async () => {
    registerMarketReader(liveishReader());
    // A mandate that allows nothing this shadow trades.
    const { row } = await shadowed({}, { allowedAssets: [] });

    const pass = await runDueShadows();
    expect(pass.outcomes[0]!.outcome).toBe('REFUSED');
    const after = await tradeShadows.getShadow(row.id);
    expect(after!.refusals).toBe(1);
    expect(after!.fills).toBe(0);
    // The codes, because "why did it stop filling" is a fair question and a
    // count cannot answer it.
    expect(after!.lastDetail).toContain('NO_ASSETS_ALLOWED');
  });

  it('keeps a venue it could not read apart from a mandate that said no', async () => {
    registerMarketReader(liveishReader(['PONS_V2_CURVE'], () => null));
    const { row } = await shadowed();

    expect((await runDueShadows()).ran).toBe(1);
    const after = await tradeShadows.getShadow(row.id);
    expect(after!.lastOutcome).toBe('NO_MARKET');
    expect(after!.noMarket).toBe(1);
    expect(after!.refusals).toBe(0);
  });

  it('records a thrown error as an outcome rather than losing the run', async () => {
    // A shadow nobody can see failing is worse than one that is not running.
    registerMarketReader({
      id: 'angry',
      version: '1',
      venues: ['PONS_V2_CURVE'],
      async read() {
        throw new Error('the node fell over');
      },
    });
    const { row } = await shadowed();

    const pass = await runDueShadows();
    expect(pass.ran).toBe(1);
    const after = await tradeShadows.getShadow(row.id);
    // A read that failed is NO_MARKET, because `readMarket` classifies it as
    // UNAVAILABLE and the engine reports that: the error did not escape.
    expect(after!.lastOutcome).toBe('NO_MARKET');
    expect(after!.lastDetail).toContain('the node fell over');
  });
});

describe('what stops a shadow', () => {
  it('a global pause stops it before it spends a market read', async () => {
    let reads = 0;
    registerMarketReader({
      id: 'counting',
      version: '1',
      venues: ['PONS_V2_CURVE'],
      async read() {
        reads += 1;
        return snap();
      },
    });
    const { fixture, row } = await shadowed();
    await trading.pauseTrading({ scope: 'GLOBAL', target: null, reason: 'testing', createdBy: fixture.ownerId });

    const pass = await runDueShadows();
    expect(pass.ran).toBe(0);
    expect(pass.why).toBe('PAUSED_GLOBALLY');
    // Nothing was read and nothing was claimed, so the shadow is still due
    // the moment the pause is lifted. Delayed, never dropped.
    expect(reads).toBe(0);
    expect((await tradeShadows.getShadow(row.id))!.runs).toBe(0);
  });

  it('a paused shadow is never claimed', async () => {
    registerMarketReader(liveishReader());
    const { row } = await shadowed();
    await tradeShadows.setShadowPaused(row.id, true);
    expect((await runDueShadows()).ran).toBe(0);
  });

  it('runs at most a bounded number in one pass', async () => {
    registerMarketReader(liveishReader());
    for (let i = 0; i < MAX_SHADOWS_PER_PASS + 2; i += 1) await shadowed({ label: `pair ${i}` });
    const pass = await runDueShadows();
    expect(pass.ran).toBe(MAX_SHADOWS_PER_PASS);
  });
});

describe('the shadow row itself', () => {
  it('updates the shadow with the same label rather than adding a second', async () => {
    const { fixture, row } = await shadowed();
    const again = await tradeShadows.putShadow({
      agentId: fixture.agentId,
      ownerId: fixture.ownerId,
      label: 'fixture pair',
      venue: 'PONS_V2_CURVE',
      side: 'SELL',
      assetIn: TOKEN,
      assetOut: NATIVE,
      subject: TOKEN,
      maxIn: '2000000000000000000',
      maxSlippageBps: 10,
      maxPriceImpactBps: 20,
      maxFeeBase: '1',
      intervalSeconds: 900,
    });
    expect(again.id).toBe(row.id);
    expect(again.side).toBe('SELL');
    expect(again.intervalSeconds).toBe(900);
    expect(await tradeShadows.listShadows(fixture.agentId)).toHaveLength(1);
  });

  it('refuses an interval too fast to be a shadow of anything', async () => {
    const fixture = await createFixture();
    const draft = {
      agentId: fixture.agentId,
      ownerId: fixture.ownerId,
      label: 'too fast',
      venue: 'PONS_V2_CURVE' as const,
      side: 'BUY' as const,
      assetIn: NATIVE,
      assetOut: TOKEN,
      subject: TOKEN,
      maxIn: '1',
      maxSlippageBps: 1,
      maxPriceImpactBps: 1,
      maxFeeBase: '1',
      intervalSeconds: 5,
    };
    // Enforced by the database rather than by whoever remembered to check:
    // faster than a minute is a load generator aimed at a free API.
    await expect(tradeShadows.putShadow(draft)).rejects.toThrow();
  });

  it('accepts every outcome the contract names, and nothing else', async () => {
    const { row } = await shadowed();
    for (const outcome of SHADOW_OUTCOMES) {
      const noted = await tradeShadows.noteRun(row.id, outcome, 'a sentence');
      expect(noted!.lastOutcome).toBe(outcome);
    }
    await expect(tradeShadows.noteRun(row.id, 'DEFINITELY_NOT' as never, null)).rejects.toThrow();
  });

  it('goes when its agent goes', async () => {
    // ON DELETE CASCADE rather than something somebody remembered to write: a
    // standing instruction to read a market on behalf of an agent that no
    // longer exists is a loop with no owner.
    const { fixture, row } = await shadowed();
    await agentsRepo.deleteAgent(fixture.agentId);
    expect(await tradeShadows.getShadow(row.id)).toBeNull();
  });
});
