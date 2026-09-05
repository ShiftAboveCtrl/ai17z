import { describe, expect, it } from 'vitest';
import { agents as agentsRepo, jobs as jobsRepo, query } from '@xbam/database';
import { approveJob, rejectJob } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/** A job held for a person, with a draft, on a real agent. */
async function heldJob(text: string, ownerId?: string, agentId?: string) {
  const fixture = ownerId && agentId ? { ownerId, agentId } : await createFixture();
  const persona = await agentsRepo.getActivePersona(fixture.agentId);
  const policy = await agentsRepo.getActivePolicy(fixture.agentId);
  const suffix = uniqueSuffix();

  const [event] = await query<{ id: string }>(
    `INSERT INTO events (channel, remote_event_id, type, remote_author_handle, text, occurred_at)
     VALUES ('mock', $1, 'MENTION', 'someone', 'a question', now()) RETURNING id`,
    [`bulk-${suffix}`],
  );
  const [job] = await query<{ id: string }>(
    `INSERT INTO jobs (event_id, agent_id, channel, action_type, idempotency_key, dry_run,
       max_attempts, priority, persona_version_id, policy_version_id, status,
       generated_output, validated_output)
     VALUES ($1, $2, 'mock', 'REPLY', $3, true, 5, 100, $4, $5, 'WAITING_FOR_APPROVAL', $6, $6)
     RETURNING id`,
    [event!.id, fixture.agentId, `bulk:${suffix}`, persona!.id, policy!.id, text],
  );
  return { jobId: job!.id, fixture };
}

/**
 * Deciding on many at once.
 *
 * The bulk route is a loop over the same `approveJob` a single decision uses,
 * and that is the whole safety argument: it is not a faster path, it is the
 * same path called repeatedly. These pin the parts of that which would be
 * tempting to optimise away.
 */
describe('approving several held replies', () => {
  it('approves each one, and each gets its own approval record', async () => {
    const a = await heldJob('The first answer.');
    const b = await heldJob('The second answer.', a.fixture.ownerId, a.fixture.agentId);

    await approveJob({ jobId: a.jobId, decidedBy: null });
    await approveJob({ jobId: b.jobId, decidedBy: null });

    for (const id of [a.jobId, b.jobId]) {
      expect((await jobsRepo.requireJob(id)).status).toBe('VALIDATED');
    }
    const [approvals] = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM approvals WHERE job_id = ANY($1) AND status = $2',
      [[a.jobId, b.jobId], 'APPROVED'],
    );
    expect(approvals!.n).toBe(2);
  });

  it('rejects without publishing anything', async () => {
    const { jobId } = await heldJob('Something not worth saying.');
    await rejectJob({ jobId, decidedBy: null, note: 'no' });

    const job = await jobsRepo.requireJob(jobId);
    expect(job.status).toBe('CANCELLED');
    const [actions] = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM actions WHERE job_id = $1 AND status = 'EXECUTED'",
      [jobId],
    );
    expect(actions!.n).toBe(0);
  });

  /**
   * The property that makes a bulk button safe to have at all.
   *
   * Every job is re-validated against its own policy on the way through. If a
   * loop could skip that, "approve all" would be a way to publish something
   * the policy forbids, forty times, in one click.
   */
  it('still refuses one the policy rejects, however many were selected', async () => {
    const fixture = await createFixture();
    const policy = await agentsRepo.getActivePolicy(fixture.agentId);
    // A banned phrase is a hard rejection. Set before the jobs exist, because a
    // job is validated against the policy it was generated under -- editing the
    // agent's policy afterwards deliberately does not reach back.
    await agentsRepo.savePolicyVersion(
      fixture.agentId,
      {
        ...(policy!.config as Record<string, unknown>),
        output: {
          ...((policy!.config as { output?: Record<string, unknown> }).output ?? {}),
          bannedPhrases: ['guaranteed returns'],
        },
      } as never,
      'banned a phrase for this test',
      null,
    );

    const ok = await heldJob('A perfectly ordinary answer.', fixture.ownerId, fixture.agentId);
    const banned = await heldJob('You can expect guaranteed returns.', fixture.ownerId, fixture.agentId);

    await expect(approveJob({ jobId: banned.jobId, decidedBy: null })).rejects.toThrow(/banned phrase/i);
    expect((await jobsRepo.requireJob(banned.jobId)).status).toBe('WAITING_FOR_APPROVAL');

    // And the one beside it is unaffected: a refusal is per job, not per batch.
    await approveJob({ jobId: ok.jobId, decidedBy: null });
    expect((await jobsRepo.requireJob(ok.jobId)).status).toBe('VALIDATED');
  });

  it('will not approve one that is not waiting for anybody', async () => {
    // Deciding twice on the same job, which is what a stale selection does
    // after somebody else has already acted on it.
    const { jobId } = await heldJob('An answer.');
    await approveJob({ jobId, decidedBy: null });
    await expect(approveJob({ jobId, decidedBy: null })).rejects.toThrow(/nothing to approve/i);
  });
});

/**
 * The inbox has to carry the draft, or the row cannot show what it is asking
 * about and every decision costs a page visit.
 */
describe('the inbox carries the pending draft', () => {
  it('shows a draft while the job is held', async () => {
    const { jobId, fixture } = await heldJob('The proposed reply.');
    const { inbox } = await import('@xbam/database');
    const items = await inbox.ownerInbox(fixture.ownerId);
    const row = items.find((i) => i.jobId === jobId);
    expect(row?.draftText).toBe('The proposed reply.');
  });

  it('stops showing it once the job is no longer waiting', async () => {
    // Otherwise a finished job keeps offering an approve button for a decision
    // that has already been made.
    const { jobId, fixture } = await heldJob('The proposed reply.');
    await rejectJob({ jobId, decidedBy: null });

    const { inbox } = await import('@xbam/database');
    const row = (await inbox.ownerInbox(fixture.ownerId)).find((i) => i.jobId === jobId);
    expect(row?.draftText).toBeNull();
  });
});
