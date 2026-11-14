import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ops, query, trading } from '@xbam/database';
import { TradeMandate } from '@xbam/shared/contracts';
import { sealSecret } from '@xbam/shared';
import { newInstallationKey } from '../../packages/runtime/src/studioJose';
import { buildServer } from '../../apps/api/src/server';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

/**
 * Publishing this agent's own setup as a Studio playbook, against the real
 * database and a Studio that is a local server on loopback. No real host is
 * contacted. What is proved: the document is built from the paper mandate and
 * parsed through the strict schema; preview and publish are bound by a digest;
 * a published version is a pin and editing publishes the next version; a Studio
 * that cannot be reached is "unavailable", never a half-published listing.
 */

installHarness();
vi.mock('@xbam/channels', async (original) => ({
  ...await original<typeof import('@xbam/channels')>(),
  getChannelAdapter: vi.fn(),
}));

let app: FastifyInstance;
let studio: Server;
let publishHandler: (json: Record<string, unknown>) => { status: number; body: unknown };
const publishRequests: Array<Record<string, unknown>> = [];

const MINT_A = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

const paper = TradeMandate.omit({ id: true, agentId: true }).parse({
  mode: 'PAPER', approval: 'OWNER_APPROVES_EACH', venues: ['AMM_POOL_SOLANA'], networks: ['solana'],
  allowedAssets: [{ kind: 'ONCHAIN', network: 'solana', address: MINT_A, decimals: 5 }], assetScope: 'LISTED',
  maxPerTrade: '2000000000', maxPerDay: '6000000000', maxOpenExposure: '8000000000', maxOpenPositions: 6,
  maxSlippageBps: 500, maxPriceImpactBps: 800, minLiquidityBase: '20000000000', maxFeeBase: '20000000',
  quoteMaxAgeMs: 60_000, expiresAt: null,
});

const echoPublish = (json: Record<string, unknown>): { status: number; body: unknown } => {
  const playbook = json.playbook as Record<string, unknown>;
  return { status: 200, body: { protocol: 1, published: true, playbook_id: playbook.id, version: playbook.version, playbook_sha256: json.playbook_sha256 } };
};
const echoUnpublish = (json: Record<string, unknown>): { status: number; body: unknown } => ({
  status: 200, body: { protocol: 1, published: false, playbook_id: json.publication_key, version: 1, playbook_sha256: json.playbook_sha256 },
});
const echoReply = (json: Record<string, unknown>): { status: number; body: unknown } =>
  json.operation === 'UNPUBLISH' ? echoUnpublish(json) : echoPublish(json);

beforeAll(async () => {
  studio = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/api/v1/token') return send(200, { access_token: 'local-test-token', expires_in: 300 });
    if (req.method === 'POST' && req.url === '/api/v1/installation/playbooks') {
      let data = '';
      req.on('data', (chunk) => { data += chunk; });
      req.on('end', () => {
        let json: Record<string, unknown> = {};
        try { json = JSON.parse(data) as Record<string, unknown>; } catch { /* not json */ }
        publishRequests.push(json);
        const answer = publishHandler(json);
        return send(answer.status, answer.body);
      });
      return;
    }
    return send(404, { error: 'not_found' });
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
  publishRequests.length = 0;
  publishHandler = echoReply;
  const origin = process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN!;
  await ops.setSetting('studio.installation.key', sealSecret(JSON.stringify(newInstallationKey())));
  await ops.setSetting('studio.link', { installationId: '0b7d8f0e-0000-4000-8000-000000000001', origin, linkedAt: new Date().toISOString(), revokedAt: null });
});

const signIn = async (email: string) => {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password-1234' } });
  return { authorization: `Bearer ${(r.json() as { data: { token: string } }).data.token}` };
};

async function setup() {
  const f = await createFixture();
  const auth = await signIn(f.ownerEmail);
  await ops.setSetting('studio.control', { enabled: true, changedAt: new Date().toISOString(), announced: true });
  const base = `/api/agents/${f.agentId}/playbook-publish`;
  const state = () => app.inject({ method: 'GET', url: base, headers: auth });
  const preview = (title: string) => app.inject({ method: 'POST', url: `${base}/preview`, headers: auth, payload: { title } as never });
  const publish = (digest: string) => app.inject({ method: 'POST', url: `${base}/publish`, headers: auth, payload: { digest } as never });
  const unpublish = () => app.inject({ method: 'POST', url: `${base}/unpublish`, headers: auth, payload: {} as never });
  return { f, auth, state, preview, publish, unpublish };
}

const data = <T>(r: { json(): unknown }) => (r.json() as { data: T }).data;

describe('publishing an agent setup as a playbook', () => {
  it('previews the exact document from the paper mandate, then publishes it and stores the confirmed version', async () => {
    const t = await setup();
    await trading.putMandate({ agentId: t.f.agentId, ownerId: t.f.ownerId, mandate: paper });

    const before = data<{ published: boolean }>(await t.state());
    expect(before.published).toBe(false);

    const preview = data<{ document: { id: string; version: number; capitalSol: string; universe: { assets: Array<{ mint: string }> }; limits: Record<string, unknown> }; digest: string; playbookId: string; version: number }>(await t.preview('Slow and liquid'));
    expect(preview.version).toBe(1);
    expect(preview.playbookId).toMatch(/^[0-9a-f-]{36}$/);
    expect(preview.document).toMatchObject({ schema: 1, title: 'Slow and liquid', capitalSol: '8', publisher: null });
    expect(preview.document.universe.assets.map((a) => a.mint)).toEqual([MINT_A]);
    expect(preview.document.limits).toMatchObject({ maxPerTradeSol: '2', maxPerDaySol: '6', maxOpenExposureSol: '8', maxOpenPositions: 6 });

    const published = data<{ ok: boolean; playbookId: string; version: number }>(await t.publish(preview.digest));
    expect(published).toMatchObject({ ok: true, playbookId: preview.playbookId, version: 1 });

    const after = data<{ published: boolean; playbookId: string; version: number; title: string; problem: string | null }>(await t.state());
    expect(after).toMatchObject({ published: true, playbookId: preview.playbookId, version: 1, title: 'Slow and liquid', problem: null });

    expect(publishRequests).toHaveLength(1);
    expect(publishRequests[0]).toMatchObject({ protocol: 1, operation: 'PUBLISH', playbook_sha256: preview.digest });
  });

  it('editing the setup publishes a new version of the same playbook, and unpublish removes the listing', async () => {
    const t = await setup();
    await trading.putMandate({ agentId: t.f.agentId, ownerId: t.f.ownerId, mandate: paper });

    const first = data<{ digest: string; playbookId: string; version: number }>(await t.preview('Setup'));
    await t.publish(first.digest);

    await trading.putMandate({ agentId: t.f.agentId, ownerId: t.f.ownerId, mandate: { ...paper, maxPerTrade: '3000000000' } });
    const second = data<{ digest: string; playbookId: string; version: number; document: { limits: { maxPerTradeSol: string } } }>(await t.preview('Setup v2'));
    expect(second.playbookId).toBe(first.playbookId);
    expect(second.version).toBe(2);
    expect(second.document.limits.maxPerTradeSol).toBe('3');
    await t.publish(second.digest);

    const state = data<{ published: boolean; playbookId: string; version: number }>(await t.state());
    expect(state).toMatchObject({ published: true, playbookId: first.playbookId, version: 2 });

    const removed = data<{ ok: boolean }>(await t.unpublish());
    expect(removed.ok).toBe(true);
    expect(publishRequests.at(-1)).toMatchObject({ operation: 'UNPUBLISH', publication_key: first.playbookId });

    const after = data<{ published: boolean; playbookId: string | null; version: number | null }>(await t.state());
    expect(after).toMatchObject({ published: false, playbookId: null, version: null });
  });

  it('refuses a live mandate, an any-token scope, and no mandate, before Studio hears anything', async () => {
    const t = await setup();
    await trading.putMandate({ agentId: t.f.agentId, ownerId: t.f.ownerId, mandate: { ...paper, mode: 'LIVE' } });
    const live = await t.preview('x');
    expect(live.statusCode).toBe(409);
    expect(live.body).toMatch(/live mandate/);

    await trading.putMandate({ agentId: t.f.agentId, ownerId: t.f.ownerId, mandate: { ...paper, assetScope: 'ANY_SOLANA_TOKEN', allowedAssets: [] } });
    const any = await t.preview('x');
    expect(any.statusCode).toBe(409);
    expect(any.body).toMatch(/any Solana token/);

    const other = await createFixture();
    const otherAuth = await signIn(other.ownerEmail);
    await ops.setSetting('studio.control', { enabled: true, changedAt: new Date().toISOString(), announced: true });
    const none = await app.inject({ method: 'POST', url: `/api/agents/${other.agentId}/playbook-publish/preview`, headers: otherAuth, payload: { title: 'x' } as never });
    expect(none.statusCode).toBe(409);
    expect(none.body).toMatch(/no trading mandate/);

    expect(publishRequests).toHaveLength(0);
  });

  it('refuses to publish when the digest was not previewed, and when control is off', async () => {
    const t = await setup();
    await trading.putMandate({ agentId: t.f.agentId, ownerId: t.f.ownerId, mandate: paper });
    const wrong = data<{ ok: boolean; why: string }>(await t.publish('a'.repeat(64)));
    expect(wrong).toMatchObject({ ok: false });
    expect(wrong.why).toMatch(/Preview this exact playbook first/);

    const preview = data<{ digest: string }>(await t.preview('x'));
    await ops.setSetting('studio.control', { enabled: false, changedAt: new Date().toISOString(), announced: true });
    const off = data<{ ok: boolean; why: string }>(await t.publish(preview.digest));
    expect(off.ok).toBe(false);
    expect(off.why).toMatch(/Enable control/);
  });

  it('reports a Studio that cannot confirm as unavailable, never as a half-published listing', async () => {
    const t = await setup();
    await trading.putMandate({ agentId: t.f.agentId, ownerId: t.f.ownerId, mandate: paper });
    const preview = data<{ digest: string }>(await t.preview('x'));

    publishHandler = () => ({ status: 500, body: { error: 'down' } });
    const failed = data<{ ok: boolean; why: string }>(await t.publish(preview.digest));
    expect(failed.ok).toBe(false);
    expect(failed.why).toMatch(/Studio could not confirm/);

    const state = data<{ published: boolean; problem: string | null; canUnpublish: boolean }>(await t.state());
    expect(state.published).toBe(false);
    expect(state.problem).toMatch(/not presented as published/);
  });

  it('audits the publish and unpublish', async () => {
    const t = await setup();
    await trading.putMandate({ agentId: t.f.agentId, ownerId: t.f.ownerId, mandate: paper });
    const preview = data<{ digest: string }>(await t.preview('x'));
    await t.publish(preview.digest);
    await t.unpublish();
    const rows = await query<{ action: string }>(`SELECT action FROM audit_events WHERE entity_id = $1 AND action LIKE 'playbook.%' ORDER BY at`, [t.f.agentId]);
    expect(rows.map((r) => r.action)).toEqual(['playbook.published', 'playbook.unpublished']);
  });
});
