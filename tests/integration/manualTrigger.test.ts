import { describe, expect, it } from 'vitest';
import { accounts as accountsRepo, jobs as jobsRepo } from '@xbam/database';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * A manual trigger decides *which* event to act on, never *what* to do about it.
 *
 * The two halves were conflated. Asking an agent to act on a post exempted it
 * from the freshness ceiling and the retroactive guard -- correct, that is what
 * a person asking is for -- and then hard-coded the action as REPLY. So an
 * agent an owner had configured to LIKE replied to the post instead: the wrong
 * public action, under the agent's name, and not one anybody chose.
 *
 * The capability check inherited it. It asked whether REPLY was granted rather
 * than the action that would actually run, so an agent granted LIKE and not
 * REPLY was refused work it was permitted to do, and an agent granted REPLY but
 * configured never to use it was waved through.
 *
 * Found by running a live LIKE on a real account and watching a reply go out.
 */
async function agentWithAction(action: 'REPLY' | 'LIKE' | 'REPOST' | 'POST') {
  const fixture = await createFixture();
  const account = await accountsRepo.createAccount({
    ownerId: fixture.ownerId,
    channel: 'x',
    handle: `manual_${uniqueSuffix()}`,
  });
  await accountsRepo.linkAgentAccount({
    agentId: fixture.agentId,
    accountId: account.id,
    actionType: action,
  });
  return { fixture, account };
}

function post(handle: string, overrides: Record<string, unknown> = {}) {
  const id = `manual-${uniqueSuffix()}`;
  return {
    channel: 'x' as const,
    type: 'MENTION' as const,
    remoteEventId: id,
    remoteMessageId: id,
    remoteAuthorId: 'someone',
    remoteAuthorHandle: 'someone',
    remoteAuthorDisplayName: 'Someone',
    remoteConversationId: id,
    parentRemoteMessageId: null,
    remoteUrl: `https://x.com/someone/status/${id}`,
    text: `@${handle} what do you make of this?`,
    occurredAt: new Date().toISOString(),
    raw: {},
    ...overrides,
  };
}

describe('a manual trigger performs the action the agent is configured for', () => {
  for (const action of ['LIKE', 'REPOST', 'POST'] as const) {
    it(`queues ${action} for an agent set to ${action}`, async () => {
      const { fixture, account } = await agentWithAction(action);

      const outcome = await ingestNormalizedEvent({
        accountId: account.id,
        onlyAgentId: fixture.agentId,
        event: post(account.handle),
      });

      expect(outcome.jobs, JSON.stringify(outcome.skipped)).toHaveLength(1);
      const job = await jobsRepo.getJob(outcome.jobs[0]!.job.id);
      // The assertion that would have caught a reply going out where a like was
      // configured.
      expect(job!.actionType).toBe(action);
    });
  }

  it('still queues REPLY for an agent set to REPLY', async () => {
    const { fixture, account } = await agentWithAction('REPLY');

    const outcome = await ingestNormalizedEvent({
      accountId: account.id,
      onlyAgentId: fixture.agentId,
      event: post(account.handle),
    });

    expect(outcome.jobs).toHaveLength(1);
    expect((await jobsRepo.getJob(outcome.jobs[0]!.job.id))!.actionType).toBe('REPLY');
  });

  it('still exempts a manual trigger from the freshness ceiling', async () => {
    // The half that was right, pinned so fixing the action does not cost it.
    // Ordinary ingest refuses anything past the freshness window; a person
    // asking on purpose is the documented exception.
    const { fixture, account } = await agentWithAction('LIKE');
    const old = post(account.handle, {
      occurredAt: new Date(Date.now() - 40 * 3_600_000).toISOString(),
    });

    const manual = await ingestNormalizedEvent({
      accountId: account.id,
      onlyAgentId: fixture.agentId,
      event: old,
    });
    expect(manual.jobs).toHaveLength(1);

    const ordinary = await ingestNormalizedEvent({
      accountId: account.id,
      event: post(account.handle, { occurredAt: old.occurredAt }),
    });
    expect(ordinary.jobs).toHaveLength(0);
    expect(ordinary.skipped[0]?.reason).toMatch(/freshness/i);
  });
});
