import { describe, expect, it } from 'vitest';
import { actions as actionsRepo, jobs as jobsRepo, query } from '@xbam/database';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainAgentJobs, makeDue } from '../support/runner';

installHarness();

/**
 * Deliberately no truncation between these tests.
 *
 * The usual harness empties every table before each test, which needs an
 * AccessExclusiveLock on all of them at once. That collides with the writes the
 * pipeline is still finishing from the test before -- and the collision surfaces
 * as a foreign-key error or a deadlock inside whichever test is running next,
 * which reads exactly like a concurrency bug in the code under test. Chasing
 * that is how an afternoon disappears.
 *
 * Every test here makes its own owner and agent, so the tests cannot see each
 * other's rows anyway. Assertions are scoped by agent for the same reason.
 *
 * Draining is scoped by agent because `claimJobs` is global, as production
 * wants it: a test that drains the whole queue also drains every other test's
 * work, then fails somewhere unrelated when that work refers to rows it never
 * created. Claiming is still contended -- several racing is the point.
 */

/**
 * What has to hold when everything happens at once.
 *
 * The guarantees this system makes are carried by unique indexes and by a
 * handful of claim statements, and both are only interesting under contention.
 * A duplicate-suppression test that ingests twice in sequence proves almost
 * nothing: the case that actually happens is several radar monitors surfacing
 * one post in the same second, or two workers waking on the same job.
 *
 * Everything here is deliberately concurrent, and nothing mocks the database,
 * because the database is where the guarantee lives.
 */

const times = (n: number) => Array.from({ length: n }, (_, i) => i);

const SETTLED = ['EXECUTED', 'DRY_RUN_COMPLETED', 'CANCELLED', 'PERMANENT_FAILURE', 'REVIEW_REQUIRED'];

describe('the same post arriving from several places at once', () => {
  it('records one event and queues one job, however many monitors saw it', async () => {
    const fixture = await createFixture();
    const event = mockEvent('A post several monitors will all surface at the same moment, worth answering');

    // Twelve simultaneous ingests. In production these are radar monitors, a
    // mentions scrape and a notifications scrape racing each other.
    const outcomes = await Promise.allSettled(
      times(12).map(() => ingestNormalizedEvent({ accountId: null, onlyAgentId: fixture.agentId, event })),
    );
    const ok = outcomes.filter((o) => o.status === 'fulfilled') as PromiseFulfilledResult<{
      eventCreated: boolean;
    }>[];
    expect(ok.length).toBeGreaterThan(0);

    const [events] = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM events WHERE remote_event_id = $1',
      [event.remoteEventId],
    );
    expect(events!.n).toBe(1);

    const jobs = await jobsRepo.listJobs({ agentId: fixture.agentId, limit: 50 });
    expect(jobs.items).toHaveLength(1);

    // And exactly one caller is told it created the event. Two would mean two
    // callers each believing they were first.
    expect(ok.filter((o) => o.value.eventCreated)).toHaveLength(1);
  });

  it('produces at most one real action even when the pipeline runs twice over', async () => {
    const fixture = await createFixture();
    const event = mockEvent('Another post that monitors surface together, worth a real answer about governance');
    await ingestNormalizedEvent({ accountId: null, onlyAgentId: fixture.agentId, event });

    // allSettled, not all: `Promise.all` rejects on the first failure and leaves
    // its siblings running, so a failed assertion here would let a half-finished
    // drain write into the next test while that test truncates. That is how one
    // real failure turns into four unrelated foreign-key errors.
    await Promise.allSettled([drainAgentJobs(fixture.agentId), drainAgentJobs(fixture.agentId)]);

    const [acts] = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM actions WHERE dry_run = false AND agent_id = $1',
      [fixture.agentId],
    );
    expect(acts!.n).toBeLessThanOrEqual(1);
  });
});

describe('several workers reaching for one action', () => {
  const claimFor = (agentId: string, job: { id: string; accountId: string | null }, key: string) => ({
    jobId: job.id,
    agentId,
    accountId: job.accountId!,
    channel: 'mock' as const,
    type: 'REPLY' as const,
    dryRun: false,
    idempotencyKey: key,
    payload: { text: 'one reply', targetRef: 'somewhere' },
    targetRef: 'somewhere',
  });

  it('hands it to exactly one and refuses the rest', async () => {
    const fixture = await createFixture();
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('Something worth answering at length about token distribution and incentives'),
    });
    const job = outcome.jobs[0]!.job;
    const claim = claimFor(fixture.agentId, job, `race-${job.id}`);

    const settled = await Promise.allSettled(times(10).map(() => actionsRepo.claimAction(claim)));
    const rejected = settled.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    // A claim must resolve to a verdict. Throwing a raw constraint violation at
    // the caller is the racing worker being told nothing useful.
    expect(rejected.map((r) => String(r.reason).slice(0, 120))).toEqual([]);
    const results = settled
      .filter((r) => r.status === 'fulfilled')
      .map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof actionsRepo.claimAction>>>).value);

    // Exactly one may act. The rest are refused rather than queued behind it:
    // queueing is how the same reply goes out ten times.
    expect(results.filter((r) => r.outcome === 'CLAIMED')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'IN_PROGRESS')).toHaveLength(9);

    const [rows] = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM actions WHERE idempotency_key = $1',
      [claim.idempotencyKey],
    );
    expect(rows!.n).toBe(1);
  });

  it('refuses every later claim once the action has executed', async () => {
    const fixture = await createFixture();
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('A post whose reply has already gone out to the remote service entirely'),
    });
    const job = outcome.jobs[0]!.job;
    const claim = claimFor(fixture.agentId, job, `done-${job.id}`);

    const first = await actionsRepo.claimAction(claim);
    expect(first.outcome).toBe('CLAIMED');
    if (first.outcome !== 'CLAIMED') return;
    await actionsRepo.completeAction(first.action.id, { status: 'EXECUTED', remoteActionId: 'remote-1' });

    const later = await Promise.all(times(6).map(() => actionsRepo.claimAction(claim)));

    expect(later.every((r) => r.outcome === 'ALREADY_EXECUTED')).toBe(true);
  });
});

describe('a queue under load', () => {
  it('settles every job exactly once with four workers draining together', async () => {
    const fixture = await createFixture();

    const count = 25;
    for (const i of times(count)) {
      await ingestNormalizedEvent({
        accountId: null,
        onlyAgentId: fixture.agentId,
        event: mockEvent(`Message ${i}, long enough to be worth a considered answer about governance and fees`),
      });
    }

    // Four workers on one queue, which is where a claim that is not atomic
    // shows up as two workers running the same job.
    //
    // Drained until quiet rather than a fixed number of rounds: a job that took
    // a retryable failure is waiting on a backoff and is not claimable yet, so
    // stopping early would call a job that is working its way through "stuck".
    for (let pass = 0; pass < 6; pass += 1) {
      await Promise.allSettled(times(4).map(() => drainAgentJobs(fixture.agentId, 20)));
      const waiting = await jobsRepo.listJobs({ agentId: fixture.agentId, limit: 100 });
      const unsettled = waiting.items.filter((j) => !SETTLED.includes(j.status));
      if (unsettled.length === 0) break;
      for (const job of unsettled) await makeDue(job.id);
    }

    const jobs = await jobsRepo.listJobs({ agentId: fixture.agentId, limit: 100 });
    expect(jobs.items).toHaveLength(count);
    const stuck = jobs.items
      .filter((j) => !SETTLED.includes(j.status))
      .map((j) => `${j.status}: ${j.lastError ?? 'no error recorded'}`);
    expect(stuck).toEqual([]);

    // No job produced two real actions, whichever worker got there first.
    const dupes = await query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM actions WHERE dry_run = false AND agent_id = $1
        GROUP BY idempotency_key HAVING count(*) > 1`,
      [fixture.agentId],
    );
    expect(dupes).toHaveLength(0);
  });
});

describe('a worker that dies holding a job', () => {
  it('returns the job and lets another worker finish it', async () => {
    const fixture = await createFixture();
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('A message a worker starts answering and then dies halfway through, mid-step'),
    });
    const jobId = outcome.jobs[0]!.job.id;

    // A worker that stops existing while holding the job mid-step. Only the
    // *_ING states are held under a lease -- a settled state is not in flight
    // and there is nothing to resume -- so the job has to be in one for the
    // sweep to have anything to do.
    await query(
      `UPDATE jobs SET status = 'GENERATING', lock_expires_at = now() - interval '5 minutes',
              locked_by = 'doomed-worker' WHERE id = $1`,
      [jobId],
    );

    const recovered = await jobsRepo.recoverExpiredLeases();
    expect(recovered.some((j) => j.id === jobId)).toBe(true);


    const returned = await jobsRepo.requireJob(jobId);
    expect(returned.lockedBy).toBeNull();
    // Returned to the state *before* the step it died in, not the step itself:
    // that is what makes a restart resume rather than restart.
    expect(returned.status).toBe('MEMORY_RESOLVED');

    // And it runs to completion afterwards rather than being stuck forever.
    await makeDue(jobId);
    await drainAgentJobs(fixture.agentId);
    expect(SETTLED).toContain((await jobsRepo.requireJob(jobId)).status);
  });
});
