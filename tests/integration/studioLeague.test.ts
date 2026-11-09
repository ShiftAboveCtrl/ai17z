import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { leagueBridge, query, trading, type LeagueEntryRow } from '@xbam/database';
import {
  UNSAFE_DEV_ORIGIN_ENV,
  beginStudioLink,
  enterLeagueSeason,
  pollStudioLink,
  readLeagueSeason,
  readLeagueStanding,
  registerStudioLeagueCapabilities,
  reportLeagueFills,
  sweepLeagueBridge,
} from '@xbam/runtime';
import { AssetRef, MarketSnapshot, TradeMandate } from '@xbam/shared/contracts';
import { invokeCapability, registerBuiltinCapabilities, resetCapabilitiesForTest } from '@xbam/tools';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { TOKEN_MINT, USDC, leagueRules, seasonDocument, startLeagueStudio, type LeagueStudio } from '../support/leagueStudioServer';

installHarness();

/**
 * The paper league bridge, against a server that implements
 * `docs/architecture/STUDIO_LEAGUE_BRIDGE.md` and verifies DPoP for real.
 *
 * Time is the server's `setNow` and the `now` each call takes. The season
 * published here opens in the future, so a fill "in the season" is one dated
 * three hours after it starts.
 */

const H = 3_600_000;
const BASE = new Date();
let studio: LeagueStudio;
let previousOrigin: string | undefined;

beforeAll(async () => {
  studio = await startLeagueStudio({ now: BASE });
  previousOrigin = process.env[UNSAFE_DEV_ORIGIN_ENV];
  process.env[UNSAFE_DEV_ORIGIN_ENV] = studio.url;
  resetCapabilitiesForTest();
  registerBuiltinCapabilities();
  registerStudioLeagueCapabilities();
});

afterAll(async () => {
  if (previousOrigin === undefined) delete process.env[UNSAFE_DEV_ORIGIN_ENV];
  else process.env[UNSAFE_DEV_ORIGIN_ENV] = previousOrigin;
  await studio.close();
});

beforeEach(() => {
  studio.requests.length = 0;
  studio.entries.clear();
  studio.fills.clear();
  studio.rules = leagueRules();
  studio.seasonPatch = {};
  studio.seasonOverride = null;
  studio.standingOverride = null;
  studio.fillAnswerOverride = null;
  studio.failFillReports = { times: 0, status: 503 };
  studio.setNow(BASE);
  studio.goUp();
});

async function link(): Promise<void> {
  if ((await pollStudioLink()).state === 'LINKED') return;
  const started = await beginStudioLink({ replacePrevious: false });
  if (!started.ok) throw new Error(started.why);
  expect((await pollStudioLink()).state).toBe('LINKED');
}

const quoteAsset = AssetRef.parse({ kind: 'ONCHAIN', network: 'solana', address: USDC, decimals: 6, symbol: 'USDC' });
const tokenAsset = AssetRef.parse({ kind: 'ONCHAIN', network: 'solana', address: TOKEN_MINT, decimals: 9, symbol: 'WIF' });
const snapshot = (at: Date) =>
  MarketSnapshot.parse({ venue: 'AMM_POOL_SOLANA', network: 'solana', asset: tokenAsset, quoteAsset, atBlock: '10', observedAt: at.toISOString(), priceBaseUnits: '2000000', liquidityBase: '90000000000', feeMicroBps: 25_000, phase: 'POOL', source: 'fixture-pool' });

async function setup() {
  await link();
  const fixture = await createFixture({});
  return fixture;
}

const enter = (agentId: string, ownerId: string, over: Record<string, unknown> = {}, now = BASE) =>
  enterLeagueSeason({ agentId, ownerId, slug: 'week-45', alias: 'Night Owl', ...over }, now);

/** A paper fill under `mandateId`, dated `at` (the journal's own clock is the database's, so it is moved). */
async function seedFill(agentId: string, mandateId: string, at: Date, over: { inBase?: string; outBase?: string; postcondition?: Record<string, unknown> | null } = {}) {
  const snap = snapshot(at);
  const { row } = await trading.createIntent({
    agentId, mandateId, walletId: null, mode: 'PAPER', venue: 'AMM_POOL_SOLANA', network: 'solana', side: 'BUY',
    assetIn: quoteAsset, assetOut: tokenAsset, maxIn: over.inBase ?? '100000000', minOut: '1', maxSlippageBps: 100, maxPriceImpactBps: 200,
    maxFeeBase: '10000000', quote: snap, expiresAt: new Date(at.getTime() + H).toISOString(), idempotencyKey: `test-${randomUUID()}`,
  });
  await trading.transitionIntent(row.id, 'DRAFTED', 'SIMULATED', { simulation: { simulated: true } });
  await trading.transitionIntent(row.id, 'SIMULATED', 'PAPER_FILLED', {
    executedOn: snap,
    postcondition: over.postcondition === undefined
      ? { simulated: true, inBase: over.inBase ?? '100000000', outBase: over.outBase ?? '49875000', feeBase: '250000', slippageBps: 4, priceImpactBps: 12, impactModel: 'constant product' }
      : over.postcondition,
    riskReasons: [],
  });
  await query(`UPDATE trade_intents SET updated_at = $2 WHERE id = $1`, [row.id, at.toISOString()]);
  return row.id;
}

const inSeason = (hours = 3) => new Date(studio.times.startsAt.getTime() + hours * H);

async function entered() {
  const f = await setup();
  const result = await enter(f.agentId, f.ownerId);
  if (!result.ok) throw new Error(result.why);
  expect(result.state).toBe('ACTIVE');
  return { ...f, entry: result.entry as LeagueEntryRow };
}

describe('reading a season', () => {
  it('goes to the linked origin with a DPoP proof for that exact request, and never a bearer secret', async () => {
    await link();
    const read = await readLeagueSeason('week-45', BASE);
    expect(read.ok).toBe(true);
    expect(studio.requests).toHaveLength(1);
    expect(studio.requests[0]).toMatchObject({ method: 'GET', scheme: 'dpop', proofValid: true, why: null, path: '/api/v1/installation/league/seasons/week-45' });
  });

  it('asks nothing when the name is not a season name, and when the installation is not linked', async () => {
    expect((await readLeagueSeason('../token', BASE)).ok).toBe(false);
    expect((await readLeagueSeason('Week 45', BASE)).ok).toBe(false);
    expect(studio.requests).toHaveLength(0);
  });

  it('refuses a hostile season and writes nothing: no entry row, no mandate, nothing sent to Studio', async () => {
    const f = await setup();
    for (const hostile of [
      { ...seasonDocument('week-45', BASE, studio.times, leagueRules(), {}), extra_field: 1 },
      seasonDocument('week-45', BASE, studio.times, leagueRules({ capital: 2_000_000 }), {}),
      seasonDocument('week-45', BASE, studio.times, leagueRules({ bounds: { maxOpenPositions: 99, maxTradePct: 25, minLiquidityUsd: 1 } }), {}),
      seasonDocument('week-45', BASE, studio.times, leagueRules({ quote: { symbol: 'USDC', network: 'solana', address: TOKEN_MINT, decimals: 6 } }), {}),
      seasonDocument('week-45', BASE, studio.times, leagueRules({ universe: { kind: 'MARKETS', lists: [] } }), {}),
    ]) {
      studio.seasonOverride = () => ({ body: hostile });
      const result = await enter(f.agentId, f.ownerId);
      expect(result.ok).toBe(false);
    }
    expect(await leagueBridge.latestEntryOf(f.agentId)).toBeNull();
    expect(await trading.liveMandate(f.agentId)).toBeNull();
    expect(studio.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
    expect(studio.entries.size).toBe(0);
  });

  it('refuses a season that is stale, or whose rules are not its hash', async () => {
    const f = await setup();
    studio.seasonOverride = () => ({ body: seasonDocument('week-45', new Date(BASE.getTime() - H), studio.times, leagueRules(), {}) });
    const stale = await enter(f.agentId, f.ownerId);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.why).toMatch(/not current/);

    const doc = seasonDocument('week-45', BASE, studio.times, leagueRules(), {}) as { season: { rules: Record<string, unknown> } };
    doc.season.rules = { ...doc.season.rules, capital: 5 };
    studio.seasonOverride = () => ({ body: doc });
    expect((await enter(f.agentId, f.ownerId)).ok).toBe(false);
    expect(await leagueBridge.latestEntryOf(f.agentId)).toBeNull();
  });
});

describe('entering', () => {
  it('records the entry, tells Studio under a key, then writes a PAPER mandate and activates', async () => {
    const f = await setup();
    const result = await enter(f.agentId, f.ownerId);
    expect(result).toMatchObject({ ok: true, state: 'ACTIVE' });
    if (!result.ok) return;
    const entry = result.entry;
    expect(entry.status).toBe('ACTIVE');
    expect(entry.remoteEntryId).toMatch(/^ent_/);
    expect(studio.entries.size).toBe(1);
    // The request names no agent, handle or wallet: the key, the hash, the alias.
    const post = studio.requests.find((r) => r.method === 'POST')!;
    expect(post).toMatchObject({ scheme: 'dpop', proofValid: true });
    expect(Object.keys(post.body as object).sort()).toEqual(['alias', 'entrant', 'entry_key', 'protocol', 'rules_hash']);
    expect(JSON.stringify(post.body)).not.toContain(f.agentId);

    const mandate = await trading.liveMandate(f.agentId);
    expect(mandate).toMatchObject({ id: entry.mandateId, mode: 'PAPER', approval: 'OWNER_APPROVES_EACH', protectiveExits: null, maxPerTrade: '250000000', assetScope: 'ANY_SOLANA_TOKEN', paused: false });
    expect(mandate!.expiresAt).toBe(studio.times.endsAt.toISOString());
    expect(mandate!.venues).toEqual(['AMM_POOL_SOLANA']);
  });

  it('is idempotent: entering again is the same entry, at Studio and here', async () => {
    const { agentId, ownerId, entry } = await entered();
    const again = await enter(agentId, ownerId);
    expect(again).toMatchObject({ ok: true });
    if (again.ok) expect(again.entry.id).toBe(entry.id);
    expect(studio.entries.size).toBe(1);
    const rows = await query(`SELECT id FROM league_entries WHERE agent_id = $1`, [agentId]);
    expect(rows).toHaveLength(1);
  });

  it('survives a crash after Studio said yes: the pending row resumes under the same key and no second entry appears', async () => {
    const f = await setup();
    // Studio took the entry and the answer never arrived: the row exists with no remote id.
    const read = await readLeagueSeason('week-45', BASE);
    if (!read.ok) throw new Error(read.why);
    const created = await leagueBridge.createPendingEntry({
      agentId: f.agentId, ownerId: f.ownerId, seasonSlug: 'week-45', alias: 'Night Owl', replacePaperMandate: false, season: read.season,
      rulesHash: read.season.season.rules_hash, startsAt: read.season.season.starts_at, endsAt: read.season.season.ends_at, fillsAcceptedUntil: read.season.season.fills_accepted_until,
    });
    expect(created.kind).toBe('CREATED');
    studio.entries.set(created.row.entryKey, { entryId: 'ent_lost', alias: 'Night Owl', enteredAt: BASE.toISOString() });
    // The sweep finishes it.
    await sweepLeagueBridge(BASE);
    const after = await leagueBridge.getEntry(created.row.id);
    expect(after).toMatchObject({ status: 'ACTIVE', remoteEntryId: 'ent_lost' });
    expect(studio.entries.size).toBe(1);
  });

  it('never replaces a live mandate, and replaces an owner\'s own paper mandate only when told to, before Studio hears anything', async () => {
    const f = await setup();
    const paper = TradeMandate.omit({ id: true, agentId: true }).parse({
      mode: 'PAPER', approval: 'OWNER_APPROVES_EACH', venues: ['AMM_POOL_SOLANA'], networks: ['solana'], allowedAssets: [], assetScope: 'ANY_SOLANA_TOKEN',
      maxPerTrade: '1000000', maxPerDay: '10000000', maxOpenExposure: '10000000', maxOpenPositions: 5, maxSlippageBps: 100, maxPriceImpactBps: 200,
      minLiquidityBase: '1000000', maxFeeBase: '10000', quoteMaxAgeMs: 30000, expiresAt: null,
    });
    const own = await trading.putMandate({ agentId: f.agentId, ownerId: f.ownerId, mandate: paper });
    const refused = await enter(f.agentId, f.ownerId);
    expect(refused.ok).toBe(false);
    expect(studio.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
    expect((await trading.liveMandate(f.agentId))!.id).toBe(own.id);
    // Refused before anything was recorded, so nothing is left holding the agent's one slot.
    expect(await leagueBridge.latestEntryOf(f.agentId)).toBeNull();

    // A live mandate is never replaced, even when asked.
    const g = await createFixture({});
    await trading.putMandate({ agentId: g.agentId, ownerId: g.ownerId, mandate: { ...paper, mode: 'LIVE' } });
    const live = await enter(g.agentId, g.ownerId, { replacePaperMandate: true });
    expect(live.ok).toBe(false);
    if (!live.ok) expect(live.why).toMatch(/live trading mandate/);
    expect((await trading.liveMandate(g.agentId))!.mode).toBe('LIVE');
    expect(studio.entries.size).toBe(0);

    // Told to, the owner's paper mandate is superseded, and the old row is kept as history.
    const h = await createFixture({});
    const theirs = await trading.putMandate({ agentId: h.agentId, ownerId: h.ownerId, mandate: paper });
    const replaced = await enter(h.agentId, h.ownerId, { replacePaperMandate: true });
    expect(replaced).toMatchObject({ ok: true, state: 'ACTIVE' });
    const now = await trading.liveMandate(h.agentId);
    expect(now!.id).not.toBe(theirs.id);
    expect((await trading.getMandate(theirs.id))!.retiredAt).not.toBeNull();
  });

  it('refuses entry after the lock, to a season that takes no local agent, or under changed rules, without touching the mandate', async () => {
    const f = await setup();
    const late = new Date(studio.times.entryClosesAt.getTime() + 1000);
    studio.setNow(late);
    const closed = await enter(f.agentId, f.ownerId, {}, late);
    expect(closed.ok).toBe(false);
    studio.setNow(BASE);

    studio.seasonOverride = () => ({ body: { ...seasonDocument('week-45', BASE, studio.times, leagueRules(), {}), local_agents: { allowed: false, note: 'Journal agents only.' } } });
    const nolocal = await enter(f.agentId, f.ownerId);
    expect(nolocal).toMatchObject({ ok: false, why: 'Journal agents only.' });
    expect(await trading.liveMandate(f.agentId)).toBeNull();
    expect(await leagueBridge.latestEntryOf(f.agentId)).toBeNull();
  });

  it('records a refusal by Studio and leaves the mandate alone', async () => {
    const f = await setup();
    // Studio has the rules hash wrong: the entry is refused with a 409.
    studio.rules = leagueRules();
    studio.seasonOverride = null;
    const read = await readLeagueSeason('week-45', BASE);
    if (!read.ok) throw new Error(read.why);
    const stale = { ...read.season, season: { ...read.season.season } };
    studio.seasonOverride = () => ({ body: stale });
    // Between the read and the post the published rules change.
    studio.rules = leagueRules({ capital: 2000 });
    const refused = await enter(f.agentId, f.ownerId);
    expect(refused.ok).toBe(false);
    expect(await trading.liveMandate(f.agentId)).toBeNull();
    expect(await leagueBridge.latestEntryOf(f.agentId)).toMatchObject({ status: 'REFUSED' });
    // A refused entry is history, not a slot to be reused with other rules.
    studio.seasonOverride = null;
    studio.rules = leagueRules();
    const retry = await enter(f.agentId, f.ownerId);
    expect(retry.ok).toBe(false);
  });

  it('is one season at a time', async () => {
    const { agentId, ownerId } = await entered();
    const other = await enterLeagueSeason({ agentId, ownerId, slug: 'week-46', alias: 'Night Owl' }, BASE);
    expect(other.ok).toBe(false);
  });
});

describe('reporting fills', () => {
  it('reports each in-season fill once under its own key, and labels the answer', async () => {
    const { agentId, entry } = await entered();
    const a = await seedFill(agentId, entry.mandateId!, inSeason(3));
    await seedFill(agentId, entry.mandateId!, inSeason(5), { inBase: '50000000', outBase: '24900000' });
    studio.setNow(inSeason(6));
    const first = await sweepLeagueBridge(inSeason(6));
    expect(first).toMatchObject({ entries: 1, recorded: 2, accepted: 2 });
    expect(studio.fills.size).toBe(2);
    const counts = await leagueBridge.fillCounts(entry.id);
    expect(counts).toMatchObject({ ACCEPTED: 2, PENDING: 0, REJECTED: 0 });
    const sent = [...studio.fills.values()][0]!.fill;
    expect(sent.simulated).toBe(true);
    expect(JSON.stringify(sent)).not.toContain(a);
    // The report names the Studio entry, never the agent.
    const post = studio.requests.filter((r) => r.path.endsWith('/entry/fills'))[0]!;
    expect(JSON.stringify(post.body)).not.toContain(agentId);

    // Nothing new, nothing sent.
    const before = studio.requests.length;
    await sweepLeagueBridge(inSeason(7));
    expect(studio.requests.filter((r) => r.path.endsWith('/entry/fills'))).toHaveLength(1);
    expect(studio.requests.length).toBeGreaterThanOrEqual(before);
  });

  it('a restart that lost its ledger replays the same bytes and Studio counts nothing twice', async () => {
    const { agentId, entry } = await entered();
    await seedFill(agentId, entry.mandateId!, inSeason(3));
    studio.setNow(inSeason(4));
    await sweepLeagueBridge(inSeason(4));
    expect(studio.fills.size).toBe(1);
    const held = [...studio.fills.values()][0]!;

    await query(`DELETE FROM league_fill_reports WHERE entry_id = $1`, [entry.id]);
    const again = await sweepLeagueBridge(inSeason(5));
    expect(again.accepted).toBe(1);
    expect(studio.fills.size).toBe(1);
    expect([...studio.fills.values()][0]!.hash).toBe(held.hash);
    expect(await leagueBridge.fillCounts(entry.id)).toMatchObject({ ACCEPTED: 1 });
  });

  it('retries a failed report with the same key and bytes, and a lost answer is not a second fill', async () => {
    const { agentId, entry } = await entered();
    await seedFill(agentId, entry.mandateId!, inSeason(3));
    studio.setNow(inSeason(4));
    studio.failFillReports = { times: 1, status: 503 };
    const failed = await sweepLeagueBridge(inSeason(4));
    expect(failed).toMatchObject({ accepted: 0, deferred: 1 });
    expect(studio.fills.size).toBe(0);
    const pending = (await leagueBridge.fillsOf(entry.id))[0]!;
    expect(pending).toMatchObject({ state: 'PENDING', attempts: 1 });
    // Not before the backoff.
    expect((await sweepLeagueBridge(inSeason(4))).accepted).toBe(0);
    const later = new Date(inSeason(4).getTime() + 2 * H);
    studio.setNow(later);
    expect((await sweepLeagueBridge(later)).accepted).toBe(1);
    expect(studio.fills.size).toBe(1);
  });

  it('does not take an answer that accounts for a key that was not sent, or leaves one out', async () => {
    const { agentId, entry } = await entered();
    await seedFill(agentId, entry.mandateId!, inSeason(3));
    studio.setNow(inSeason(4));
    studio.fillAnswerOverride = () => ({ body: { protocol: 1, simulated: true, accepted: ['f' + 'a'.repeat(31)], duplicates: [], rejected: [] } });
    const result = await sweepLeagueBridge(inSeason(4));
    expect(result).toMatchObject({ accepted: 0, deferred: 1 });
    expect((await leagueBridge.fillsOf(entry.id))[0]!.state).toBe('PENDING');
    studio.fillAnswerOverride = () => ({ body: { protocol: 1, simulated: true, accepted: [], duplicates: [], rejected: [], leaderboard: [] } });
    expect((await sweepLeagueBridge(new Date(inSeason(4).getTime() + 2 * H))).accepted).toBe(0);
    expect((await leagueBridge.fillsOf(entry.id))[0]!.state).toBe('PENDING');
  });

  it('cannot be edited after the fact: the ledger refuses, and a changed fill under the same key is rejected, not applied', async () => {
    const { agentId, entry } = await entered();
    const intent = await seedFill(agentId, entry.mandateId!, inSeason(3));
    studio.setNow(inSeason(4));
    await sweepLeagueBridge(inSeason(4));
    const [stored] = await leagueBridge.fillsOf(entry.id);
    await expect(query(`UPDATE league_fill_reports SET payload = '{"simulated": true}'::jsonb WHERE entry_id = $1`, [entry.id])).rejects.toThrow(/not edited/);
    await expect(query(`UPDATE league_fill_reports SET state = 'PENDING' WHERE entry_id = $1`, [entry.id])).rejects.toThrow(/does not change state/);
    await expect(query(`UPDATE league_entries SET rules_hash = $2 WHERE id = $1`, [entry.id, 'b'.repeat(64)])).rejects.toThrow(/frozen/);
    await expect(query(`UPDATE league_entries SET ends_at = ends_at + interval '1 day' WHERE id = $1`, [entry.id])).rejects.toThrow(/frozen/);
    expect(stored!.state).toBe('ACCEPTED');

    // The trade record is changed behind the ledger's back and the ledger forgotten: same key, different content.
    await query(`UPDATE trade_intents SET postcondition = jsonb_set(postcondition, '{outBase}', '"99999999"') WHERE id = $1`, [intent]);
    await query(`DELETE FROM league_fill_reports WHERE entry_id = $1`, [entry.id]);
    await sweepLeagueBridge(inSeason(5));
    expect(studio.fills.size).toBe(1);
    expect([...studio.fills.values()][0]!.fill.out_base).toBe('49875000');
    expect((await leagueBridge.fillsOf(entry.id))[0]).toMatchObject({ state: 'REJECTED', reason: expect.stringMatching(/content changed/) });
  });

  it('keeps a fill made outside the season at home, with the reason, and never sends it', async () => {
    const { agentId, entry } = await entered();
    await seedFill(agentId, entry.mandateId!, new Date(studio.times.startsAt.getTime() - H));
    await seedFill(agentId, entry.mandateId!, new Date(studio.times.endsAt.getTime() + H));
    studio.setNow(new Date(studio.times.endsAt.getTime() + 2 * H));
    await sweepLeagueBridge(new Date(studio.times.endsAt.getTime() + 2 * H));
    expect(studio.fills.size).toBe(0);
    expect(studio.requests.filter((r) => r.path.endsWith('/entry/fills'))).toHaveLength(0);
    const rows = await leagueBridge.fillsOf(entry.id);
    expect(rows.map((r) => r.state)).toEqual(['LOCAL_ONLY', 'LOCAL_ONLY']);
    expect(rows.map((r) => r.reason).join(' ')).toMatch(/before the season started.*after the season ended|after the season ended.*before the season started/);
  });

  it('does not backfill past the report deadline: what is unsent becomes local only, and the entry ends', async () => {
    const { agentId, entry } = await entered();
    studio.failFillReports = { times: 50, status: 503 };
    await seedFill(agentId, entry.mandateId!, inSeason(3));
    studio.setNow(inSeason(4));
    await sweepLeagueBridge(inSeason(4));
    expect(studio.fills.size).toBe(0);
    studio.failFillReports = { times: 0, status: 503 };
    const late = new Date(studio.times.fillsAcceptedUntil.getTime() + H);
    studio.setNow(late);
    await sweepLeagueBridge(late);
    expect(studio.fills.size).toBe(0);
    expect((await leagueBridge.fillsOf(entry.id))[0]).toMatchObject({ state: 'LOCAL_ONLY' });
    expect(await leagueBridge.getEntry(entry.id)).toMatchObject({ status: 'ENDED' });
    expect(await reportLeagueFills((await leagueBridge.getEntry(entry.id))!, late)).toEqual({ recorded: 0, accepted: 0, rejected: 0, deferred: 0 });
  });

  it('with Studio unreachable, nothing is lost and nothing throws: the fill waits', async () => {
    const { agentId, entry } = await entered();
    await seedFill(agentId, entry.mandateId!, inSeason(3));
    studio.setNow(inSeason(4));
    studio.goDown();
    const down = await sweepLeagueBridge(inSeason(4));
    expect(down).toMatchObject({ accepted: 0, deferred: 1 });
    expect(await leagueBridge.getEntry(entry.id)).toMatchObject({ status: 'ACTIVE' });
    studio.goUp();
    expect((await sweepLeagueBridge(new Date(inSeason(4).getTime() + 2 * H))).accepted).toBe(1);
  });
});

describe('the season changing under an entry', () => {
  it('keeps the applied season when Studio publishes different rules, and records why', async () => {
    const { entry } = await entered();
    studio.rules = leagueRules({ capital: 5000 });
    const later = new Date(BASE.getTime() + 31 * 60_000);
    studio.setNow(later);
    await sweepLeagueBridge(later);
    const after = await leagueBridge.getEntry(entry.id);
    expect(after).toMatchObject({ status: 'ACTIVE', rulesHash: entry.rulesHash });
    expect(after!.lastProblem).toMatch(/different rules/);
    expect((await trading.liveMandate(entry.agentId))!.maxPerDay).toBe('1000000000');
  });

  it('ends the entry and pauses its mandate when Studio cancels the season', async () => {
    const { entry } = await entered();
    studio.seasonPatch = { status: 'CANCELLED' };
    const later = new Date(BASE.getTime() + 31 * 60_000);
    studio.setNow(later);
    await sweepLeagueBridge(later);
    expect(await leagueBridge.getEntry(entry.id)).toMatchObject({ status: 'ENDED', statusReason: 'Studio cancelled the season.' });
    expect((await trading.getMandate(entry.mandateId!))!.paused).toBe(true);
  });

  it('leaves the season running on paper, and says so, when Studio cannot be reached', async () => {
    const { entry } = await entered();
    studio.goDown();
    const later = new Date(BASE.getTime() + 31 * 60_000);
    await sweepLeagueBridge(later);
    const after = await leagueBridge.getEntry(entry.id);
    expect(after).toMatchObject({ status: 'ACTIVE' });
    expect(after!.lastProblem).toMatch(/could not be reached/);
    const mandate = await trading.liveMandate(entry.agentId);
    expect(mandate).toMatchObject({ id: entry.mandateId, mode: 'PAPER', paused: false });
  });
});

describe('the standing', () => {
  const ask = (agentId: string, audience: 'OWNER' | 'PUBLIC' = 'OWNER', stored: 'ALLOWED' | 'DISABLED' | null = 'ALLOWED') =>
    invokeCapability({
      call: { id: 'league.standing', input: {} },
      context: { agentId, jobId: null, accountId: null, config: {}, audience, logger: console as never },
      permission: { stored, paused: false },
    });

  it('reads the standing from Studio now, and says it as Studio\'s, simulated, paper and a loss as a loss', async () => {
    const f = await entered();
    studio.setNow(new Date());
    const result = await ask(f.agentId);
    expect(result.outcome).toBe('SUCCEEDED');
    const out = result.output as { state: string; statement: string; rank: number | null };
    expect(out.state).toBe('NOT_STARTED');
    expect(out.rank).toBeNull();
    expect(out.statement).toMatch(/simulated, paper only/);

    // Once the season runs, with a fill counted, Studio ranks it.
    studio.standingOverride = () => ({
      body: {
        protocol: 1, simulated: true, source: 'ai17z-studio', generated_at: new Date().toISOString(), season_slug: 'week-45',
        entry_id: f.entry.remoteEntryId, season_status: 'RUNNING', entry_status: 'ACTIVE', basis: 'REPORTED_BY_ENTRANT',
        standing: { state: 'RANKED', rank: 3, of: 12, return_bps: -125, max_drawdown_bps: 480, fills_counted: 2, last_mark_at: new Date().toISOString(), reason: null },
      },
    });
    const ranked = await ask(f.agentId);
    const text = (ranked.output as { statement: string }).statement;
    expect(text).toMatch(/ranked 3 of 12/);
    expect(text).toMatch(/simulated net loss of 1\.25%/);
    expect(text).toMatch(/Studio/);
    expect(text).toMatch(/not real trades/);
    expect(studio.requests.filter((r) => r.path.endsWith('/entry') && r.method === 'GET').every((r) => r.proofValid)).toBe(true);
  });

  it('keeps no copy: Studio unreachable is UNAVAILABLE, with no rank, even straight after a ranked answer', async () => {
    const f = await entered();
    studio.setNow(new Date());
    studio.standingOverride = () => ({
      body: {
        protocol: 1, simulated: true, source: 'ai17z-studio', generated_at: new Date().toISOString(), season_slug: 'week-45',
        entry_id: f.entry.remoteEntryId, season_status: 'RUNNING', entry_status: 'ACTIVE', basis: 'REPORTED_BY_ENTRANT',
        standing: { state: 'RANKED', rank: 1, of: 12, return_bps: 900, max_drawdown_bps: 100, fills_counted: 5, last_mark_at: new Date().toISOString(), reason: null },
      },
    });
    expect((await ask(f.agentId)).output).toMatchObject({ state: 'RANKED', rank: 1 });
    studio.goDown();
    const down = (await ask(f.agentId)).output as { state: string; rank: number | null; returnBps: number | null; statement: string };
    expect(down).toMatchObject({ state: 'UNAVAILABLE', rank: null, returnBps: null });
    expect(down.statement).toMatch(/cannot check/);
    expect(down.statement).toMatch(/still in place here/);
    expect(down.statement).toMatch(/will not guess/);
    expect(down.statement).not.toMatch(/ranked|\b1 of 12\b/);
    // The season keeps running on paper meanwhile.
    expect(await trading.liveMandate(f.agentId)).toMatchObject({ id: f.entry.mandateId, mode: 'PAPER', paused: false });
  });

  it('refuses a hostile standing: an extra field, a rank past the field, another entry, a stale date, a figure that is not simulated', async () => {
    const f = await entered();
    studio.setNow(new Date());
    const good = () => ({
      protocol: 1, simulated: true, source: 'ai17z-studio', generated_at: new Date().toISOString(), season_slug: 'week-45',
      entry_id: f.entry.remoteEntryId, season_status: 'RUNNING', entry_status: 'ACTIVE', basis: 'REPORTED_BY_ENTRANT',
      standing: { state: 'RANKED', rank: 2, of: 12, return_bps: 10, max_drawdown_bps: 1, fills_counted: 1, last_mark_at: new Date().toISOString(), reason: null },
    });
    const variants: Array<Record<string, unknown>> = [
      { ...good(), wallet: '0xabc' },
      { ...good(), standing: { ...good().standing, rank: 13 } },
      { ...good(), entry_id: 'ent_somebody_else' },
      { ...good(), generated_at: new Date(Date.now() - 3 * H).toISOString() },
      { ...good(), simulated: false },
      { ...good(), season_slug: 'week-46' },
    ];
    for (const body of variants) {
      studio.standingOverride = () => ({ body });
      const read = await readLeagueStanding(f.agentId);
      expect(read.ok, JSON.stringify(body).slice(0, 80)).toBe(false);
    }
  });

  it('says plainly that there is no standing when the agent is not entered, and invents none', async () => {
    await link();
    const f = await createFixture({});
    const out = (await ask(f.agentId)).output as { state: string; statement: string };
    expect(out.state).toBe('NOT_ENTERED');
    expect(out.statement).toMatch(/not entered/);
    expect(studio.requests).toHaveLength(0);
  });

  it('is for the owner only, and off until the owner enables it', async () => {
    const f = await entered();
    expect((await ask(f.agentId, 'PUBLIC')).outcome).toBe('REFUSED');
    expect((await ask(f.agentId, 'OWNER', 'DISABLED')).outcome).toBe('REFUSED');
    expect((await ask(f.agentId, 'OWNER', null)).outcome).toBe('REFUSED');
    expect((await ask(f.agentId, 'OWNER', 'ALLOWED')).outcome).toBe('SUCCEEDED');
  });
});
