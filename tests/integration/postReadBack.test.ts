import { afterEach, describe, expect, it, vi } from 'vitest';
import { accounts, actions, agents, content, jobs, providers, query } from '@xbam/database';
import { mockAdapter } from '@xbam/channels';
import { ingestNormalizedEvent, originatePost } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture, seedCatalogue } from '../support/fixtures';
import { drainJobs, makeDue } from '../support/runner';
import { uniqueSuffix } from '../support/db';

installHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A post is EXECUTED only with evidence it is public.
 *
 * Every account here is `mock`, which runs the real executor and stops at the
 * adapter. The adapter is told what X would have said, so nothing reaches x.com.
 */

const TEXT =
  'Watching two agents argue about gas fees in a thread nobody asked them into is the most 2026 thing I have seen all week.';

async function poster() {
  await seedCatalogue();
  const fixture = await createFixture();
  await agents.updateAgent(fixture.agentId, { state: 'ACTIVE' });
  await providers.setModelConfig({
    agentId: fixture.agentId,
    role: 'primary',
    providerCredentialId: fixture.providerId,
    model: `mock-fixed:${TEXT}`,
    parameters: {},
  });
  const account = await accounts.createAccount({ ownerId: fixture.ownerId, channel: 'mock', handle: `poster_${uniqueSuffix()}`, displayName: 'Poster' });
  await accounts.linkAgentAccount({ agentId: fixture.agentId, accountId: account.id, triggerEventTypes: ['MENTION'], actionType: 'POST', enabled: true });
  const idea = await content.addIdea({ agentId: fixture.agentId, summary: 'Agents arguing with each other in public threads.', score: 90, source: 'deliberation' });
  return { fixture, accountId: account.id, ideaId: idea.id };
}

/** What the X adapter returns when it submitted a post and could not find it afterwards. */
function submittedButNotReadable(real: typeof mockAdapter.executeAction) {
  return async (c: Parameters<typeof mockAdapter.executeAction>[0], request: Parameters<typeof mockAdapter.executeAction>[1]) => {
    const result = await real(c, request);
    return {
      ...result,
      remoteActionId: null,
      remoteActionUrl: null,
      verification: {
        ...result.verification,
        detail: 'Post submitted, but it was not visible on the profile on read-back.',
        evidence: { ...result.verification.evidence, readBackConfirmed: false },
      },
    };
  };
}

async function notificationsFor(agentId: string) {
  return query<{ kind: string; severity: string; dedupe_key: string; action_href: string | null }>(
    `SELECT kind, severity, dedupe_key, action_href FROM notifications WHERE agent_id = $1 AND kind = 'POST_UNCONFIRMED'`,
    [agentId],
  );
}

describe('a post nobody can read back', () => {
  it('is not marked as posted, is not retried, and tells the owner once', async () => {
    const { fixture, accountId, ideaId } = await poster();
    const real = mockAdapter.executeAction.bind(mockAdapter);
    const spy = vi.spyOn(mockAdapter, 'executeAction').mockImplementation(submittedButNotReadable(real));

    const started = await originatePost({ agentId: fixture.agentId, accountId });
    await drainJobs();

    const job = await jobs.requireJob(started.jobId!);
    expect(job.actionType).toBe('POST');
    expect(job.status).toBe('REVIEW_REQUIRED');
    expect(job.errorClass).toBe('REVIEW_REQUIRED');
    expect(job.lastError).toMatch(/not visible on the profile/);
    expect(job.lastError).toMatch(/will not be sent again/);

    const [action] = await actions.listJobActions(job.id);
    expect(action!.status).toBe('FAILED');
    expect(action!.errorClass).toBe('REVIEW_REQUIRED');
    expect(action!.remoteActionId).toBeNull();
    expect(action!.verification).toMatchObject({ postOutcome: 'AMBIGUOUS' });
    // No signature means nothing else treats this text as already sent, and the
    // idea it came from is not spent on a post nobody has seen.
    const [signed] = await query<{ content_signature: string | null }>(`SELECT content_signature FROM actions WHERE id = $1`, [action!.id]);
    expect(signed!.content_signature).toBeNull();
    const [idea] = await query<{ status: string }>(`SELECT status FROM content_ideas WHERE id = $1`, [ideaId]);
    expect(idea!.status).not.toBe('used');

    // Waiting does not send it again: a review is not claimable.
    await makeDue(job.id);
    await drainJobs();
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await jobs.requireJob(job.id)).status).toBe('REVIEW_REQUIRED');

    const told = await notificationsFor(fixture.agentId);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ severity: 'WARNING', action_href: `/jobs/${job.id}` });
  });

  it('is still held, not resent, when the owner approves it and the remote cannot prove it is absent', async () => {
    const { fixture, accountId } = await poster();
    const real = mockAdapter.executeAction.bind(mockAdapter);
    const spy = vi.spyOn(mockAdapter, 'executeAction').mockImplementation(submittedButNotReadable(real));
    const adapter = mockAdapter as { wasAlreadyDone?: unknown };
    adapter.wasAlreadyDone = async () => ({ done: false, remoteActionId: null, remoteActionUrl: null, detail: 'Nothing seen.' });
    try {
      const started = await originatePost({ agentId: fixture.agentId, accountId });
      await drainJobs();
      const jobId = started.jobId!;
      expect((await jobs.requireJob(jobId)).status).toBe('REVIEW_REQUIRED');

      // What approving a held job does: put it back on the execute node.
      await jobs.updateJob(jobId, { status: 'VALIDATED', currentNodeKey: 'execute', releaseLock: true });
      await drainJobs();

      const job = await jobs.requireJob(jobId);
      expect(job.status).toBe('REVIEW_REQUIRED');
      expect(job.lastError).toMatch(/may or may not have reached the account/);
      expect(spy, 'the second pass must not send').toHaveBeenCalledTimes(1);
    } finally {
      delete adapter.wasAlreadyDone;
    }
  });

  it('is recorded as posted when the remote then says it is there', async () => {
    const { fixture, accountId } = await poster();
    const real = mockAdapter.executeAction.bind(mockAdapter);
    const spy = vi.spyOn(mockAdapter, 'executeAction').mockImplementation(submittedButNotReadable(real));
    const adapter = mockAdapter as { wasAlreadyDone?: unknown };
    adapter.wasAlreadyDone = async () => ({
      done: true,
      remoteActionId: 'status-4242',
      remoteActionUrl: 'https://x.invalid/status/4242',
      detail: 'This was already sent as status-4242.',
    });
    try {
      const started = await originatePost({ agentId: fixture.agentId, accountId });
      await drainJobs();
      const jobId = started.jobId!;
      await jobs.updateJob(jobId, { status: 'VALIDATED', currentNodeKey: 'execute', releaseLock: true });
      await drainJobs();

      expect((await jobs.requireJob(jobId)).status).toBe('EXECUTED');
      const [action] = await actions.listJobActions(jobId);
      expect(action).toMatchObject({ status: 'EXECUTED', remoteActionId: 'status-4242' });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      delete adapter.wasAlreadyDone;
    }
  });
});

describe('a post that was read back', () => {
  it('is EXECUTED with the remote id, and nobody is told anything is wrong', async () => {
    const { fixture, accountId } = await poster();
    const real = mockAdapter.executeAction.bind(mockAdapter);
    vi.spyOn(mockAdapter, 'executeAction').mockImplementation(async (c, request) => {
      const result = await real(c, request);
      return {
        ...result,
        remoteActionId: 'status-9001',
        remoteActionUrl: 'https://x.invalid/status/9001',
        verification: {
          ...result.verification,
          evidence: { ...result.verification.evidence, readBackConfirmed: true, composerClosed: true, postStatusId: 'status-9001' },
        },
      };
    });

    const started = await originatePost({ agentId: fixture.agentId, accountId });
    await drainJobs();

    const job = await jobs.requireJob(started.jobId!);
    expect(job.status).toBe('EXECUTED');
    const [action] = await actions.listJobActions(job.id);
    expect(action).toMatchObject({ status: 'EXECUTED', remoteActionId: 'status-9001', remoteActionUrl: 'https://x.invalid/status/9001' });
    const [signed] = await query<{ content_signature: string | null }>(`SELECT content_signature FROM actions WHERE id = $1`, [action!.id]);
    expect(signed!.content_signature).not.toBeNull();
    expect(await notificationsFor(fixture.agentId)).toHaveLength(0);
  });
});

describe('a reply is unchanged', () => {
  it('is still EXECUTED when its result carries no id, because only a post needs the proof', async () => {
    const fixture = await createFixture();
    const real = mockAdapter.executeAction.bind(mockAdapter);
    vi.spyOn(mockAdapter, 'executeAction').mockImplementation(submittedButNotReadable(real));

    const outcome = await ingestNormalizedEvent({ accountId: null, onlyAgentId: fixture.agentId, event: mockEvent('A question about gas fees?') });
    await drainJobs();

    const job = await jobs.requireJob(outcome.jobs[0]!.job.id);
    expect(job.actionType).toBe('REPLY');
    expect(job.status).toBe('EXECUTED');
    expect(await notificationsFor(fixture.agentId)).toHaveLength(0);
  });
});
