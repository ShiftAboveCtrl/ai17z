import { describe, expect, it } from 'vitest';
import { ResolvedContext } from '@xbam/shared/contracts';
import { accounts as accountsRepo, jobs as jobsRepo, query } from '@xbam/database';
import { ensureMediaResolved, ingestNormalizedEvent, loadJobBundle, stepResolveMedia } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * Pictures are described for posts that will be answered, not before.
 *
 * Measured on a live installation over three days: 426 vision calls, 364 of
 * them for posts the agent then declined, against 118 replies written. The
 * decision to answer never read the description.
 */

async function jobWithAPicture() {
  const fixture = await createFixture();
  const account = await accountsRepo.createAccount({ ownerId: fixture.ownerId, channel: 'mock', handle: `media_${uniqueSuffix()}` });
  await accountsRepo.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
  await accountsRepo.linkAgentAccount({
    agentId: fixture.agentId,
    accountId: account.id,
    triggerEventTypes: ['MENTION'],
    actionType: 'REPLY',
  });
  const id = `media-${uniqueSuffix()}`;
  const outcome = await ingestNormalizedEvent({
    accountId: account.id,
    event: {
      channel: 'mock',
      type: 'MENTION',
      remoteEventId: id,
      remoteMessageId: id,
      remoteAuthorId: null,
      remoteAuthorHandle: 'someone',
      remoteAuthorDisplayName: null,
      remoteConversationId: id,
      parentRemoteMessageId: null,
      remoteUrl: null,
      text: `@${account.handle} look at this chart`,
      occurredAt: new Date().toISOString(),
      raw: {},
    },
  });
  const job = outcome.jobs[0]!.job;
  const context = ResolvedContext.parse({
    targetRef: id,
    targetAuthorHandle: 'someone',
    incomingText: 'look at this chart',
    meta: { inventory: { media: [{ kind: 'image', sourceUrl: 'https://example.test/chart.png' }] } },
  });
  await jobsRepo.updateJob(job.id, { resolvedContext: context });
  return { fixture, jobId: job.id };
}

const bundleFor = async (jobId: string) => loadJobBundle((await jobsRepo.getJob(jobId))!);

describe('describing attached media', () => {
  it('notes the picture and spends nothing before the decision to answer', async () => {
    const { jobId } = await jobWithAPicture();
    await stepResolveMedia(await bundleFor(jobId));

    const job = (await jobsRepo.getJob(jobId))!;
    const meta = job.resolvedContext!.meta as { mediaDeferred?: boolean; mediaContext?: unknown };
    expect(meta.mediaDeferred).toBe(true);
    expect(meta.mediaContext).toBeUndefined();
    const calls = await query<{ n: number }>(`SELECT count(*)::int AS n FROM model_calls WHERE job_id = $1`, [jobId]);
    expect(calls[0]!.n).toBe(0);
  });

  it('describes it once the post is being answered, and only once', async () => {
    const { jobId } = await jobWithAPicture();
    await stepResolveMedia(await bundleFor(jobId));

    const first = await bundleFor(jobId);
    await ensureMediaResolved(first);
    // The step that resolved it sees the result without reloading.
    expect((first.job.resolvedContext!.meta as { mediaContext?: unknown }).mediaContext).toBeDefined();

    const stored = (await jobsRepo.getJob(jobId))!.resolvedContext!.meta as { mediaDeferred?: boolean; mediaContext?: { items?: unknown[] } };
    expect(stored.mediaDeferred).toBe(false);
    expect(stored.mediaContext?.items).toHaveLength(1);

    // A later step finds it done and does nothing.
    const traces = async () =>
      (await query<{ n: number }>(`SELECT count(*)::int AS n FROM trace_events WHERE job_id = $1 AND type = 'MEDIA_RESOLVED'`, [jobId]))[0]!.n;
    const before = await traces();
    await ensureMediaResolved(await bundleFor(jobId));
    expect(await traces()).toBe(before);
  });

  it('describes it straight away in a graph where the decision came first', async () => {
    const { jobId } = await jobWithAPicture();
    const job = (await jobsRepo.getJob(jobId))!;
    await jobsRepo.updateJob(jobId, {
      resolvedContext: { ...job.resolvedContext!, meta: { ...job.resolvedContext!.meta, engagement: { decision: 'ENGAGE' } } },
    });
    await stepResolveMedia(await bundleFor(jobId));
    const meta = (await jobsRepo.getJob(jobId))!.resolvedContext!.meta as { mediaDeferred?: boolean; mediaContext?: unknown };
    expect(meta.mediaDeferred).toBeUndefined();
    expect(meta.mediaContext).toBeDefined();
  });
});
