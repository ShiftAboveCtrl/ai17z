import { describe, expect, it } from 'vitest';
import {
  accounts as accountsRepo,
  actions as actionsRepo,
  engagements as engagementsRepo,
  jobs as jobsRepo,
  query,
} from '@xbam/database';
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

/**
 * A claim somebody else is holding must never be recorded as a completed act.
 *
 * Found on a live installation, and it had cost the account a day of
 * engagement. Twelve `agent_engagements` rows read DONE with the reason
 * "Done. Something else is already doing this.", their record jobs were
 * EXECUTED, and nothing had been sent to X. The daily ceiling counts DONE, so
 * those twelve filled a ceiling of twelve and the next four real candidates
 * were declined for being over it.
 *
 * The executor returns `performed: false, alreadyDone: false` for two entirely
 * different endings: a verified dry run, and a claim it could not get. Only the
 * prose told them apart, so the ending is a value now.
 */
describe('the executor says which ending it reached', () => {
  it('reports a claim another worker holds as IN_PROGRESS, not as success', async () => {
    const fixture = await createFixture();
    await seedCatalogue();
    const job = await newJob(fixture.agentId);
    const key = `inflight-${job.id}`;

    const first = await actionsRepo.claimAction({
      jobId: job.id,
      agentId: fixture.agentId,
      accountId: job.accountId,
      channel: 'mock',
      type: 'LIKE',
      dryRun: false,
      idempotencyKey: key,
      payload: {},
      targetRef: 'a-post',
    });
    expect(first.outcome).toBe('CLAIMED');

    // A second caller on the same key, while the first is still holding it.
    const second = await actionsRepo.claimAction({
      jobId: job.id,
      agentId: fixture.agentId,
      accountId: job.accountId,
      channel: 'mock',
      type: 'LIKE',
      dryRun: false,
      idempotencyKey: key,
      payload: {},
      targetRef: 'a-post',
    });
    expect(second.outcome, 'a held claim is not a free one').toBe('IN_PROGRESS');

    // And the row is still EXECUTING, which is what made the caller guess.
    const rows = await query<{ status: string }>('SELECT status FROM actions WHERE idempotency_key = $1', [key]);
    expect(rows[0]!.status).toBe('EXECUTING');
  });
});

/**
 * An engagement that could not get its claim is not charged an attempt.
 *
 * Each proposal gets three, and `claimDue` holds for two minutes, so counting
 * a claim it never got spent all three inside six minutes. An abandoned action
 * needs ten before it may be retaken, so one orphaned row could defeat a
 * proposal for good, before the recovery that exists for it could run.
 */
describe('a claim it could not get is not an attempt', () => {
  it('gives the attempt back and defers past the stale window', async () => {
    const fixture = await createFixture();
    const account = await accountsRepo.createAccount({
      ownerId: fixture.ownerId,
      channel: 'mock',
      handle: `eng_${Date.now().toString(36).slice(-6)}`,
      displayName: 'Engager',
    });
    const proposed = await engagementsRepo.propose({
      agentId: fixture.agentId,
      accountId: account.id,
      kind: 'LIKE',
      remoteId: `post-${Date.now()}`,
      remoteUrl: null,
      authorHandle: 'someone',
      excerpt: 'worth reading',
      score: 70,
      factors: [],
      confidence: 0.8,
      attentionId: null,
    });
    expect(proposed).not.toBeNull();

    const claimed = (await engagementsRepo.claimDue(5, 120)).find((r) => r.id === proposed!.id)!;
    expect(claimed.attempts, 'claimDue charges one on the way out').toBe(1);

    await engagementsRepo.deferAttempt(proposed!.id, 15 * 60, 'Something else is already doing this.');

    const after = await query<{ attempts: number; next_attempt_at: string; reason: string }>(
      'SELECT attempts, next_attempt_at, reason FROM agent_engagements WHERE id = $1',
      [proposed!.id],
    );
    expect(after[0]!.attempts, 'the attempt it never made is given back').toBe(0);
    expect(after[0]!.reason).toMatch(/already doing this/i);
    // Past the ten minutes an abandoned action needs before it can be retaken.
    const waitMs = new Date(after[0]!.next_attempt_at).getTime() - Date.now();
    expect(waitMs).toBeGreaterThan(10 * 60_000);
  });
});
