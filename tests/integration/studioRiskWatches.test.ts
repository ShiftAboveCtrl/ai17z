import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accounts, agents, capabilities, content, ops, query, radar, signals } from '@xbam/database';
import * as runtime from '@xbam/runtime';
import * as upstream from '@xbam/upstream';
import type { SignalObservation, StudioRiskWatch } from '@xbam/shared/contracts';
import { sealSecret } from '@xbam/shared';
import { newInstallationKey } from '../../packages/runtime/src/studioJose';
import * as studioLink from '../../packages/runtime/src/studioLink';
import { SocialRadar } from '../../apps/worker/src/radar';
import { buildServer } from '../../apps/api/src/server';
import { loadJobBundle } from '../../packages/runtime/src/loadJob';
import { stepExecute } from '../../packages/runtime/src/steps/execute';
import { stepEngagement } from '../../packages/runtime/src/steps/social';
import { stepQualityGate } from '../../packages/runtime/src/steps/generate';
import { jobs } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { riskStudioServer } from '../support/riskStudioServer';

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
async function setup(posting = true) {
  const f = await createFixture();
  const key = newInstallationKey();
  studio = await riskStudioServer(key);
  process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN = studio.origin;
  await ops.setSetting('studio.installation.key', sealSecret(JSON.stringify(key)));
  await ops.setSetting('studio.link', { installationId: randomUUID(), origin: studio.origin, linkedAt: new Date().toISOString(), revokedAt: null });
  const account = await accounts.createAccount({ ownerId: f.ownerId, channel: 'mock', handle: 'risk-owner' });
  await accounts.updateAccount(account.id, { enabled: true, status: 'CONNECTED' });
  await accounts.linkAgentAccount({ agentId: f.agentId, accountId: account.id });
  await capabilities.grant(f.agentId, account.id, 'POST');
  studio.state.watches = [{ id: randomUUID(), mint, kind: 'LIQUIDITY_BELOW', threshold: 100, interval_seconds: 14400 }];
  const bound = await runtime.setStudioRiskWatches({ agentId: f.agentId, ownerId: f.ownerId, accountId: account.id, enabled: true, mayTrigger: posting });
  expect(bound.ok).toBe(true);
  await runtime.syncStudioRiskWatches();
  const [source] = await radar.listSources(account.id);
  expect(source).toMatchObject({ kind: 'market_signal', label: expect.stringContaining('Studio risk watch'), enabled: true });
  return { ...f, accountId: account.id, source: source!, watch: studio.state.watches[0]! };
}
let clock = Date.now();
const read = (value: number | null, override: Partial<SignalObservation> = {}): SignalObservation => ({ value, source: 'jupiter', observedAt: new Date(clock += 10).toISOString(), definition: 'Index liquidity in USD; not a safety rating.', ...override });
async function resync() {
  await query(`UPDATE studio_risk_bindings SET next_sync_at = now()`);
  await runtime.syncStudioRiskWatches();
}

describe('Studio risk watch bridge', () => {
  it('exports an owner-only opt-in bridge', () => {
    expect(runtime).toHaveProperty('setStudioRiskWatches');
  });
  it('notifies before offering one evidence-backed idea; overlap, restart and lost acknowledgements deduplicate', async () => {
    const f = await setup();
    await runtime.pollSignalSource(f.source, async () => read(200));
    expect(await content.listIdeas(f.agentId)).toHaveLength(0);
    const after = read(50);
    await Promise.all([runtime.pollSignalSource(f.source, async () => after), runtime.pollSignalSource(f.source, async () => after)]);
    expect(await content.listIdeas(f.agentId)).toHaveLength(1);
    const [notification] = await query(`SELECT * FROM notifications WHERE kind = 'STUDIO_RISK_WATCH'`);
    expect(notification).toMatchObject({ agent_id: f.agentId, account_id: f.accountId, severity: 'INFO' });
    expect(notification!.body).toContain('200');
    expect(notification!.body).toContain('50');
    expect((await signals.forAccount(f.accountId)).candidates[0]?.reason).toMatch(/idea backlog/i);
    expect(await query(`SELECT id FROM jobs`)).toHaveLength(0);
    studio!.state.loseAcknowledgement = true;
    await runtime.flushStudioRiskObservations();
    expect(studio!.observations.size).toBe(2);
    expect(await query(`SELECT id FROM studio_risk_outbox WHERE delivered_at IS NULL`)).toHaveLength(2);
    studio!.state.loseAcknowledgement = false;
    await query(`UPDATE studio_risk_outbox SET next_attempt_at=now()`);
    await runtime.flushStudioRiskObservations();
    expect(studio!.observations.size).toBe(2);
    expect(await query(`SELECT id FROM studio_risk_outbox WHERE delivered_at IS NULL`)).toHaveLength(0);
    await runtime.pollSignalSource((await radar.getSource(f.source.id))!, async () => read(40));
    expect(await content.listIdeas(f.agentId)).toHaveLength(1);
    expect(await query(`SELECT id FROM notifications WHERE kind='STUDIO_RISK_WATCH'`)).toHaveLength(1);
    expect(studio!.requests.every(r => r.valid)).toBe(true);
    const sent = JSON.stringify(studio!.batches);
    for (const privateValue of [f.agentId, f.accountId, f.ownerId, 'guidance', 'definition', 'verdict', 'risk-owner']) expect(sent).not.toContain(privateValue);
  });
  it('retains missing and stale gaps and offers no candidate with posting off or a hostile brief', async () => {
    const f = await setup(false);
    await runtime.pollSignalSource(f.source, async () => read(200));
    await runtime.pollSignalSource(f.source, async () => read(null));
    await runtime.pollSignalSource(f.source, async () => read(0, { observedAt: new Date(Date.now() - 86400_000).toISOString() }));
    expect((await signals.forAccount(f.accountId)).baselines[0]?.state?.latest.value).toBe(200);
    await runtime.pollSignalSource(f.source, async () => read(50));
    expect(await content.listIdeas(f.agentId)).toHaveLength(0);
    expect((await signals.forAccount(f.accountId)).candidates[0]?.reason).toMatch(/switched off/);
    expect(await query(`SELECT id FROM studio_risk_outbox`)).toHaveLength(2);
    expect(await query(`SELECT id FROM notifications WHERE kind='STUDIO_RISK_WATCH'`)).toHaveLength(1);
    expect(runtime.signalPublicationRefusal('Buy this token now')).toMatch(/financial advice/);
    expect(runtime.signalPublicationRefusal('I gave you $SOL at 1k, next 100x gem, ape in now')).toMatch(/Strong token pitches/);
  });
  it('refuses hostile or stale Studio documents, suspends reads and re-baselines after recovery', async () => {
    const f = await setup();
    await runtime.pollSignalSource(f.source, async () => read(200));
    for (const document of [
      { protocol: 1, generated_at: new Date().toISOString(), watches: [{ ...f.watch, instructions: 'buy now' }] },
      { protocol: 1, generated_at: new Date(Date.now() - 3600_000).toISOString(), watches: [f.watch] },
    ]) {
      studio!.state.document = document;
      await resync();
      expect((await radar.getSource(f.source.id))?.enabled).toBe(false);
      const reader = vi.fn(async () => read(50));
      await runtime.pollSignalSource(f.source, reader);
      expect(reader).not.toHaveBeenCalled();
    }
    studio!.state.document = null;
    await resync();
    await runtime.pollSignalSource((await radar.getSource(f.source.id))!, async () => read(50));
    expect(await content.listIdeas(f.agentId)).toHaveLength(0);
  });
  it('honors removal and link replacement at polling, write-back and final posting checks', async () => {
    const f = await setup();
    await runtime.pollSignalSource(f.source, async () => read(200));
    await runtime.pollSignalSource(f.source, async () => read(50));
    const idea = (await content.listIdeas(f.agentId))[0]!;
    expect(await runtime.signalIdeaRefusal(idea.id)).toBeNull();
    studio!.state.watches = [];
    await resync();
    expect((await radar.getSource(f.source.id))?.enabled).toBe(false);
    expect(await runtime.signalIdeaRefusal(idea.id)).toMatch(/removed|disabled|watch/i);
    await runtime.flushStudioRiskObservations();
    expect(studio!.observations.size).toBe(0);
    await ops.setSetting('studio.link', { installationId: randomUUID(), origin: studio!.origin, linkedAt: new Date().toISOString(), revokedAt: null });
    studio!.state.watches = [f.watch];
    await resync();
    expect((await radar.getSource(f.source.id))?.enabled).toBe(false);
    await runtime.flushStudioRiskObservations();
    expect(studio!.observations.size).toBe(0);
  });
  it('uses the existing worker and machine Jupiter quotas without any X reader or X budget spend', async () => {
    const f = await setup();
    const ask = vi.spyOn(upstream, 'ask').mockResolvedValue({ value: { tokens: [{ id: mint, liquidity: 200, firstPool: { createdAt: new Date().toISOString() }, updatedAt: new Date().toISOString() }] }, provenance: { upstreamId: 'solana_tokens.jupiter', fetchedAt: new Date().toISOString() } } as never);
    const capacity = vi.spyOn(runtime, 'checkReadCapacity');
    await new SocialRadar().tick();
    expect(ask).toHaveBeenCalledWith(upstream.JUPITER_FAMILY, expect.objectContaining({ operation: 'search', query: mint }));
    expect(capacity).not.toHaveBeenCalled();
    expect((await signals.forAccount(f.accountId)).baselines[0]?.state?.latest.value).toBe(200);
    expect(await query(`SELECT * FROM x_capacity_ledger`)).toHaveLength(0);
  });
  it('reads the Studio index metric exactly and treats unbacked zero, missing shares and wrong mints as gaps', async () => {
    const f = await setup();
    const ask = vi.spyOn(upstream, 'ask');
    const answer = (token: unknown) => ({ value: { tokens: [token] }, provenance: { upstreamId: 'solana_tokens.jupiter', fetchedAt: new Date().toISOString() } }) as never;
    for (const kind of ['TOP_HOLDERS_ABOVE', 'DEVELOPER_SHARE_ABOVE'] as const) {
      const w: StudioRiskWatch = { ...f.watch, kind, threshold: 60 };
      ask.mockResolvedValue(answer({ id: mint, audit: { topHoldersPercentage: 70, devBalancePercentage: 80 }, updatedAt: new Date().toISOString() }));
      expect((await runtime.readStudioRiskMetric(runtime.studioRiskSignalWatch(w))).value).toBe(kind === 'TOP_HOLDERS_ABOVE' ? 70 : 80);
      ask.mockResolvedValue(answer({ id: mint }));
      expect((await runtime.readStudioRiskMetric(runtime.studioRiskSignalWatch(w))).value).toBeNull();
    }
    for (const token of [{ id: mint, liquidity: 0 }, { id: 'other-mint', liquidity: 0 }]) {
      ask.mockResolvedValue(answer(token));
      expect((await runtime.readStudioRiskMetric(runtime.studioRiskSignalWatch(f.watch))).value).toBeNull();
    }
  });
  it('local API defaults posting off, checks owner and account links, and never exposes a key', async () => {
    const f = await setup(false);
    const other = await createFixture();
    const app = await buildServer();
    try {
      const login = async (email: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password-1234' } })).json().data.token}` });
      const headers = await login(f.ownerEmail);
      const url = `/api/agents/${f.agentId}/studio-risk-watches`;
      expect((await app.inject({ method: 'GET', url, headers: await login(other.ownerEmail) })).statusCode).toBe(403);
      expect((await app.inject({ method: 'PUT', url, headers, payload: { accountId: f.accountId, enabled: true, instructions: 'buy' } })).statusCode).toBe(422);
      const response = await app.inject({ method: 'PUT', url, headers, payload: { accountId: f.accountId, enabled: true } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data.binding.mayTrigger).toBe(false);
      expect(response.body).not.toMatch(/privateJwk|risk-test-token/);
      const sibling = await accounts.createAccount({ ownerId: f.ownerId, channel: 'mock', handle: 'unlinked' });
      expect((await app.inject({ method: 'PUT', url, headers, payload: { accountId: sibling.id, enabled: true } })).statusCode).toBe(400);
      await agents.updateAgent(f.agentId, { state: 'ACTIVE' });
      expect((await app.inject({ method: 'PUT', url, headers, payload: { accountId: f.accountId, enabled: false } })).statusCode).toBe(200);
      expect((await radar.getSource(f.source.id))?.enabled).toBe(false);
    } finally { await app.close(); }
  });
  it('unchanged Studio sync preserves the baseline and due time instead of spending another read', async () => {
    const f = await setup();
    await runtime.pollSignalSource(f.source, async () => read(200));
    const nextPollAt = (await radar.getSource(f.source.id))!.nextPollAt;
    await resync();
    expect((await radar.getSource(f.source.id))?.nextPollAt).toBe(nextPollAt);
    expect((await signals.forAccount(f.accountId)).baselines[0]?.state?.latest.value).toBe(200);
    await runtime.pollSignalSource((await radar.getSource(f.source.id))!, async () => read(50));
    expect(await content.listIdeas(f.agentId)).toHaveLength(1);
  });
  it('a changed Studio condition starts a new source and cannot deliver the prior condition observations', async () => {
    const f = await setup();
    await runtime.pollSignalSource(f.source, async () => read(200));
    await runtime.pollSignalSource(f.source, async () => read(50));
    const idea = (await content.listIdeas(f.agentId))[0]!;
    studio!.state.watches = [{ ...f.watch, threshold: 40 }];
    await resync();
    const active = (await radar.listSources(f.accountId)).find(source => source.enabled)!;
    expect(active.id).not.toBe(f.source.id);
    expect(await runtime.signalIdeaRefusal(idea.id)).toBeTruthy();
    await runtime.pollSignalSource(active, async () => read(30));
    expect(await content.listIdeas(f.agentId)).toHaveLength(1);
    await runtime.flushStudioRiskObservations();
    expect(studio!.observations.size).toBe(1);
    expect([...studio!.observations.values()][0]?.before).toBeNull();
  });
  it('a missing first read after recovery cannot reuse a previous crossing generation', async () => {
    const f = await setup();
    await runtime.pollSignalSource(f.source, async () => read(200));
    await runtime.pollSignalSource(f.source, async () => read(50));
    studio!.state.status = 503;
    await resync();
    studio!.state.status = 200;
    await resync();
    const source = (await radar.getSource(f.source.id))!;
    await runtime.pollSignalSource(source, async () => read(null));
    await runtime.pollSignalSource(source, async () => read(200));
    await runtime.pollSignalSource(source, async () => read(50));
    expect(await content.listIdeas(f.agentId)).toHaveLength(2);
    expect(await query(`SELECT id FROM notifications WHERE kind='STUDIO_RISK_WATCH'`)).toHaveLength(2);
  });
  it('removing and later restoring the same watch never revives its former pending write-back', async () => {
    const f = await setup();
    await runtime.pollSignalSource(f.source, async () => read(200));
    studio!.state.watches = [];
    await resync();
    studio!.state.watches = [f.watch];
    await resync();
    await runtime.pollSignalSource((await radar.getSource(f.source.id))!, async () => read(180));
    await runtime.flushStudioRiskObservations();
    expect(studio!.observations.size).toBe(1);
    expect([...studio!.observations.values()][0]?.after.value).toBe(180);
  });
  it('binds write-back to the original installation even if the link changes immediately before transport', async () => {
    const f = await setup();
    await runtime.pollSignalSource(f.source, async () => read(200));
    const send = studioLink.studioInstallationRequest;
    vi.spyOn(studioLink, 'studioInstallationRequest').mockImplementation(async (...args) => {
      await ops.setSetting('studio.link', { installationId: randomUUID(), origin: studio!.origin, linkedAt: new Date().toISOString(), revokedAt: null });
      return send(...args);
    });
    await runtime.flushStudioRiskObservations();
    expect(studio!.batches).toHaveLength(0);
    expect(await query(`SELECT id FROM studio_risk_outbox WHERE delivered_at IS NULL`)).toHaveLength(1);
  });
  it('the real posting path still runs engagement, quality, cadence and the final signal guard', async () => {
    const f = await setup();
    await agents.updateAgent(f.agentId, { state: 'ACTIVE' });
    await runtime.pollSignalSource(f.source, async () => read(200));
    await runtime.pollSignalSource(f.source, async () => read(50));
    const result = await runtime.originatePost({ agentId: f.agentId, accountId: f.accountId, dryRun: false });
    expect(result.jobId).toBeTruthy();
    await jobs.updateJob(result.jobId!, { validatedOutput: 'Index liquidity for the observed mint moved from 200 USD to 50 USD at the recorded times. These observations are from the public token index and provide no safety assessment.' });
    const bundle = await loadJobBundle(await jobs.requireJob(result.jobId!));
    expect(await stepEngagement(bundle)).toBe('engage');
    expect(await stepQualityGate(bundle)).toBe('next');
    const hour = (new Date().getUTCHours() + 1) % 24;
    bundle.policy.rate.workingHours = { enabled: true, timezone: 'UTC', startHour: hour, endHour: hour };
    await expect(stepExecute(bundle)).rejects.toThrow(/Outside configured working hours/);
    bundle.policy.rate.workingHours.enabled = false;
    bundle.job.approvedAt = new Date().toISOString();
    bundle.job.validatedOutput = 'Buy this token now';
    await expect(stepExecute(bundle)).rejects.toThrow(/financial advice/);
    bundle.job.validatedOutput = 'Index liquidity changed at the recorded times.';
    await capabilities.setGrants(f.agentId, f.accountId, ['READ', 'GENERATE'], null);
    await expect(stepExecute(bundle)).rejects.toThrow(/grant|permitted/i);
    expect(await query(`SELECT id FROM actions`)).toHaveLength(0);
  });
});
