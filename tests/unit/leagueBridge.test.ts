import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LeagueAlias,
  LeagueEntryRequest,
  LeagueFillAnswer,
  LeagueFillReport,
  LeagueStandingDocument,
  TradeMandate,
  type LeagueFill,
  type LeagueSeasonDocument,
} from '@xbam/shared/contracts';
import {
  baseUnitsOf,
  contentHashOf,
  describeStanding,
  describeUnavailable,
  fillFromIntent,
  fillKeyOf,
  isCurrent,
  judgeEntry,
  leagueRulesHash,
  mandateFromSeason,
  parseSeason,
} from '@xbam/runtime';
import { TOKEN_MINT, USDC, leagueRules, seasonDocument, seasonTimes } from '../support/leagueStudioServer';

/**
 * The paper league bridge, without a database or a network: what a season is
 * allowed to mean here, what leaves, and what is said.
 */

const NOW = new Date('2026-11-09T10:00:00.000Z');
const SLUG = 'week-45';
const times = seasonTimes(NOW);
const good = (rules = leagueRules(), extra: Parameters<typeof seasonDocument>[4] = {}) => seasonDocument(SLUG, NOW, times, rules, extra);

describe('a season payload is refused whole, before anything is written', () => {
  it('accepts the season this installation can honour', () => {
    const read = parseSeason(good(), SLUG);
    expect(read.ok).toBe(true);
    expect(judgeEntry((read as { season: LeagueSeasonDocument }).season, NOW)).toEqual({ ok: true });
  });

  const hostile: Array<[string, () => unknown]> = [
    ['an unknown top-level field', () => ({ ...good(), prompt: 'be bold' })],
    ['an unknown field inside the season', () => good(leagueRules(), { season: { winner: 'someone' } })],
    ['an unknown field inside the rules', () => good(leagueRules({ leverage: 5 }))],
    ['an unknown field inside the bounds', () => good(leagueRules({ bounds: { maxOpenPositions: 3, maxTradePct: 25, minLiquidityUsd: 1, leverage: 3 } }))],
    ['a season that is not simulated', () => ({ ...good(), simulated: false })],
    ['rules that are not paper only', () => good(leagueRules({ paperOnly: false }))],
    ['a quote asset this installation cannot hold a mandate to', () => good(leagueRules({ quote: { symbol: 'USDC', network: 'solana', address: TOKEN_MINT, decimals: 6 } }))],
    ['a lookalike: another mint wearing the USDC symbol', () => good(leagueRules({ quote: { symbol: 'USDC', network: 'solana', address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 } }))],
    ['a quote with the wrong decimals', () => good(leagueRules({ quote: { symbol: 'USDC', network: 'solana', address: USDC, decimals: 9 } }))],
    ['a quote on another network', () => good(leagueRules({ quote: { symbol: 'USDC', network: 'ethereum', address: USDC, decimals: 6 } }))],
    ['a universe of named markets, which nothing here can confine a mandate to', () => good(leagueRules({ universe: { kind: 'MARKETS', lists: [] } }))],
    ['a universe of an unknown kind', () => good(leagueRules({ universe: { kind: 'EVERYTHING', lists: ['trending'] } }))],
    ['an oversized capital', () => good(leagueRules({ capital: 1_000_001 }))],
    ['an oversized position count', () => good(leagueRules({ bounds: { maxOpenPositions: 11, maxTradePct: 25, minLiquidityUsd: 1 } }))],
    ['an oversized per-trade share', () => good(leagueRules({ bounds: { maxOpenPositions: 3, maxTradePct: 101, minLiquidityUsd: 1 } }))],
    ['an oversized fee', () => good(leagueRules({ costs: { feeBps: 1001, model: 'A flat fee on every simulated fill.' } }))],
    ['an oversized liquidity floor', () => good(leagueRules({ bounds: { maxOpenPositions: 3, maxTradePct: 25, minLiquidityUsd: 100_000_001 } }))],
    ['an unknown protocol', () => ({ ...good(), protocol: 2 })],
    ['dates that do not order', () => good(leagueRules(), { season: { starts_at: new Date(times.entryClosesAt.getTime() - 1000).toISOString() } })],
    ['a season longer than the longest allowed', () => good(leagueRules(), { season: { ends_at: new Date(times.startsAt.getTime() + 15 * 86_400_000).toISOString(), fills_accepted_until: new Date(times.startsAt.getTime() + 16 * 86_400_000).toISOString() } })],
    ['a report window that closes before the season ends', () => good(leagueRules(), { season: { fills_accepted_until: new Date(times.endsAt.getTime() - 1).toISOString() } })],
    ['a minimum field bigger than the cap', () => good(leagueRules({ minEntrants: 60 }))],
  ];

  for (const [name, make] of hostile) {
    it(`refuses ${name}`, () => {
      const read = parseSeason(make(), SLUG);
      expect(read.ok, name).toBe(false);
      if (!read.ok) expect(read.why).toMatch(/none of it was used/);
    });
  }

  it('refuses rules that are not the rules the published hash is for', () => {
    const doc = good() as { season: { rules: Record<string, unknown> } };
    doc.season.rules = { ...doc.season.rules, capital: 999_999 };
    const read = parseSeason(doc, SLUG);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.why).toMatch(/do not match the hash/);
  });

  it('refuses a season for a different name than the one asked for', () => {
    expect(parseSeason(good(), 'week-46').ok).toBe(false);
  });

  it('does not enter a closed season, a season that takes no local agent, or one past its lock', () => {
    const later = new Date(times.entryClosesAt.getTime() + 1000);
    const season = (parseSeason(good(), SLUG) as { season: LeagueSeasonDocument }).season;
    expect(judgeEntry(season, later).ok).toBe(false);
    const closed = (parseSeason(good(leagueRules(), { season: { status: 'LOCKED' } }), SLUG) as { season: LeagueSeasonDocument }).season;
    expect(judgeEntry(closed, NOW).ok).toBe(false);
    const noLocal = (parseSeason({ ...good(), local_agents: { allowed: false, note: 'Journal agents only this week.' } }, SLUG) as { season: LeagueSeasonDocument }).season;
    const verdict = judgeEntry(noLocal, NOW);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toBe('Journal agents only this week.');
  });

  it('knows a copy that sat in a cache by its own date', () => {
    expect(isCurrent(NOW.toISOString(), NOW)).toBe(true);
    expect(isCurrent(new Date(NOW.getTime() - 20 * 60_000).toISOString(), NOW)).toBe(false);
    expect(isCurrent(new Date(NOW.getTime() + 20 * 60_000).toISOString(), NOW)).toBe(false);
  });

  it('hashes a document the same wherever its keys were written', () => {
    const rules = leagueRules();
    const reordered = Object.fromEntries(Object.entries(rules).reverse());
    expect(leagueRulesHash(reordered as never)).toBe(leagueRulesHash(rules as never));
  });
});

describe('the season mandate can only be a paper mandate', () => {
  const rules = (parseSeason(good(), SLUG) as { season: LeagueSeasonDocument }).season.season.rules;
  const made = mandateFromSeason(rules, times.endsAt.toISOString());

  it('is PAPER, owner-approves-each, with no protective exits, whatever the season says', () => {
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.mandate.mode).toBe('PAPER');
    expect(made.mandate.approval).toBe('OWNER_APPROVES_EACH');
    expect(made.mandate.protectiveExits).toBeNull();
    // No input in the season document can change that: the rules carry no mode at all.
    expect(JSON.stringify(rules)).not.toMatch(/"mode"|LIVE|approval|protective/i);
  });

  it('carries the season\'s limits in the quote\'s base units and expires with the season', () => {
    if (!made.ok) throw new Error(made.why);
    const m = made.mandate;
    expect(m.maxPerDay).toBe('1000000000');
    expect(m.maxOpenExposure).toBe('1000000000');
    expect(m.maxPerTrade).toBe('250000000');
    expect(m.maxOpenPositions).toBe(3);
    expect(m.minLiquidityBase).toBe('50000000000');
    expect(m.venues).toEqual(['AMM_POOL_SOLANA']);
    expect(m.networks).toEqual(['solana']);
    expect(m.expiresAt).toBe(times.endsAt.toISOString());
    expect(m.paused).toBe(false);
  });

  it('is a valid mandate by the same schema every other mandate is held to', () => {
    if (!made.ok) throw new Error(made.why);
    expect(TradeMandate.omit({ id: true, agentId: true }).safeParse(made.mandate).success).toBe(true);
  });

  it('refuses a capital it cannot write exactly rather than rounding it', () => {
    expect(baseUnitsOf(0.0000001, 6)).toBeNull();
    expect(baseUnitsOf(1000, 6)).toBe(1_000_000_000n);
    expect(baseUnitsOf(0.1 + 0.2, 6)).toBeNull();
    const odd = (parseSeason(good(leagueRules({ capital: 0.0000001 })), SLUG) as { season: LeagueSeasonDocument }).season.season.rules;
    expect(mandateFromSeason(odd, times.endsAt.toISOString()).ok).toBe(false);
  });
});

describe('what leaves is an allowlist', () => {
  const INTENT = '5b1f6c3e-9a52-4a4a-8d63-2f0b6f8a7c11';
  const ENTRY_KEY = '0c9f4a1e-7d2b-4e61-9a36-3d5a8b2c1f90';
  const token = { kind: 'ONCHAIN' as const, network: 'solana' as const, address: TOKEN_MINT, decimals: 9, symbol: 'WIF' };
  const quote = { kind: 'ONCHAIN' as const, network: 'solana' as const, address: USDC, decimals: 6, symbol: 'USDC' };
  const snap = { venue: 'AMM_POOL_SOLANA' as const, network: 'solana' as const, asset: token, quoteAsset: quote, atBlock: '10', observedAt: new Date(times.startsAt.getTime() + 3_600_000).toISOString(), priceBaseUnits: '2000000', liquidityBase: '90000000000', feeMicroBps: 25_000, phase: 'POOL' as const, source: 'fixture-pool' };
  const filledAt = new Date(times.startsAt.getTime() + 3_600_000).toISOString();
  const buy = {
    intentId: INTENT, side: 'BUY' as const, assetIn: quote, assetOut: token, quote: snap, executedOn: snap, filledAt,
    postcondition: { simulated: true, inBase: '100000000', outBase: '49875000', feeBase: '250000', slippageBps: 4, priceImpactBps: 12, impactModel: 'constant product', intentId: INTENT },
  };
  const season = { quoteAddress: USDC, startsAt: times.startsAt.toISOString(), endsAt: times.endsAt.toISOString() };

  it('reports only the allowlisted figures, labelled simulated, and names nothing local', () => {
    const verdict = fillFromIntent(ENTRY_KEY, buy, season);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    const text = JSON.stringify(verdict.fill);
    expect(text).not.toContain(INTENT);
    expect(text).not.toContain(ENTRY_KEY);
    expect(text).not.toMatch(/impactModel|constant product|intentId/);
    expect(verdict.fill.simulated).toBe(true);
    expect(verdict.fill.fill_key).toBe(fillKeyOf(ENTRY_KEY, INTENT));
    expect(LeagueFillReport.safeParse({ protocol: 1, entry_id: 'ent_1', fills: [verdict.fill] }).success).toBe(true);
  });

  it('gives one fill one key, and the same bytes every time it is built', () => {
    const a = fillFromIntent(ENTRY_KEY, buy, season);
    const b = fillFromIntent(ENTRY_KEY, buy, season);
    expect(a).toEqual(b);
    if (a.ok) expect(contentHashOf(a.fill)).toBe(contentHashOf((b as { fill: LeagueFill }).fill));
    expect(fillKeyOf(ENTRY_KEY, INTENT)).not.toBe(fillKeyOf(ENTRY_KEY, '6b1f6c3e-9a52-4a4a-8d63-2f0b6f8a7c11'));
    expect(fillKeyOf(ENTRY_KEY, INTENT)).not.toBe(fillKeyOf('1c9f4a1e-7d2b-4e61-9a36-3d5a8b2c1f90', INTENT));
  });

  it('reports a sale as a sale, priced in the same quote', () => {
    const sell = { ...buy, side: 'SELL' as const, assetIn: token, assetOut: quote, postcondition: { ...buy.postcondition, inBase: '49875000', outBase: '99000000' } };
    const verdict = fillFromIntent(ENTRY_KEY, sell, season);
    expect(verdict.ok && verdict.fill.side).toBe('SELL');
  });

  it('keeps a fill from outside the season at home, with the reason', () => {
    expect(fillFromIntent(ENTRY_KEY, { ...buy, filledAt: new Date(times.startsAt.getTime() - 1000).toISOString() }, season)).toEqual({ ok: false, why: 'Made before the season started, so it is not counted.' });
    expect(fillFromIntent(ENTRY_KEY, { ...buy, filledAt: new Date(times.endsAt.getTime() + 1000).toISOString() }, season)).toEqual({ ok: false, why: 'Made after the season ended, so it is not counted.' });
  });

  it('does not report a fill priced in anything but the season quote, or one with an incomplete record', () => {
    const other = { ...quote, address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' };
    expect(fillFromIntent(ENTRY_KEY, { ...buy, assetIn: other }, season).ok).toBe(false);
    expect(fillFromIntent(ENTRY_KEY, { ...buy, postcondition: null }, season).ok).toBe(false);
    expect(fillFromIntent(ENTRY_KEY, { ...buy, executedOn: null }, season).ok).toBe(false);
    expect(fillFromIntent(ENTRY_KEY, { ...buy, postcondition: { ...buy.postcondition, inBase: '1.5' } }, season).ok).toBe(false);
    expect(fillFromIntent(ENTRY_KEY, { ...buy, executedOn: { ...snap, asset: { ...token, address: 'So11111111111111111111111111111111111111113' } } }, season).ok).toBe(false);
    expect(fillFromIntent(ENTRY_KEY, { ...buy, assetOut: { kind: 'NATIVE' as const, network: 'solana' as const } }, season).ok).toBe(false);
  });

  it('refuses a report with an unknown field, a fill that is not simulated, an oversized batch or a repeated key', () => {
    const fill = (fillFromIntent(ENTRY_KEY, buy, season) as { fill: LeagueFill }).fill;
    const report = (fills: unknown[]) => LeagueFillReport.safeParse({ protocol: 1, entry_id: 'ent_1', fills }).success;
    expect(report([fill])).toBe(true);
    expect(report([{ ...fill, wallet: 'abc' }])).toBe(false);
    expect(report([{ ...fill, simulated: false }])).toBe(false);
    expect(report([{ ...fill, fee_base: '-1' }])).toBe(false);
    expect(report([fill, fill])).toBe(false);
    expect(report(Array.from({ length: 51 }, (_, i) => ({ ...fill, fill_key: `f${i.toString(16).padStart(31, '0')}` })))).toBe(false);
    expect(LeagueFillReport.safeParse({ protocol: 1, entry_id: 'ent_1', fills: [fill], note: 'x' }).success).toBe(false);
  });

  it('accepts only an answer that accounts in the contract\'s own words', () => {
    const key = 'f' + '0'.repeat(31);
    expect(LeagueFillAnswer.safeParse({ protocol: 1, simulated: true, accepted: [key], duplicates: [], rejected: [] }).success).toBe(true);
    expect(LeagueFillAnswer.safeParse({ protocol: 1, simulated: true, accepted: [], duplicates: [], rejected: [{ fill_key: key, reason: 'WHATEVER' }] }).success).toBe(false);
    expect(LeagueFillAnswer.safeParse({ protocol: 1, simulated: true, accepted: [], duplicates: [], rejected: [], extra: 1 }).success).toBe(false);
  });
});

describe('the entry request', () => {
  const request = { protocol: 1, entry_key: '0c9f4a1e-7d2b-4e61-9a36-3d5a8b2c1f90', rules_hash: 'a'.repeat(64), alias: 'Night Owl', entrant: 'LOCAL_AGENT' };
  it('is strict, and says nothing about the agent', () => {
    expect(LeagueEntryRequest.safeParse(request).success).toBe(true);
    for (const extra of [{ agent_id: 'x' }, { handle: '@someone' }, { wallet: '0xabc' }, { persona: 'bold' }]) {
      expect(LeagueEntryRequest.safeParse({ ...request, ...extra }).success).toBe(false);
    }
    expect(LeagueEntryRequest.safeParse({ ...request, entrant: 'STUDIO_JOURNAL' }).success).toBe(false);
  });

  it('refuses an alias that is a link, an address or too short', () => {
    for (const alias of ['ab', 'x'.repeat(25), 'example.com', 'https://x', 'a..b', '0x1234567890abcdef', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v']) {
      expect(LeagueAlias.safeParse(alias).success, alias).toBe(false);
    }
    expect(LeagueAlias.safeParse('Night Owl').success).toBe(true);
  });
});

describe('the standing, and what is said about it', () => {
  const base = {
    protocol: 1, simulated: true, source: 'ai17z-studio', generated_at: NOW.toISOString(), season_slug: SLUG, entry_id: 'ent_1',
    season_status: 'RUNNING', entry_status: 'ACTIVE', basis: 'REPORTED_BY_ENTRANT',
  };
  const ranked = (over: Record<string, unknown> = {}) => ({
    ...base,
    standing: { state: 'RANKED', rank: 3, of: 12, return_bps: -125, max_drawdown_bps: 480, fills_counted: 4, last_mark_at: NOW.toISOString(), reason: null, ...over },
  });

  it('refuses an inconsistent or unknown-field standing', () => {
    expect(LeagueStandingDocument.safeParse(ranked()).success).toBe(true);
    expect(LeagueStandingDocument.safeParse(ranked({ rank: 13 })).success).toBe(false);
    expect(LeagueStandingDocument.safeParse(ranked({ rank: null })).success).toBe(false);
    expect(LeagueStandingDocument.safeParse(ranked({ extra: 1 })).success).toBe(false);
    expect(LeagueStandingDocument.safeParse({ ...ranked(), simulated: false }).success).toBe(false);
    expect(LeagueStandingDocument.safeParse({ ...ranked(), basis: 'WATCHED_BY_STUDIO' }).success).toBe(false);
    expect(LeagueStandingDocument.safeParse({ ...ranked(), pnl_usd: '5' }).success).toBe(false);
    expect(LeagueStandingDocument.safeParse(ranked({ state: 'PENDING', rank: 2 })).success).toBe(false);
    expect(LeagueStandingDocument.safeParse(ranked({ state: 'NOT_STARTED', rank: null, of: null, return_bps: 5 })).success).toBe(false);
  });

  it('says a loss as plainly as a gain, names Studio, and says simulated and paper', () => {
    const loss = describeStanding(LeagueStandingDocument.parse(ranked()), 'Weekly holder paper league');
    expect(loss).toMatch(/simulated net loss of 1\.25%/);
    expect(loss).toMatch(/ranked 3 of 12/);
    for (const word of [/Studio/, /simulated/, /paper/, /not real trades/, /nothing about future results/]) expect(loss).toMatch(word);
    const gain = describeStanding(LeagueStandingDocument.parse(ranked({ return_bps: 210 })), 'Weekly holder paper league');
    expect(gain).toMatch(/simulated net gain of 2\.10%/);
    expect(describeStanding(LeagueStandingDocument.parse(ranked({ return_bps: 0 })), 'x')).toMatch(/no net change/);
  });

  it('never implies a future return, a position or advice', () => {
    for (const return_bps of [-125, 0, 2100]) {
      const text = describeStanding(LeagueStandingDocument.parse(ranked({ return_bps })), 'Weekly holder paper league');
      expect(text).not.toMatch(/\b(will|expect|guarantee|profit|buy|sell|signal|upside|edge|alpha)\b/i);
    }
  });

  it('gives no rank when there is none', () => {
    const pending = describeStanding(LeagueStandingDocument.parse(ranked({ state: 'PENDING', rank: null, of: null, return_bps: null, reason: 'Studio has no usable valuation for it yet' })), 'x');
    const unranked = describeStanding(LeagueStandingDocument.parse(ranked({ state: 'UNRANKED', rank: null, of: null, return_bps: null, reason: 'withdrawn' })), 'x');
    const notStarted = describeStanding(LeagueStandingDocument.parse(ranked({ state: 'NOT_STARTED', rank: null, of: null, return_bps: null, fills_counted: 0, last_mark_at: null })), 'x');
    for (const text of [pending, unranked, notStarted]) expect(text).not.toMatch(/ranked \d|\d+ of \d+|bps/);
    expect(pending).toMatch(/will not guess/);
  });

  it('says it cannot check, still says what is true locally, and invents no rank', () => {
    const text = describeUnavailable('Studio could not be reached: connect ECONNREFUSED', { seasonSlug: SLUG, endsAt: times.endsAt.toISOString() });
    expect(text).toMatch(/cannot check/);
    expect(text).toMatch(/simulated paper mandate/);
    expect(text).toMatch(/will not guess/);
    expect(text).not.toMatch(/ranked|\d+ of \d+/);
    expect(describeUnavailable('Studio answered 503.', null)).not.toMatch(/mandate/);
  });
});

describe('no path reaches a signer or the live trade path', () => {
  const root = join(__dirname, '..', '..', 'packages');
  const files = [
    join(root, 'runtime', 'src', 'leagueSeason.ts'),
    join(root, 'runtime', 'src', 'studioLeague.ts'),
    join(root, 'runtime', 'src', 'studioLeagueCapabilities.ts'),
    join(root, 'database', 'src', 'repositories', 'leagueBridge.ts'),
    join(root, 'shared', 'src', 'contracts', 'studioLeague.ts'),
  ];

  for (const file of files) {
    it(`${file.split(/[\\/]/).slice(-2).join('/')} imports nothing that signs, holds a key or trades for real`, () => {
      const text = readFileSync(file, 'utf8');
      const imports = [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
      for (const spec of imports) {
        expect(spec, spec).not.toMatch(/studioLiveTrades|walletCore|walletRecovery|walletCapabilities|tradeExecution|liveTrading|tradePreflight|studioControl|killSwitch/);
      }
      expect(text).not.toMatch(/prepareMarketplacePurchase|prepareStudioPurchase|studioLiveTrade|sealedSecretOf|openSecret|\.sign\(|\.broadcast\(|submitIntent|approveIntent/);
      // The only mode this code ever writes is PAPER.
      expect(text).not.toMatch(/mode:\s*'LIVE'|AUTONOMOUS_WITHIN_MANDATE/);
    });
  }

  it('writes the mandate\'s mode itself, over whatever it was handed', () => {
    const text = readFileSync(join(root, 'database', 'src', 'repositories', 'leagueBridge.ts'), 'utf8');
    expect(text).toMatch(/mode: 'PAPER', approval: 'OWNER_APPROVES_EACH', protectiveExits: null/);
  });
});
