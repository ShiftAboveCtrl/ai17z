import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { accounts, capabilityPermissions, ops, playbooks, query, radar, trading, xCapacity } from '@xbam/database';
import { getChannelAdapter, mockAdapter } from '@xbam/channels';
import { SocialRadar } from '../../apps/worker/src/radar';
import type { RadarPollResult } from '@xbam/shared/contracts';
import { asMandate, parsePlaybook, playbookStatus, playbookUniverse, type PlaybookPreview, type PlaybookStatus } from '@xbam/runtime';
import { sealSecret } from '@xbam/shared';
import { newInstallationKey } from '../../packages/runtime/src/studioJose';
import { buildServer } from '../../apps/api/src/server';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

/**
 * Running a published playbook on the local agent, against the real database
 * and a Studio that is a local server on loopback. No real host is contacted.
 * What is proved: the import writes a paper, exact-asset
 * mandate and a pin in one transaction; nothing a document says can change
 * that; an owner's ceiling holds; versions are pins; a failed or hostile
 * import leaves the agent exactly as it was.
 */

installHarness();
// Only the channel boundary is replaced. The worker, capacity and database run normally.
vi.mock('@xbam/channels', async (original) => ({
  ...await original<typeof import('@xbam/channels')>(),
  getChannelAdapter: vi.fn(),
}));
let app: FastifyInstance;
let studio: Server;
const served = new Map<string, { status: number; body: unknown }>();
const seen: Array<{ method: string; url: string; authorization?: string; dpop?: string }> = [];

beforeAll(async () => {
  studio = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, dpop: req.headers.dpop as string | undefined });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/api/v1/token') return send(200, { access_token: 'local-test-token', expires_in: 300 });
    const answer = served.get(req.url ?? '');
    if (!answer) return send(404, { error: 'not_found' });
    return send(answer.status, answer.body);
  });
  await new Promise<void>((resolve) => studio.listen(0, '127.0.0.1', resolve));
  process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN = `http://127.0.0.1:${(studio.address() as AddressInfo).port}`;
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  delete process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN;
  await app?.close();
  await new Promise<void>((resolve) => studio.close(() => resolve()));
});
beforeEach(async () => {
  served.clear();
  seen.length = 0;
  // Linked to the local Studio, as an installation is after the owner pairs it.
  const origin = process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN!;
  await ops.setSetting('studio.installation.key', sealSecret(JSON.stringify(newInstallationKey())));
  await ops.setSetting('studio.link', { installationId: '0b7d8f0e-0000-4000-8000-000000000001', origin, linkedAt: new Date().toISOString(), revokedAt: null });
});

const MINT_A = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const MINT_B = 'So11111111111111111111111111111111111111112';
const doc = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  id: 'top-holder-1',
  version: 1,
  title: 'Slow and liquid',
  publisher: 'Example Studio',
  capitalSol: '10',
  universe: { chain: 'solana', assets: [{ mint: MINT_A, decimals: 5 }, { mint: MINT_B, decimals: 9 }] },
  limits: { maxPerTradeSol: '1', maxPerDaySol: '3', maxOpenExposureSol: '5', maxOpenPositions: 4, maxSlippageBps: 300, maxPriceImpactBps: 500, minLiquiditySol: '50', maxFeeSol: '0.01' },
  expiresAt: null,
  ...over,
});

const signIn = async (email: string) => {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password-1234' } });
  return { authorization: `Bearer ${(r.json() as { data: { token: string } }).data.token}` };
};

async function setup() {
  const f = await createFixture();
  const auth = await signIn(f.ownerEmail);
  const url = (tail: string) => `/api/agents/${f.agentId}/playbook${tail}`;
  const preview = (payload: unknown) => app.inject({ method: 'POST', url: url('/preview'), headers: auth, payload: payload as never });
  const confirm = (payload: unknown) => app.inject({ method: 'POST', url: url('/confirm'), headers: auth, payload: payload as never });
  const imported = async (document: unknown, extra: Record<string, unknown> = {}) => {
    const p = await preview({ document, ...extra });
    expect(p.statusCode, p.body).toBe(200);
    const sha256 = (p.json() as { data: { preview: { sha256: string } } }).data.preview.sha256;
    return confirm({ document, sha256, ...extra });
  };
  return { f, auth, url, preview, confirm, imported };
}

const mandateRows = async (agentId: string) => (await query<{ id: string }>(`SELECT id FROM trade_mandates WHERE agent_id = $1`, [agentId])).length;
const body = (r: { json(): unknown }) => (r.json() as { data: { preview: PlaybookPreview; promises: string[]; playbook: PlaybookStatus | null } }).data;

describe('importing a playbook from a file', () => {
  it('previews every limit from the parsed document, writes nothing, then writes a paper mandate and a pin on confirm', async () => {
    const t = await setup();
    const before = await capabilityPermissions.listForAgent(t.f.agentId);
    const p = await t.preview({ document: doc() });
    expect(p.statusCode).toBe(200);
    const preview = body(p).preview;
    expect(preview).toMatchObject({ mode: 'PAPER', approval: 'OWNER_APPROVES_EACH', capitalSol: '10', alreadyRunning: false });
    expect(preview.limits).toHaveLength(8);
    expect(preview.limits.find((l: { key: string }) => l.key === 'maxPerTrade')).toMatchObject({ published: '1 SOL', effective: '1 SOL' });
    expect(preview.universe.map((a: { mint: string }) => a.mint)).toEqual([MINT_A, MINT_B]);
    expect(body(p).promises.join(' ')).toMatch(/Nothing here can make it live/);
    // Previewing changed nothing.
    expect(await trading.liveMandate(t.f.agentId)).toBeNull();
    expect(await playbooks.livePin(t.f.agentId)).toBeNull();

    const c = await t.confirm({ document: doc(), sha256: preview.sha256 });
    expect(c.statusCode, c.body).toBe(200);
    const row = (await trading.liveMandate(t.f.agentId))!;
    expect(row).toMatchObject({ mode: 'PAPER', approval: 'OWNER_APPROVES_EACH', assetScope: 'LISTED', venues: ['AMM_POOL_SOLANA'], networks: ['solana'], maxPerTrade: '1000000000', maxPerDay: '3000000000', maxOpenPositions: 4, ownerId: t.f.ownerId, paused: false });
    expect(row.allowedAssets.map((a) => (a.kind === 'ONCHAIN' ? a.address : ''))).toEqual([MINT_A, MINT_B]);
    expect(row.protectiveExits).toBeNull();
    const pin = (await playbooks.livePin(t.f.agentId))!;
    expect(pin).toMatchObject({ playbookId: 'top-holder-1', version: 1, mandateId: row.id, contentSha256: preview.sha256 });

    // Nothing about what the agent may do changed: no permission row was written.
    expect(await capabilityPermissions.listForAgent(t.f.agentId)).toEqual(before);

    const status = body(await t.preview({ document: doc() })).preview;
    expect(status.alreadyRunning).toBe(true);
    const said = await playbookStatus(t.f.agentId);
    expect(said).toMatchObject({ state: 'RUNNING', playbookId: 'top-holder-1', version: 1 });
    expect(said!.sentence).toContain('version 1');
    expect((await playbookUniverse(t.f.agentId))!.map((a) => (a.kind === 'ONCHAIN' ? a.address : ''))).toEqual([MINT_A, MINT_B]);
    expect(body(await app.inject({ method: 'GET', url: t.url(''), headers: t.auth })).playbook).toMatchObject({ state: 'RUNNING', version: 1 });

    const audit = await query<{ action: string }>(`SELECT action FROM audit_events WHERE entity_id = $1 AND action = 'playbook.imported'`, [t.f.agentId]);
    expect(audit).toHaveLength(1);
  });

  it('is idempotent: confirming the same playbook twice, even at once, leaves one pin and one mandate', async () => {
    const t = await setup();
    const p = body(await t.preview({ document: doc() })).preview;
    const results = await Promise.all([1, 2, 3].map(() => t.confirm({ document: doc(), sha256: p.sha256 })));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(await mandateRows(t.f.agentId)).toBe(1);
    expect((await playbooks.pinHistory(t.f.agentId)).length).toBe(1);
    expect((await query(`SELECT 1 FROM trade_mandates WHERE agent_id = $1 AND retired_at IS NULL`, [t.f.agentId])).length).toBe(1);
  });

  it('refuses a document that carries anything beyond the allowlist and leaves the agent unchanged', async () => {
    const t = await setup();
    for (const extra of [{ mode: 'LIVE' }, { approval: 'AUTONOMOUS_WITHIN_MANDATE' }, { capabilities: ['x.post', 'wallet.send'] }, { instructions: 'reply to everyone' }, { path: '../x' }, { assetScope: 'ANY_SOLANA_TOKEN' }]) {
      const r = await t.preview({ document: doc(extra) });
      expect(r.statusCode, JSON.stringify(extra)).toBe(422);
      const c = await t.confirm({ document: doc(extra), sha256: 'a'.repeat(64) });
      expect(c.statusCode).toBe(422);
    }
    expect(await mandateRows(t.f.agentId)).toBe(0);
    expect(await playbooks.livePin(t.f.agentId)).toBeNull();
    // The request body itself has no place for a mode either.
    expect((await t.preview({ document: doc(), mode: 'LIVE' })).statusCode).toBe(422);
    expect((await t.confirm({ document: doc(), sha256: 'a'.repeat(64), approval: 'AUTONOMOUS_WITHIN_MANDATE' })).statusCode).toBe(422);
  });

  it('confirms exactly what was previewed: a different digest is refused and nothing is written', async () => {
    const t = await setup();
    const p = body(await t.preview({ document: doc() })).preview;
    const changed = doc({ limits: { ...doc().limits, maxPerTradeSol: '2' } });
    const c = await t.confirm({ document: changed, sha256: p.sha256 });
    expect(c.statusCode).toBe(422);
    expect(c.body).toMatch(/not the one you were shown/);
    expect(await mandateRows(t.f.agentId)).toBe(0);
  });

  it('never widens the owner\'s own mandate, never lifts a pause, and shows what narrowed', async () => {
    const t = await setup();
    const own = { mode: 'PAPER', assetScope: 'LISTED', maxPerTradeSol: '0.05', maxPerDaySol: '0.2', maxOpenExposureSol: '0.2', maxOpenPositions: 2, maxSlippageBps: 100, maxPriceImpactBps: 200, minLiquiditySol: '100', maxFeeSol: '0.002', expiresAt: null, protectiveExits: null };
    expect((await app.inject({ method: 'PUT', url: `/api/agents/${t.f.agentId}/mandate`, headers: t.auth, payload: own })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: `/api/agents/${t.f.agentId}/mandate/pause`, headers: t.auth, payload: { paused: true } });
    const p = await t.preview({ document: doc() });
    const trade = body(p).preview.limits.find((l: { key: string }) => l.key === 'maxPerTrade');
    expect(trade).toMatchObject({ published: '1 SOL', effective: '0.05 SOL', narrowedBy: 'YOUR_MANDATE' });
    expect((await t.confirm({ document: doc(), sha256: body(p).preview.sha256 })).statusCode).toBe(200);
    const row = (await trading.liveMandate(t.f.agentId))!;
    expect(row).toMatchObject({ maxPerTrade: '50000000', maxPerDay: '200000000', maxOpenExposure: '200000000', maxOpenPositions: 2, maxSlippageBps: 100, maxPriceImpactBps: 200, minLiquidityBase: '100000000000', maxFeeBase: '2000000', paused: true, mode: 'PAPER' });
    // The owner's earlier mandate is kept on record, retired.
    expect(await mandateRows(t.f.agentId)).toBe(2);
  });

  it('refuses to replace a live mandate and leaves it exactly as it was', async () => {
    const t = await setup();
    await trading.putMandate({
      agentId: t.f.agentId, ownerId: t.f.ownerId,
      mandate: { mode: 'LIVE', approval: 'OWNER_APPROVES_EACH', venues: ['AMM_POOL_SOLANA'], networks: ['solana'], allowedAssets: [], assetScope: 'LISTED', maxPerTrade: '1000', maxPerDay: '2000', maxOpenExposure: '2000', maxOpenPositions: 1, maxSlippageBps: 100, maxPriceImpactBps: 100, minLiquidityBase: '1', maxFeeBase: '1', quoteMaxAgeMs: 60_000, expiresAt: null, paused: false, protectiveExits: null },
    });
    const before = (await trading.liveMandate(t.f.agentId))!;
    const p = await t.preview({ document: doc() });
    expect(p.statusCode).toBe(422);
    expect(p.body).toMatch(/live mandate/);
    expect((await t.confirm({ document: doc(), sha256: 'a'.repeat(64) })).statusCode).toBe(422);
    expect((await trading.liveMandate(t.f.agentId))!.id).toBe(before.id);
    expect(await playbooks.livePin(t.f.agentId)).toBeNull();
  });
});

describe('versions', () => {
  it('re-enables the same pinned source after unlinking and relinking its agent', async () => {
    const t = await setup();
    const account = await accounts.createAccount({ ownerId: t.f.ownerId, channel: 'mock', handle: 'relinked-playbook' });
    await accounts.linkAgentAccount({ agentId: t.f.agentId, accountId: account.id, actionType: 'REPLY' });
    await t.imported(doc());
    await playbooks.syncRadarSources();
    const [source] = await radar.listSources(account.id);
    expect(source).toBeDefined();
    await query(`UPDATE agent_accounts SET enabled = false WHERE agent_id = $1`, [t.f.agentId]);
    await playbooks.syncRadarSources();
    expect(await radar.getSource(source!.id)).toMatchObject({ enabled: false, status: 'DISABLED' });
    await query(`UPDATE agent_accounts SET enabled = true WHERE agent_id = $1`, [t.f.agentId]);
    await playbooks.syncRadarSources();
    expect(await radar.getSource(source!.id)).toMatchObject({ enabled: true, status: 'UNKNOWN', cursor: null, config: source!.config });
    expect(await radar.listSources(account.id)).toHaveLength(1);
  });

  it('defers playbook X reads under account capacity and records allowed reads in the shared budget', async () => {
    const t = await setup();
    const account = await accounts.createAccount({ ownerId: t.f.ownerId, channel: 'x', handle: 'playbook-budget' });
    await accounts.updateAccount(account.id, { enabled: true, status: 'CONNECTED' });
    await accounts.linkAgentAccount({ agentId: t.f.agentId, accountId: account.id, actionType: 'REPLY', triggerEventTypes: ['MENTION'] });
    const reads: string[] = [];
    const budgetAtRead: number[] = [];
    vi.mocked(getChannelAdapter).mockReturnValue({
      ...mockAdapter,
      async pollRadarSource(_ctx, input): Promise<RadarPollResult> {
        reads.push(input.target ?? '');
        budgetAtRead.push((await xCapacity.usage(account.id, new Date(Date.now() - 60_000))).readsByClass.BROAD);
        return { candidates: [], cursor: null, error: null };
      },
    });
    await t.imported(doc());
    const [source] = await radar.listSources(account.id);
    expect(source).toBeDefined();
    // The worker must recreate a missing source on tick, without an import or timer.
    await query(`DELETE FROM radar_sources WHERE id = $1`, [source!.id]);
    await xCapacity.setState({ accountId: account.id, health: 'COOLDOWN', reason: 'fixture pressure', until: new Date(Date.now() + 600_000), strikes: 1 });
    const worker = new SocialRadar();
    await worker.tick();
    expect(reads).toEqual([]);
    const [synced] = await radar.listSources(account.id);
    expect(synced!.idleReason).toMatch(/cool/i);
    await xCapacity.setState({ accountId: account.id, health: 'HEALTHY', reason: null, until: null, strikes: 0 });
    await radar.retryNow(synced!.id);
    await worker.tick();
    expect(reads).toEqual([MINT_A]);
    expect((await xCapacity.usage(account.id, new Date(Date.now() - 60_000))).readsByClass.BROAD).toBe(1);
    await radar.retryNow(synced!.id);
    await worker.tick();
    expect(reads).toEqual([MINT_A, MINT_B]);
    expect(budgetAtRead).toEqual([0, 1]);
    expect((await xCapacity.usage(account.id, new Date(Date.now() - 60_000))).readsByClass.BROAD).toBe(2);
  });

  it('runs the confirmed mint universe through the existing radar and stops reading after an owner edit', async () => {
    const t = await setup();
    const account = await accounts.createAccount({ ownerId: t.f.ownerId, channel: 'mock', handle: 'playbook-radar' });
    await accounts.updateAccount(account.id, { enabled: true, status: 'CONNECTED' });
    await accounts.linkAgentAccount({ agentId: t.f.agentId, accountId: account.id, actionType: 'REPLY', triggerEventTypes: ['MENTION'] });
    const reads: string[] = [];
    vi.mocked(getChannelAdapter).mockReturnValue({
      ...mockAdapter,
      async pollRadarSource(_ctx, input): Promise<RadarPollResult> {
        reads.push(input.target ?? '');
        return { candidates: [], cursor: null, error: null };
      },
    });
    await t.imported(doc());
    const sources = await radar.listSources(account.id);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ kind: 'tracked_keyword', config: { mayTrigger: false } });
    const worker = new SocialRadar();
    await worker.tick();
    await radar.retryNow(sources[0]!.id);
    await worker.tick();
    expect(reads).toEqual([MINT_A, MINT_B]);
    const own = (await trading.liveMandate(t.f.agentId))!;
    await trading.putMandate({ agentId: t.f.agentId, ownerId: t.f.ownerId, mandate: { ...asMandate(own), maxPerTrade: '1' } });
    await radar.retryNow(sources[0]!.id);
    await worker.tick();
    expect(reads).toHaveLength(2);
    expect((await radar.getSource(sources[0]!.id))!.enabled).toBe(false);
    // A confirmed new pin replaces the source's rotation, including a formerly disabled source.
    await t.imported(doc({ version: 2, universe: { chain: 'solana', assets: [{ mint: MINT_B, decimals: 9 }] } }));
    await worker.tick();
    expect(reads).toEqual([MINT_A, MINT_B, MINT_B]);
    expect(await radar.listSources(account.id)).toHaveLength(1);
  });

  it('keeps the original owner ceilings through upgrades and switching playbooks', async () => {
    const t = await setup();
    const own = { mode: 'PAPER', assetScope: 'LISTED', maxPerTradeSol: '0.05', maxPerDaySol: '0.2', maxOpenExposureSol: '0.2', maxOpenPositions: 2, maxSlippageBps: 100, maxPriceImpactBps: 200, minLiquiditySol: '100', maxFeeSol: '0.002', expiresAt: null, protectiveExits: null };
    expect((await app.inject({ method: 'PUT', url: `/api/agents/${t.f.agentId}/mandate`, headers: t.auth, payload: own })).statusCode).toBe(200);
    await t.imported(doc());
    for (const document of [doc({ version: 2 }), doc({ id: 'another-playbook' }), doc({ version: 3, capitalSol: '0.01' })]) {
      const p = body(await t.preview({ document })).preview;
      expect(p.limits.find((l: { key: string }) => l.key === 'maxPerDay')).toMatchObject(document.capitalSol === '0.01'
        ? { effective: '0.01 SOL', narrowedBy: 'PLAYBOOK_CAPITAL' } : { effective: '0.2 SOL', narrowedBy: 'YOUR_MANDATE' });
      expect((await t.confirm({ document, sha256: p.sha256 })).statusCode).toBe(200);
      expect(await trading.liveMandate(t.f.agentId)).toMatchObject({
        maxPerTrade: document.capitalSol === '0.01' ? '10000000' : '50000000', maxPerDay: document.capitalSol === '0.01' ? '10000000' : '200000000',
        maxOpenExposure: document.capitalSol === '0.01' ? '10000000' : '200000000',
        maxOpenPositions: 2, maxSlippageBps: 100, maxPriceImpactBps: 200, minLiquidityBase: '100000000000', maxFeeBase: '2000000',
      });
    }
  });

  it('refuses changed content for a retired version after switching playbooks, including confirm without preview', async () => {
    const t = await setup();
    await t.imported(doc());
    await t.imported(doc({ id: 'another-playbook' }));
    const changed = doc({ title: 'Changed contents' });
    const parsed = parsePlaybook(changed);
    if (!parsed.ok) throw new Error(parsed.why);
    expect((await t.preview({ document: changed })).statusCode).toBe(422);
    const confirm = await t.confirm({ document: changed, sha256: parsed.sha256 });
    expect(confirm.statusCode).toBe(422);
    expect(confirm.body).toMatch(/never changes/);
    expect(await mandateRows(t.f.agentId)).toBe(2);
    expect((await t.imported(doc())).statusCode).toBe(200);
  });

  it('describes automatic paper simulation without promising per-entry approval', async () => {
    const t = await setup();
    const p = body(await t.preview({ document: doc() }));
    expect(p.promises.join(' ')).not.toMatch(/Every entry still waits for you to approve/);
    expect(p.promises.join(' ')).toMatch(/simulated.*without.*approval/i);
  });

  it('a new version is a new mandate and a new pin, the old ones are retired, and the agent says which it runs', async () => {
    const t = await setup();
    await t.imported(doc());
    const first = (await playbooks.livePin(t.f.agentId))!;
    const v2 = doc({ version: 2, limits: { ...doc().limits, maxPerTradeSol: '0.5' } });
    const p = body(await t.preview({ document: v2 })).preview;
    expect(p.replaces).toEqual({ title: 'Slow and liquid', version: 1 });
    expect((await t.confirm({ document: v2, sha256: p.sha256 })).statusCode).toBe(200);
    const live = (await playbooks.livePin(t.f.agentId))!;
    expect(live).toMatchObject({ version: 2 });
    expect(live.id).not.toBe(first.id);
    const history = await playbooks.pinHistory(t.f.agentId);
    expect(history.map((h) => [h.version, h.retiredAt === null])).toEqual([[2, true], [1, false]]);
    expect((await trading.liveMandate(t.f.agentId))!.maxPerTrade).toBe('500000000');
    expect((await playbookStatus(t.f.agentId))!.sentence).toContain('version 2');
    // The earlier mandate is still on record.
    expect(await mandateRows(t.f.agentId)).toBe(2);
  });

  it('refuses a downgrade unless asked, and refuses changed content under the same version', async () => {
    const t = await setup();
    await t.imported(doc({ version: 2 }));
    const older = await t.preview({ document: doc({ version: 1 }) });
    expect(older.statusCode).toBe(422);
    expect(older.body).toMatch(/older version has to be asked for/);
    expect((await t.imported(doc({ version: 1 }), { allowDowngrade: true })).statusCode).toBe(200);
    expect((await playbooks.livePin(t.f.agentId))!.version).toBe(1);

    const sneaky = doc({ version: 1, limits: { ...doc().limits, maxPerTradeSol: '2' } });
    const r = await t.preview({ document: sneaky });
    expect(r.statusCode).toBe(422);
    expect(r.body).toMatch(/never changes/);
  });

  it('an owner editing the mandate afterwards turns the status to edited and stops offering the universe', async () => {
    const t = await setup();
    await t.imported(doc());
    expect(await playbookUniverse(t.f.agentId)).not.toBeNull();
    const own = { mode: 'PAPER', assetScope: 'ANY_SOLANA_TOKEN', maxPerTradeSol: '0.05', maxPerDaySol: '0.2', maxOpenExposureSol: '0.2', maxOpenPositions: 2, maxSlippageBps: 300, maxPriceImpactBps: 500, minLiquiditySol: '25', maxFeeSol: '0.002', expiresAt: null, protectiveExits: null };
    expect((await app.inject({ method: 'PUT', url: `/api/agents/${t.f.agentId}/mandate`, headers: t.auth, payload: own })).statusCode).toBe(200);
    expect(await playbookStatus(t.f.agentId)).toMatchObject({ state: 'EDITED', version: 1 });
    expect((await playbookStatus(t.f.agentId))!.sentence).toMatch(/no longer runs that playbook as published/);
    expect(await playbookUniverse(t.f.agentId)).toBeNull();
    // The playbook's pin was not rewritten by the edit.
    expect((await playbooks.livePin(t.f.agentId))!.version).toBe(1);
  });
});

describe('importing from Studio', () => {
  const path = (id: string) => `/api/v1/installation/playbooks/${id}`;

  it('fetches over the linked installation\'s token and proof, and applies it like a file', async () => {
    const t = await setup();
    served.set(path('top-holder-1'), { status: 200, body: { protocol: 1, playbook: doc() } });
    const p = await t.preview({ studioId: 'top-holder-1' });
    expect(p.statusCode, p.body).toBe(200);
    const get = seen.find((r) => r.url === path('top-holder-1'))!;
    expect(get).toMatchObject({ method: 'GET', authorization: 'DPoP local-test-token' });
    expect(get.dpop).toBeTruthy();
    const c = await t.confirm({ studioId: 'top-holder-1', sha256: body(p).preview.sha256 });
    expect(c.statusCode, c.body).toBe(200);
    expect((await trading.liveMandate(t.f.agentId))).toMatchObject({ mode: 'PAPER', approval: 'OWNER_APPROVES_EACH' });
  });

  it('refuses when Studio changed the playbook between the preview and the click', async () => {
    const t = await setup();
    served.set(path('top-holder-1'), { status: 200, body: { protocol: 1, playbook: doc() } });
    const sha = body(await t.preview({ studioId: 'top-holder-1' })).preview.sha256;
    served.set(path('top-holder-1'), { status: 200, body: { protocol: 1, playbook: doc({ limits: { ...doc().limits, maxPerTradeSol: '9' } }) } });
    const c = await t.confirm({ studioId: 'top-holder-1', sha256: sha });
    expect(c.statusCode).toBe(422);
    expect(c.body).toMatch(/changed since the preview/);
    expect(await mandateRows(t.f.agentId)).toBe(0);
  });

  it('leaves the agent unchanged, with a sentence, when Studio errors, has no such playbook or serves a hostile one', async () => {
    const t = await setup();
    served.set(path('broken'), { status: 500, body: { error_description: 'try later' } });
    const broken = await t.preview({ studioId: 'broken' });
    expect(broken.statusCode).toBe(422);
    expect(broken.body).toMatch(/Studio answered 500.*unchanged/);
    const missing = await t.preview({ studioId: 'nope' });
    expect(missing.body).toMatch(/no playbook with that id/);
    served.set(path('hostile'), { status: 200, body: { protocol: 1, playbook: doc({ mode: 'LIVE', capabilities: ['wallet.send'] }) } });
    const hostile = await t.preview({ studioId: 'hostile' });
    expect(hostile.statusCode).toBe(422);
    expect(hostile.body).toMatch(/does not accept/);
    // An id that is not an id never reaches a path.
    expect((await t.preview({ studioId: '../token' })).statusCode).toBe(422);
    expect(seen.some((r) => r.url.includes('..'))).toBe(false);
    expect(await mandateRows(t.f.agentId)).toBe(0);
  });

  it('says so when this installation is not linked to Studio', async () => {
    const t = await setup();
    await ops.setSetting('studio.link', null);
    const r = await t.preview({ studioId: 'top-holder-1' });
    expect(r.statusCode).toBe(422);
    expect(r.body).toMatch(/not linked to Studio/);
  });
});

describe('who may do it', () => {
  it('is the agent\'s owner only', async () => {
    const t = await setup();
    const stranger = await createFixture();
    const other = await signIn(stranger.ownerEmail);
    const r = await app.inject({ method: 'POST', url: t.url('/preview'), headers: other, payload: { document: doc() } });
    expect(r.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: t.url(''), headers: other })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: t.url('/preview'), payload: { document: doc() } })).statusCode).toBe(401);
  });
});
