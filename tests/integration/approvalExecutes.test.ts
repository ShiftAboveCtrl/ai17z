import { describe, expect, it } from 'vitest';
import { PolicyConfig } from '@xbam/shared/contracts';
import { actions as actionsRepo, jobs as jobsRepo, query } from '@xbam/database';
import { approveJob, ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * Approving something has to make it happen.
 *
 * Reported from a live installation as "I approve things and nothing really
 * happens", and the owner was right. Approval sets the job back to VALIDATED
 * and requeues it, and the pipeline then resumes at the node *after* that --
 * which is the voice and quality pair that sent it to review in the first
 * place. The report has not changed, so the same verdict fires again and the
 * job is back in REVIEW_REQUIRED before the owner's click has finished.
 *
 * Measured: three jobs approved at 19:19:24, 19:22:38 and 19:23:15 were back
 * in review at +4s, +1s and +1s, two of them saying "does not sound like this
 * agent". Nothing was broken in the approval path itself, which is why it was
 * hard to see: the work really was requeued, really was claimed, and really
 * was refused by the platform overruling the person who had just decided.
 *
 * The rule restored here is the one already written down for the approve
 * path: somebody who approves has made a judgement the platform should
 * respect, short of letting through something policy forbids outright.
 */

async function approvableJob(overrides: Parameters<typeof createFixture>[0] = {}) {
  const fixture = await createFixture(overrides);
  const outcome = await ingestNormalizedEvent({
    accountId: null,
    onlyAgentId: fixture.agentId,
    event: mockEvent('what do you make of this?', { remoteAuthorHandle: 'a_real_person' }),
  });
  const jobId = outcome.jobs[0]!.job.id;

  // Held for a person, with a draft, exactly as the review path leaves it.
  await query(
    `UPDATE jobs SET status='REVIEW_REQUIRED', generated_output=$2, validated_output=$2,
            last_error='Does not sound like this agent — 158 characters, and this agent writes shorter.'
      WHERE id=$1`,
    [jobId, 'A short answer that the quality gate happens to dislike.'],
  );
  return { ...fixture, jobId };
}

describe('an approved job does not bounce straight back to review', () => {
  it('leaves review and becomes runnable', async () => {
    const { jobId, ownerId } = await approvableJob();

    await approveJob({ jobId, decidedBy: ownerId });

    const job = await jobsRepo.requireJob(jobId);
    expect(job.status, 'approval must take it out of review').not.toBe('REVIEW_REQUIRED');
    expect(job.status).toBe('VALIDATED');
    expect(job.approvedAt, 'the decision is on the job, which is what the gates read').not.toBeNull();
    // Due now by the clock the claim actually uses, or the worker will not see
    // it until whenever it happened to be scheduled.
    expect(new Date(job.runAt).getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  }, 60_000);

  it('records the decision so the owner can see it was theirs', async () => {
    const { jobId, ownerId } = await approvableJob();
    await approveJob({ jobId, decidedBy: ownerId, note: 'this is fine' });

    const approval = await actionsRepo.getApproval(jobId);
    expect(approval?.status).toBe('APPROVED');
    expect(approval?.decidedBy).toBe(ownerId);
  }, 60_000);

  it('does not let a soft quality verdict overrule the person who approved it', async () => {
    /*
      The heart of it. Without the fix the pipeline resumes into the quality
      gate, the unchanged report still says "do not send", and the job returns
      to REVIEW_REQUIRED with the owner none the wiser.
    */
    const { jobId, ownerId, agentId } = await approvableJob();
    await approveJob({ jobId, decidedBy: ownerId });

    const { stepQualityGate } = await import('../../packages/runtime/src/steps/generate');
    const { loadJobBundle } = await import('../../packages/runtime/src/loadJob');
    const bundle = await loadJobBundle(await jobsRepo.requireJob(jobId));

    // A report the gate would normally refuse.
    await jobsRepo.updateJob(jobId, {
      resolvedContext: {
        ...(bundle.job.resolvedContext ?? ({} as never)),
        meta: {
          ...((bundle.job.resolvedContext?.meta as Record<string, unknown>) ?? {}),
          quality: {
            outcome: 'review',
            reason: 'Does not sound like this agent — 158 characters.',
            voice: { score: 20 },
            generic: { score: 80, reasons: [] },
            repetition: { score: 10, reason: null, matched: null, matchedAt: null },
          },
        },
      },
    });

    const approved = await loadJobBundle(await jobsRepo.requireJob(jobId));
    expect(approved.job.approvedAt).not.toBeNull();
    await expect(stepQualityGate(approved), 'an approved job must not be handed back').resolves.toBeUndefined();
    expect(agentId).toBeTruthy();
  }, 60_000);

  it('still refuses an unapproved job that scores badly', async () => {
    // The gate has to keep working for everything nobody has decided on. A fix
    // that let every draft through would be worse than the fault.
    const { jobId } = await approvableJob();
    await query(`UPDATE jobs SET status='VALIDATED', approved_at=NULL WHERE id=$1`, [jobId]);

    const { stepQualityGate } = await import('../../packages/runtime/src/steps/generate');
    const { loadJobBundle } = await import('../../packages/runtime/src/loadJob');
    const bundle = await loadJobBundle(await jobsRepo.requireJob(jobId));
    await jobsRepo.updateJob(jobId, {
      resolvedContext: {
        ...(bundle.job.resolvedContext ?? ({} as never)),
        meta: {
          ...((bundle.job.resolvedContext?.meta as Record<string, unknown>) ?? {}),
          quality: {
            outcome: 'review',
            reason: 'Does not sound like this agent.',
            voice: { score: 20 },
            generic: { score: 80, reasons: [] },
            repetition: { score: 10, reason: null, matched: null, matchedAt: null },
          },
        },
      },
    });

    const unapproved = await loadJobBundle(await jobsRepo.requireJob(jobId));
    expect(unapproved.job.approvedAt).toBeNull();
    await expect(stepQualityGate(unapproved)).rejects.toThrow(/sound like this agent/i);
  }, 60_000);
});

describe('approval never becomes authority it was not given', () => {
  it('refuses to approve something that is no longer waiting', async () => {
    // An expired or already-settled request must not pretend to execute.
    const { jobId, ownerId } = await approvableJob();
    await query(`UPDATE jobs SET status='CANCELLED' WHERE id=$1`, [jobId]);
    await expect(approveJob({ jobId, decidedBy: ownerId })).rejects.toThrow(/nothing to approve/i);
  }, 60_000);

  it('does not grant a capability the agent did not have', async () => {
    const { jobId, ownerId, agentId } = await approvableJob();
    const before = await query<{ n: string }>(
      'SELECT count(*)::text AS n FROM agent_capability_permissions WHERE agent_id=$1',
      [agentId],
    );
    await approveJob({ jobId, decidedBy: ownerId });
    const after = await query<{ n: string }>(
      'SELECT count(*)::text AS n FROM agent_capability_permissions WHERE agent_id=$1',
      [agentId],
    );
    expect(after[0]!.n).toBe(before[0]!.n);
  }, 60_000);

  it('is idempotent, so a double click cannot queue two actions', async () => {
    const { jobId, ownerId } = await approvableJob();
    await approveJob({ jobId, decidedBy: ownerId });
    // The second is refused because the job is no longer in a decision state,
    // which is what stops a restart or an impatient owner sending twice.
    await expect(approveJob({ jobId, decidedBy: ownerId })).rejects.toThrow(/nothing to approve/i);

    const policy = PolicyConfig.parse({});
    expect(policy.automation.mode).toBeTruthy();
  }, 60_000);
});
