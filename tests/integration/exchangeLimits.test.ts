import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '@xbam/shared/contracts';
import { actions as actionsRepo, jobs as jobsRepo, observability } from '@xbam/database';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainJobs } from '../support/runner';

installHarness();

/**
 * The limits on one exchange, through the whole pipeline.
 *
 * Every message here arrives in a conversation of its own, the way a live
 * agent's replies from @grok did: a mention read off a search carries no
 * ancestry, and the thread it is bound to is whatever X rendered at the top.
 * The only thing tying the turns together is the agent's own published
 * replies, which is what these prove the limit is counted from.
 */

async function reply(agentId: string, text: string, author: string, parentRemoteMessageId: string | null) {
  const outcome = await ingestNormalizedEvent({
    accountId: null,
    onlyAgentId: agentId,
    event: mockEvent(text, {
      remoteAuthorHandle: author,
      remoteAuthorId: `mock-user-${author}`,
      parentRemoteMessageId,
    }),
  });
  await drainJobs();
  const job = await jobsRepo.requireJob(outcome.jobs[0]!.job.id);
  const sent = (await actionsRepo.listJobActions(job.id)).find((a) => a.status === 'EXECUTED' && !a.dryRun);
  const decided = (await observability.listTrace(job.id)).find((t) => t.type === 'ENGAGEMENT_DECIDED');
  return { job, remoteId: sent?.remoteActionId ?? null, decided: decided?.message ?? '' };
}

describe('how much the agent says in one exchange', () => {
  it('stops at the thread limit, counted from its own published replies', async () => {
    const fixture = await createFixture({
      policy: {
        engagement: { ...DEFAULT_POLICY.engagement, strategy: 'ALWAYS_REPLY', maxRepliesPerPersonPerHour: 50, maxRepliesPerThread: 2 },
      },
    });

    const one = await reply(fixture.agentId, 'What do you think about the unlock schedule?', 'carol', null);
    expect(one.job.status).toBe('EXECUTED');
    const two = await reply(fixture.agentId, 'And the second order effects on liquidity?', 'carol', one.remoteId);
    expect(two.job.status).toBe('EXECUTED');
    const three = await reply(fixture.agentId, 'What about the vesting cliff after that?', 'carol', two.remoteId);

    expect(three.job.status).toBe('CANCELLED');
    expect(three.decided).toMatch(/Already spoke 2 times in this back-and-forth/);
  });

  it('answers an automated account once and then stops', async () => {
    const fixture = await createFixture({
      policy: {
        engagement: { ...DEFAULT_POLICY.engagement, strategy: 'ALWAYS_REPLY', maxRepliesPerPersonPerHour: 50, automatedHandles: ['replybot'] },
      },
    });

    const first = await reply(fixture.agentId, 'What do you make of the new fee schedule?', 'replybot', null);
    expect(first.job.status).toBe('EXECUTED');
    const second = await reply(fixture.agentId, 'Exactly. The fee schedule tells the whole story, right?', 'replybot', first.remoteId);

    expect(second.job.status).toBe('CANCELLED');
    expect(second.decided).toMatch(/automated account/);
  });

  it('stops at the hourly limit for one person even when told to answer everything', async () => {
    const fixture = await createFixture({
      policy: { engagement: { ...DEFAULT_POLICY.engagement, strategy: 'ALWAYS_REPLY', maxRepliesPerPersonPerHour: 1 } },
    });

    const first = await reply(fixture.agentId, 'What do you think about the unlock schedule?', 'dave', null);
    expect(first.job.status).toBe('EXECUTED');
    const second = await reply(fixture.agentId, 'Separate question: which chain is it on?', 'dave', null);

    expect(second.job.status).toBe('CANCELLED');
    expect(second.decided).toMatch(/limit for one person/);
  });

  it('counts an unbroken chain and nothing else', async () => {
    const fixture = await createFixture({
      policy: { engagement: { ...DEFAULT_POLICY.engagement, strategy: 'ALWAYS_REPLY', maxRepliesPerPersonPerHour: 50 } },
    });

    const one = await reply(fixture.agentId, 'What do you think about the unlock schedule?', 'erin', null);
    const two = await reply(fixture.agentId, 'And the vesting cliff?', 'erin', one.remoteId);

    expect(await actionsRepo.publishedReplyChain(fixture.agentId, two.remoteId)).toBe(2);
    expect(await actionsRepo.publishedReplyChain(fixture.agentId, one.remoteId)).toBe(1);
    expect(await actionsRepo.publishedReplyChain(fixture.agentId, 'somebody-elses-post')).toBe(0);
    expect(await actionsRepo.publishedReplyChain(fixture.agentId, null)).toBe(0);
  });
});
