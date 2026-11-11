import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actions as actionsRepo, capabilityPermissions, ops, query } from '@xbam/database';
import { invokeCapability } from '@xbam/tools';
import { createLogger, sealSecret } from '@xbam/shared';
import { ACTIVITY_CAPABILITY, activityTapeProjection, scrubStudioActivity, setStudioActivityText, setStudioActivityTape, studioActivityTextSetting, studioActivityTapeSetting, sweepStudioActivityTape, registerActivityTapeCapability } from '../../packages/runtime/src/studioActivityTape';
import { setStudioTransportForTests } from '../../packages/runtime/src/studioLink';
import { newInstallationKey } from '../../packages/runtime/src/studioJose';
import { installHarness } from '../support/harness';
import { createFixture, type Fixture } from '../support/fixtures';
import { activityStudioServer } from '../support/activityStudioServer';
import { buildServer } from '../../apps/api/src/server';

installHarness();
let studio: Awaited<ReturnType<typeof activityStudioServer>>;
let fixture: Fixture;
beforeEach(async () => {
  fixture = await createFixture();
  registerActivityTapeCapability();
  const key = newInstallationKey();
  studio = await activityStudioServer(key);
  process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN = studio.origin;
  await ops.setSetting('studio.installation.key', sealSecret(JSON.stringify(key)));
  await ops.setSetting('studio.link', { installationId: randomUUID(), origin: studio.origin, linkedAt: new Date().toISOString(), revokedAt: null });
  setStudioTransportForTests(async (url, init) => {
    const response = await fetch(url, init);
    return { status: response.status, text: await response.text() };
  });
});
afterEach(async () => {
  setStudioTransportForTests(null);
  delete process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN;
  await studio.close();
});

async function grant() {
  await capabilityPermissions.set({ agentId: fixture.agentId, capabilityId: ACTIVITY_CAPABILITY, permission: 'ALLOWED' });
}
async function ready() { await grant(); await setStudioActivityTape(true, fixture.ownerId); }
async function due() { await query("DELETE FROM app_settings WHERE key = 'studio.activity_tape.attempt'"); }
interface Published { remoteId?: string | null; url?: string | null; text?: string }
async function action(type = 'REPLY', status = 'EXECUTED', ageMinutes = 0, channel = 'x', rehearsal = false, agentId = fixture.agentId, published: Published = {}) {
  const [event] = await query<{ id: string }>("INSERT INTO events (channel,type,remote_event_id,text,remote_author_handle,payload) VALUES ($1,'MENTION',$2,'PRIVATE','private-person',$3) RETURNING id", [channel, randomUUID(), JSON.stringify({ prompt: 'PRIVATE', rehearsal, ...(rehearsal ? { origin: 'rehearsal' } : {}) })]);
  const [job] = await query<{ id: string }>("INSERT INTO jobs(event_id,agent_id,channel,action_type,idempotency_key,generated_output) VALUES ($1,$2,$3,$4,$5,'PRIVATE') RETURNING id", [event!.id, agentId, channel, type, randomUUID()]);
  const [row] = await query<{ id: string }>(`INSERT INTO actions(job_id,agent_id,channel,type,status,dry_run,payload,target_ref,idempotency_key,executed_at,remote_action_id,remote_action_url)
    VALUES ($1,$2,$8,$3,$4,$5,$9::jsonb,'@private-person',$6,now() - ($7::int * interval '1 minute'),$10,$11) RETURNING id`,
  [job!.id, agentId, type, status, status === 'DRY_RUN', randomUUID(), ageMinutes, channel,
    JSON.stringify({ text: published.text ?? 'PRIVATE', wallet: 'PRIVATE', reasoning: 'PRIVATE', cookies: 'PRIVATE' }), published.remoteId ?? null, published.url ?? null]);
  return `action:${row!.id}`;
}

describe('activity tape against Postgres and a DPoP Studio contract server', () => {
  it('scrubs a receipt through the owner API and cannot resurrect it on replay', async () => {
    await ready();
    const actionId = await action('POST');
    await query(`UPDATE events SET payload = payload || '{"ideaSource":"radar_receipt"}'::jsonb
      WHERE id=(SELECT event_id FROM jobs WHERE id=(SELECT job_id FROM actions WHERE id=$1))`, [actionId.slice(7)]);
    const receiptId = `receipt:${actionId.slice(7)}`;
    expect((await sweepStudioActivityTape()).sent).toBe(1);
    expect([...studio.visible.values()].map(event => event.id)).toEqual([receiptId]);
    const app = await buildServer();
    try {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: fixture.ownerEmail, password: 'test-password-1234' } });
      const response = await app.inject({ method: 'POST', url: '/api/studio/activity-tape/scrub',
        headers: { authorization: `Bearer ${login.json().data.token}` }, payload: { id: receiptId } });
      expect(response.statusCode).toBe(200);
    } finally { await app.close(); }
    studio.setUnavailable(true); await due(); await sweepStudioActivityTape();
    expect(await ops.getSetting('studio.activity_tape.scrubs')).toEqual([receiptId]);
    studio.setUnavailable(false); await due(); await sweepStudioActivityTape();
    expect(studio.visible.size).toBe(0);
    expect(await ops.getSetting('studio.activity_tape.scrubs')).toEqual([]);
    await query("DELETE FROM app_settings WHERE key = 'studio.activity_tape.cursor'");
    await due(); await sweepStudioActivityTape();
    expect(studio.visible.size).toBe(0);
  });
  it('queues receipt removals and delivers them to Studio alongside ordinary events', async () => {
    await ready();
    const receiptId = `receipt:${randomUUID()}`;
    await scrubStudioActivity(receiptId, fixture.ownerId);
    expect(await ops.getSetting('studio.activity_tape.scrubs')).toEqual([receiptId]);
    const id = await action();
    expect((await sweepStudioActivityTape()).sent).toBe(1);
    expect(studio.batches[0]!.events.map(event => event.id)).toEqual([id]);
    expect(studio.batches[0]!.remove).toEqual([receiptId]);
    expect((await ops.getSetting('studio.activity_tape.scrubs')) ?? []).toEqual([]);
  });

  it('keeps scrubs queued and sends nothing while the switch is off', async () => {
    await grant();
    const id = await action();
    await scrubStudioActivity(id, fixture.ownerId);
    expect(await sweepStudioActivityTape()).toEqual({ sent: 0, skipped: 'off' });
    expect(await ops.getSetting('studio.activity_tape.scrubs')).toEqual([id]);
    expect(studio.requests).toBe(0);
  });

  it.each([null, 'DISABLED', 'OWNER_APPROVAL'] as const)('starts a fresh grant from %s after earlier rows without backdating', async (permission) => {
    await setStudioActivityTape(true, fixture.ownerId);
    if (permission) await capabilityPermissions.set({ agentId: fixture.agentId, capabilityId: ACTIVITY_CAPABILITY, permission });
    await action();
    await grant();
    const id = await action();
    expect((await sweepStudioActivityTape()).sent).toBe(1);
    expect(studio.batches[0]!.events.map((event) => event.id)).toEqual([id]);
  });

  it('excludes future-dated rows', async () => {
    await ready();
    await action('POST', 'EXECUTED', -1);
    const id = await action();
    expect((await sweepStudioActivityTape()).sent).toBe(1);
    expect(studio.batches[0]!.events.map((event) => event.id)).toEqual([id]);
  });

  it('excludes an ungranted agent while another agent is granted', async () => {
    await ready();
    const other = await createFixture();
    await action('POST', 'EXECUTED', 0, 'x', false, other.agentId);
    const id = await action();
    expect((await sweepStudioActivityTape()).sent).toBe(1);
    expect(studio.batches[0]!.events.map((event) => event.id)).toEqual([id]);
  });

  it('preserves pending events when an ALLOWED grant config is edited', async () => {
    await ready();
    const id = await action();
    await capabilityPermissions.setConfig({ agentId: fixture.agentId, capabilityId: ACTIVITY_CAPABILITY,
      permission: 'ALLOWED', config: { display: true } });
    expect((await sweepStudioActivityTape()).sent).toBe(1);
    expect(studio.batches[0]!.events.map((event) => event.id)).toEqual([id]);
  });

  it('preserves the grant floor when ALLOWED is recorded again', async () => {
    await ready();
    const id = await action();
    await grant();
    expect((await sweepStudioActivityTape()).sent).toBe(1);
    expect(studio.batches[0]!.events.map((event) => event.id)).toEqual([id]);
  });

  it.each(['ALLOWED', 'OWNER_APPROVAL'] as const)('previews only the requested agent before limiting under %s', async (permission) => {
    await ready();
    for (let i = 0; i < 50; i++) await action();
    const other = await createFixture();
    await capabilityPermissions.set({ agentId: other.agentId, capabilityId: ACTIVITY_CAPABILITY, permission });
    const id = await action('POST', 'EXECUTED', 0, 'x', false, other.agentId);
    const result = await invokeCapability({ call: { id: ACTIVITY_CAPABILITY, input: {} },
      context: { agentId: other.agentId, jobId: null, accountId: null, config: {}, audience: 'OWNER', logger: createLogger('tape-test') },
      permission: { stored: permission, paused: false, approved: true } });
    expect(result.outcome).toBe('SUCCEEDED');
    expect(result.output).toEqual({ events: [expect.objectContaining({ id, agent_id: other.agentId })] });
    expect(studio.requests).toBe(0);
  });

  it('protects owner switch and scrub routes and rejects extra fields', async () => {
    const app = await buildServer();
    try {
      for (const method of ['GET', 'PUT'] as const) {
        expect((await app.inject({ method, url: '/api/studio/activity-tape', ...(method === 'PUT' ? { payload: { enabled: true } } : {}) })).statusCode).toBe(401);
      }
      expect((await app.inject({ method: 'POST', url: '/api/studio/activity-tape/scrub', payload: { id: `action:${randomUUID()}` } })).statusCode).toBe(401);
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: fixture.ownerEmail, password: 'test-password-1234' } });
      const headers = { authorization: `Bearer ${login.json().data.token}` };
      expect((await app.inject({ method: 'PUT', url: '/api/studio/activity-tape', headers, payload: { enabled: true, prompt: 'PRIVATE' } })).statusCode).toBe(422);
      expect((await studioActivityTapeSetting()).enabled).toBe(false);
      expect((await app.inject({ method: 'PUT', url: '/api/studio/activity-tape', headers, payload: { enabled: true } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/api/studio/activity-tape/scrub', headers, payload: { id: `action:${randomUUID()}` } })).json().data).toEqual({ queued: true });
    } finally { await app.close(); }
  });

  it('drops stale rows after an outage and skips paused-period rows on resume', async () => {
    await ready();
    await ops.setSetting('studio.activity_tape', { enabled: true, changedAt: new Date(Date.now() - 3_600_000).toISOString() });
    await query("UPDATE agent_capability_permissions SET permission_changed_at = now() - interval '1 hour' WHERE agent_id = $1", [fixture.agentId]);
    await action('POST', 'EXECUTED', 16); const fresh = await action('POST', 'EXECUTED', 14);
    expect((await sweepStudioActivityTape()).sent).toBe(1);
    expect([...studio.visible.values()][0]!.id).toBe(fresh);
    await setStudioActivityTape(false, fixture.ownerId); await action();
    await setStudioActivityTape(true, fixture.ownerId); await due();
    expect((await sweepStudioActivityTape()).sent).toBe(0);
  });

  it('does not request a token or transmit when the installation is unlinked', async () => {
    await ready(); await action(); await ops.setSetting('studio.link', null);
    expect((await sweepStudioActivityTape()).sent).toBe(0);
    expect(studio.requests).toBe(0);
  });
  it('projects existing paper fills and radar discoveries without source payloads or live trades', async () => {
    await ready();
    const [mandate] = await query<{ id: string }>(`INSERT INTO trade_mandates(agent_id,venues,networks,max_per_trade,max_per_day,max_open_exposure,max_open_positions,max_slippage_bps,max_price_impact_bps,min_liquidity_base,max_fee_base,quote_max_age_ms)
      VALUES ($1,'[]','[]','100','100','100',1,100,100,'0','1',1000) RETURNING id`, [fixture.agentId]);
    for (const mode of ['PAPER', 'LIVE']) {
      await query(`INSERT INTO trade_intents(agent_id,mandate_id,mode,venue,side,asset_in,asset_out,max_in,min_out,max_slippage_bps,max_price_impact_bps,max_fee_base,quote,status,idempotency_key,postcondition,expires_at)
        VALUES ($1,$2,$3,'AMM_POOL_SOLANA','BUY','{"kind":"NATIVE","network":"solana","wallet":"PRIVATE"}','{}','100','1',100,100,'1','{"reasoning":"PRIVATE"}','PAPER_FILLED',$4,'{"simulated":true,"inBase":"42","prompt":"PRIVATE"}',now() + interval '1 hour')`,
      [fixture.agentId, mandate!.id, mode, randomUUID()]);
    }
    const [account] = await query<{ id: string }>("INSERT INTO accounts(owner_id,channel,handle) VALUES ($1,'x','PRIVATE') RETURNING id", [fixture.ownerId]);
    await query('INSERT INTO agent_accounts(agent_id,account_id) VALUES ($1,$2)', [fixture.agentId, account!.id]);
    const [event] = await query<{ id: string }>("INSERT INTO events(channel,account_id,type,remote_event_id,text,payload) VALUES ('x',$1,'KEYWORD_MATCH',$2,'PRIVATE','{\"reasoning\":\"PRIVATE\"}') RETURNING id", [account!.id, randomUUID()]);
    await query("INSERT INTO event_discoveries(event_id,source_kind) VALUES ($1,'tracked_keyword')", [event!.id]);
    expect((await sweepStudioActivityTape()).sent).toBe(2);
    const events = studio.batches[0]!.events;
    expect(events.find((e) => e.kind === 'PAPER_FILL')?.paper).toEqual({ simulated: true, size_base_units: '42', asset: 'SOL', verdict: 'PAPER_FILLED' });
    expect(events.find((e) => e.kind === 'RADAR_HIT')?.dry_run).toBeNull();
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|wallet|prompt|reasoning/);
  });
  it('sends nothing off by default or after pause, even with an allowed capability', async () => {
    await grant(); await action();
    expect(await studioActivityTapeSetting()).toEqual({ enabled: false, changedAt: null });
    expect(await sweepStudioActivityTape()).toEqual({ sent: 0, skipped: 'off' });
    expect(studio.requests).toBe(0);
    await setStudioActivityTape(true, fixture.ownerId); await action();
    expect((await sweepStudioActivityTape()).sent).toBe(1);
    const requests = studio.requests;
    await setStudioActivityTape(false, fixture.ownerId); await due(); await action();
    await sweepStudioActivityTape();
    expect(studio.requests).toBe(requests);
  });

  it('requires an explicit capability grant and refuses OWNER_APPROVAL for background publishing', async () => {
    await setStudioActivityTape(true, fixture.ownerId); await action();
    expect((await sweepStudioActivityTape()).sent).toBe(0);
    await capabilityPermissions.set({ agentId: fixture.agentId, capabilityId: ACTIVITY_CAPABILITY, permission: 'OWNER_APPROVAL' });
    await due(); await action(); await sweepStudioActivityTape();
    expect(studio.requests).toBe(0);
    await grant(); await due(); await action();
    expect((await sweepStudioActivityTape()).sent).toBe(1);
  });

  it('sends a private-field-free projection, excludes drafts, stale actions and direct messages, and deduplicates replays', async () => {
    await ready();
    await action(); await action('POST', 'DRY_RUN');
    await action('DIRECT_MESSAGE'); await action('POST', 'EXECUTING'); await action('POST', 'EXECUTED', 16);
    expect((await sweepStudioActivityTape()).sent).toBe(2);
    expect(studio.visible.size).toBe(2);
    expect(JSON.stringify(studio.batches)).not.toMatch(/PRIVATE|private-person|wallet|cookies|reasoning|prompt|generated_output|payload/);
    expect(Object.keys(studio.batches[0]!.events[0]!).sort()).toEqual(['agent_id','at','dry_run','id','kind','paper','target_handle']);
    const requests = studio.requests;
    expect((await sweepStudioActivityTape()).skipped).toBe('rate');
    expect(studio.requests).toBe(requests);
    await due();
    await query("DELETE FROM app_settings WHERE key = 'studio.activity_tape.cursor'");
    await sweepStudioActivityTape();
    expect(studio.visible.size).toBe(2);
  });

  it('recovers from unreachable Studio, applies scrub tombstones, and does not resurrect them', async () => {
    await ready(); const id = await action();
    studio.setUnavailable(true);
    expect((await sweepStudioActivityTape()).sent).toBe(0);
    expect(studio.visible.size).toBe(0);
    studio.setUnavailable(false); await due();
    expect((await sweepStudioActivityTape()).sent).toBe(1);
    await scrubStudioActivity(id, fixture.ownerId); await due(); await sweepStudioActivityTape();
    expect(studio.visible.size).toBe(0);
    expect(await ops.getSetting('studio.activity_tape.scrubs')).toEqual([]);
    await query("DELETE FROM app_settings WHERE key = 'studio.activity_tape.cursor'");
    await due(); await sweepStudioActivityTape();
    expect(studio.visible.size).toBe(0);
  });

  it('normalizes scrub ids before exclusion and duplicate detection', async () => {
    await ready();
    const id = await action();
    await scrubStudioActivity(id.toUpperCase(), fixture.ownerId);
    await scrubStudioActivity(id, fixture.ownerId);
    expect(await activityTapeProjection(new Date(Date.now() - 900_000))).toEqual([]);
    expect(await ops.getSetting('studio.activity_tape.scrubs')).toEqual([id]);
  });

  it('clears only acknowledged tombstones and preserves scrubs added in flight', async () => {
    await ready();
    const id = await action();
    const later = `action:${randomUUID()}`;
    await scrubStudioActivity(id, fixture.ownerId);
    setStudioTransportForTests(async (url, init) => {
      const response = await fetch(url, init);
      if (url.endsWith('/activity-tape')) await scrubStudioActivity(later, fixture.ownerId);
      return { status: response.status, text: await response.text() };
    });
    await sweepStudioActivityTape();
    expect(await ops.getSetting('studio.activity_tape.scrubs')).toEqual([later]);
    expect(studio.batches[0]!.remove).toEqual([id]);
  });

  it('returns 409 for a full pending queue and frees capacity after acknowledgement', async () => {
    await ready();
    const ids = Array.from({ length: 200 }, () => `action:${randomUUID()}`);
    await ops.setSetting('studio.activity_tape.scrubs', ids);
    const app = await buildServer();
    try {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: fixture.ownerEmail, password: 'test-password-1234' } });
      const headers = { authorization: `Bearer ${login.json().data.token}` };
      const scrub = (id: string) => app.inject({ method: 'POST', url: '/api/studio/activity-tape/scrub', headers, payload: { id } });
      const extra = `action:${randomUUID()}`;
      expect((await scrub(extra)).statusCode).toBe(409);
      expect((await scrub(ids[0]!.toUpperCase())).statusCode).toBe(200);
      await sweepStudioActivityTape();
      expect(studio.batches[0]!.remove).toHaveLength(200);
      expect((await scrub(extra)).statusCode).toBe(200);
      expect(await ops.getSetting('studio.activity_tape.scrubs')).toEqual([extra]);
    } finally { await app.close(); }
  });

  it('replays a committed batch after a lost acknowledgement without duplicates or resurrection', async () => {
    await ready();
    const removed = await action();
    const kept = await action();
    await scrubStudioActivity(removed, fixture.ownerId);
    let loseAcknowledgement = true;
    setStudioTransportForTests(async (url, init) => {
      const response = await fetch(url, init);
      const text = await response.text();
      if (url.endsWith('/activity-tape') && loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error('Acknowledgement lost after commit');
      }
      return { status: response.status, text };
    });
    expect((await sweepStudioActivityTape()).sent).toBe(0);
    expect([...studio.visible.values()].map((event) => event.id)).toEqual([kept]);
    expect(await ops.getSetting('studio.activity_tape.cursor')).toBeNull();
    expect(await ops.getSetting('studio.activity_tape.scrubs')).toEqual([removed]);
    await due();
    expect((await sweepStudioActivityTape()).sent).toBe(1);
    expect(studio.batches[1]).toEqual(studio.batches[0]);
    expect([...studio.visible.values()].map((event) => event.id)).toEqual([kept]);
    expect(await ops.getSetting('studio.activity_tape.scrubs')).toEqual([]);
    await query("DELETE FROM app_settings WHERE key = 'studio.activity_tape.cursor'");
    await due(); await sweepStudioActivityTape();
    expect([...studio.visible.values()].map((event) => event.id)).toEqual([kept]);
  });

  it('refreshes once on 401 and clears tombstones only after the authenticated retry', async () => {
    await ready();
    const id = await action();
    await scrubStudioActivity(id, fixture.ownerId);
    studio.rejectBatches(1);
    await sweepStudioActivityTape();
    expect(studio.tokenRequests).toBe(2);
    expect(studio.batchRequests).toBe(2);
    expect(studio.batches).toHaveLength(1);
    expect(await ops.getSetting('studio.activity_tape.scrubs')).toEqual([]);
    const next = `action:${randomUUID()}`;
    await scrubStudioActivity(next, fixture.ownerId);
    studio.rejectBatches(2);
    await due(); await sweepStudioActivityTape();
    expect(studio.tokenRequests).toBe(3);
    expect(studio.batchRequests).toBe(4);
    expect(await ops.getSetting('studio.activity_tape.scrubs')).toEqual([next]);
  });

  it('excludes mock actions and Response Lab rehearsals but retains real-channel dry runs', async () => {
    await ready();
    await action('POST', 'EXECUTED', 0, 'mock');
    await action('REPLY', 'DRY_RUN', 0, 'x', true);
    const real = await action('POST', 'DRY_RUN');
    expect((await sweepStudioActivityTape()).sent).toBe(1);
    expect(studio.batches[0]!.events).toEqual([expect.objectContaining({ id: real, dry_run: true })]);
  });

  it('keeps the opt-in cutoff and pending activity on an idempotent enabled PUT', async () => {
    await ready();
    const setting = await studioActivityTapeSetting();
    const id = await action();
    const app = await buildServer();
    try {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: fixture.ownerEmail, password: 'test-password-1234' } });
      const response = await app.inject({ method: 'PUT', url: '/api/studio/activity-tape', headers: { authorization: `Bearer ${login.json().data.token}` }, payload: { enabled: true } });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual(setting);
      expect((await sweepStudioActivityTape()).sent).toBe(1);
      expect(studio.batches[0]!.events[0]!.id).toBe(id);
    } finally { await app.close(); }
  });

  it.each([
    { channel: 'mock', payload: {} },
    { channel: 'x', payload: { rehearsal: true } },
    { channel: 'x', payload: { origin: 'rehearsal' } },
  ])('excludes synthetic radar discoveries: $channel $payload', async ({ channel, payload }) => {
    await ready();
    const [account] = await query<{ id: string }>('INSERT INTO accounts(owner_id,channel,handle) VALUES ($1,$2,$3) RETURNING id', [fixture.ownerId, channel, 'PRIVATE']);
    await query('INSERT INTO agent_accounts(agent_id,account_id) VALUES ($1,$2)', [fixture.agentId, account!.id]);
    const [event] = await query<{ id: string }>("INSERT INTO events(channel,account_id,type,remote_event_id,payload) VALUES ($1,$2,'KEYWORD_MATCH',$3,$4) RETURNING id", [channel, account!.id, randomUUID(), JSON.stringify(payload)]);
    await query("INSERT INTO event_discoveries(event_id,source_kind) VALUES ($1,'tracked_keyword')", [event!.id]);
    expect(await activityTapeProjection(new Date(Date.now() - 900_000))).toEqual([]);
    expect((await sweepStudioActivityTape()).sent).toBe(0);
    expect(studio.requests).toBe(0);
  });

  it('bounds each batch and revoking the grant stops the next sweep', async () => {
    await ready();
    for (let i = 0; i < 51; i++) await action();
    expect((await sweepStudioActivityTape()).sent).toBe(50);
    await due();
    expect((await sweepStudioActivityTape()).sent).toBe(1);
    expect(studio.visible.size).toBe(51);
    await capabilityPermissions.clear(fixture.agentId, ACTIVITY_CAPABILITY); await due();
    const requests = studio.requests;
    expect((await sweepStudioActivityTape()).sent).toBe(0);
    expect(studio.requests).toBe(requests);
  });
});

describe('verifiable posts against Postgres and the contract server', () => {
  const link = (id: string) => ({ remoteId: id, url: `https://x.com/agentone/status/${id}` });
  const sent = () => studio.batches.flatMap((b) => b.events);

  it('sends the stored status link of a real published post and reply, and never any words by default', async () => {
    await ready();
    const post = link('1111111111'), reply = link('2222222222');
    const a = await action('POST', 'EXECUTED', 0, 'x', false, fixture.agentId, { ...post, text: 'SECRET WORDS' });
    const b = await action('REPLY', 'EXECUTED', 0, 'x', false, fixture.agentId, { ...reply, text: 'SECRET REPLY' });
    expect((await sweepStudioActivityTape()).sent).toBe(2);
    expect(sent().find((e) => e.id === a)).toMatchObject({ kind: 'POST', dry_run: false, target_handle: null, post_url: post.url });
    expect(sent().find((e) => e.id === b)).toMatchObject({ kind: 'REPLY', dry_run: false, target_handle: null, post_url: reply.url });
    expect(JSON.stringify(studio.batches)).not.toMatch(/SECRET|PRIVATE|private-person|post_text/);
  });

  it('sends no link for a dry run, an unverified post, a mock channel, a receipt, or another service', async () => {
    await ready();
    const dry = await action('POST', 'DRY_RUN', 0, 'x', false, fixture.agentId, link('3333333333'));
    const unverified = await action('POST', 'EXECUTED', 0, 'x', false, fixture.agentId, { remoteId: null, url: 'https://x.com/agentone/status/4444444444' });
    const elsewhere = await action('POST', 'EXECUTED', 0, 'bluesky', false, fixture.agentId, { remoteId: 'abc', url: 'https://bsky.app/profile/a/post/abc' });
    const mismatched = await action('POST', 'EXECUTED', 0, 'x', false, fixture.agentId, { remoteId: '5555555555', url: 'https://x.com/agentone/status/6666666666' });
    const receipt = await action('POST', 'EXECUTED', 0, 'x', false, fixture.agentId, link('7777777777'));
    await query(`UPDATE events SET payload = payload || '{"ideaSource":"radar_receipt"}'::jsonb
      WHERE id=(SELECT event_id FROM jobs WHERE id=(SELECT job_id FROM actions WHERE id=$1))`, [receipt.slice(7)]);
    await action('POST', 'EXECUTED', 0, 'mock', false, fixture.agentId, link('8888888888'));
    expect((await sweepStudioActivityTape()).sent).toBe(5);
    const byId = new Map(sent().map((e) => [e.id, e]));
    for (const id of [dry, unverified, elsewhere, mismatched]) expect(byId.get(id), id).not.toHaveProperty('post_url');
    expect(byId.get(`receipt:${receipt.slice(7)}`)).toMatchObject({ kind: 'RECEIPT' });
    expect(byId.get(`receipt:${receipt.slice(7)}`)).not.toHaveProperty('post_url');
    expect(JSON.stringify(studio.batches)).not.toMatch(/8888888888|bsky\.app|mock:/);
  });

  it('keeps the old event shape for a post with no link', async () => {
    await ready();
    await action('POST');
    await sweepStudioActivityTape();
    expect(Object.keys(sent()[0]!).sort()).toEqual(['agent_id', 'at', 'dry_run', 'id', 'kind', 'paper', 'target_handle']);
  });

  it('sends words only after the owner opts in, only for posts made after that, and stops when they opt out', async () => {
    await ready();
    expect(await studioActivityTextSetting()).toEqual({ enabled: false, changedAt: null });
    const before = await action('POST', 'EXECUTED', 0, 'x', false, fixture.agentId, { ...link('1000000001'), text: 'written before consent' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await setStudioActivityText(true, fixture.ownerId);
    const after = await action('POST', 'EXECUTED', 0, 'x', false, fixture.agentId, { ...link('1000000002'), text: 'Shipped the radar update.' });
    const mention = await action('REPLY', 'EXECUTED', 0, 'x', false, fixture.agentId, { ...link('1000000003'), text: '@private-person thanks for asking' });
    expect((await sweepStudioActivityTape()).sent).toBe(3);
    const byId = new Map(sent().map((e) => [e.id, e]));
    expect(byId.get(before)).not.toHaveProperty('post_text');
    expect(byId.get(after)).toMatchObject({ post_text: 'Shipped the radar update.', post_url: 'https://x.com/agentone/status/1000000002' });
    expect(byId.get(mention)).toMatchObject({ post_url: 'https://x.com/agentone/status/1000000003', target_handle: null });
    expect(byId.get(mention)).not.toHaveProperty('post_text');
    expect(JSON.stringify(studio.batches)).not.toMatch(/private-person|written before consent/);
    await setStudioActivityText(false, fixture.ownerId); await due();
    await action('POST', 'EXECUTED', 0, 'x', false, fixture.agentId, { ...link('1000000004'), text: 'after opting out' });
    await sweepStudioActivityTape();
    expect(JSON.stringify(studio.batches)).not.toContain('after opting out');
  });

  it('never sends text for a dry run even with consent', async () => {
    await ready(); await setStudioActivityText(true, fixture.ownerId);
    await action('POST', 'DRY_RUN', 0, 'x', false, fixture.agentId, { ...link('1000000005'), text: 'never published' });
    await sweepStudioActivityTape();
    expect(JSON.stringify(studio.batches)).not.toContain('never published');
  });

  it('strips words at send time when text consent is withdrawn after projection, and still sends the link', async () => {
    await ready(); await setStudioActivityText(true, fixture.ownerId);
    const id = await action('POST', 'EXECUTED', 0, 'x', false, fixture.agentId, { ...link('1000000010'), text: 'withdrawn words' });
    const real = ops.getSetting;
    let reads = 0;
    // The owner switches sharing off in the gap between the projection reading the setting and the send.
    const spy = vi.spyOn(ops, 'getSetting').mockImplementation(async (key: string) => {
      const value = await real(key);
      if (key === 'studio.activity_tape.text' && ++reads === 1) await setStudioActivityText(false, fixture.ownerId);
      return value;
    });
    try { expect((await sweepStudioActivityTape()).sent).toBe(1); } finally { spy.mockRestore(); }
    expect(reads).toBeGreaterThanOrEqual(1);
    const event = sent().find((e) => e.id === id);
    expect(event).toMatchObject({ post_url: 'https://x.com/agentone/status/1000000010' });
    expect(event).not.toHaveProperty('post_text');
    expect(JSON.stringify(studio.batches)).not.toContain('withdrawn words');
  });

  it('keeps the original publish time when a recovery only confirms an earlier send', async () => {
    await ready();
    const id = await action('POST', 'EXECUTED', 0, 'x', false, fixture.agentId, { text: 'sent before opt in' });
    const actionId = id.slice(7);
    await query(`UPDATE actions SET status = 'EXECUTING', executed_at = NULL, remote_action_id = NULL, remote_action_url = NULL,
      created_at = now() - interval '1 hour' WHERE id = $1`, [actionId]);
    await setStudioActivityText(true, fixture.ownerId);
    const done = await actionsRepo.completeAction(actionId, { status: 'EXECUTED', ...link('1000000011'), confirmsEarlierSend: true });
    const [row] = await query<{ executed_at: Date; created_at: Date }>('SELECT executed_at, created_at FROM actions WHERE id = $1', [actionId]);
    expect(done.status).toBe('EXECUTED');
    expect(row!.executed_at.getTime()).toBe(row!.created_at.getTime());
    expect((await sweepStudioActivityTape()).sent).toBe(0);
    expect(JSON.stringify(studio.batches)).not.toContain('sent before opt in');
    expect(await activityTapeProjection(new Date(Date.now() - 3 * 3_600_000))).toEqual([]);
  });

  it('stamps the time of a send that really happened now, so only a confirmation keeps the earlier time', async () => {
    await ready();
    const id = await action('POST', 'EXECUTED', 0, 'x', false, fixture.agentId, {});
    const actionId = id.slice(7);
    await query(`UPDATE actions SET status = 'EXECUTING', executed_at = NULL, created_at = now() - interval '1 hour' WHERE id = $1`, [actionId]);
    await actionsRepo.completeAction(actionId, { status: 'EXECUTED', ...link('1000000012') });
    const [row] = await query<{ ago: number }>("SELECT extract(epoch FROM now() - executed_at)::float AS ago FROM actions WHERE id = $1", [actionId]);
    expect(row!.ago).toBeLessThan(60);
  });

  it('gives no link or words to an action that is not on an X account, even with an X-shaped link', async () => {
    await ready(); await setStudioActivityText(true, fixture.ownerId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const foreign = await action('POST', 'EXECUTED', 0, 'telegram', false, fixture.agentId, { ...link('1000000013'), text: 'telegram words' });
    const mixed = await action('POST', 'EXECUTED', 0, 'x', false, fixture.agentId, { ...link('1000000014'), text: 'mismatched account words' });
    // An action that says x but is tied to an account on another service.
    const [acct] = await query<{ id: string }>(
      "INSERT INTO accounts (owner_id, channel, handle) VALUES ($1,'telegram','tg') RETURNING id", [fixture.ownerId]);
    await query('UPDATE actions SET account_id = $2 WHERE id = $1', [mixed.slice(7), acct!.id]);
    await sweepStudioActivityTape();
    const byId = new Map(sent().map((e) => [e.id, e]));
    for (const id of [foreign, mixed]) {
      expect(byId.get(id), id).toBeDefined();
      expect(byId.get(id), id).not.toHaveProperty('post_url');
      expect(byId.get(id), id).not.toHaveProperty('post_text');
    }
    expect(JSON.stringify(studio.batches)).not.toMatch(/1000000013|1000000014|telegram words|mismatched account words/);
  });

  it('lets only the signed-in owner change the text switch, with nothing else in the body', async () => {
    const app = await buildServer();
    try {
      expect((await app.inject({ method: 'GET', url: '/api/studio/activity-tape/text' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'PUT', url: '/api/studio/activity-tape/text', payload: { enabled: true } })).statusCode).toBe(401);
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: fixture.ownerEmail, password: 'test-password-1234' } });
      const headers = { authorization: `Bearer ${login.json().data.token}` };
      expect((await app.inject({ method: 'PUT', url: '/api/studio/activity-tape/text', headers, payload: { enabled: true, text: 'x' } })).statusCode).toBe(422);
      expect((await studioActivityTextSetting()).enabled).toBe(false);
      const on = await app.inject({ method: 'PUT', url: '/api/studio/activity-tape/text', headers, payload: { enabled: true } });
      expect(on.statusCode).toBe(200);
      expect(on.json().data).toEqual(await studioActivityTextSetting());
      expect((await app.inject({ method: 'GET', url: '/api/studio/activity-tape/text', headers })).json().data.enabled).toBe(true);
      expect((await studioActivityTapeSetting()).enabled).toBe(false);
    } finally { await app.close(); }
  });
});
