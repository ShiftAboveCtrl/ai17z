import { afterEach, describe, expect, it, vi } from 'vitest';
import { Message, ReactionType } from '@farcaster/core';
import { farcasterAdapter } from '@xbam/channels';
import { accounts, capabilities, cadences, channelState, farcasterSigners, jobs, query } from '@xbam/database';
import { buildChannelContext, connectFarcaster, ingestNormalizedEvent, loadJobBundle, registerFarcasterCapabilities,
  stepExecute, stepResolveContext, actionIdempotencyKeyFor, capabilityIdempotencyKey } from '@xbam/runtime';
import { getCapability, resetCapabilitiesForTest } from '@xbam/tools';
import { ChannelPoller } from '../../apps/worker/src/poller';
import { createLogger, PipelineError, redact } from '@xbam/shared';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { CAST_HASH, CAST_REF, OWN_HASH, TEST_SIGNER, castMessage, fakeFarcaster } from '../support/fakeFarcaster';

installHarness();
afterEach(() => vi.unstubAllGlobals());
async function setup() {
  const hub = fakeFarcaster();
  const fixture = await createFixture();
  const account = await accounts.createAccount({ ownerId: fixture.ownerId, channel: 'farcaster', handle: 'fid:11',
    remoteAccountId: '11', capabilities: ['REPLY', 'POST', 'LIKE', 'REPOST'],
    settings: { farcaster: { hubUrl: 'https://hub.example.test' } } });
  const config = await cadences.activeCadence(account.id);
  await cadences.saveVersion(account.id, { ...config, quietHours: { ...config.quietHours, enabled: false },
    acting: { ...config.acting, minSecondsBetweenActions: 0 } }, 'test cadence', fixture.ownerId);
  await farcasterSigners.setSigner(account.id, TEST_SIGNER);
  const connected = await connectFarcaster(account.id);
  await accounts.linkAgentAccount({ agentId: fixture.agentId, accountId: account.id, actionType: 'REPLY' });
  const ctx = await buildChannelContext(connected, null);
  return { hub, fixture, account: connected, ctx };
}
const action = (type: 'POST' | 'REPLY' | 'LIKE' | 'REPOST' = 'REPLY', key = 'one-action') => ({
  type, text: type === 'POST' || type === 'REPLY' ? 'A considered answer about public crypto infrastructure.' : '',
  targetRef: type === 'POST' ? null : CAST_REF, idempotencyKey: key, dryRun: false,
});
async function incoming(ctx: Awaited<ReturnType<typeof buildChannelContext>>, agentId: string) {
  const [event] = await farcasterAdapter.ingestEvents(ctx, { limit: 10 });
  const result = await ingestNormalizedEvent({ accountId: ctx.account.id, onlyAgentId: agentId, event: event! });
  const job = result.jobs[0]?.job;
  if (!job) throw new Error('The Farcaster fixture must create a job.');
  return { event: event!, job };
}

describe('Farcaster channel with real database guarantees', () => {
  it('seals the app key and validates without publishing, and redacts key-shaped fields', async () => {
    const { hub, account } = await setup();
    const [row] = await query<{ sealed_signer_key: string }>('SELECT sealed_signer_key FROM farcaster_signers WHERE account_id = $1', [account.id]);
    expect(row!.sealed_signer_key).toMatch(/^v1\./);
    expect(row!.sealed_signer_key).not.toContain(TEST_SIGNER);
    expect(await farcasterSigners.getDecryptedSigner(account.id)).toBe(TEST_SIGNER);
    expect(await farcasterSigners.signerPresence(account.id)).toEqual({ hasSigner: true });
    expect(JSON.stringify(account)).not.toContain(TEST_SIGNER);
    expect(redact({ signerKey: TEST_SIGNER, privateKey: TEST_SIGNER })).toEqual({ signerKey: '[redacted]', privateKey: '[redacted]' });
    expect(hub.submitted).toHaveLength(0);
  });

  it('sends a signed reply to the incoming cast, verifies readback and reuses bytes after a lost response', async () => {
    const { hub, ctx } = await setup();
    hub.loseNextResponse();
    await expect(farcasterAdapter.executeAction(ctx, action())).rejects.toMatchObject({ reason: 'farcaster_unavailable' });
    const result = await farcasterAdapter.executeAction(ctx, action());
    expect(result.status).toBe('EXECUTED');
    expect(hub.submitted).toHaveLength(2);
    expect(Message.encode(hub.submitted[0]!).finish()).toEqual(Message.encode(hub.submitted[1]!).finish());
    const target = hub.submitted[1]!.data!.castAddBody!.parentCastId!;
    expect(target.fid).toBe(22);
    expect(Buffer.from(target.hash).toString('hex')).toBe(CAST_HASH.slice(2));
    expect(await farcasterAdapter.wasAlreadyDone!(ctx, action())).toMatchObject({ done: true, remoteActionId: result.remoteActionId });
    await expect(farcasterAdapter.executeAction(ctx, { ...action(), text: 'Different text' }))
      .rejects.toMatchObject({ reason: 'farcaster_idempotency_conflict' });
  });

  it('posts without a parent and never submits a dry run', async () => {
    const { hub, ctx } = await setup();
    expect((await farcasterAdapter.executeAction(ctx, { ...action(), dryRun: true })).status).toBe('DRY_RUN');
    expect(hub.submitted).toHaveLength(0);
    await farcasterAdapter.executeAction(ctx, action('POST'));
    expect(hub.submitted[0]!.data!.castAddBody!.parentCastId).toBeUndefined();
  });

  it('keeps an accepted cast recoverable while the node catches up on reads', async () => {
    const { hub, ctx } = await setup();
    hub.delayNextReadback();
    await expect(farcasterAdapter.executeAction(ctx, action())).rejects.toMatchObject({ errorClass: 'RETRYABLE' });
    expect(hub.submitted).toHaveLength(1);
    expect(await farcasterAdapter.wasAlreadyDone!(ctx, action())).toMatchObject({ done: true });
    expect(hub.submitted).toHaveLength(1);
  });

  it('likes and recasts as desired states without toggling or quoting', async () => {
    const { hub, ctx } = await setup();
    for (const type of ['LIKE', 'REPOST'] as const) {
      await farcasterAdapter.executeAction(ctx, action(type, type));
      await farcasterAdapter.executeAction(ctx, action(type, `again-${type}`));
    }
    expect(hub.submitted.map((m) => m.data!.reactionBody!.type)).toEqual([ReactionType.LIKE, ReactionType.RECAST]);
    expect(hub.submitted.every((m) => m.data!.castAddBody === undefined)).toBe(true);
  });

  it('deduplicates a mention and a reply by cast hash through the real ingest indexes', async () => {
    const { ctx, fixture, account } = await setup();
    const { event, job } = await incoming(ctx, fixture.agentId);
    const again = await ingestNormalizedEvent({ accountId: account.id, event: { ...event, type: 'REPLY' } });
    expect(again.eventId).toBe(job.eventId);
    expect(again.jobs.filter((j) => j.created)).toHaveLength(0);
    const rows = await query('SELECT id FROM events WHERE account_id = $1 AND remote_event_id = $2', [account.id, CAST_HASH]);
    expect(rows).toHaveLength(1);
  });

  it('counts each context read and stops before HTTP when the read budget is exhausted', async () => {
    const { hub, fixture, account, ctx } = await setup();
    const { job } = await incoming(ctx, fixture.agentId);
    const before = await query<{ n: number }>("SELECT count(*)::int AS n FROM x_capacity_ledger WHERE account_id = $1 AND entry = 'READ'", [account.id]);
    const readsBefore = hub.reads.length;
    await stepResolveContext(await loadJobBundle(job));
    const after = await query<{ n: number }>("SELECT count(*)::int AS n FROM x_capacity_ledger WHERE account_id = $1 AND entry = 'READ'", [account.id]);
    // Every HTTP read the context step made, name lookups included, is on the ledger.
    expect(after[0]!.n - before[0]!.n).toBe(hub.reads.length - readsBefore);
    await query(`INSERT INTO x_capacity_ledger (account_id, entry, class) SELECT $1, 'READ', 'DIRECT' FROM generate_series(1,200)`, [account.id]);
    const count = hub.reads.length;
    await expect(farcasterAdapter.ingestEvents(ctx, { limit: 10 })).rejects.toMatchObject({ reason: 'account_capacity' });
    expect(hub.reads).toHaveLength(count);
  });

  it('preserves paginated mentions and finds replies that do not mention the agent', async () => {
    const { hub, ctx } = await setup();
    const reply = castMessage(`0x${'ef'.repeat(20)}`, 33, 'Reply without an explicit mention', { fid: 11, hash: OWN_HASH });
    reply.data.castAddBody.mentions = [];
    reply.data.castAddBody.mentionsPositions = [];
    hub.pages((url) => url.pathname.endsWith('castsByMention')
      ? { messages: [castMessage()], nextPageToken: url.searchParams.get('pageToken') ? '' : 'next-mentions' }
      : url.pathname.endsWith('castsByFid') ? { messages: [castMessage(OWN_HASH, 11)], nextPageToken: '' }
        : { messages: [reply], nextPageToken: '' });
    let cursor: string | null = null;
    const seen: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const events = await farcasterAdapter.ingestEvents(ctx, { limit: 1, cursor, reportCursor: (c) => { cursor = c; } });
      seen.push(...events.map((e) => e.type));
    }
    expect(hub.reads.filter((u) => u.pathname.endsWith('castsByMention')).map((u) => u.searchParams.get('pageToken')))
      .toEqual(['', 'next-mentions', '']);
    expect(seen).toContain('REPLY');
  });

  it('rejects an overlapping cursor write while keeping the newer committed state', async () => {
    const { account } = await setup();
    const state = await channelState.pollState(account.id);
    expect(await channelState.advancePoll(account.id, state.version, 'newer')).toBe(true);
    expect(await channelState.advancePoll(account.id, state.version, 'stale')).toBe(false);
    expect((await channelState.pollState(account.id)).cursor).toBe('newer');
  });

  it('checks revoked reply grants again immediately before execution', async () => {
    const { hub, fixture, account, ctx } = await setup();
    const { job } = await incoming(ctx, fixture.agentId);
    await stepResolveContext(await loadJobBundle(job));
    await jobs.updateJob(job.id, { validatedOutput: 'A considered reply.' });
    await capabilities.setGrants(fixture.agentId, account.id, ['READ', 'GENERATE'], null);
    await expect(stepExecute(await loadJobBundle((await jobs.getJob(job.id))!)))
      .rejects.toMatchObject({ errorClass: 'PERMANENT', reason: 'capability_not_granted' });
    expect(hub.submitted).toHaveLength(0);
  });

  it('publishes one authorized pipeline reply and records its durable action', async () => {
    const { hub, fixture, ctx } = await setup();
    const { job } = await incoming(ctx, fixture.agentId);
    await stepResolveContext(await loadJobBundle(job));
    await jobs.updateJob(job.id, { validatedOutput: 'A considered reply about public infrastructure.' });
    await stepExecute(await loadJobBundle((await jobs.getJob(job.id))!));
    expect(hub.submitted).toHaveLength(1);
    expect((await jobs.getJob(job.id))!.status).toBe('EXECUTED');
    const [row] = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM actions WHERE job_id = $1 AND status = 'EXECUTED'", [job.id]);
    expect(row!.n).toBe(1);
  });

  it('uses the same key for pipeline and model-callable engagement actions', async () => {
    for (const [type, capabilityId] of [['LIKE', 'farcaster.like'], ['REPOST', 'farcaster.recast']] as const) {
      expect(actionIdempotencyKeyFor({ channel: 'farcaster', actionType: type, jobIdempotencyKey: 'job', targetRef: CAST_REF }))
        .toBe(capabilityIdempotencyKey({ jobIdempotencyKey: 'job', capabilityId, targetRef: CAST_REF }));
    }
  });

  it('refuses a model action after the account grant is revoked', async () => {
    const { hub, fixture, account, ctx } = await setup();
    const { job } = await incoming(ctx, fixture.agentId);
    resetCapabilitiesForTest(); registerFarcasterCapabilities();
    const capability = getCapability('farcaster.like')!;
    await expect(capability.run({ cast: CAST_REF } as never, { agentId: fixture.agentId, accountId: account.id,
      jobId: job.id, config: {}, logger: createLogger('test'), signal: new AbortController().signal }))
      .rejects.toMatchObject({ reason: 'capability_not_granted' });
    expect(hub.submitted).toHaveLength(0);
  });

  it('runs the ordinary poller, commits after ingestion, and respects the server retry delay', async () => {
    const { account, hub } = await setup();
    const config = await cadences.activeCadence(account.id);
    await cadences.saveVersion(account.id, { ...config, polling: { ...config.polling,
      intervalSeconds: 15, maxIntervalSeconds: 15, jitterPercent: 0 } }, 'poll test', null);
    const poller = new ChannelPoller();
    await poller.tick();
    const state = await channelState.pollState(account.id);
    expect(state.version).toBe(1);
    expect(JSON.parse(state.cursor!).surface).toBe('own');
    const rows = await query('SELECT id FROM events WHERE account_id = $1', [account.id]);
    expect(rows).toHaveLength(1);
    hub.refuse('castsByFid');
    await query('UPDATE accounts SET next_poll_at = now() WHERE id = $1', [account.id]);
    const before = Date.now();
    await poller.tick();
    expect(await channelState.pollState(account.id)).toEqual(state);
    const scheduled = await cadences.pollState(account.id);
    expect(Date.parse(scheduled!.nextPollAt!) - before).toBeGreaterThanOrEqual(61_000);
    const [usage] = await query<{ n: number }>("SELECT count(*)::int AS n FROM x_capacity_ledger WHERE account_id = $1 AND entry = 'READ'", [account.id]);
    // Three before this change, plus one username lookup each for FIDs 22 and 11.
    expect(usage!.n).toBe(5);
  });

  it('records a node rate limit as pushback by its code, and never reads other errors as X wording', async () => {
    const { hub, account, ctx } = await setup();
    const signals = () => query<{ signal: string }>("SELECT signal FROM x_capacity_ledger WHERE account_id = $1 AND entry = 'SIGNAL'", [account.id]);
    // These sentences are what classifyXSignal reads as X pushback. A node did not write them.
    for (const words of ['Something went wrong, try reloading.', 'It never finished and showed a loading screen.']) {
      await ctx.afterRead!(PipelineError.retryable('farcaster_unavailable', words));
    }
    await ctx.afterRead!(new Error('slow down, too many requests'));
    expect(await signals()).toHaveLength(0);
    hub.refuse('castsByMention');
    await expect(farcasterAdapter.ingestEvents(ctx, { limit: 10 })).rejects.toMatchObject({ reason: 'farcaster_rate_limited' });
    expect(await signals()).toEqual([{ signal: 'RATE_LIMITED' }]);
  });

  it('shows usernames from the node and keeps the numeric FID as the event identity', async () => {
    const { hub, fixture, ctx } = await setup();
    hub.usernames.set(22, 'alice');
    const { event } = await incoming(ctx, fixture.agentId);
    expect(event).toMatchObject({ remoteAuthorHandle: 'alice', remoteAuthorId: '22', remoteMessageId: CAST_REF });
    const resolved = await farcasterAdapter.resolveContext(ctx, event);
    // FID 11 has no name on this node, so it keeps the FID form.
    expect(resolved).toMatchObject({ targetAuthorHandle: 'alice', incomingText: '@fid:11A question about crypto infrastructure?' });
  });

  it('holds HTTP reads during quiet hours using the existing cadence configuration', async () => {
    const { hub, account, ctx } = await setup();
    const config = await cadences.activeCadence(account.id);
    const nextHour = (new Date().getUTCHours() + 1) % 24;
    await cadences.saveVersion(account.id, { ...config, quietHours: { enabled: true,
      timezone: 'UTC', startHour: nextHour, endHour: nextHour } }, 'quiet test', null);
    const before = hub.reads.length;
    await expect(farcasterAdapter.ingestEvents(ctx, { limit: 10 })).rejects.toMatchObject({ reason: 'quiet_hours' });
    expect(hub.reads).toHaveLength(before);
  });

  it('uses BROAD capacity for model lookups and charges each ancestor separately', async () => {
    const { hub, account, fixture } = await setup();
    hub.casts.set(CAST_HASH, castMessage(CAST_HASH, 22, 'Incoming reply', { fid: 11, hash: OWN_HASH }));
    resetCapabilitiesForTest(); registerFarcasterCapabilities();
    const result = await getCapability('farcaster.read_thread')!.run({ cast: CAST_REF } as never, {
      agentId: fixture.agentId, jobId: null, accountId: account.id, config: {}, logger: createLogger('test'),
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ targetRef: CAST_REF, parentText: '@fid:11Our original cast' });
    const [usage] = await query<{ n: number }>("SELECT count(*)::int AS n FROM x_capacity_ledger WHERE account_id = $1 AND entry = 'READ' AND class = 'BROAD'", [account.id]);
    // Two casts, then one username lookup each for the two FIDs shown.
    expect(usage!.n).toBe(4);
  });

  it('executes a granted model like through durable actions and observes account cadence on the next one', async () => {
    const { hub, account, fixture, ctx } = await setup();
    const { job } = await incoming(ctx, fixture.agentId);
    await capabilities.grant(fixture.agentId, account.id, 'LIKE');
    resetCapabilitiesForTest(); registerFarcasterCapabilities();
    const context = { agentId: fixture.agentId, jobId: job.id, accountId: account.id, config: {}, logger: createLogger('test'),
      signal: new AbortController().signal };
    const capability = getCapability('farcaster.like')!;
    expect(await capability.run({ cast: CAST_REF } as never, context)).toMatchObject({ performed: true });
    expect(hub.submitted).toHaveLength(1);
    const config = await cadences.activeCadence(account.id);
    await cadences.saveVersion(account.id, { ...config, acting: { ...config.acting, minSecondsBetweenActions: 3600 } }, 'slower actions', null);
    await expect(capability.run({ cast: CAST_REF } as never, context)).rejects.toMatchObject({ errorClass: 'RETRYABLE' });
    expect(hub.submitted).toHaveLength(1);
  });
});
