import { describe, expect, it } from 'vitest';
import { actions as actionsRepo, jobs as jobsRepo, query } from '@xbam/database';
import { failPermanently, scheduleRetry, sendToReview, waitForInFlight } from '@xbam/jobs';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture, seedCatalogue } from '../support/fixtures';

installHarness();

/**
 * A job that has stopped must not leave an action claiming to be in flight.
 *
 * Found in a live run: a reply failed four times, the job went to review, and
 * the action row sat at EXECUTING afterwards. Two things are wrong with that.
 * A person opening the job sees it parked for them next to an action that says
 * it is running; and the next claim on that idempotency key is told another
 * worker is already on it until the stale window passes.
 */
async function claimOne(agentId: string, jobId: string, accountId: string) {
  const claim = await actionsRepo.claimAction({
    jobId,
    agentId,
    accountId,
    channel: 'mock',
    type: 'REPLY',
    dryRun: false,
    idempotencyKey: `closeout-${jobId}`,
    payload: { text: 'anything', targetRef: 'somewhere' },
    targetRef: 'somewhere',
  });
  expect(claim.outcome).toBe('CLAIMED');
}

async function newJob(agentId: string) {
  const outcome = await ingestNormalizedEvent({
    accountId: null,
    onlyAgentId: agentId,
    event: mockEvent('Something worth a considered answer about token distribution today'),
  });
  return outcome.jobs[0]!.job;
}

async function statusOf(jobId: string): Promise<string | undefined> {
  const [row] = await query<{ status: string }>('SELECT status FROM actions WHERE job_id = $1', [jobId]);
  return row?.status;
}

describe('closing off an action when its job stops', () => {
  it('marks the in-flight action FAILED when the job goes to review', async () => {
    await seedCatalogue();
    const fixture = await createFixture();
    const job = await newJob(fixture.agentId);
    await claimOne(fixture.agentId, job.id, job.accountId!);
    expect(await statusOf(job.id)).toBe('EXECUTING');

    await sendToReview(job, 'composer_empty', 'The composer was still empty after typing, twice.');
    expect(await statusOf(job.id)).toBe('FAILED');
  });

  it('does the same when the job fails permanently', async () => {
    await seedCatalogue();
    const fixture = await createFixture();
    const job = await newJob(fixture.agentId);
    await claimOne(fixture.agentId, job.id, job.accountId!);

    await failPermanently(job, 'source_deleted', 'The source post no longer exists on X.');
    expect(await statusOf(job.id)).toBe('FAILED');
  });

  it('leaves an action that already executed alone', async () => {
    // The record that something was published is what stops it being published
    // again. Closing a job must never overwrite it.
    await seedCatalogue();
    const fixture = await createFixture();
    const job = await newJob(fixture.agentId);
    await claimOne(fixture.agentId, job.id, job.accountId!);
    const [row] = await query<{ id: string }>('SELECT id FROM actions WHERE job_id = $1', [job.id]);
    await actionsRepo.completeAction(row!.id, { status: 'EXECUTED', remoteActionId: '123' });

    await sendToReview(job, 'whatever', 'parked');
    expect(await statusOf(job.id)).toBe('EXECUTED');
  });
});

/**
 * The stale-EXECUTING recovery, which had never once run.
 *
 * `claimAction` retakes an action abandoned by a dead worker, but asked whether
 * it was stale with `updated_at < now() - ...` against a table that had no
 * `updated_at`. Every attempt to reach the branch raised a SQL error instead,
 * and the branch is reached exactly when a reply has failed and is retrying.
 */
describe('retaking an action a dead worker left in flight', () => {
  it('retakes it once it is stale, and says so', async () => {
    await seedCatalogue();
    const fixture = await createFixture();
    const job = await newJob(fixture.agentId);
    const key = `stale-${job.id}`;
    const claim = {
      jobId: job.id,
      agentId: fixture.agentId,
      accountId: job.accountId!,
      channel: 'mock' as const,
      type: 'REPLY' as const,
      dryRun: false,
      idempotencyKey: key,
      payload: { text: 'a reply that was interrupted', targetRef: 'somewhere' },
      targetRef: 'somewhere',
    };
    const first = await actionsRepo.claimAction(claim);
    expect(first.outcome).toBe('CLAIMED');

    // Still warm: a second worker must be told to keep off, not handed the row.
    const second = await actionsRepo.claimAction(claim);
    expect(second.outcome).toBe('IN_PROGRESS');

    // Now make it look abandoned. The trigger keeps updated_at honest, so the
    // test has to disable it to write a past timestamp.
    await query('ALTER TABLE actions DISABLE TRIGGER actions_set_updated_at');
    await query(`UPDATE actions SET updated_at = now() - interval '2 hours' WHERE idempotency_key = $1`, [key]);
    await query('ALTER TABLE actions ENABLE TRIGGER actions_set_updated_at');

    const retaken = await actionsRepo.claimAction(claim);
    expect(retaken.outcome).toBe('CLAIMED');
    // The flag is the difference between recovering an action and sending it
    // twice: it is what makes the caller ask the remote before acting.
    expect(retaken.outcome === 'CLAIMED' && retaken.retakenFromStale).toBe(true);
  });

  it('keeps updated_at current on every write', async () => {
    await seedCatalogue();
    const fixture = await createFixture();
    const job = await newJob(fixture.agentId);
    await claimOne(fixture.agentId, job.id, job.accountId!);
    const [before] = await query<{ updated_at: Date }>('SELECT updated_at FROM actions WHERE job_id = $1', [job.id]);

    await new Promise((r) => setTimeout(r, 50));
    await sendToReview(job, 'whatever', 'parked');
    const [after] = await query<{ updated_at: Date }>('SELECT updated_at FROM actions WHERE job_id = $1', [job.id]);

    expect(new Date(after!.updated_at).getTime()).toBeGreaterThan(new Date(before!.updated_at).getTime());
  });
});

/**
 * A job must not spend its attempts waiting for work that is still going.
 *
 * `claimAction` refuses a job whose action is already EXECUTING -- correctly,
 * because retrying past it is how a reply goes out twice. But that refusal was
 * charged as a failed attempt, and the backoff spends all five in about thirty
 * seconds while an action cannot be retaken for ten minutes. A live reply hit
 * this and reached review reporting "Another worker is already executing this
 * action (gave up after 5 attempts)" without ever having been retried.
 */
describe('waiting for an action that is still in flight', () => {
  it('reschedules without charging an attempt', async () => {
    await seedCatalogue();
    const fixture = await createFixture();
    const job = await newJob(fixture.agentId);
    const before = (await jobsRepo.requireJob(job.id)).attemptCount;

    await waitForInFlight(job, 'VALIDATED', 'Another worker is already executing this action.');

    const after = await jobsRepo.requireJob(job.id);
    expect(after.attemptCount).toBe(before);
    expect(after.status).toBe('VALIDATED');
    // And it waits long enough to be worth waking up for.
    expect(new Date(after.runAt).getTime()).toBeGreaterThan(Date.now() + 30_000);
  });

  it('still charges an attempt for a genuine failure', async () => {
    await seedCatalogue();
    const fixture = await createFixture();
    const job = await newJob(fixture.agentId);
    const before = (await jobsRepo.requireJob(job.id)).attemptCount;

    await scheduleRetry(job, 'VALIDATED', 'The composer was still empty after typing, twice.');

    expect((await jobsRepo.requireJob(job.id)).attemptCount).toBe(before + 1);
  });
});
