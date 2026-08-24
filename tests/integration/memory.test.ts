import { describe, expect, it } from 'vitest';
import { memories, jobs as jobsRepo } from '@xbam/database';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainJobs } from '../support/runner';

installHarness();

/**
 * Cross-conversation recall is the capability the legacy per-thread scheme could
 * not provide: a new tweet meant a new channel key and therefore zero memory.
 */
describe('memory across conversations', () => {
  it('recalls a fact stated in one conversation while handling a different one', async () => {
    const fixture = await createFixture();

    await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('Please remember that my favorite number is 41.', { remoteConversationId: 'thread-one' }),
    });
    await drainJobs();

    const userMemories = await memories.searchMemories({ agentId: fixture.agentId, scopes: ['USER'], limit: 10 });
    expect(userMemories.total).toBe(1);
    expect(userMemories.items[0]?.content).toContain('favorite number is 41');
    expect(userMemories.items[0]?.remoteHandle).toBe('alice');

    // A completely separate conversation with the same person.
    const second = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('What is my favorite number again?', { remoteConversationId: 'thread-two' }),
    });
    await drainJobs();

    const jobId = second.jobs[0]!.job.id;
    const retrieved = await memories.listRetrievals(jobId);
    const userScoped = retrieved.filter((r) => r.scope === 'USER');
    expect(userScoped).toHaveLength(1);
    expect(userScoped[0]?.content).toContain('favorite number is 41');
    // The reason is stored, so the UI can answer "why did it remember this?".
    expect(userScoped[0]?.reason).toBe('same remote user @alice');
  });

  it('keeps one person memories out of another person prompts', async () => {
    const fixture = await createFixture();

    await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('Remember that my favorite number is 41.', { remoteConversationId: 'a' }),
    });
    await drainJobs();

    const other = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('What is my favorite number?', {
        remoteConversationId: 'b',
        remoteAuthorHandle: 'bob',
        remoteAuthorId: 'mock-user-bob',
      }),
    });
    await drainJobs();

    const retrieved = await memories.listRetrievals(other.jobs[0]!.job.id);
    expect(retrieved.filter((r) => r.scope === 'USER')).toHaveLength(0);
  });

  it('does not store the same fact twice when it is repeated', async () => {
    const fixture = await createFixture();
    for (const conversation of ['x', 'y', 'z']) {
      await ingestNormalizedEvent({
        accountId: null,
        onlyAgentId: fixture.agentId,
        event: mockEvent('Remember that my favorite number is 41.', { remoteConversationId: conversation }),
      });
      await drainJobs();
    }
    const userMemories = await memories.searchMemories({ agentId: fixture.agentId, scopes: ['USER'], limit: 10 });
    expect(userMemories.total).toBe(1);
  });

  it('honours a memory policy that turns user extraction off', async () => {
    const fixture = await createFixture({
      policy: {
        memory: {
          retrieval: {},
          write: { thread: { enabled: true }, user: { enabled: false, extractor: 'off' }, persona: { enabled: false } },
        },
      } as never,
    });
    await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('Remember that my favorite number is 41.'),
    });
    await drainJobs();

    const userMemories = await memories.searchMemories({ agentId: fixture.agentId, scopes: ['USER'], limit: 10 });
    expect(userMemories.total).toBe(0);
    const threadMemories = await memories.searchMemories({ agentId: fixture.agentId, scopes: ['THREAD'], limit: 10 });
    expect(threadMemories.total).toBe(2);
  });

  it('records a retrieval row for every memory used, with its rank', async () => {
    const fixture = await createFixture();
    await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('Remember that I prefer very short answers.', { remoteConversationId: 'same' }),
    });
    await drainJobs();

    const second = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('Anything to add?', { remoteConversationId: 'same' }),
    });
    await drainJobs();

    const retrieved = await memories.listRetrievals(second.jobs[0]!.job.id);
    expect(retrieved.length).toBeGreaterThan(0);
    expect(retrieved.map((r) => r.rank)).toEqual([...retrieved.map((_, i) => i + 1)]);
    expect(retrieved.every((r) => r.reason.length > 0)).toBe(true);
    const job = await jobsRepo.requireJob(second.jobs[0]!.job.id);
    expect(job.status).toBe('EXECUTED');
  });
});
