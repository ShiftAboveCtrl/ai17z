import { describe, expect, it, vi } from 'vitest';
import { accounts, actions, agents, capabilities, jobs, ops, query, radar } from '@xbam/database';
import { DEFAULT_POLICY } from '@xbam/shared/contracts';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { pollSignalSource } from '../../packages/runtime/src/signalRadar';
import { originatePost } from '../../packages/runtime/src/originate';
import { processRadarReceipts } from '../../packages/runtime/src/radarReceipts';
import { publishedReceipts, proposeReceiptsRecap, recapFrom, checkReceiptsRecapAtSend, recapKey } from '../../packages/runtime/src/receiptsRecap';
import { prepareReceiptsRecapImage, decidedReceiptsRecapImage } from '../../packages/runtime/src/receiptsRecapImage';
import { loadJobBundle } from '../../packages/runtime/src/loadJob';

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
let studioCalls = 0;
vi.mock('../../packages/runtime/src/studioLink', async (original) => ({
  ...(await original<typeof import('../../packages/runtime/src/studioLink')>()),
  studioInstallationFile: async () => { studioCalls++; return { ok: true, status: 200, bytes: PNG, contentType: 'image/png' }; },
}));

installHarness();
const watch = { chain: 'solana', address: 'So11111111111111111111111111111111111111112', predicate: 'liquidity_below' as const, threshold: 100 };
const read = (value: number | null, at = Date.now()) => ({ value, source: 'fixture', observedAt: new Date(at).toISOString(), definition: 'Median liquidity across three pools.' });

/** A real published radar signal, as radarReceipts.test.ts builds one. */
async function published(opts: { dryRun?: boolean; hoursAgo?: number } = {}) {
  const dryRun = opts.dryRun ?? false;
  const f = await createFixture();
  await agents.updateAgent(f.agentId, { state: 'ACTIVE' });
  const account = await accounts.createAccount({ ownerId: f.ownerId, channel: 'mock', handle: 'recap' });
  await accounts.updateAccount(account.id, { enabled: true, status: 'CONNECTED' });
  await accounts.linkAgentAccount({ agentId: f.agentId, accountId: account.id });
  await capabilities.grant(f.agentId, account.id, 'POST');
  const source = await radar.upsertSource({ accountId: account.id, kind: 'market_signal', config: { watches: [watch], mayTrigger: true } });
  await pollSignalSource(source, async () => read(200, Date.now() - 1000));
  await pollSignalSource(source, async () => read(50));
  const post = await originatePost({ agentId: f.agentId, accountId: account.id, dryRun });
  const claim = await actions.claimAction({ jobId: post.jobId!, agentId: f.agentId, accountId: account.id, channel: 'mock', type: 'POST', dryRun,
    idempotencyKey: `published:${post.jobId}`, payload: { text: 'Observed liquidity change.' }, targetRef: null });
  await actions.completeAction(claim.action.id, { status: dryRun ? 'DRY_RUN' : 'EXECUTED', remoteActionId: 'fixture-post' });
  await query("UPDATE actions SET executed_at=now()-($2 || ' hours')::interval WHERE id=$1", [claim.action.id, String(opts.hoursAgo ?? 30)]);
  return { ...f, accountId: account.id, actionId: claim.action.id };
}
const enable = async (agentId: string, studio: Record<string, boolean>) => {
  const current = await agents.getActivePolicy(agentId);
  await agents.savePolicyVersion(agentId, { ...(current?.config ?? DEFAULT_POLICY), studio: { ...DEFAULT_POLICY.studio, ...studio } } as never, 'recap test', null);
};
const window = () => ({ start: new Date(Date.now() - 7 * 86_400_000), end: new Date() });

describe('weekly receipts recap, from published receipts', () => {
  it('includes a published signal with its 24h reading and never counts a dry run', async () => {
    const f = await published();
    await processRadarReceipts(f.agentId, async () => read(30));
    const recap = recapFrom(await publishedReceipts(f.agentId, window()), window());
    expect(recap).toMatchObject({ n: 1, readings_taken: 1, changed: 1, without_reading: 0 });
    expect(recap.rows[0]!.after_24h.state).toBe('changed');

    const dry = await published({ dryRun: true });
    await processRadarReceipts(dry.agentId, async () => read(30));
    expect(await publishedReceipts(dry.agentId, window())).toHaveLength(0);
  });

  it('counts a published signal whose follow-up was never read, as no reading, not as a hit', async () => {
    const f = await published();
    await processRadarReceipts(f.agentId, async () => { throw new Error('upstream down'); });
    const recap = recapFrom(await publishedReceipts(f.agentId, window()), window());
    expect(recap).toMatchObject({ n: 1, readings_taken: 0, without_reading: 1 });
  });

  it('never counts a rehearsal or a signal outside the window', async () => {
    const f = await published();
    await query(`UPDATE events SET payload=jsonb_set(payload,'{rehearsal}','"true"') WHERE id=(SELECT j.event_id FROM jobs j JOIN actions a ON a.job_id=j.id WHERE a.id=$1)`, [f.actionId]);
    expect(await publishedReceipts(f.agentId, window())).toHaveLength(0);
    const old = await published({ hoursAgo: 24 * 12 });
    expect(await publishedReceipts(old.agentId, window())).toHaveLength(0);
  });

  it('proposes nothing when off, then one idea a week when on, and nothing for an empty week', async () => {
    const f = await published();
    await processRadarReceipts(f.agentId, async () => read(30));
    expect((await proposeReceiptsRecap(f.agentId)).proposed).toBe(false);
    expect(await query("SELECT id FROM content_ideas WHERE source='receipts_recap'")).toHaveLength(0);
    await enable(f.agentId, { postReceiptsRecap: true });
    const first = await proposeReceiptsRecap(f.agentId);
    expect(first.proposed).toBe(true);
    const [idea] = await query<{ id: string; summary: string }>("SELECT id, summary FROM content_ideas WHERE source='receipts_recap'");
    expect(idea!.summary).toContain('n = 1');
    expect(await ops.getSetting(recapKey(idea!.id))).toMatchObject({ n: 1 });
    expect((await proposeReceiptsRecap(f.agentId)).proposed).toBe(false);
    const empty = await createFixture();
    await enable(empty.agentId, { postReceiptsRecap: true });
    expect((await proposeReceiptsRecap(empty.agentId)).why).toMatch(/No radar signal/);
  });

  it('asks Studio for a picture only when the image switch is on, and falls back to text otherwise', async () => {
    const f = await published();
    await processRadarReceipts(f.agentId, async () => read(30));
    await enable(f.agentId, { postReceiptsRecap: true });
    await proposeReceiptsRecap(f.agentId);
    const post = await originatePost({ agentId: f.agentId, accountId: f.accountId });
    const bundle = await loadJobBundle(await jobs.requireJob(post.jobId!));
    // A freshly originated job has no resolved context until the pipeline runs, so give it the empty one.
    bundle.job.resolvedContext = { meta: {}, incomingText: '', targetRef: null } as never;
    bundle.job.dryRun = false;
    // The radar's own idea outranks the recap in the backlog, so state which one this job is.
    (bundle.event.payload as Record<string, unknown>).ideaSource = 'receipts_recap';
    const recap = recapFrom(await publishedReceipts(f.agentId, window()), window());
    studioCalls = 0;
    await prepareReceiptsRecapImage(bundle, recap);
    expect(studioCalls).toBe(0);
    expect(decidedReceiptsRecapImage(bundle)).toHaveLength(0);
    await enable(f.agentId, { postReceiptsRecap: true, receiptsRecapImage: true });
    await prepareReceiptsRecapImage(bundle, recap);
    expect(studioCalls).toBe(1);
    expect(decidedReceiptsRecapImage(bundle)).toHaveLength(1);
    bundle.job.dryRun = true;
    bundle.job.resolvedContext = { meta: {}, incomingText: '', targetRef: null } as never;
    await prepareReceiptsRecapImage(bundle, recap);
    expect(studioCalls).toBe(1);
  });

  it('holds a recap whose text lost the sample size, and stops one whose switch was turned off', async () => {
    const f = await published();
    await processRadarReceipts(f.agentId, async () => read(30));
    await enable(f.agentId, { postReceiptsRecap: true });
    await proposeReceiptsRecap(f.agentId);
    const [idea] = await query<{ id: string; summary: string }>("SELECT id, summary FROM content_ideas WHERE source='receipts_recap'");
    const on = (await agents.getActivePolicy(f.agentId))!.config;
    const raw = { ideaSource: 'receipts_recap', ideaId: idea!.id };
    await expect(checkReceiptsRecapAtSend({ raw, text: idea!.summary, policy: on })).resolves.toMatchObject({ n: 1 });
    await expect(checkReceiptsRecapAtSend({ raw, text: 'A good week, best calls yet.', policy: on })).rejects.toThrow(/needs the owner/);
    await expect(checkReceiptsRecapAtSend({ raw, text: idea!.summary, policy: DEFAULT_POLICY })).rejects.toThrow(/switched off/);
    await expect(checkReceiptsRecapAtSend({ raw: { ideaSource: 'manual' }, text: 'x', policy: DEFAULT_POLICY })).resolves.toBeNull();
  });
});
