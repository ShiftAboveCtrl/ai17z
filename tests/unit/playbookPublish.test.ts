import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TradeMandateRow } from '@xbam/database';
import { buildPublishDocument } from '@xbam/runtime';
import { PlaybookDocument } from '@xbam/shared/contracts';

/**
 * The outbound direction of the playbook flow. `buildPublishDocument` is the
 * one mapping from a paper mandate to a published playbook, and it is pure so
 * the refusal reasons can be pinned without a database.
 */

const MINT_A = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const MINT_B = 'So11111111111111111111111111111111111111112';

const asset = (address: string, decimals = 5) => ({ kind: 'ONCHAIN' as const, network: 'solana' as const, address, decimals });

function mandate(over: Partial<TradeMandateRow> = {}): TradeMandateRow {
  return {
    id: '11111111-1111-4111-8111-111111111111', agentId: '22222222-2222-4222-8222-222222222222', ownerId: '33333333-3333-4333-8333-333333333333',
    mode: 'PAPER', approval: 'OWNER_APPROVES_EACH', venues: ['AMM_POOL_SOLANA'], networks: ['solana'],
    allowedAssets: [asset(MINT_A, 5), asset(MINT_B, 9)], assetScope: 'LISTED',
    maxPerTrade: '2000000000', maxPerDay: '6000000000', maxOpenExposure: '8000000000', maxOpenPositions: 6,
    maxSlippageBps: 500, maxPriceImpactBps: 800, minLiquidityBase: '20000000000', maxFeeBase: '20000000', quoteMaxAgeMs: 60_000,
    expiresAt: null, paused: false, protectiveExits: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', retiredAt: null,
    ...over,
  };
}

const built = (m: TradeMandateRow, title = 'Slow and liquid') => {
  const result = buildPublishDocument(m, { title, playbookId: 'my-setup', version: 1 });
  if (!result.ok) throw new Error(result.why);
  return result.document;
};

describe('building a playbook from an agent setup', () => {
  it('maps the paper mandate to SOL bounds, capital and the exact-mint universe', () => {
    const document = built(mandate());
    expect(document).toMatchObject({
      schema: 1,
      id: 'my-setup',
      version: 1,
      title: 'Slow and liquid',
      publisher: null,
      capitalSol: '8',
      expiresAt: null,
      universe: { chain: 'solana', assets: [{ mint: MINT_A, decimals: 5 }, { mint: MINT_B, decimals: 9 }] },
      limits: {
        maxPerTradeSol: '2', maxPerDaySol: '6', maxOpenExposureSol: '8', maxOpenPositions: 6,
        maxSlippageBps: 500, maxPriceImpactBps: 800, minLiquiditySol: '20', maxFeeSol: '0.02',
      },
    });
    expect(PlaybookDocument.safeParse(document).success).toBe(true);
  });

  it('copies the mandate bounds exactly, so it never widens what the agent itself runs', () => {
    const document = built(mandate({ maxPerTrade: '100000000', maxSlippageBps: 100 }));
    expect(document.limits.maxPerTradeSol).toBe('0.1');
    expect(document.limits.maxSlippageBps).toBe(100);
  });

  it('carries the mandate expiry through', () => {
    const document = built(mandate({ expiresAt: '2027-01-01T00:00:00.000Z' }));
    expect(document.expiresAt).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('what cannot be published', () => {
  it.each([
    ['a live mandate', mandate({ mode: 'LIVE' }), /live mandate/],
    ['an any-token scope', mandate({ assetScope: 'ANY_SOLANA_TOKEN' }), /any Solana token/],
    ['no universe', mandate({ allowedAssets: [] }), /no assets/],
    ['no capital', mandate({ maxOpenExposure: '0' }), /no paper capital/],
    ['nothing per trade', mandate({ maxPerTrade: '0' }), /nothing per trade/],
  ])('refuses %s with a sentence', (_label, m, pattern) => {
    const result = buildPublishDocument(m, { title: 'x', playbookId: 'my-setup', version: 1 });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.why).toMatch(pattern);
  });

  it('refuses a setup outside what a playbook may express, never clamping it into shape', () => {
    for (const m of [
      mandate({ maxOpenPositions: 500 }),
      mandate({ maxSlippageBps: 5_000 }),
      mandate({ maxPriceImpactBps: 2_500 }),
      mandate({ allowedAssets: [asset('not-a-mint', 5)] }),
      mandate({ allowedAssets: [asset('1'.repeat(60), 5)] }),
    ]) {
      const result = buildPublishDocument(m, { title: 'x', playbookId: 'my-setup', version: 1 });
      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.why).toMatch(/cannot be a playbook/);
    }
  });

  it('holds the title to the plain-name grammar, so it cannot carry markup or an instruction', () => {
    for (const title of ['<b>bold</b>', 'two\nlines', 'see https://example.invalid', '`rm -rf`', 'a'.repeat(61)]) {
      const result = buildPublishDocument(mandate(), { title, playbookId: 'my-setup', version: 1 });
      expect(result.ok, title).toBe(false);
      expect(result.ok ? '' : result.why).toMatch(/cannot be a playbook/);
    }
  });
});

describe('the publish path reaches no money or live-trade path', () => {
  it('does not import the live trades module, a signer, or a wallet submit path', () => {
    const text = readFileSync(join(__dirname, '..', '..', 'packages', 'runtime', 'src', 'playbookPublish.ts'), 'utf8');
    expect(text).not.toMatch(/studioLiveTrades|studioLiveTrade|prepareStudioPurchase|prepareMarketplacePurchase/);
    expect(text).not.toMatch(/\b(submitIntent|approveIntent|draftIntent|sealedSecretOf|openSecret)\b|\.sign\(|\.broadcast\(/);
    expect(text).not.toMatch(/walletCore|walletCapabilities/);
  });
});
