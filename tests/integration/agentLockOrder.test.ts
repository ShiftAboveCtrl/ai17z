import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accounts, capabilities, ops, playbooks, query, radar, trading, withTransaction } from '@xbam/database';
import * as runtime from '@xbam/runtime';
import { AssetRef, STUDIO_COIN_ALERTS_PATH, type TradeMandate } from '@xbam/shared/contracts';
import { sealSecret } from '@xbam/shared';
import { newInstallationKey } from '../../packages/runtime/src/studioJose';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { riskStudioServer } from '../support/riskStudioServer';

/**
 * A transaction that locks the agent row must not make a foreign-key check on agents.id wait.
 *
 * Every insert of a row that references an agent takes a KEY SHARE lock on it, and FOR UPDATE
 * conflicts with that while FOR NO KEY UPDATE does not. So a transaction that takes the agent row
 * first and another row second deadlocks with any transaction that holds that other row and then
 * records something about the same agent. Each case here pins that exact interleaving, the way
 * the receipt claim's does, instead of hoping two workers line up: the agent-locking call is
 * started while a second transaction holds the row it needs next, and only once Postgres shows
 * the first one waiting does the second go on to insert a row that references the agent.
 */

installHarness();

const mint = 'So11111111111111111111111111111111111111112';
let studio: Awaited<ReturnType<typeof riskStudioServer>> | undefined;
const originalOrigin = process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN;
afterEach(async () => {
  vi.restoreAllMocks();
  await studio?.close();
  studio = undefined;
  if (originalOrigin === undefined) delete process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN;
  else process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN = originalOrigin;
});

const IDEA = "INSERT INTO content_ideas(agent_id,kind,summary,detail,source,score) VALUES($1,'observation','Lock order','detail','market_signal',50)";

type Tx = Parameters<Parameters<typeof withTransaction>[0]>[0];

/**
 * Holds a row until told to go on, then runs `then` in the same transaction. The default records
 * an idea for the agent: a KEY SHARE on agents.id.
 */
function holder(lock: (tx: Tx) => Promise<unknown>, agentId: string, then: (tx: Tx) => Promise<unknown> = tx => tx.query(IDEA, [agentId])) {
  let holding!: () => void;
  let proceed!: () => void;
  const held = new Promise<void>(resolve => { holding = resolve; });
  const queued = new Promise<void>(resolve => { proceed = resolve; });
  const finished = withTransaction(async tx => {
    await lock(tx);
    holding();
    await queued;
    await then(tx);
  });
  return { held, proceed, finished };
}

/** Pooled reads are fine out here: only the transactions above forbid them. */
async function waitUntilLockWaiters(count = 1): Promise<void> {
  for (let tries = 0; tries < 200; tries++) {
    const [waiting] = await query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");
    if ((waiting?.n ?? 0) >= count) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('The agent-locking call never queued behind the held row.');
}
const waitUntilSomeoneWaitsOnALock = () => waitUntilLockWaiters(1);

const outcome = (r: PromiseSettledResult<unknown>) => (r.status === 'rejected' ? String(r.reason) : r.status);

const TOKEN = AssetRef.parse({ kind: 'ONCHAIN', network: 'robinhood', address: '0x00000000000000000000000000000000000000aa', decimals: 18, symbol: 'FIXTURE' });
const mandate = {
  mode: 'PAPER', approval: 'OWNER_APPROVES_EACH', venues: ['PONS_V2_CURVE'], networks: ['robinhood'], allowedAssets: [TOKEN],
  maxPerTrade: '10000000000000000000', maxPerDay: '50000000000000000000', maxOpenExposure: '40000000000000000000', maxOpenPositions: 5,
  maxSlippageBps: 100, maxPriceImpactBps: 200, minLiquidityBase: '1000000000000000000', maxFeeBase: '100000000000000000',
  quoteMaxAgeMs: 30_000, expiresAt: null, paused: false,
} as unknown as Omit<TradeMandate, 'id' | 'agentId'>;

describe('agent row locks leave foreign-key checks alone', () => {
  it('AC1 changing a risk watch binding never deadlocks a poll that is recording a crossing', async () => {
    // The poll holds its radar source row and records an idea and candidate for the agent; the
    // owner's change locks the agent, then the binding, then needs that same source row.
    const f = await createFixture();
    const key = newInstallationKey();
    studio = await riskStudioServer(key);
    process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN = studio.origin;
    await ops.setSetting('studio.installation.key', sealSecret(JSON.stringify(key)));
    await ops.setSetting('studio.link', { installationId: randomUUID(), origin: studio.origin, linkedAt: new Date().toISOString(), revokedAt: null });
    const account = await accounts.createAccount({ ownerId: f.ownerId, channel: 'mock', handle: 'lock-order-owner' });
    await accounts.updateAccount(account.id, { enabled: true, status: 'CONNECTED' });
    await accounts.linkAgentAccount({ agentId: f.agentId, accountId: account.id });
    await capabilities.grant(f.agentId, account.id, 'POST');
    studio.state.watches = [{ id: randomUUID(), mint, kind: 'LIQUIDITY_BELOW', threshold: 100, interval_seconds: 14400 }];
    const input = { agentId: f.agentId, ownerId: f.ownerId, accountId: account.id, enabled: true, mayTrigger: true };
    expect((await runtime.setStudioRiskWatches(input)).ok).toBe(true);
    await runtime.syncStudioRiskWatches();
    const [source] = await radar.listSources(account.id);
    expect(source).toMatchObject({ kind: 'market_signal', enabled: true });

    // recordStudioRiskObservation's own statement: the outbox row's foreign key to the binding is a
    // KEY SHARE on that binding, which the owner's change must not hold against it.
    const [binding] = await query<{ id: string }>('SELECT id FROM studio_risk_bindings WHERE agent_id=$1', [f.agentId]);
    const crossing = (tx: Tx) => tx.query(
      'INSERT INTO studio_risk_outbox(binding_id,source_id,observation_key,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [binding!.id, source!.id, `lock-order-${randomUUID()}`, { fixture: true }],
    );
    const polling = holder(tx => tx.one('SELECT id FROM radar_sources WHERE id=$1 FOR UPDATE', [source!.id]), f.agentId, crossing);
    await polling.held;
    const changing = runtime.setStudioRiskWatches(input);
    await waitUntilSomeoneWaitsOnALock();
    polling.proceed();
    const [a, b] = await Promise.allSettled([polling.finished, changing]);
    expect([a, b].map(outcome)).toEqual(['fulfilled', 'fulfilled']);
    expect(await query('SELECT id FROM studio_risk_outbox WHERE binding_id=$1', [binding!.id])).toHaveLength(1);
  });

  it('AC1 changing a risk watch binding never deadlocks a poll that records an idea for the agent', async () => {
    const f = await createFixture();
    const key = newInstallationKey();
    studio = await riskStudioServer(key);
    process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN = studio.origin;
    await ops.setSetting('studio.installation.key', sealSecret(JSON.stringify(key)));
    await ops.setSetting('studio.link', { installationId: randomUUID(), origin: studio.origin, linkedAt: new Date().toISOString(), revokedAt: null });
    const account = await accounts.createAccount({ ownerId: f.ownerId, channel: 'mock', handle: 'lock-order-idea' });
    await accounts.updateAccount(account.id, { enabled: true, status: 'CONNECTED' });
    await accounts.linkAgentAccount({ agentId: f.agentId, accountId: account.id });
    await capabilities.grant(f.agentId, account.id, 'POST');
    studio.state.watches = [{ id: randomUUID(), mint, kind: 'LIQUIDITY_BELOW', threshold: 100, interval_seconds: 14400 }];
    const input = { agentId: f.agentId, ownerId: f.ownerId, accountId: account.id, enabled: true, mayTrigger: true };
    expect((await runtime.setStudioRiskWatches(input)).ok).toBe(true);
    await runtime.syncStudioRiskWatches();
    const [source] = await radar.listSources(account.id);
    const polling = holder(tx => tx.one('SELECT id FROM radar_sources WHERE id=$1 FOR UPDATE', [source!.id]), f.agentId);
    await polling.held;
    const changing = runtime.setStudioRiskWatches(input);
    await waitUntilSomeoneWaitsOnALock();
    polling.proceed();
    const [a, b] = await Promise.allSettled([polling.finished, changing]);
    expect([a, b].map(outcome)).toEqual(['fulfilled', 'fulfilled']);
    expect(await query('SELECT id FROM content_ideas WHERE agent_id=$1', [f.agentId])).toHaveLength(1);
  });

  it('AC1 changing coin alerts never deadlocks a sync that holds the binding and then needs the source', async () => {
    // The owner's change used to take the agent, then the source, then the binding; a sync took
    // the binding, then the source. Run in that order, each holds what the other wants next.
    const f = await createFixture();
    const key = newInstallationKey();
    studio = await riskStudioServer(key);
    process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN = studio.origin;
    await ops.setSetting('studio.installation.key', sealSecret(JSON.stringify(key)));
    await ops.setSetting('studio.link', { installationId: randomUUID(), origin: studio.origin, linkedAt: new Date().toISOString(), revokedAt: null });
    const account = await accounts.createAccount({ ownerId: f.ownerId, channel: 'x', handle: `lock_order_${randomUUID().slice(0, 8)}` });
    await accounts.updateAccount(account.id, { enabled: true, status: 'CONNECTED' });
    await accounts.linkAgentAccount({ agentId: f.agentId, accountId: account.id });
    studio.state.coinAlerts = { protocol: 1, generated_at: new Date().toISOString(), alerts: [{ mint }] };
    const input = { agentId: f.agentId, ownerId: f.ownerId, accountId: account.id, enabled: true };
    expect((await runtime.setStudioCoinAlerts(input)).ok).toBe(true);
    await runtime.syncStudioCoinAlerts();
    const [source] = await radar.listSources(account.id);
    expect(source).toMatchObject({ kind: 'tracked_keyword', enabled: true });

    // The sync is claimed and then held at Studio's answer, so its transaction opens only after
    // the owner's change is already waiting on the source row.
    let release!: () => void;
    studio.state.coinAlertsGate = new Promise<void>(resolve => { release = resolve; });
    const polling = holder(tx => tx.one('SELECT id FROM radar_sources WHERE id=$1 FOR UPDATE', [source!.id]), f.agentId, async () => undefined);
    await polling.held;
    await query('UPDATE studio_coin_alert_bindings SET next_sync_at=now()');
    const syncing = runtime.syncStudioCoinAlerts();
    for (let tries = 0; tries < 200 && !studio.requests.some(r => r.path === STUDIO_COIN_ALERTS_PATH && r.valid); tries++) await new Promise(resolve => setTimeout(resolve, 25));
    const changing = runtime.setStudioCoinAlerts(input);
    await waitUntilLockWaiters(1);
    release();
    await waitUntilLockWaiters(2);
    polling.proceed();
    const results = await Promise.allSettled([polling.finished, syncing, changing]);
    expect(results.map(outcome)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
  });

  it('AC1 importing a playbook never deadlocks a writer that holds the live mandate and records for the agent', async () => {
    // The import locks the agent, then retires the live mandate; a mandate activation holds that
    // mandate row first and its replacement's insert needs the agent row for the foreign key.
    const f = await createFixture();
    await trading.putMandate({ agentId: f.agentId, ownerId: f.ownerId, mandate });
    const writing = holder(tx => tx.one('SELECT id FROM trade_mandates WHERE agent_id=$1 AND retired_at IS NULL FOR UPDATE', [f.agentId]), f.agentId);
    await writing.held;
    const importing = playbooks.applyPin(f.agentId, f.ownerId, () => ({
      kind: 'APPLY', mandate,
      pin: { playbookId: 'lock-order', version: 1, title: 'Lock order', contentSha256: 'a'.repeat(64), document: {}, effective: {} },
    }), { playbookId: 'lock-order', version: 1 });
    await waitUntilSomeoneWaitsOnALock();
    writing.proceed();
    const [a, b] = await Promise.allSettled([writing.finished, importing]);
    expect([a, b].map(outcome)).toEqual(['fulfilled', 'fulfilled']);
    expect(await query('SELECT id FROM agent_playbooks WHERE agent_id=$1 AND retired_at IS NULL', [f.agentId])).toHaveLength(1);
  });
});
