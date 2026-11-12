import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accounts, agents, content as contentRepo, leagueBridge, query, trading } from '@xbam/database';
import {
  UNSAFE_DEV_ORIGIN_ENV,
  beginStudioLink,
  checkLeaguePostAtSend,
  enterLeagueSeason,
  pollStudioLink,
  proposeLeagueSeasonPosts,
  setPauseAll,
  sweepLeagueBridge,
  LEAGUE_IDEA_SOURCE,
} from '@xbam/runtime';
import { AssetRef, DEFAULT_POLICY, MarketSnapshot, PolicyConfig } from '@xbam/shared/contracts';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { TOKEN_MINT, USDC, leagueRules, seasonTimes, startLeagueStudio, type LeagueStudio } from '../support/leagueStudioServer';

installHarness();

/**
 * The agent narrating its paper league season, against a server that
 * implements `docs/architecture/STUDIO_LEAGUE_BRIDGE.md` and verifies DPoP for
 * real. Time is the server's `setNow` and the `now` each call takes.
 */

const H = 3_600_000;
const BASE = new Date();
let studio: LeagueStudio;
let previousOrigin: string | undefined;

beforeAll(async () => {
  studio = await startLeagueStudio({ now: BASE });
  previousOrigin = process.env[UNSAFE_DEV_ORIGIN_ENV];
  process.env[UNSAFE_DEV_ORIGIN_ENV] = studio.url;
});

afterAll(async () => {
  if (previousOrigin === undefined) delete process.env[UNSAFE_DEV_ORIGIN_ENV];
  else process.env[UNSAFE_DEV_ORIGIN_ENV] = previousOrigin;
  await studio.close();
});

beforeEach(async () => {
  studio.requests.length = 0;
  studio.entries.clear();
  studio.fills.clear();
  studio.rules = leagueRules();
  studio.seasonPatch = {};
  studio.seasonOverride = null;
  studio.standingOverride = null;
  studio.fillAnswerOverride = null;
  studio.failFillReports = { times: 0, status: 503 };
  studio.failEntries = { times: 0, status: 503 };
  studio.times = seasonTimes(BASE);
  studio.setNow(BASE);
  studio.goUp();
  await setPauseAll({ paused: false, by: null });
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

async function seedFill(agentId: string, mandateId: string, at: Date) {
  const snap = snapshot(at);
  const { row } = await trading.createIntent({
    agentId, mandateId, walletId: null, mode: 'PAPER', venue: 'AMM_POOL_SOLANA', network: 'solana', side: 'BUY',
    assetIn: quoteAsset, assetOut: tokenAsset, maxIn: '100000000', minOut: '1', maxSlippageBps: 100, maxPriceImpactBps: 200,
    maxFeeBase: '10000000', quote: snap, expiresAt: new Date(at.getTime() + H).toISOString(), idempotencyKey: `test-${Math.random()}`,
  });
  await trading.transitionIntent(row.id, 'DRAFTED', 'SIMULATED', { simulation: { simulated: true } });
  await trading.transitionIntent(row.id, 'SIMULATED', 'PAPER_FILLED', {
    executedOn: snap,
    postcondition: { simulated: true, inBase: '100000000', outBase: '49875000', feeBase: '250000', slippageBps: 4, priceImpactBps: 12, impactModel: 'constant product' },
    riskReasons: [],
  });
  await query(`UPDATE trade_intents SET updated_at = $2 WHERE id = $1`, [row.id, at.toISOString()]);
}

const on = PolicyConfig.parse({ ...DEFAULT_POLICY, studio: { ...DEFAULT_POLICY.studio, postLeagueSeason: true } });

/** An entered agent with a connected account, posting switched on unless told otherwise. */
async function entered(optIn = true) {
  await link();
  const f = await createFixture(optIn ? { policy: { studio: on.studio } } : {});
  await agents.updateAgent(f.agentId, { state: 'ACTIVE' });
  const account = await accounts.createAccount({ ownerId: f.ownerId, channel: 'mock', handle: `league-${Math.random().toString(36).slice(2, 8)}` });
  await accounts.updateAccount(account.id, { enabled: true, status: 'CONNECTED' });
  await accounts.linkAgentAccount({ agentId: f.agentId, accountId: account.id });
  const result = await enterLeagueSeason({ agentId: f.agentId, ownerId: f.ownerId, slug: 'week-45', alias: 'Night Owl' }, BASE);
  if (!result.ok) throw new Error(result.why);
  return { ...f, accountId: account.id, entry: result.entry };
}

const at = (hours: number) => new Date(studio.times.startsAt.getTime() + hours * H);
const rowsOf = (agentId: string) => query<{ kind: string; status: string; reason: string; idea_id: string | null; facts: Record<string, unknown> | null }>(
  'SELECT kind, status, reason, idea_id, facts FROM league_season_posts WHERE agent_id = $1 ORDER BY kind', [agentId]);

describe('the season arc is an opt in', () => {
  it('does nothing when the owner has not turned it on: no row, no idea, no question to Studio', async () => {
    const f = await entered(false);
    studio.requests.length = 0;
    expect(await proposeLeagueSeasonPosts(f.agentId, f.accountId, BASE)).toMatchObject({ proposed: null, why: expect.stringMatching(/off/) });
    expect(await rowsOf(f.agentId)).toHaveLength(0);
    expect(await contentRepo.listIdeas(f.agentId)).toHaveLength(0);
    expect(studio.requests).toHaveLength(0);
  });
});

describe('the entry post', () => {
  it('adds one idea that says simulated paper and states no rank, and never a second', async () => {
    const f = await entered();
    expect(await proposeLeagueSeasonPosts(f.agentId, f.accountId, BASE)).toMatchObject({ proposed: 'ENTRY' });
    const ideas = await contentRepo.listIdeas(f.agentId);
    expect(ideas).toHaveLength(1);
    expect(ideas[0]!.source).toBe(LEAGUE_IDEA_SOURCE);
    expect(ideas[0]!.summary).toMatch(/simulated paper/i);
    expect(ideas[0]!.summary).not.toMatch(/rank|%|return/i);
    // The entry post asks Studio for nothing.
    expect(studio.requests.filter((r) => r.path.endsWith('/entry') && r.method === 'GET')).toHaveLength(0);

    for (let i = 0; i < 5; i += 1) await proposeLeagueSeasonPosts(f.agentId, f.accountId, new Date(BASE.getTime() + i * 40 * 60_000));
    expect(await contentRepo.listIdeas(f.agentId)).toHaveLength(1);
    expect((await rowsOf(f.agentId)).filter((r) => r.kind === 'ENTRY')).toHaveLength(1);
  });

  it('records "skipped" with the reason while everything is paused, and posts it once the pause lifts', async () => {
    const f = await entered();
    await setPauseAll({ paused: true, by: f.ownerId });
    const held = await proposeLeagueSeasonPosts(f.agentId, f.accountId, BASE);
    expect(held.proposed).toBeNull();
    expect(held.why).toMatch(/paused/i);
    expect(await rowsOf(f.agentId)).toEqual([expect.objectContaining({ kind: 'ENTRY', status: 'skipped', reason: expect.stringMatching(/paused/i) })]);
    expect(await contentRepo.listIdeas(f.agentId)).toHaveLength(0);

    await setPauseAll({ paused: false, by: null });
    expect(await proposeLeagueSeasonPosts(f.agentId, f.accountId, new Date(BASE.getTime() + H))).toMatchObject({ proposed: 'ENTRY' });
    expect(await rowsOf(f.agentId)).toEqual([expect.objectContaining({ kind: 'ENTRY', status: 'proposed' })]);
  });

  it('records "skipped" for a paused agent and for an agent without an account', async () => {
    const f = await entered();
    await agents.updateAgent(f.agentId, { state: 'PAUSED' });
    expect((await proposeLeagueSeasonPosts(f.agentId, f.accountId, BASE)).why).toMatch(/paused or inactive/);
    expect(await contentRepo.listIdeas(f.agentId)).toHaveLength(0);
    await agents.updateAgent(f.agentId, { state: 'ACTIVE' });
    expect((await proposeLeagueSeasonPosts(f.agentId, null, new Date(BASE.getTime() + H))).why).toMatch(/No account/);
    expect(await contentRepo.listIdeas(f.agentId)).toHaveLength(0);
  });

  it('does not say it after the season is half over', async () => {
    const f = await entered();
    const late = at(60);
    studio.setNow(late);
    await proposeLeagueSeasonPosts(f.agentId, f.accountId, late);
    const rows = await rowsOf(f.agentId);
    expect(rows.find((r) => r.kind === 'ENTRY')).toMatchObject({ status: 'closed' });
  });
});

describe('the standing post', () => {
  it('states the rank and the field Studio gave now, with fills counted, and no return', async () => {
    const f = await entered();
    await proposeLeagueSeasonPosts(f.agentId, f.accountId, BASE);
    await seedFill(f.agentId, f.entry.mandateId!, at(3));
    const mid = at(40);
    studio.setNow(mid);
    await sweepLeagueBridge(mid);

    const out = await proposeLeagueSeasonPosts(f.agentId, f.accountId, mid);
    expect(out).toMatchObject({ proposed: 'STANDING' });
    const idea = (await contentRepo.listIdeas(f.agentId)).find((i) => /rank 3 of 12/.test(i.summary))!;
    expect(idea.summary).toMatch(/Simulated paper league update/);
    expect(idea.summary).toMatch(/1 simulated paper fill counted/);
    expect(idea.summary).not.toMatch(/-?125|bps|%|return|loss|gain/i);
    expect((await rowsOf(f.agentId)).find((r) => r.kind === 'STANDING')).toMatchObject({ status: 'proposed', facts: expect.objectContaining({ rank: 3, field: 12, fillsCounted: 1 }) });
  });

  it('says "unavailable" and states no rank when Studio cannot be reached, then recovers', async () => {
    const f = await entered();
    await proposeLeagueSeasonPosts(f.agentId, f.accountId, BASE);
    await seedFill(f.agentId, f.entry.mandateId!, at(3));
    const mid = at(40);
    studio.setNow(mid);
    await sweepLeagueBridge(mid);
    studio.goDown();
    const down = await proposeLeagueSeasonPosts(f.agentId, f.accountId, mid);
    expect(down.proposed).toBeNull();
    expect(down.why).toMatch(/unavailable/i);
    expect((await rowsOf(f.agentId)).find((r) => r.kind === 'STANDING')).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/unavailable/i) });
    expect((await contentRepo.listIdeas(f.agentId)).filter((i) => /rank/i.test(i.summary))).toHaveLength(0);

    studio.goUp();
    // Not before the retry delay, then yes. The row's clock is the database's, so it is moved to the simulated one.
    await query(`UPDATE league_season_posts SET updated_at = $2 WHERE agent_id = $1 AND kind = 'STANDING'`, [f.agentId, mid.toISOString()]);
    expect((await proposeLeagueSeasonPosts(f.agentId, f.accountId, mid)).proposed).toBeNull();
    const later = new Date(mid.getTime() + H);
    studio.setNow(later);
    expect(await proposeLeagueSeasonPosts(f.agentId, f.accountId, later)).toMatchObject({ proposed: 'STANDING' });
  });

  it('states nothing until Studio has ranked the entry', async () => {
    const f = await entered();
    await proposeLeagueSeasonPosts(f.agentId, f.accountId, BASE);
    const mid = at(40);
    studio.setNow(mid);
    const out = await proposeLeagueSeasonPosts(f.agentId, f.accountId, mid);
    expect(out.proposed).toBeNull();
    expect(out.why).toMatch(/not ranked|not counted/i);
  });
});

describe('the recap', () => {
  it('is built from this agent\'s own fills and published receipts, with what changed since the midway note', async () => {
    const f = await entered();
    await proposeLeagueSeasonPosts(f.agentId, f.accountId, BASE);
    await seedFill(f.agentId, f.entry.mandateId!, at(3));
    const mid = at(40);
    studio.setNow(mid);
    await sweepLeagueBridge(mid);
    await proposeLeagueSeasonPosts(f.agentId, f.accountId, mid);
    // The midway note is posted, then the standing moves.
    await query(`UPDATE league_season_posts SET facts = jsonb_set(facts, '{rank}', '5') WHERE agent_id = $1 AND kind = 'STANDING'`, [f.agentId]);

    const after = new Date(f.entry.endsAt === '' ? Date.now() : Date.parse(f.entry.endsAt) + H);
    studio.setNow(after);
    expect(await proposeLeagueSeasonPosts(f.agentId, f.accountId, after)).toMatchObject({ proposed: 'RECAP' });
    const idea = (await contentRepo.listIdeas(f.agentId)).find((i) => /is over/.test(i.summary))!;
    expect(idea.summary).toMatch(/Final rank for this AI agent: 3 of 12, moved from rank 5 at the midway note/);
    expect(idea.summary).toMatch(/1 simulated paper fill counted/);
    expect(idea.summary).not.toMatch(/%|bps|return|profit|loss/i);
  });

  it('caps the whole season at three posts however often it is asked', async () => {
    const f = await entered();
    await seedFill(f.agentId, f.entry.mandateId!, at(3));
    for (let h = 0; h <= 3 * 24 + 40; h += 2) {
      const t = new Date(BASE.getTime() + h * H);
      studio.setNow(t);
      await sweepLeagueBridge(t);
      await proposeLeagueSeasonPosts(f.agentId, f.accountId, t);
    }
    const ideas = (await contentRepo.listIdeas(f.agentId)).filter((i) => i.source === LEAGUE_IDEA_SOURCE);
    expect(ideas.length).toBeLessThanOrEqual(3);
    const rows = await rowsOf(f.agentId);
    expect(rows.filter((r) => r.status === 'proposed').map((r) => r.kind).sort()).toEqual(['ENTRY', 'RECAP', 'STANDING']);
    await expect(query(`INSERT INTO league_season_posts (entry_id, agent_id, kind, status, reason) VALUES ($1,$2,'ENTRY','skipped','again')`, [f.entry.id, f.agentId])).rejects.toThrow(/duplicate|unique/i);
  });
});

describe('the check at send', () => {
  const good = 'Simulated paper league update: this AI agent is rank 3 of 12, with 1 simulated paper fill counted.';

  async function standingIdea() {
    const f = await entered();
    await proposeLeagueSeasonPosts(f.agentId, f.accountId, BASE);
    await seedFill(f.agentId, f.entry.mandateId!, at(3));
    const mid = at(40);
    studio.setNow(mid);
    await sweepLeagueBridge(mid);
    await proposeLeagueSeasonPosts(f.agentId, f.accountId, mid);
    const row = (await rowsOf(f.agentId)).find((r) => r.kind === 'STANDING')!;
    return { f, mid, raw: { ideaSource: LEAGUE_IDEA_SOURCE, ideaId: row.idea_id } };
  }

  it('sends a post that still says Studio\'s current standing', async () => {
    const { mid, raw } = await standingIdea();
    await expect(checkLeaguePostAtSend({ raw, text: good, policy: on, now: mid })).resolves.toBeUndefined();
  });

  it('refuses the same post once the standing has moved, and releases the kind to be written again', async () => {
    const { f, mid, raw } = await standingIdea();
    studio.standingOverride = () => ({
      body: {
        protocol: 1, simulated: true, source: 'ai17z-studio', generated_at: mid.toISOString(), season_slug: 'week-45',
        entry_id: f.entry.remoteEntryId, season_status: 'RUNNING', entry_status: 'ACTIVE', basis: 'REPORTED_BY_ENTRANT',
        standing: { state: 'RANKED', rank: 2, of: 12, return_bps: 10, max_drawdown_bps: 1, fills_counted: 1, last_mark_at: mid.toISOString(), reason: null },
      },
    });
    await expect(checkLeaguePostAtSend({ raw, text: good, policy: on, now: mid })).rejects.toMatchObject({ reason: 'league_standing_changed' });
    expect((await rowsOf(f.agentId)).find((r) => r.kind === 'STANDING')).toMatchObject({ status: 'skipped' });
  });

  it('waits rather than send a rank when Studio cannot confirm it', async () => {
    const { mid, raw } = await standingIdea();
    studio.goDown();
    await expect(checkLeaguePostAtSend({ raw, text: good, policy: on, now: mid })).rejects.toMatchObject({ reason: 'league_unavailable', errorClass: 'RETRYABLE' });
  });

  it('sends an owner an edited post that drifted into comparing with others', async () => {
    const { mid, raw } = await standingIdea();
    await expect(checkLeaguePostAtSend({ raw, text: `${good} Beating the field.`, policy: on, now: mid })).rejects.toMatchObject({ reason: 'league_post_text' });
    await expect(checkLeaguePostAtSend({ raw, text: 'Up 12% this week, rank 3 of 12, simulated paper.', policy: on, now: mid })).rejects.toMatchObject({ reason: 'league_post_text' });
  });

  it('does not send once the owner has turned it off', async () => {
    const { mid, raw } = await standingIdea();
    await expect(checkLeaguePostAtSend({ raw, text: good, policy: PolicyConfig.parse({}), now: mid })).rejects.toMatchObject({ reason: 'league_posting_off' });
  });

  it('does not send once the entry has ended', async () => {
    const { f, mid, raw } = await standingIdea();
    await leagueBridge.endEntry(f.entry.id, 'ended for the test');
    await expect(checkLeaguePostAtSend({ raw, text: good, policy: on, now: mid })).rejects.toMatchObject({ reason: 'league_entry_ended' });
  });
});
