import { afterEach, describe, expect, it, vi } from 'vitest';
import { accounts, actions, agents, cadences, capabilities, capabilityPermissions, content, crossPosts, farcasterSigners, jobs, query, radar } from '@xbam/database';
import { connectFarcaster, fanOutPost, accountPostingStatus } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { fakeFarcaster, TEST_SIGNER } from '../support/fakeFarcaster';
import { originatePost } from '../../packages/runtime/src/originate';
import { loadJobBundle } from '../../packages/runtime/src/loadJob';
import { stepExecute } from '../../packages/runtime/src/steps/execute';
import { pollSignalSource } from '../../packages/runtime/src/signalRadar';
import { processRadarReceipts, receiptEvidence } from '../../packages/runtime/src/radarReceipts';
import { activityTapeProjection, ACTIVITY_CAPABILITY } from '../../packages/runtime/src/studioActivityTape';

installHarness();
afterEach(() => vi.unstubAllGlobals());

/** A mock account stands in for X, so no test reaches the X adapter. */
async function world(options: { optIn?: boolean; signer?: boolean } = {}) {
  const hub = fakeFarcaster();
  const f = await createFixture();
  await agents.updateAgent(f.agentId, { state: 'ACTIVE' });
  const primary = await accounts.createAccount({ ownerId: f.ownerId, channel: 'mock', handle: 'primary' });
  await accounts.updateAccount(primary.id, { enabled: true, status: 'CONNECTED' });
  await accounts.linkAgentAccount({ agentId: f.agentId, accountId: primary.id });
  await capabilities.grant(f.agentId, primary.id, 'POST');
  const cast = await accounts.createAccount({ ownerId: f.ownerId, channel: 'farcaster', handle: 'fid:11', remoteAccountId: '11',
    capabilities: ['REPLY', 'POST', 'LIKE', 'REPOST'], settings: { farcaster: { hubUrl: 'https://hub.example.test' } } });
  const config = await cadences.activeCadence(cast.id);
  await cadences.saveVersion(cast.id, { ...config, quietHours: { ...config.quietHours, enabled: false },
    acting: { ...config.acting, minSecondsBetweenActions: 0 } }, 'test cadence', f.ownerId);
  if (options.signer !== false) {
    await farcasterSigners.setSigner(cast.id, TEST_SIGNER);
    await connectFarcaster(cast.id);
  }
  await accounts.linkAgentAccount({ agentId: f.agentId, accountId: cast.id, actionType: 'REPLY' });
  await capabilities.grant(f.agentId, cast.id, 'POST');
  if (options.optIn !== false) await crossPosts.setFarcasterPosting(cast.id, true);
  return { hub, f, primary, cast };
}
const idea = (agentId: string, summary = 'What building a durable job queue taught the agent about retries') =>
  content.addIdea({ agentId, kind: 'observation', summary, source: 'manual', score: 90 });
const castJobs = () => query<{ id: string; idempotency_key: string; dry_run: boolean; event_id: string }>("SELECT id, idempotency_key, dry_run, event_id FROM jobs WHERE channel = 'farcaster' ORDER BY created_at");
async function execute(jobId: string, text: string) {
  const bundle = await loadJobBundle(await jobs.requireJob(jobId));
  bundle.job.validatedOutput = text;
  return stepExecute(bundle);
}

describe('one voice across X and Farcaster', () => {
  it('casts nothing unless the owner switched Farcaster posting on for that account', async () => {
    const { f, primary } = await world({ optIn: false });
    await idea(f.agentId);
    const post = await originatePost({ agentId: f.agentId, accountId: primary.id });
    expect(post.posted).toBe(true);
    expect(await castJobs()).toHaveLength(0);
    expect(await query('SELECT id FROM cross_posts')).toHaveLength(0);
  });

  it('copies an idea to an opted-in account as an independent job with its own key', async () => {
    const { f, primary, cast } = await world();
    await idea(f.agentId);
    const post = await originatePost({ agentId: f.agentId, accountId: primary.id });
    const [copy] = await castJobs();
    expect(copy).toBeDefined();
    const primaryJob = await jobs.requireJob(post.jobId!);
    expect(copy!.idempotency_key).not.toBe(primaryJob.idempotencyKey);
    expect(copy!.id).not.toBe(primaryJob.id);
    const [event] = await query<{ payload: { mirrorOf: { accountId: string; jobId: string }; ideaId: string } }>('SELECT payload FROM events WHERE id = $1', [copy!.event_id]);
    expect(event!.payload.mirrorOf).toEqual({ accountId: primary.id, jobId: primaryJob.id });
    expect(await query('SELECT status, target_account_id FROM cross_posts')).toEqual([{ status: 'QUEUED', target_account_id: cast.id }]);
  });

  it('is idempotent: fanning the same idea out again, as a restart would, makes no second copy', async () => {
    const { f, primary } = await world();
    const added = await idea(f.agentId);
    const post = await originatePost({ agentId: f.agentId, accountId: primary.id });
    const input = { agentId: f.agentId, originAccount: { id: primary.id, channel: 'mock' }, originJobId: post.jobId,
      idea: { id: added.id, summary: added.summary, source: added.source }, brief: 'again', remoteEventId: `post:${added.id}`,
      dryRun: false, maxAttempts: 3, versions: { personaVersionId: null, policyVersionId: null, pipelineVersionId: null, promptTemplateVersionId: null } };
    const again = await fanOutPost(input);
    expect(again.queued).toHaveLength(0);
    expect(await castJobs()).toHaveLength(1);
    expect(await query('SELECT id FROM cross_posts')).toHaveLength(1);
  });

  it('keeps a rehearsal apart from the real post so a dry run never spends the real cast', async () => {
    const { f, primary } = await world();
    await idea(f.agentId);
    await originatePost({ agentId: f.agentId, accountId: primary.id, dryRun: true });
    await originatePost({ agentId: f.agentId, accountId: primary.id, dryRun: false });
    const rows = await castJobs();
    expect(rows.map((r) => r.dry_run).sort()).toEqual([false, true]);
    expect(new Set(rows.map((r) => r.idempotency_key)).size).toBe(2);
  });

  it('casts once however many times the job runs, and never posts on the other network', async () => {
    const { hub, f, primary } = await world();
    await idea(f.agentId);
    const post = await originatePost({ agentId: f.agentId, accountId: primary.id });
    const [copy] = await castJobs();
    await execute(copy!.id, 'A durable queue teaches you retries are a design decision.');
    await execute(copy!.id, 'A durable queue teaches you retries are a design decision.');
    expect(hub.submitted).toHaveLength(1);
    // The primary network's job was never touched by the cast.
    expect(await query('SELECT id FROM actions WHERE job_id = $1', [post.jobId])).toHaveLength(0);
    const keys = await query<{ channel: string; idempotency_key: string }>('SELECT channel, idempotency_key FROM actions');
    expect(keys.map((k) => k.channel)).toEqual(['farcaster']);
  });

  it('lets one network fail alone: a Farcaster outage does not stop the primary post, and a retry does not repost it', async () => {
    const { hub, f, primary } = await world();
    await idea(f.agentId);
    const post = await originatePost({ agentId: f.agentId, accountId: primary.id });
    const [copy] = await castJobs();
    hub.refuse('submitMessage');
    await expect(execute(copy!.id, 'A durable queue teaches you retries are a design decision.')).rejects.toBeDefined();
    await execute(post.jobId!, 'A durable queue teaches you retries are a design decision.');
    const rows = await query<{ channel: string; status: string }>('SELECT channel, status FROM actions ORDER BY channel');
    expect(rows.find((r) => r.channel === 'mock')?.status).toBe('EXECUTED');
    expect(rows.find((r) => r.channel === 'farcaster')?.status).not.toBe('EXECUTED');
    await expect(execute(copy!.id, 'A durable queue teaches you retries are a design decision.')).rejects.toBeDefined();
    expect(await query("SELECT id FROM actions WHERE channel = 'mock'")).toHaveLength(1);
  });

  it('stops a queued cast when the owner switches Farcaster posting off', async () => {
    const { hub, f, primary, cast } = await world();
    await idea(f.agentId);
    await originatePost({ agentId: f.agentId, accountId: primary.id });
    const [copy] = await castJobs();
    await crossPosts.setFarcasterPosting(cast.id, false);
    await expect(execute(copy!.id, 'A durable queue teaches you retries are a design decision.')).rejects.toMatchObject({ reason: 'farcaster_posting_off' });
    expect(hub.submitted).toHaveLength(0);
  });

  it('refuses a cast longer than a Farcaster cast holds instead of cutting it', async () => {
    const { hub, f, primary } = await world();
    await idea(f.agentId);
    await originatePost({ agentId: f.agentId, accountId: primary.id });
    const [copy] = await castJobs();
    await expect(execute(copy!.id, 'é'.repeat(200))).rejects.toMatchObject({ reason: 'farcaster_cast_length' });
    expect(hub.submitted).toHaveLength(0);
  });

  it('reports an opted-in account with no signer as unavailable, with the reason, and records the skip', async () => {
    const { f, primary, cast } = await world({ signer: false });
    await idea(f.agentId);
    const post = await originatePost({ agentId: f.agentId, accountId: primary.id });
    expect(post.posted).toBe(true);
    expect(await castJobs()).toHaveLength(0);
    const [row] = await query<{ status: string; reason: string }>('SELECT status, reason FROM cross_posts');
    expect(row).toMatchObject({ status: 'SKIPPED', reason: expect.stringMatching(/signer/i) });
    expect(await accountPostingStatus(cast.id)).toMatchObject({ enabled: true, available: false, reason: expect.stringMatching(/signer/i) });
  });

  it('reports an available account as ready', async () => {
    const { cast } = await world();
    expect(await accountPostingStatus(cast.id)).toEqual({ enabled: true, available: true, reason: null });
  });

  it('does not show a copy as a second event on the public activity tape', async () => {
    const { hub, f, primary } = await world();
    await capabilityPermissions.set({ agentId: f.agentId, capabilityId: ACTIVITY_CAPABILITY, permission: 'ALLOWED' });
    await idea(f.agentId);
    const post = await originatePost({ agentId: f.agentId, accountId: primary.id });
    const [copy] = await castJobs();
    await execute(post.jobId!, 'A durable queue teaches you retries are a design decision.');
    await execute(copy!.id, 'A durable queue teaches you retries are a design decision.');
    expect(hub.submitted).toHaveLength(1);
    // The tape never lists the mock channel, so the primary stands in for X by being relabelled.
    await query("UPDATE actions SET channel = 'bluesky', executed_at = now() WHERE channel = 'mock'");
    await query('UPDATE actions SET executed_at = now()');
    const tape = await activityTapeProjection(new Date(Date.now() - 60_000));
    expect(tape.filter((e) => e.kind === 'POST')).toHaveLength(1);
  });
});

describe('the publication refusals run per channel on the final text', () => {
  const watch = { chain: 'solana', address: 'So11111111111111111111111111111111111111112', predicate: 'liquidity_below' as const, threshold: 100 };
  const read = (value: number, at = Date.now()) => ({ value, source: 'fixture', observedAt: new Date(at).toISOString(), definition: 'Median liquidity across three pools.' });

  async function signalWorld() {
    const w = await world();
    const source = await radar.upsertSource({ accountId: w.primary.id, kind: 'market_signal', config: { watches: [watch], mayTrigger: true } });
    await pollSignalSource(source, async () => read(200, Date.now() - 1000));
    await pollSignalSource(source, async () => read(50));
    const post = await originatePost({ agentId: w.f.agentId, accountId: w.primary.id });
    return { ...w, post };
  }

  it('judges a copy of a signal post as a signal post, against the account that watched the chain', async () => {
    const { hub, post } = await signalWorld();
    expect(post.posted).toBe(true);
    const [copy] = await castJobs();
    expect(copy).toBeDefined();
    await expect(execute(copy!.id, 'Liquidity moved. I called it, pnl is up.')).rejects.toMatchObject({ reason: 'signal_publication_refused' });
    await expect(execute(copy!.id, 'Buy now before this moons.')).rejects.toMatchObject({ reason: 'signal_publication_refused' });
    expect(hub.submitted).toHaveLength(0);
    // Clean text passes: the copy is not refused as belonging to a different account.
    await execute(copy!.id, 'Observed liquidity change.');
    expect(hub.submitted).toHaveLength(1);
  });

  it('keeps the receipt language on a copy: no PnL, no called-it, and the receipt stays', async () => {
    const { hub, f, primary, post } = await signalWorld();
    const claim = await actions.claimAction({ jobId: post.jobId!, agentId: f.agentId, accountId: primary.id, channel: 'mock', type: 'POST',
      dryRun: false, idempotencyKey: `published:${post.jobId}`, payload: { text: 'Observed liquidity change.' }, targetRef: null });
    await actions.completeAction(claim.action.id, { status: 'EXECUTED', remoteActionId: 'fixture-post' });
    await query("UPDATE actions SET executed_at = now() - interval '2 hours' WHERE id = $1", [claim.action.id]);
    await processRadarReceipts(f.agentId, async () => read(30));
    const receiptPost = await originatePost({ agentId: f.agentId, accountId: primary.id });
    expect(receiptPost.posted).toBe(true);
    const copies = await castJobs();
    const copy = copies.at(-1)!;
    const [stored] = await query("SELECT evidence, now_read FROM signal_receipts WHERE status = 'offered'");
    const compact = receiptEvidence(stored!.evidence as Parameters<typeof receiptEvidence>[0], stored!.now_read as Parameters<typeof receiptEvidence>[1]).compact;
    await expect(execute(copy.id, `${compact} I called it.`)).rejects.toMatchObject({ reason: 'receipt_publication_refused' });
    await expect(execute(copy.id, 'Liquidity changed.')).rejects.toMatchObject({ reason: 'receipt_publication_refused' });
    expect(hub.submitted).toHaveLength(0);
    await execute(copy.id, compact);
    expect(hub.submitted).toHaveLength(1);
  });
});
