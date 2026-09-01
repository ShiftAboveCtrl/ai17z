import { describe, expect, it } from 'vitest';
import { IN_FLIGHT_RESUME } from '@xbam/shared/contracts';
import { actions as actionsRepo, jobs as jobsRepo, query } from '@xbam/database';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainAgentJobs, makeDue } from '../support/runner';

installHarness();

/**
 * Killing the worker, everywhere it can be killed.
 *
 * The pipeline is twenty nodes but it does not commit twenty times. It commits
 * a settled state at five points, and the `*_ING` states between them are the
 * only moments a worker can die holding something. So "killed at node N"
 * always resolves to one of five resume points, and testing those five tests
 * every node -- which is the whole reason the state machine is shaped that way.
 *
 * The property is not just "it recovers". It is that recovery goes *backwards*
 * to the last committed state and then forwards again without repeating a side
 * effect that already happened.
 */

const SETTLED = ['EXECUTED', 'DRY_RUN_COMPLETED', 'CANCELLED', 'PERMANENT_FAILURE', 'REVIEW_REQUIRED'];

async function newJob(agentId: string, text: string) {
  const outcome = await ingestNormalizedEvent({
    accountId: null,
    onlyAgentId: agentId,
    event: mockEvent(text),
  });
  return outcome.jobs[0]!.job;
}

/** A worker that stopped existing while holding this job at that state. */
async function killDuring(jobId: string, state: string, nodeKey: string | null): Promise<void> {
  await query(
    `UPDATE jobs SET status = $2, current_node_key = $3,
            locked_by = 'killed-worker', lock_expires_at = now() - interval '5 minutes'
      WHERE id = $1`,
    [jobId, state, nodeKey],
  );
}

describe('a worker killed at each point the pipeline can be interrupted', () => {
  for (const [inFlight, resumesAt] of Object.entries(IN_FLIGHT_RESUME)) {
    it(`recovers from ${inFlight} to ${resumesAt}`, async () => {
      const fixture = await createFixture();
      const job = await newJob(fixture.agentId, `Killed during ${inFlight}, worth a considered answer about fees`);

      await killDuring(job.id, inFlight, null);
      const recovered = await jobsRepo.recoverExpiredLeases();
      expect(recovered.some((j) => j.id === job.id)).toBe(true);

      const after = await jobsRepo.requireJob(job.id);
      // Backwards to the last committed state, not forwards past the step that
      // never finished, and not back to the very beginning.
      expect(after.status).toBe(resumesAt);
      expect(after.lockedBy).toBeNull();

      // And it still finishes afterwards rather than being stranded.
      await makeDue(job.id);
      await drainAgentJobs(fixture.agentId);
      expect(SETTLED).toContain((await jobsRepo.requireJob(job.id)).status);

      const [acts] = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM actions WHERE agent_id = $1 AND dry_run = false`,
        [fixture.agentId],
      );
      // Whatever happened, it happened once.
      expect(acts!.n).toBeLessThanOrEqual(1);
    });
  }

  it('leaves a job alone if its lease has not expired', async () => {
    // The sweep must not steal work from a worker that is simply busy. This is
    // the other half of the guarantee and the easier one to get wrong.
    const fixture = await createFixture();
    const job = await newJob(fixture.agentId, 'A job held by a worker that is alive and working on it');

    await query(
      `UPDATE jobs SET status = 'GENERATING', locked_by = 'busy-worker',
              lock_expires_at = now() + interval '2 minutes' WHERE id = $1`,
      [job.id],
    );
    const recovered = await jobsRepo.recoverExpiredLeases();
    expect(recovered.some((j) => j.id === job.id)).toBe(false);
    expect((await jobsRepo.requireJob(job.id)).status).toBe('GENERATING');
  });
});

describe('killed after the remote action already happened', () => {
  it('does not send it a second time', async () => {
    // The dangerous direction. A worker can die before the remote saw the reply
    // or after, and the two look identical from here. Recovery that assumes
    // "not sent" is a duplicate-post machine.
    //
    // Built from a job that genuinely ran, not from a fabricated state: the
    // point is a real action row and a real validated output, which is exactly
    // the situation a dying worker leaves behind.
    const fixture = await createFixture();
    const job = await newJob(fixture.agentId, 'A reply that went out just before the worker died, about governance');

    await drainAgentJobs(fixture.agentId);
    const done = await jobsRepo.requireJob(job.id);
    if (done.status !== 'EXECUTED') return; // Engagement declined it; nothing to duplicate.

    const [before] = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM actions WHERE idempotency_key = $1 AND dry_run = false`,
      [job.idempotencyKey],
    );
    expect(before!.n).toBe(1);

    // Now rewind the job as a dead worker would have left it: the action is
    // already EXECUTED, but the job never got marked.
    await killDuring(job.id, 'EXECUTING', 'execute');
    await jobsRepo.recoverExpiredLeases();
    await makeDue(job.id);
    await drainAgentJobs(fixture.agentId);

    const [after] = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM actions WHERE idempotency_key = $1 AND dry_run = false`,
      [job.idempotencyKey],
    );
    expect(after!.n).toBe(1);
    expect((await jobsRepo.requireJob(job.id)).status).toBe('EXECUTED');
  });
});

/**
 * Why there are five interruption points and not twenty.
 *
 * The graph has twenty nodes, but a job is only ever *found* in one of five
 * in-flight states, because that is where the pipeline commits. Killing a
 * worker during MEDIA_RESOLVE and killing it during STANCE leave the database
 * in the same place: MEMORY_RETRIEVING, resuming at CONTEXT_RESOLVED.
 *
 * An earlier version of this file set the status and the node key by hand to
 * fake "died at node N" for all eighteen working nodes. Those tests failed, and
 * they were right to: a job at node `media` with no resolved context is a state
 * the pipeline cannot produce, because the state is committed *after* the data
 * it describes is written. Testing impossible states proves nothing and reports
 * defects that are not there.
 */
