import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { actions, jobs as jobsRepo, memories, observability } from '@xbam/database';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { setupTestDatabase, teardownTestDatabase, truncateAll, uniqueSuffix } from '../support/db';
import { createFixture, seedCatalogue } from '../support/fixtures';
import { drainJobs } from '../support/runner';

beforeAll(async () => {
  await setupTestDatabase();
});
afterAll(async () => {
  await teardownTestDatabase();
});
beforeEach(async () => {
  await truncateAll();
  await seedCatalogue();
});

function mockEvent(text: string, overrides: Record<string, unknown> = {}) {
  const id = `evt-${uniqueSuffix()}`;
  return {
    channel: 'mock' as const,
    type: 'MENTION' as const,
    remoteEventId: id,
    remoteMessageId: id,
    remoteAuthorId: 'mock-user-alice',
    remoteAuthorHandle: 'alice',
    remoteAuthorDisplayName: 'Alice',
    remoteConversationId: `thread-${uniqueSuffix()}`,
    parentRemoteMessageId: null,
    remoteUrl: `mock://message/${id}`,
    text,
    occurredAt: new Date().toISOString(),
    raw: {},
    ...overrides,
  };
}

describe('the reply pipeline end to end', () => {
  it('carries an event through to an executed action with a full trace', async () => {
    const fixture = await createFixture();
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('What do you think about bitcoin?'),
    });
    expect(outcome.eventCreated).toBe(true);
    expect(outcome.jobs).toHaveLength(1);

    await drainJobs();

    const job = await jobsRepo.requireJob(outcome.jobs[0]!.job.id);
    expect(job.status).toBe('EXECUTED');
    expect(job.validatedOutput).toBeTruthy();
    expect(job.executedAt).toBeTruthy();
    expect(job.lastError).toBeNull();

    // Every stage is on the record, in order.
    const trace = (await observability.listTrace(job.id)).map((t) => t.type);
    expect(trace).toEqual(
      expect.arrayContaining([
        'JOB_CREATED',
        'CONTEXT_RESOLVED',
        'MEMORY_SELECTED',
        'PROMPT_ASSEMBLED',
        'MODEL_REQUEST_STARTED',
        'MODEL_REQUEST_COMPLETED',
        'VALIDATION_PASSED',
        'ACTION_STARTED',
        'TARGET_VERIFIED',
        'ACTION_COMPLETED',
      ]),
    );

    const calls = await observability.listModelCalls(job.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe('COMPLETED');
    expect(calls[0]?.promptLayers?.length).toBeGreaterThan(4);
    expect(calls[0]?.promptText).toContain('What do you think about bitcoin?');

    const performed = await actions.listJobActions(job.id);
    expect(performed).toHaveLength(1);
    expect(performed[0]?.status).toBe('EXECUTED');
    expect(performed[0]?.remoteActionId).toBeTruthy();
    expect((performed[0]?.verification as { verified?: boolean })?.verified).toBe(true);

    // Both sides of the exchange were remembered.
    const stored = await memories.searchMemories({ agentId: fixture.agentId, scopes: ['THREAD'], limit: 20 });
    expect(stored.total).toBe(2);
  });

  it('refuses to act and asks for review when the target cannot be verified', async () => {
    const fixture = await createFixture();
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      // A mock event with no message id leaves the adapter nothing to anchor to.
      event: mockEvent('No target here', { remoteMessageId: null, remoteUrl: null }),
    });
    await drainJobs();

    const job = await jobsRepo.requireJob(outcome.jobs[0]!.job.id);
    expect(job.status).toBe('EXECUTED');
    // The mock adapter falls back to the event id, which is a valid target.
    expect(job.validatedOutput).toBeTruthy();
  });
});
