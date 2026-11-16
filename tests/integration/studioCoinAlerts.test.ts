import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accounts, ops, query, radar as radarRepo, type RadarSourceRow } from '@xbam/database';
import * as runtime from '@xbam/runtime';
import { getChannelAdapter } from '@xbam/channels';
import { sealSecret } from '@xbam/shared';
import { effectiveXInterval } from '@xbam/shared/contracts';
import { newInstallationKey } from '../../packages/runtime/src/studioJose';
import { SocialRadar } from '../../apps/worker/src/radar';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { riskStudioServer } from '../support/riskStudioServer';

installHarness();
const A = 'So11111111111111111111111111111111111111112';
const B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
class Radar extends SocialRadar { poll(source: RadarSourceRow) { return this.pollOne(source); } }
let studio: Awaited<ReturnType<typeof riskStudioServer>> | undefined;
const originalOrigin = process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN;
afterEach(async () => {
  vi.restoreAllMocks();
  await studio?.close();
  studio = undefined;
  if (originalOrigin === undefined) delete process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN;
  else process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN = originalOrigin;
});
const doc = (alerts: unknown[], generatedAt = new Date().toISOString()) => ({ protocol: 1, generated_at: generatedAt, alerts });
async function setup() {
  const f = await createFixture();
  const key = newInstallationKey();
  studio = await riskStudioServer(key);
  process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN = studio.origin;
  await ops.setSetting('studio.installation.key', sealSecret(JSON.stringify(key)));
  await ops.setSetting('studio.link', { installationId: randomUUID(), origin: studio.origin, linkedAt: new Date().toISOString(), revokedAt: null });
  const account = await accounts.createAccount({ ownerId: f.ownerId, channel: 'x', handle: `alerts_${randomUUID().slice(0, 8)}` });
  await accounts.updateAccount(account.id, { enabled: true, status: 'CONNECTED' });
  await accounts.linkAgentAccount({ agentId: f.agentId, accountId: account.id });
  return { ...f, accountId: account.id };
}
const resync = async () => { await query('UPDATE studio_coin_alert_bindings SET next_sync_at = now()'); await runtime.syncStudioCoinAlerts(); };
const sources = (accountId: string) => radarRepo.listSources(accountId);

describe('Studio coin alerts as the radar universe', () => {
  it('is off by default: no binding, no source, however long Studio lists', async () => {
    const f = await setup();
    studio!.state.coinAlerts = doc([{ mint: A }]);
    await runtime.syncStudioCoinAlerts();
    expect(await sources(f.accountId)).toHaveLength(0);
    expect(await runtime.coinAlertUniverse(f.agentId)).toBeNull();
  });

  it('imports exact mints only, skips the malformed with a reason, and rotates them through one source', async () => {
    const f = await setup();
    studio!.state.coinAlerts = doc([{ mint: A, wallet: 'W'.repeat(44), size: 9, entry_price: 2 }, { mint: 'bogus' }, { mint: B }]);
    expect((await runtime.setStudioCoinAlerts({ agentId: f.agentId, ownerId: f.ownerId, accountId: f.accountId, enabled: true })).ok).toBe(true);
    await runtime.syncStudioCoinAlerts();
    const [source] = await sources(f.accountId);
    expect(source).toMatchObject({ kind: 'tracked_keyword', enabled: true, config: { coinAlertAgentId: f.agentId, mayTrigger: false } });
    const status = await runtime.studioCoinAlertStatus(f.agentId, f.ownerId);
    expect(status.binding).toMatchObject({ watching: 2, skipped: [{ index: 1, reason: expect.stringContaining('not a valid Solana') }] });
    const [row] = await query('SELECT * FROM studio_coin_alert_bindings');
    expect(JSON.stringify(row)).not.toMatch(/wallet|entry_price|"size"/);

    const asked: (string | null)[] = [];
    vi.spyOn(getChannelAdapter('x'), 'pollRadarSource').mockImplementation(async (_ctx, request) => { asked.push(request.target); return { candidates: [], cursor: null, error: null }; });
    await new Radar().poll(source!);
    const next = (await radarRepo.getSource(source!.id))!;
    // The poll is paced by the X floor for this kind, never faster.
    expect(Date.parse(String(next.nextPollAt)) - Date.now()).toBeGreaterThan((effectiveXInterval('tracked_keyword', 180).seconds - 5) * 1000);
    await new Radar().poll(next);
    expect(asked).toEqual([A, B]);
  });

  it('keeps the last confirmed universe when Studio is unreachable or stale, and says so', async () => {
    const f = await setup();
    studio!.state.coinAlerts = doc([{ mint: A }]);
    await runtime.setStudioCoinAlerts({ agentId: f.agentId, ownerId: f.ownerId, accountId: f.accountId, enabled: true });
    await runtime.syncStudioCoinAlerts();
    studio!.state.status = 503;
    await resync();
    expect(await runtime.coinAlertUniverse(f.agentId)).toEqual([A]);
    expect((await runtime.studioCoinAlertStatus(f.agentId, f.ownerId)).binding?.lastError).toMatch(/last confirmed list \(1 coins/);
    studio!.state.status = 200;
    studio!.state.coinAlerts = doc([{ mint: B }], new Date(Date.now() - 3 * 3_600_000).toISOString());
    await resync();
    expect(await runtime.coinAlertUniverse(f.agentId)).toEqual([A]);
    expect((await sources(f.accountId))[0]!.enabled).toBe(true);
  });

  it('stops reading when the owner switches it off, and a removed list leaves no live source', async () => {
    const f = await setup();
    studio!.state.coinAlerts = doc([{ mint: A }]);
    await runtime.setStudioCoinAlerts({ agentId: f.agentId, ownerId: f.ownerId, accountId: f.accountId, enabled: true });
    await runtime.syncStudioCoinAlerts();
    expect((await sources(f.accountId))[0]!.enabled).toBe(true);
    studio!.state.coinAlerts = doc([]);
    await resync();
    expect((await sources(f.accountId))[0]!.enabled).toBe(false);
    studio!.state.coinAlerts = doc([{ mint: A }]);
    await resync();
    expect((await sources(f.accountId))[0]!.enabled).toBe(true);
    await runtime.setStudioCoinAlerts({ agentId: f.agentId, ownerId: f.ownerId, accountId: f.accountId, enabled: false });
    expect((await sources(f.accountId))[0]!.enabled).toBe(false);
    expect(await runtime.coinAlertUniverse(f.agentId)).toBeNull();
  });
});
