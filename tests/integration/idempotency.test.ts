import { describe, expect, it } from 'vitest';
import { actions, jobs as jobsRepo, query } from '@xbam/database';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainJobs } from '../support/runner';

installHarness();

/**
 * The property that makes the whole platform safe to re-run. AI4CZ relied on a
 * flat posted_index.json for this; here it is enforced by unique indexes.
 */
describe('idempotency', () => {
  it('creates one event, one job, and one remote action no matter how often an event arrives', async () => {
    const fixture = await createFixture();
    const event = mockEvent('Same message every time');

    const first = await ingestNormalizedEvent({ accountId: null, onlyAgentId: fixture.agentId, event });
    expect(first.eventCreated).toBe(true);
    expect(first.jobs[0]?.created).toBe(true);

    for (let i = 0; i < 4; i += 1) {
      const repeat = await ingestNormalizedEvent({ accountId: null, onlyAgentId: fixture.agentId, event });
      expect(repeat.eventCreated).toBe(false);
      expect(repeat.jobs[0]?.created).toBe(false);
      expect(repeat.jobs[0]?.job.id).toBe(first.jobs[0]!.job.id);
    }

    await drainJobs();

    const events = await query<{ count: number }>('SELECT count(*)::int AS count FROM events');
    const jobRows = await query<{ count: number }>('SELECT count(*)::int AS count FROM jobs');
    const executed = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM actions WHERE status = 'EXECUTED'`,
    );
    expect(events[0]?.count).toBe(1);
    expect(jobRows[0]?.count).toBe(1);
    expect(executed[0]?.count).toBe(1);
  });

  it('re-running a completed job never sends a second remote action', async () => {
    const fixture = await createFixture();
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('Only once please'),
    });
    await drainJobs();

    const jobId = outcome.jobs[0]!.job.id;
    const before = await actions.listJobActions(jobId);
    expect(before).toHaveLength(1);

    // Force the job back to the execute step, as a botched recovery would.
    await jobsRepo.updateJob(jobId, { status: 'VALIDATED', releaseLock: true });
    await drainJobs();

    const after = await actions.listJobActions(jobId);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before[0]?.id);
    const job = await jobsRepo.requireJob(jobId);
    expect(job.status).toBe('EXECUTED');
  });

  it('suppresses byte-identical text sent to the same target twice', async () => {
    const fixture = await createFixture({ model: 'mock-fixed:Understood.' });
    const conversation = `thread-shared-${Date.now()}`;

    const first = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('First', { remoteConversationId: conversation, remoteMessageId: 'same-target' }),
    });
    await drainJobs();
    expect((await jobsRepo.requireJob(first.jobs[0]!.job.id)).status).toBe('EXECUTED');

    // A different event, same target, and the model returns the same fixed text.
    const second = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('Second', { remoteConversationId: conversation, remoteMessageId: 'same-target' }),
    });
    await drainJobs();

    const job = await jobsRepo.requireJob(second.jobs[0]!.job.id);
    expect(job.status).toBe('EXECUTED');
    // The second job completed, but nothing new was sent.
    const executed = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM actions WHERE status = 'EXECUTED'`,
    );
    expect(executed[0]?.count).toBe(1);
  });
});
