import { describe, expect, it } from 'vitest';
import { experiments as experimentsRepo, postAnalytics, query } from '@xbam/database';
import { experimentsFor, recordPublished, variantForPost } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * Running an experiment against real posts.
 *
 * The arithmetic is pinned by unit tests, where it belongs. What is proved here
 * is everything that only a database can be wrong about: that one agent cannot
 * have two experiments running at once, that a retried job stays in the arm it
 * was first put in, and that a post which was written but never published takes
 * no part in the comparison.
 *
 * The last of those is the one that would be silently wrong. A join that
 * counted unpublished assignments would report twelve posts in an arm when six
 * of them were drafts somebody rejected, and the verdict would look like a
 * finished experiment.
 */

const armsOf = (view: { reading: { perArm: { key: string; posts: number }[] } }) =>
  Object.fromEntries(view.reading.perArm.map((arm) => [arm.key, arm.posts]));

async function startOne(agentId: string) {
  return experimentsRepo.start({
    agentId,
    hypothesis: 'Do shorter posts get more replies?',
    variantA: { key: 'a', label: 'As usual', instruction: '' },
    variantB: { key: 'b', label: 'Shorter', instruction: 'Keep this post under 120 characters.' },
  });
}

/** A job to hang an assignment off, since assignments reference one. */
async function makeJob(agentId: string, text: string): Promise<{ id: string; idempotencyKey: string }> {
  const { ingestNormalizedEvent } = await import('@xbam/runtime');
  const { NormalizedEvent } = await import('@xbam/shared/contracts');
  const outcome = await ingestNormalizedEvent({
    accountId: null,
    onlyAgentId: agentId,
    event: NormalizedEvent.parse({
      channel: 'x',
      type: 'MENTION',
      remoteEventId: `exp-${uniqueSuffix()}`,
      remoteAuthorHandle: 'somebody',
      text,
    }),
  });
  const job = outcome.jobs[0]!.job;
  return { id: job.id, idempotencyKey: job.idempotencyKey };
}

describe('running an experiment', () => {
  it('allows one at a time, and says so rather than starting a second', async () => {
    // Two at once are one experiment with four arms and no way to attribute
    // anything. The database is what says so, not a screen.
    const fixture = await createFixture();
    await startOne(fixture.agentId);
    await expect(startOne(fixture.agentId)).rejects.toThrow();
  });

  it('lets another start once the first has stopped', async () => {
    const fixture = await createFixture();
    const first = await startOne(fixture.agentId);
    await experimentsRepo.stop(first.id);
    const second = await startOne(fixture.agentId);
    expect(second.id).not.toBe(first.id);
    // The old one is still readable. "We tried that and it made no difference"
    // is most of what this teaches, and it cannot teach it if it disappears.
    expect((await experimentsRepo.listForAgent(fixture.agentId)).map((row) => row.id)).toContain(first.id);
  });

  it('puts a retried job back in the arm it was already in', async () => {
    // A restart between writing a post and publishing it must not move it. If
    // it did, both arms would contain the same post and the difference between
    // them would be noise nobody could see.
    const fixture = await createFixture();
    await startOne(fixture.agentId);
    const job = await makeJob(fixture.agentId, 'something to say');

    const first = await variantForPost({
      agentId: fixture.agentId,
      jobId: job.id,
      jobIdempotencyKey: job.idempotencyKey,
    });
    const again = await variantForPost({
      agentId: fixture.agentId,
      jobId: job.id,
      jobIdempotencyKey: job.idempotencyKey,
    });
    expect(first!.key).toBe(again!.key);
    const rows = await query<{ n: string }>('SELECT count(*) AS n FROM experiment_assignments WHERE job_id = $1', [
      job.id,
    ]);
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('carries the instruction belonging to the arm it chose', async () => {
    const fixture = await createFixture();
    await startOne(fixture.agentId);
    const job = await makeJob(fixture.agentId, 'something to say');
    const variant = await variantForPost({
      agentId: fixture.agentId,
      jobId: job.id,
      jobIdempotencyKey: job.idempotencyKey,
    });
    // The control arm carries nothing, which is what makes it the control.
    expect(variant!.instruction).toBe(variant!.key === 'a' ? '' : 'Keep this post under 120 characters.');
  });

  it('says nothing at all when the agent is running no experiment', async () => {
    const fixture = await createFixture();
    const job = await makeJob(fixture.agentId, 'something to say');
    expect(
      await variantForPost({ agentId: fixture.agentId, jobId: job.id, jobIdempotencyKey: job.idempotencyKey }),
    ).toBeNull();
  });

  it('counts only what was published and measured', async () => {
    const fixture = await createFixture();
    const experiment = await startOne(fixture.agentId);

    // Three posts written. One published and measured, one published and never
    // measured, one never published at all.
    const jobs = await Promise.all([
      makeJob(fixture.agentId, 'one'),
      makeJob(fixture.agentId, 'two'),
      makeJob(fixture.agentId, 'three'),
    ]);
    const variants = [];
    for (const job of jobs) {
      variants.push(
        await variantForPost({ agentId: fixture.agentId, jobId: job.id, jobIdempotencyKey: job.idempotencyKey }),
      );
    }

    const measured = `2200000000000000${Math.floor(Math.random() * 900 + 100)}`;
    const unmeasured = `2200000000000000${Math.floor(Math.random() * 900 + 100)}1`;
    await recordPublished(jobs[0]!.id, measured);
    await recordPublished(jobs[1]!.id, unmeasured);
    await postAnalytics.record({
      agentId: fixture.agentId,
      accountId: null,
      remotePostId: measured,
      source: 'TIMELINE',
      impressions: 1_000,
      likes: 40,
    });

    const [view] = await experimentsFor(fixture.agentId);
    expect(view!.id).toBe(experiment.id);
    // Exactly one post counted: the measured one. The unmeasured published post
    // is named separately rather than counted as a failure, and the unpublished
    // one is not here at all.
    const counted = Object.values(armsOf(view!)).reduce((total, n) => total + n, 0);
    expect(counted).toBe(1);
    expect(view!.unmeasured).toBe(1);
    expect(view!.reading.verdict).toBe('TOO_EARLY');
    expect(view!.reading.detail).toMatch(/more post/);
    expect(variants.every((variant) => variant !== null)).toBe(true);
  });

  it('refuses a verdict until both arms have enough', async () => {
    // Thirty posts in one arm and two in the other is not an answer, and the
    // screen has to say which arm is short rather than showing a number.
    const fixture = await createFixture();
    const experiment = await startOne(fixture.agentId);
    const rows: { key: string; id: string }[] = [];
    for (let i = 0; i < 14; i += 1) {
      const job = await makeJob(fixture.agentId, `post ${i}`);
      const variant = await variantForPost({
        agentId: fixture.agentId,
        jobId: job.id,
        jobIdempotencyKey: job.idempotencyKey,
      });
      const remoteId = `23000000000000000${String(i).padStart(2, '0')}`;
      await recordPublished(job.id, remoteId);
      await postAnalytics.record({
        agentId: fixture.agentId,
        accountId: null,
        remotePostId: remoteId,
        source: 'TIMELINE',
        impressions: 1_000,
        likes: 20,
      });
      rows.push({ key: variant!.key, id: remoteId });
    }

    const [view] = await experimentsFor(fixture.agentId);
    expect(view!.id).toBe(experiment.id);
    // Fourteen posts split two ways is under twelve on at least one side.
    expect(view!.reading.verdict).toBe('TOO_EARLY');
    expect(view!.reading.needed).toBeGreaterThan(0);
    expect(Object.values(armsOf(view!)).reduce((total, n) => total + n, 0)).toBe(14);
  });
});
