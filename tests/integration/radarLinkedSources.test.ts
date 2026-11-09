import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { accounts, query, radar, signals, trading } from '@xbam/database';
import { radarSourceProvenance } from '@xbam/shared/contracts';
import { signalWatchKey } from '@xbam/shared';
import { buildServer } from '../../apps/api/src/server';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

const mint = 'So11111111111111111111111111111111111111112';
const watch = { chain: 'solana', address: mint, predicate: 'liquidity_below' as const, threshold: 100 };

async function insertSource(accountId: string, kind: string, target: string | null, label: string, config: unknown) {
  const rows = await query<{ id: string }>(
    `INSERT INTO radar_sources (account_id, kind, target, label, enabled, config, next_poll_at)
     VALUES ($1,$2,$3,$4,true,$5::jsonb, now()) RETURNING id`,
    [accountId, kind, target, label, JSON.stringify(config)],
  );
  return rows[0]!.id;
}

describe('one rule for what a Studio risk source is', () => {
  it('reads the same provenance in SQL and in TypeScript for every shape the key can take', async () => {
    const f = await createFixture();
    const account = await accounts.createAccount({ ownerId: f.ownerId, channel: 'mock', handle: 'rule-owner' });
    const shapes: Record<string, unknown>[] = [
      {},
      { studioRisk: { bindingId: randomUUID() } },
      { studioRisk: null },
      { studioRisk: [] },
      { studioRisk: 'yes' },
      { studioRisk: true },
      { studioRisk: 0 },
    ];
    const sourceIds: string[] = [];
    for (const [i, shape] of shapes.entries()) {
      const id = await insertSource(account.id, 'market_signal', `shape-${i}`, `shape ${i}`, { watches: [watch], ...shape });
      await query(
        `INSERT INTO signal_baselines (source_id, watch_key, watch, reason) VALUES ($1,$2,$3::jsonb,'waiting')`,
        [id, signalWatchKey(watch), JSON.stringify(watch)],
      );
      sourceIds.push(id);
    }
    const seen = new Map((await signals.forAccount(account.id)).baselines.map((b) => [b.sourceId, b.provenance]));
    expect(seen.size).toBe(shapes.length);
    for (const [i, shape] of shapes.entries()) {
      const expected = radarSourceProvenance(shape);
      expect(seen.get(sourceIds[i]!), `config ${JSON.stringify(shape)}`).toBe(expected);
    }
    // A key holding null, a string or a boolean is not a Studio mark: nothing else ever writes one.
    expect(seen.get(sourceIds[2]!)).toBe('OWNER');
  });
});

describe('the radar API and sources that a sync recreates', () => {
  async function setup() {
    const f = await createFixture();
    // An X account row is only data here: nothing in these routes opens a browser.
    const account = await accounts.createAccount({ ownerId: f.ownerId, channel: 'x', handle: 'linked-owner' });
    const bindingId = randomUUID();
    const watchId = randomUUID();
    const agentId = f.agentId;
    // Both sources are backed by live state, because a delete is refused only while a sync can bring a source back.
    await accounts.linkAgentAccount({ agentId, accountId: account.id, actionType: 'REPLY' });
    await query(
      `INSERT INTO studio_risk_bindings (agent_id, id, owner_id, account_id, enabled, installation_id, origin, linked_at, expires_at)
       VALUES ($1,$2,$3,$4,true,'inst','https://studio.example.invalid','2026-01-01T00:00:00.000Z', now() + interval '10 minutes')`,
      [agentId, bindingId, f.ownerId, account.id],
    );
    const mandate = await trading.putMandate({
      agentId, ownerId: f.ownerId,
      mandate: {
        mode: 'PAPER', approval: 'OWNER_APPROVES_EACH', venues: ['AMM_POOL_SOLANA'], networks: ['solana'], assetScope: 'LISTED',
        allowedAssets: [{ kind: 'ONCHAIN', network: 'solana', address: mint, decimals: 9, symbol: 'SOL' }],
        maxPerTrade: '1000000000', maxPerDay: '3000000000', maxOpenExposure: '5000000000', maxOpenPositions: 4, maxSlippageBps: 300,
        maxPriceImpactBps: 500, minLiquidityBase: '50000000000', maxFeeBase: '10000000', quoteMaxAgeMs: 30_000, expiresAt: null, paused: false,
        protectiveExits: null,
      } as unknown as Parameters<typeof trading.putMandate>[0]['mandate'],
    });
    const pinId = randomUUID();
    await query(
      `INSERT INTO agent_playbooks (id, agent_id, owner_id, playbook_id, version, title, content_sha256, document, effective, mandate_id)
       VALUES ($1,$2,$3,'fixture',1,'Momentum',$4,'{}'::jsonb,'{}'::jsonb,$5)`,
      [pinId, agentId, f.ownerId, 'c'.repeat(64), mandate.id],
    );
    const studioId = await insertSource(account.id, 'market_signal', `studio-risk:${bindingId}:${watchId}:${'a'.repeat(64)}`, 'Studio risk watch: LIQUIDITY_BELOW', {
      intervalSeconds: 14400, limit: 1, mayTrigger: false, priority: 30, watches: [watch],
      studioRisk: { bindingId, agentId, watchId, watchRevision: 'a'.repeat(64) },
    });
    const playbookId = await insertSource(account.id, 'tracked_keyword', `playbook:${agentId}`, 'Playbook: Momentum', {
      playbookAgentId: agentId, playbookPinId: pinId, mayTrigger: false, intervalSeconds: 180,
    });
    const ownerId = await insertSource(account.id, 'tracked_keyword', 'my topic', 'mine', { mayTrigger: true, intervalSeconds: 300 });
    return { ...f, account, bindingId, watchId, pinId, studioId, playbookId, ownerSourceId: ownerId };
  }
  const login = async (app: Awaited<ReturnType<typeof buildServer>>, email: string) => ({
    authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password-1234' } })).json().data.token}`,
  });

  it('GET never returns the binding id, the watch id, the pin or the agent id of a linked source', async () => {
    const f = await setup();
    const app = await buildServer();
    try {
      const response = await app.inject({ method: 'GET', url: `/api/accounts/${f.account.id}/radar`, headers: await login(app, f.ownerEmail) });
      expect(response.statusCode, response.body).toBe(200);
      for (const secret of [f.bindingId, f.watchId, f.pinId, 'studio-risk:', 'studioRisk', 'playbookAgentId', 'playbookPinId', 'playbook:']) {
        expect(response.body, secret).not.toContain(secret);
      }
      const sources = response.json().data.sources as { id: string; provenance: string; target: string | null; label: string; config: Record<string, unknown> }[];
      const byId = new Map(sources.map((s) => [s.id, s]));
      expect(byId.get(f.studioId)).toMatchObject({ provenance: 'STUDIO_RISK_WATCH', target: null, label: 'Studio risk watch: LIQUIDITY_BELOW' });
      expect(byId.get(f.playbookId)).toMatchObject({ provenance: 'PLAYBOOK', target: null, label: 'Playbook: Momentum' });
      expect(byId.get(f.ownerSourceId)).toMatchObject({ provenance: 'OWNER', target: 'my topic' });
      // What the screen reads from config survives; nothing else is added.
      expect(byId.get(f.studioId)!.config).toEqual({ intervalSeconds: 14400, mayTrigger: false, watches: [watch] });
      expect(byId.get(f.playbookId)!.config).toEqual({ intervalSeconds: 180, mayTrigger: false });
    } finally { await app.close(); }
  });

  it('refuses to remove a playbook source the way it refuses a Studio one, and leaves it in place', async () => {
    const f = await setup();
    const app = await buildServer();
    try {
      const headers = await login(app, f.ownerEmail);
      const playbook = await app.inject({ method: 'DELETE', url: `/api/accounts/${f.account.id}/radar/${f.playbookId}`, headers });
      expect(playbook.statusCode, playbook.body).toBe(400);
      expect(playbook.body).toContain('playbook');
      const studio = await app.inject({ method: 'DELETE', url: `/api/accounts/${f.account.id}/radar/${f.studioId}`, headers });
      expect(studio.statusCode).toBe(400);
      expect(await radar.getSource(f.playbookId)).not.toBeNull();
      expect(await radar.getSource(f.studioId)).not.toBeNull();
      const mine = await app.inject({ method: 'DELETE', url: `/api/accounts/${f.account.id}/radar/${f.ownerSourceId}`, headers });
      expect(mine.statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it('refuses to switch a playbook source off by saving over it, and to forge a link marker', async () => {
    const f = await setup();
    const app = await buildServer();
    try {
      const headers = await login(app, f.ownerEmail);
      const url = `/api/accounts/${f.account.id}/radar`;
      const off = await app.inject({ method: 'POST', url, headers, payload: { kind: 'tracked_keyword', target: `playbook:${f.agentId}`, enabled: false } });
      expect(off.statusCode, off.body).toBe(400);
      expect((await radar.getSource(f.playbookId))?.enabled).toBe(true);
      const forged = await app.inject({ method: 'POST', url, headers, payload: { kind: 'tracked_keyword', target: 'x', config: { playbookAgentId: f.agentId } } });
      expect(forged.statusCode).toBeGreaterThanOrEqual(400);
      expect((await radar.listSources(f.account.id)).filter((s) => s.target === 'x')).toHaveLength(0);
      // An ordinary source is still saved over.
      const ok = await app.inject({ method: 'POST', url, headers, payload: { kind: 'tracked_keyword', target: 'my topic', enabled: false } });
      expect(ok.statusCode, ok.body).toBe(200);
    } finally { await app.close(); }
  });
});

describe('removing a linked source that nothing can recreate any more', () => {
  async function bound(over: { enabled?: boolean; lastError?: string | null; expiresInMs?: number | null; linked?: boolean } = {}) {
    const f = await createFixture();
    const account = await accounts.createAccount({ ownerId: f.ownerId, channel: 'x', handle: 'orphan-owner' });
    if (over.linked !== false) await accounts.linkAgentAccount({ agentId: f.agentId, accountId: account.id, actionType: 'REPLY' });
    const bindingId = randomUUID();
    await query(
      `INSERT INTO studio_risk_bindings (agent_id, id, owner_id, account_id, enabled, installation_id, origin, linked_at, last_error, expires_at)
       VALUES ($1,$2,$3,$4,true,'inst','https://studio.example.invalid','2026-01-01T00:00:00.000Z',$5,
               CASE WHEN $6::bigint IS NULL THEN NULL ELSE now() + ($6::bigint * interval '1 millisecond') END)`,
      [f.agentId, bindingId, f.ownerId, account.id, over.lastError ?? null, over.expiresInMs === undefined ? 600_000 : over.expiresInMs],
    );
    const watchId = randomUUID();
    const sourceId = await insertSource(account.id, 'market_signal', `studio-risk:${bindingId}:${watchId}:${'b'.repeat(64)}`, 'Studio risk watch: LIQUIDITY_BELOW', {
      intervalSeconds: 14400, watches: [watch], studioRisk: { bindingId, agentId: f.agentId, watchId, watchRevision: 'b'.repeat(64) },
    });
    await query('UPDATE radar_sources SET enabled = $2 WHERE id = $1', [sourceId, over.enabled ?? true]);
    return { ...f, account, sourceId };
  }
  const del = async (f: { account: { id: string }; ownerEmail: string }, sourceId: string) => {
    const app = await buildServer();
    try {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: f.ownerEmail, password: 'test-password-1234' } });
      const headers = { authorization: `Bearer ${login.json().data.token}` };
      return await app.inject({ method: 'DELETE', url: `/api/accounts/${f.account.id}/radar/${sourceId}`, headers });
    } finally { await app.close(); }
  };

  it('deletes a disabled Studio source once the settled binding no longer lists the watch', async () => {
    const f = await bound({ enabled: false });
    const response = await del(f, f.sourceId);
    expect(response.statusCode, response.body).toBe(200);
    expect(await radar.getSource(f.sourceId)).toBeNull();
  });

  it('deletes a Studio source whose binding has been switched off or whose account link is gone', async () => {
    const off = await bound({ enabled: true });
    await query('UPDATE studio_risk_bindings SET enabled = false WHERE agent_id = $1', [off.agentId]);
    expect((await del(off, off.sourceId)).statusCode).toBe(200);
    const unlinked = await bound({ enabled: false, lastError: 'The local account link was removed.', linked: false });
    expect((await del(unlinked, unlinked.sourceId)).statusCode).toBe(200);
  });

  it('still refuses while the sync can switch it on, with the sentence that says so', async () => {
    const live = await bound({ enabled: true });
    const refused = await del(live, live.sourceId);
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain('Studio risk watch link');
    expect(await radar.getSource(live.sourceId)).not.toBeNull();
    // A suspension may be lifted by the next sync, and a fresh enable has not been settled yet.
    const suspended = await bound({ enabled: false, lastError: 'Studio risk watches are unavailable.' });
    expect((await del(suspended, suspended.sourceId)).statusCode).toBe(400);
    const fresh = await bound({ enabled: false, expiresInMs: null });
    expect((await del(fresh, fresh.sourceId)).statusCode).toBe(400);
  });

  it('deletes a disabled playbook source nothing pins any more', async () => {
    const f = await createFixture();
    const account = await accounts.createAccount({ ownerId: f.ownerId, channel: 'x', handle: 'orphan-playbook' });
    const id = await insertSource(account.id, 'tracked_keyword', `playbook:${f.agentId}`, 'Playbook: Gone', {
      playbookAgentId: f.agentId, playbookPinId: randomUUID(), mayTrigger: false,
    });
    await query(`UPDATE radar_sources SET enabled = false, status = 'DISABLED' WHERE id = $1`, [id]);
    const response = await del({ account, ownerEmail: f.ownerEmail }, id);
    expect(response.statusCode, response.body).toBe(200);
    expect(await radar.getSource(id)).toBeNull();
  });
});

describe('the other radar writes return the same view as the list', () => {
  it('POST /radar and POST /radar/defaults return no raw row', async () => {
    const f = await createFixture();
    const account = await accounts.createAccount({ ownerId: f.ownerId, channel: 'x', handle: 'view-owner' });
    const app = await buildServer();
    try {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: f.ownerEmail, password: 'test-password-1234' } });
      const headers = { authorization: `Bearer ${login.json().data.token}` };
      const saved = await app.inject({ method: 'POST', url: `/api/accounts/${account.id}/radar`, headers, payload: { kind: 'tracked_keyword', target: 'my topic', config: { mayTrigger: true, intervalSeconds: 300 } } });
      expect(saved.statusCode, saved.body).toBe(200);
      const one = saved.json().data as Record<string, unknown>;
      expect(one).toMatchObject({ provenance: 'OWNER', target: 'my topic' });
      for (const raw of ['accountId', 'cursor', 'createdAt', 'updatedAt', 'lastSideWorkAt']) expect(one, raw).not.toHaveProperty(raw);
      const defaults = await app.inject({ method: 'POST', url: `/api/accounts/${account.id}/radar/defaults`, headers });
      expect(defaults.statusCode, defaults.body).toBe(200);
      const many = defaults.json().data.sources as Record<string, unknown>[];
      expect(many.length).toBeGreaterThan(0);
      for (const source of many) {
        expect(source).toHaveProperty('provenance', 'OWNER');
        for (const raw of ['accountId', 'cursor', 'createdAt', 'updatedAt', 'lastSideWorkAt']) expect(source, raw).not.toHaveProperty(raw);
      }
    } finally { await app.close(); }
  });
});
