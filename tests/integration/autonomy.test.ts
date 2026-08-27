import { describe, expect, it } from 'vitest';
import { events as eventsRepo, jobs as jobsRepo, query } from '@xbam/database';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainJobs } from '../support/runner';

installHarness();

const withMode = (mode: string) => ({ policy: { automation: { mode, dryRunDefault: false } } as never });

/**
 * Autonomy is the owner saying what an agent may do on its own. Each mode has to
 * mean something specific and enforceable, not be a label on a dropdown.
 */
describe('autonomy modes', () => {
  it('OFF records nothing and creates no job, even on a manual trigger', async () => {
    const fixture = await createFixture(withMode('OFF'));
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('nobody is home'),
    });
    expect(outcome.jobs).toHaveLength(0);
    expect(outcome.skipped[0]?.reason).toBe('automation mode is OFF');
  });

  it('MONITOR_ONLY records the event but creates no job and generates nothing', async () => {
    const fixture = await createFixture(withMode('MONITOR_ONLY'));
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      event: mockEvent('seen but not answered'),
      // No onlyAgentId: this is the automatic path, which is what the mode governs.
      onlyAgentId: undefined,
    });
    // The event itself is on the record either way.
    expect(outcome.eventCreated).toBe(true);
    expect(await eventsRepo.getEvent(outcome.eventId)).not.toBeNull();
    expect(outcome.jobs).toHaveLength(0);

    await drainJobs();
    const calls = await query<{ count: number }>('SELECT count(*)::int AS count FROM model_calls');
    expect(calls[0]?.count).toBe(0);
  });

  it('MONITOR_ONLY still yields to an explicit manual trigger', async () => {
    const fixture = await createFixture(withMode('MONITOR_ONLY'));
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('a person asked for this'),
    });
    expect(outcome.jobs).toHaveLength(1);
  });

  it('MANUAL_ONLY creates nothing automatically', async () => {
    const fixture = await createFixture(withMode('MANUAL_ONLY'));
    const outcome = await ingestNormalizedEvent({ accountId: null, event: mockEvent('automatic') });
    expect(outcome.jobs).toHaveLength(0);
  });

  it('AUTONOMOUS runs the whole pipeline through to an action', async () => {
    const fixture = await createFixture(withMode('AUTONOMOUS'));
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('go ahead'),
    });
    await drainJobs();
    expect((await jobsRepo.requireJob(outcome.jobs[0]!.job.id)).status).toBe('EXECUTED');
  });

  it('REVIEW_BEFORE_ACTION stops at the approval gate', async () => {
    const fixture = await createFixture(withMode('REVIEW_BEFORE_ACTION'));
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('ask me first'),
    });
    await drainJobs();
    expect((await jobsRepo.requireJob(outcome.jobs[0]!.job.id)).status).toBe('WAITING_FOR_APPROVAL');
  });
});
