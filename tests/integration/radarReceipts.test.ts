import { describe, expect, it, vi } from 'vitest';
import { accounts, actions, agents, capabilities, capabilityPermissions, cadences, jobs, ops, query, radar, signals, learning, deliberation as mind } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { pollSignalSource } from '../../packages/runtime/src/signalRadar';
import { originatePost } from '../../packages/runtime/src/originate';
import { processRadarReceipts, receiptDraftRefusal, receiptEvidence, receiptIdeaRefusal } from '../../packages/runtime/src/radarReceipts';
import { setPauseAll } from '../../packages/runtime/src/killSwitch';
import { nextPost } from '../../packages/runtime/src/content';
import { loadJobBundle } from '../../packages/runtime/src/loadJob';
import { stepExecute } from '../../packages/runtime/src/steps/execute';
import { runJob } from '../../packages/runtime/src/pipeline';
import * as receipts from '../../packages/runtime/src/radarReceipts';
import * as upstream from '@xbam/upstream';
import { activityTapeProjection, ACTIVITY_CAPABILITY, scrubStudioActivity } from '../../packages/runtime/src/studioActivityTape';
import { wakeAgent } from '../../packages/runtime/src/deliberate';
import { stepQualityGate } from '../../packages/runtime/src/steps/generate';
import type { SignalWatch } from '@xbam/shared/contracts';

installHarness();
const watch = { chain: 'solana', address: 'So11111111111111111111111111111111111111112', predicate: 'liquidity_below' as const, threshold: 100 };
const read = (value: number | null, at = Date.now()) => ({ value, source: 'fixture', observedAt: new Date(at).toISOString(), definition: 'Median liquidity across three pools.' });
async function published(dryRun = false, watches: SignalWatch[] = [watch], observation = read) {
  const f = await createFixture();
  await agents.updateAgent(f.agentId, { state: 'ACTIVE' });
  const account = await accounts.createAccount({ ownerId: f.ownerId, channel: 'mock', handle: 'receipts' });
  await accounts.updateAccount(account.id, { enabled: true, status: 'CONNECTED' });
  await accounts.linkAgentAccount({ agentId: f.agentId, accountId: account.id });
  await capabilities.grant(f.agentId, account.id, 'POST');
  const source = await radar.upsertSource({ accountId: account.id, kind: 'market_signal', config: { watches, mayTrigger: true } });
  await pollSignalSource(source, async () => observation(watches[0]?.predicate === 'concentration_above' ? 20 : 200, Date.now() - 1000));
  await pollSignalSource(source, async () => observation(watches[0]?.predicate === 'concentration_above' ? 60 : 50));
  const post = await originatePost({ agentId: f.agentId, accountId: account.id, dryRun });
  const claim = await actions.claimAction({ jobId: post.jobId!, agentId: f.agentId, accountId: account.id, channel: 'mock', type: 'POST', dryRun, idempotencyKey: `published:${post.jobId}`, payload: { text: 'Observed liquidity change.' }, targetRef: null });
  await actions.completeAction(claim.action.id, { status: dryRun ? 'DRY_RUN' : 'EXECUTED', remoteActionId: 'fixture-post' });
  await query("UPDATE actions SET executed_at=now()-interval '2 hours' WHERE id=$1", [claim.action.id]);
  return { ...f, accountId: account.id, actionId: claim.action.id, source };
}
describe('durable radar receipts', () => {
  it.each(['liquidity_below', 'concentration_above', 'new_pool', 'wallet_transaction'] as const)('fits or visibly declines worst-case %s evidence before offering a receipt', async predicate => {
    const f = await published();
    // Fixed-point values near 1e-6 need up to 24 characters, more than Number.MAX_VALUE.
    const value = predicate === 'new_pool' ? Array.from({ length: 20 }, (_, n) => `${n}${'z'.repeat(43)}`) : predicate === 'wallet_transaction' ? 'z'.repeat(88) : 0.0000010000000000000002;
    const observation = { ...read(null), value, source: 'solana_mainnet.official', reads: [0, 1].map(() => ({ source: 'solana_mainnet.official', observedAt: new Date().toISOString() })), poolCreatedAt: Array.isArray(value) ? Object.fromEntries(value.map(id => [id, new Date().toISOString()])) : undefined };
    await query('UPDATE signal_candidates SET evidence=$1 WHERE agent_id=$2', [{ watch: { ...watch, predicate }, before: observation, after: observation }, f.agentId]);
    await processRadarReceipts(f.agentId, async () => observation);
    const [receipt] = await query('SELECT status, reason, idea_id FROM signal_receipts WHERE window_hours=1');
    if (typeof value !== 'number') {
      expect(receipt).toMatchObject({ status: 'skipped', idea_id: null });
      expect(receipt!.reason).toMatch(/compact|character|predicate/i);
      expect(await query("SELECT id FROM content_ideas WHERE source='radar_receipt'")).toHaveLength(0);
    } else {
      expect(receipt!.status).toBe('offered');
      const post = await originatePost({ agentId: f.agentId, accountId: f.accountId });
      const bundle = await loadJobBundle(await jobs.requireJob(post.jobId!));
      const evidence = { watch: { ...watch, predicate }, before: observation, after: observation };
      const draft = receiptEvidence(evidence, observation).compact;
      expect(draft.length).toBeLessThanOrEqual(bundle.policy.output.maxCharacters);
      expect(receiptDraftRefusal(evidence, observation, draft)).toBeNull();
      bundle.job.validatedOutput = draft;
      expect(await stepQualityGate(bundle)).toBe('next');
    }
  });
  it.each(['disabled', 'revoked'] as const)('makes %s refusals terminal without repeated upstream reads', async refusal => {
    const f = await published();
    if (refusal === 'disabled') await accounts.updateAccount(f.accountId, { enabled: false });
    else await capabilities.setGrants(f.agentId, f.accountId, ['GENERATE'], null);
    let reads = 0;
    const reader = async () => { reads++; return read(30); };
    await processRadarReceipts(f.agentId, reader);
    await processRadarReceipts(f.agentId, reader, new Date(Date.now() + 16 * 60_000));
    expect(reads).toBe(0);
    const [receipt] = await query('SELECT status, reason FROM signal_receipts WHERE window_hours=1');
    expect(receipt!.status).toBe('skipped');
    expect(receipt!.reason).toMatch(/connected|grant/i);
  });
  it('declines numeric receipts whose source labels exceed the active output policy', async () => {
    const f = await published();
    await processRadarReceipts(f.agentId, async () => ({ ...read(30), source: 'source'.repeat(50) }));
    expect((await query('SELECT status, reason FROM signal_receipts WHERE window_hours=1'))[0]).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/character|compact/i) });
    expect(await query("SELECT id FROM content_ideas WHERE source='radar_receipt'")).toHaveLength(0);
  });
  it('leaves the scrub budget available after withheld and legacy receipt ids', async () => {
    const f = await published();
    await ops.setSetting('studio.activity_tape.scrubs', Array.from({ length: 200 }, () => `receipt:${f.actionId}`));
    await scrubStudioActivity(`receipt:${f.actionId}`, f.ownerId);
    await scrubStudioActivity(`action:${f.actionId}`, f.ownerId);
    expect(await ops.getSetting('studio.activity_tape.scrubs')).toEqual([`action:${f.actionId}`]);
  });
  it.each(['quiet hours', 'cooldown', 'ceiling'] as const)('defers a send-time %s refusal without claiming an action and remains bounded by expiry', async limit => {
    const f = await published();
    await processRadarReceipts(f.agentId, async () => read(30));
    const post = await originatePost({ agentId: f.agentId, accountId: f.accountId });
    const bundle = await loadJobBundle(await jobs.requireJob(post.jobId!));
    const [receipt] = await query("SELECT evidence, now_read FROM signal_receipts WHERE status='offered'");
    bundle.job.validatedOutput = receiptEvidence(receipt!.evidence as Parameters<typeof receiptEvidence>[0], receipt!.now_read as Parameters<typeof receiptEvidence>[1]).compact;
    const config = await cadences.activeCadence(f.accountId);
    if (limit === 'quiet hours') config.quietHours = { enabled: true, timezone: 'UTC', startHour: 0, endHour: 0 };
    else if (limit === 'cooldown') config.acting.minSecondsBetweenActions = 3 * 3600;
    else config.acting.maxActionsPerDay = 1;
    await cadences.saveVersion(f.accountId, config, 'fixture', f.ownerId);
    await expect(stepExecute(bundle)).rejects.toMatchObject({ errorClass: 'RETRYABLE', data: { retryAfterMs: expect.any(Number) } });
    await jobs.updateJob(bundle.job.id, { status: 'VALIDATED', currentNodeKey: 'execute', validatedOutput: bundle.job.validatedOutput });
    await runJob(await jobs.requireJob(bundle.job.id), 'receipt-limit-test');
    const deferred = await jobs.requireJob(bundle.job.id);
    expect(deferred.status).toBe('VALIDATED');
    expect(deferred.attemptCount).toBe(0);
    expect(Date.parse(deferred.runAt)).toBeGreaterThan(Date.now());
    expect(await query('SELECT id FROM actions WHERE job_id=$1', [post.jobId])).toHaveLength(0);
    await query("UPDATE actions SET executed_at=now()-interval '26 hours' WHERE id=$1", [f.actionId]);
    await expect(stepExecute(bundle)).rejects.toMatchObject({ errorClass: 'PERMANENT', message: 'Receipt window expired.' });
  });
  it('AC1 schedules exactly two windows per real published action across concurrent restarts', async () => {
    const f = await published();
    await Promise.all([processRadarReceipts(f.agentId, async () => read(30)), processRadarReceipts(f.agentId, async () => read(30))]);
    const rows = await query('SELECT window_hours, extract(epoch FROM due_at - a.executed_at)::int AS delay FROM signal_receipts r JOIN actions a ON a.id=r.action_id ORDER BY window_hours');
    expect(rows.map(r => r.window_hours)).toEqual([1, 24]);
    expect(rows.map(r => r.delay)).toEqual([3600, 86400]);
    expect(await query("SELECT id FROM content_ideas WHERE source='radar_receipt'")).toHaveLength(1);
  });
  it('AC1 rehearsals never schedule receipts', async () => {
    const f = await published(true);
    await processRadarReceipts(f.agentId, async () => read(30));
    expect(await query('SELECT * FROM signal_receipts')).toHaveLength(0);
  });
  it('AC2 reuses upstream routing and exposes before, at-post, now with source times', async () => {
    const f = await published();
    const spy = vi.spyOn(upstream, 'ask').mockResolvedValue({ value: { data: [20, 30, 40].map(n => ({ attributes: { reserve_in_usd: String(n) }, relationships: { base_token: { data: { id: `solana_${watch.address}` } } } })) }, provenance: { upstreamId: 'gecko-fixture', fetchedAt: new Date().toISOString() } } as never);
    try { await processRadarReceipts(f.agentId); } finally { spy.mockRestore(); }
    const data = await signals.forAccount(f.accountId);
    expect(data.receipts?.[0]).toMatchObject({ actionId: f.actionId, verdict: 'changed', nowRead: { value: 30, source: 'gecko-fixture' }, evidence: { before: { value: 200 }, after: { value: 50 } } });
    const brief = await nextPost(f.agentId, f.accountId);
    expect(brief?.idea.source).toBe('radar_receipt');
    expect(brief?.brief).toContain('At post 50');
    expect(brief?.brief).toContain('Now 30');
  });
  it('AC2 a failed read stores an ungraded gap and offers no post', async () => {
    const f = await published();
    await processRadarReceipts(f.agentId, async () => { throw new Error('offline'); });
    expect((await signals.forAccount(f.accountId)).receipts?.[0]).toMatchObject({ status: 'unavailable', verdict: 'unavailable' });
    expect(await query("SELECT id FROM content_ideas WHERE source='radar_receipt'")).toHaveLength(0);
  });
  it.each(['global pause', 'agent pause', 'quiet hours', 'capacity'] as const)('AC3 records an owner-visible refusal before reading during %s', async gate => {
    const f = await published();
    if (gate === 'global pause') await setPauseAll({ paused: true, by: f.ownerId });
    if (gate === 'agent pause') await agents.updateAgent(f.agentId, { state: 'PAUSED' });
    if (gate === 'quiet hours') {
      const config = await cadences.activeCadence(f.accountId);
      config.quietHours = { enabled: true, timezone: 'UTC', startHour: (new Date().getUTCHours() + 1) % 24, endHour: (new Date().getUTCHours() + 1) % 24 };
      await cadences.saveVersion(f.accountId, config, 'fixture', f.ownerId);
    }
    if (gate === 'capacity') await accounts.updateAccount(f.accountId, { status: 'CHALLENGE_REQUIRES_USER' });
    await processRadarReceipts(f.agentId, async () => { throw new Error('must not read'); });
    const receipt = (await signals.forAccount(f.accountId)).receipts?.[0];
    expect(receipt?.status).toBe(gate === 'quiet hours' ? 'pending' : 'skipped');
    const [stored] = await query('SELECT due_at FROM signal_receipts WHERE window_hours=1');
    expect(new Date(String(stored!.due_at)).getTime()).toBeGreaterThan(Date.now());
    expect(receipt?.reason).toMatch(/paused|hours|capacity|connected|challenge/i);
    expect(await query("SELECT id FROM content_ideas WHERE source='radar_receipt'")).toHaveLength(0);
  });
  it('keeps a disconnected receipt skipped after reconnection and expires a later window', async () => {
    const f = await published();
    await accounts.updateAccount(f.accountId, { status: 'CHALLENGE_REQUIRES_USER' });
    await processRadarReceipts(f.agentId, async () => { throw new Error('must not read'); });
    await accounts.updateAccount(f.accountId, { status: 'CONNECTED' });
    await query("UPDATE signal_receipts SET due_at=now()-interval '1 minute' WHERE window_hours=1");
    await processRadarReceipts(f.agentId, async () => read(30));
    expect(await query("SELECT id FROM signal_receipts WHERE status='offered'")).toHaveLength(0);
    await accounts.updateAccount(f.accountId, { status: 'CHALLENGE_REQUIRES_USER' });
    await processRadarReceipts(f.agentId, async () => { throw new Error('expired'); }, new Date(Date.now() + 49 * 3600000));
    expect((await query('SELECT status, reason FROM signal_receipts WHERE window_hours=24'))[0]).toMatchObject({ status: 'skipped', reason: 'Receipt window expired.' });
  });
  it('an offered receipt cannot be sent after its original window expires', async () => {
    const f = await published();
    await processRadarReceipts(f.agentId, async () => read(30));
    const [receipt] = await query<{ idea_id: string }>("SELECT idea_id FROM signal_receipts WHERE status='offered'");
    await query("UPDATE actions SET executed_at=now()-interval '26 hours' WHERE id=$1", [f.actionId]);
    expect(await receiptIdeaRefusal(receipt!.idea_id)).toMatch(/window expired/i);
  });
  it('AC3 final send refuses advice and revoked watch grants, including approvals', async () => {
    const f = await published();
    await processRadarReceipts(f.agentId, async () => read(30));
    const post = await originatePost({ agentId: f.agentId, accountId: f.accountId });
    const bundle = await loadJobBundle(await jobs.requireJob(post.jobId!));
    bundle.job.validatedOutput = 'I called it, buy now';
    bundle.job.approvedAt = new Date().toISOString();
    await expect(stepExecute(bundle)).rejects.toThrow(/performance|advice|pitch/i);
    await capabilities.setGrants(f.agentId, f.accountId, ['GENERATE'], null);
    bundle.job.validatedOutput = 'Observed liquidity change.';
    await expect(stepExecute(bundle)).rejects.toThrow(/grant/i);
  });
  it('a six-read concentration receipt fits the policy and passes quality and execution', async () => {
    const observation = (value: number | null, at = Date.now()) => ({
      ...read(value, at), source: 'solana_mainnet.official',
      reads: [0, 500].map(offset => ({ source: 'solana_mainnet.official', observedAt: new Date(at + offset).toISOString() })),
    });
    const f = await published(false, [{ ...watch, predicate: 'concentration_above', threshold: 40 }], observation);
    await processRadarReceipts(f.agentId, async () => observation(70));
    const post = await originatePost({ agentId: f.agentId, accountId: f.accountId });
    const bundle = await loadJobBundle(await jobs.requireJob(post.jobId!));
    const [receipt] = await query("SELECT evidence, now_read FROM signal_receipts WHERE status='offered'");
    const result = receiptEvidence(receipt!.evidence as Parameters<typeof receiptEvidence>[0], receipt!.now_read as Parameters<typeof receiptEvidence>[1]);
    bundle.job.validatedOutput = result.compact;
    expect(bundle.policy.output.maxCharacters).toBe(280);
    expect(result.compact.length).toBeLessThanOrEqual(bundle.policy.output.maxCharacters);
    expect(await stepQualityGate(bundle)).toBe('next');
    await stepExecute(bundle);
    expect((await signals.forAccount(f.accountId)).receipts?.[0]?.publishedActionId).toBeTruthy();
  });
  it('receipt failures do not prevent posting or an active wake', async () => {
    const f = await published();
    await mind.setWake(f.agentId, { enabled: true, autonomy: 'OBSERVE' });
    const spy = vi.spyOn(receipts, 'processRadarReceipts').mockRejectedValue(new Error('receipt storage unavailable'));
    try {
      await expect(originatePost({ agentId: f.agentId, accountId: f.accountId })).resolves.toMatchObject({ posted: false, jobId: null });
      const outcome = await wakeAgent(f.agentId);
      expect(outcome).toMatchObject({ agentId: f.agentId });
    } finally { spy.mockRestore(); }
  });
  it.each([false, true])('checked_at records read completion when held=%s', async held => {
    const f = await published();
    const started = new Date(Date.now() - 5000);
    let finished = 0;
    await processRadarReceipts(f.agentId, async () => {
      if (held) await accounts.updateAccount(f.accountId, { status: 'CHALLENGE_REQUIRES_USER' });
      finished = Date.now();
      return read(30);
    }, started);
    const [receipt] = await query('SELECT status, checked_at, due_at FROM signal_receipts WHERE window_hours=1');
    expect(receipt!.status).toBe(held ? 'skipped' : 'offered');
    expect(new Date(receipt!.checked_at as string).getTime()).toBeGreaterThanOrEqual(finished);
  });
  it('AC3 a receipt passes normal quality and execution on a mock account', async () => {
    const f = await published();
    await processRadarReceipts(f.agentId, async () => read(30));
    const post = await originatePost({ agentId: f.agentId, accountId: f.accountId });
    const bundle = await loadJobBundle(await jobs.requireJob(post.jobId!));
    const [idea] = await query("SELECT evidence, now_read FROM signal_receipts WHERE status='offered'");
    bundle.job.validatedOutput = receiptEvidence(idea!.evidence as Parameters<typeof receiptEvidence>[0], idea!.now_read as Parameters<typeof receiptEvidence>[1]).compact;
    expect(await stepQualityGate(bundle)).toBe('next');
    await stepExecute(bundle);
    expect((await signals.forAccount(f.accountId)).receipts?.[0]?.publishedActionId).toBeTruthy();
  });
  it('AC3 a globally paused wake does not process receipts', async () => {
    const f = await published();
    await mind.setWake(f.agentId, { enabled: true, autonomy: 'OBSERVE' });
    await setPauseAll({ paused: true, by: f.ownerId });
    await wakeAgent(f.agentId);
    expect((await signals.forAccount(f.accountId)).receipts).toHaveLength(0);
  });
  it('AC3 per-mint cap records skipped and never offers another same-day receipt', async () => {
    const f = await published();
    await processRadarReceipts(f.agentId, async () => read(30));
    await query("UPDATE signal_receipts SET due_at=now()-interval '1 minute' WHERE window_hours=24");
    await processRadarReceipts(f.agentId, async () => read(25));
    expect((await query("SELECT reason FROM signal_receipts WHERE window_hours=24"))[0]?.reason).toMatch(/mint.*cap/i);
  });
  it('AC1 the second window is offered once on the next UTC day', async () => {
    const f = await published();
    await processRadarReceipts(f.agentId, async () => read(30));
    const tomorrow = new Date(Date.now() + 86400000);
    await processRadarReceipts(f.agentId, async () => read(20, tomorrow.getTime()), tomorrow);
    await processRadarReceipts(f.agentId, async () => read(20, tomorrow.getTime()), tomorrow);
    expect(await query("SELECT id FROM content_ideas WHERE source='radar_receipt'")).toHaveLength(2);
    expect((await query('SELECT window_hours FROM signal_receipts WHERE status=\'offered\' ORDER BY window_hours')).map(r => r.window_hours)).toEqual([1, 24]);
  });
  it('AC3 receipt account scoping leaves another account backlog untouched', async () => {
    const f = await published();
    await processRadarReceipts(f.agentId, async () => read(30));
    const other = await accounts.createAccount({ ownerId: f.ownerId, channel: 'mock', handle: 'other' });
    // Consume the original idea, as a completed publication normally does.
    await query("UPDATE content_ideas SET status='used' WHERE source='market_signal'");
    expect(await nextPost(f.agentId, other.id)).toBeNull();
    expect((await nextPost(f.agentId, f.accountId))?.idea.source).toBe('radar_receipt');
  });
  it.each(['ceiling', 'cooldown'] as const)('AC3 defers before a read at the cadence %s', async limit => {
    const f = await published();
    const config = await cadences.activeCadence(f.accountId);
    if (limit === 'ceiling') config.acting.maxActionsPerDay = 1;
    else config.acting.minSecondsBetweenActions = 3 * 3600;
    await cadences.saveVersion(f.accountId, config, 'fixture', f.ownerId);
    await processRadarReceipts(f.agentId, async () => { throw new Error('must not read'); });
    const receipt = (await signals.forAccount(f.accountId)).receipts?.[0];
    expect(receipt?.status).toBe('pending');
    expect(receipt?.reason).toMatch(limit === 'ceiling' ? /daily ceiling/i : /cooling down/i);
    const [stored] = await query('SELECT due_at FROM signal_receipts WHERE window_hours=1');
    expect(new Date(String(stored!.due_at)).getTime()).toBeGreaterThan(Date.now());
  });
  it('AC3 agent daily cap limits different mints to two receipt offers', async () => {
    const watches = [watch, { ...watch, address: '11111111111111111111111111111111' }, { ...watch, address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }];
    const f = await published(false, watches);
    await query('UPDATE actions SET executed_at=now() WHERE id=$1', [f.actionId]);
    for (let n = 0; n < 2; n++) {
      const post = await originatePost({ agentId: f.agentId, accountId: f.accountId });
      const claim = await actions.claimAction({ jobId: post.jobId!, agentId: f.agentId, accountId: f.accountId, channel: 'mock', type: 'POST', dryRun: false, idempotencyKey: `mint-${n}`, payload: { text: 'Observed.' }, targetRef: null });
      await actions.completeAction(claim.action.id, { status: 'EXECUTED' });
    }
    await query("UPDATE actions SET executed_at=now()-interval '2 hours' WHERE agent_id=$1", [f.agentId]);
    await processRadarReceipts(f.agentId, async () => read(30));
    // Some windows were anchored before the fixture moved the action times.
    await query("UPDATE signal_receipts SET due_at=now()-interval '1 minute' WHERE window_hours=1");
    await processRadarReceipts(f.agentId, async () => read(30));
    expect(await query("SELECT id FROM signal_receipts WHERE status='offered'")).toHaveLength(2);
    expect((await query("SELECT reason FROM signal_receipts WHERE status='skipped'"))[0]?.reason).toMatch(/Agent daily receipt cap/i);
  });
  it('AC4 tape projection withholds unsupported receipt events', async () => {
    const f = await published();
    await processRadarReceipts(f.agentId, async () => read(30));
    const post = await originatePost({ agentId: f.agentId, accountId: f.accountId });
    const claim = await actions.claimAction({ jobId: post.jobId!, agentId: f.agentId, accountId: f.accountId, channel: 'mock', type: 'POST', dryRun: false, idempotencyKey: 'receipt-published', payload: { text: 'PRIVATE' }, targetRef: null });
    await actions.completeAction(claim.action.id, { status: 'EXECUTED' });
    await capabilityPermissions.set({ agentId: f.agentId, capabilityId: ACTIVITY_CAPABILITY, permission: 'ALLOWED' });
    // Stored non-mock metadata tests the public projection only; no adapter is invoked.
    await query("UPDATE actions SET channel='bluesky', executed_at=now() WHERE id=$1", [claim.action.id]);
    expect(await activityTapeProjection(new Date(Date.now() - 60000))).toEqual([]);
  });
  it('receipts cannot become learnable reach outcomes', async () => {
    const f = await published();
    await query(`INSERT INTO post_analytics(agent_id,channel,remote_post_id,action_id,observed_at,views)
      VALUES($1,'mock','fixture-post',$2,now(),1000)`, [f.agentId, f.actionId]);
    expect(await learning.measurableActions(f.agentId, 1)).toHaveLength(1);
    await query(`UPDATE events SET payload=jsonb_set(payload,'{ideaSource}','"radar_receipt"')
      WHERE id=(SELECT event_id FROM jobs WHERE id=(SELECT job_id FROM actions WHERE id=$1))`, [f.actionId]);
    expect(await learning.measurableActions(f.agentId, 1)).toHaveLength(0);
  });
  it('AC5 stored ranking explains magnitude instead of constant 65', async () => {
    await published();
    const [idea] = await query("SELECT score, detail FROM content_ideas WHERE source='market_signal'");
    expect(idea?.score).not.toBe(65);
    expect(idea?.detail).toMatch(/Ranking:.*magnitude/i);
    expect((await query('SELECT reason FROM signal_candidates'))[0]?.reason).toMatch(/Ranking:.*magnitude/i);
  });
});
