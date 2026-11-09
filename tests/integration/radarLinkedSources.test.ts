import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { accounts, query, radar, signals } from '@xbam/database';
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
    const studioId = await insertSource(account.id, 'market_signal', `studio-risk:${bindingId}:${watchId}:${'a'.repeat(64)}`, 'Studio risk watch: LIQUIDITY_BELOW', {
      intervalSeconds: 14400, limit: 1, mayTrigger: false, priority: 30, watches: [watch],
      studioRisk: { bindingId, agentId, watchId, watchRevision: 'a'.repeat(64) },
    });
    const pinId = randomUUID();
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
